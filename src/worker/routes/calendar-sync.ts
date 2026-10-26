/**
 * `/api/calendar` connection, proxy and OAuth routes.
 *
 * The router is SQL-free: every row lives in `connections.ts` or `oauth.ts`, and this file only turns
 * a request into arguments and a result into JSON. The OAuth callback is the one route that is not
 * behind `requireAuth` on this router, because it is a top-level browser navigation; it still runs
 * after the application's session loader, and it verifies the state row against that session itself.
 * Mount this router where `loadSession` has already run (the lead owns that wiring).
 */
import { Hono } from 'hono'
import { encryptCalendarCredential } from '../lib/crypto'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { CalendarStore } from '../calendar/store'
import { parseProviderCalendarMappings, saveProviderCalendarMappings } from '../calendar/provider-sync'
import { newId, isValidId } from '../lib/id'
import { readJson } from '../lib/request'
import { createMinuteBudget } from '../lib/rate-limit'
import { requireAuth } from '../middleware/auth'
import {
  createCalendarConnection,
  deleteCalendarConnection,
  getCalendarConnection,
  isCalendarConnectionStatus,
  listCalendarConnections,
  updateCalendarConnectionStatus,
  type CalendarConnectionStatus,
} from '../calendar/connections'
import {
  ICLOUD_CALDAV_SERVER,
  discoverCalendarConnection,
  isCaldavPreset,
  validateCalendarPassword,
} from '../calendar/discovery'
import {
  PROXY_JSON_BODY_LIMIT,
  proxyCalendarRequest,
} from '../calendar/proxy'
import {
  completeOAuth,
  isCalendarOAuthProvider,
  revokeCalendarConnection,
  startOAuth,
  type CalendarOAuthProvider,
} from '../calendar/oauth'

export const calendarSyncRoutes = new Hono<AppBindings>()

const CONNECTION_BODY_LIMIT = 16 * 1024
const STATUS_BODY_LIMIT = 8 * 1024
const OAUTH_BODY_LIMIT = 8 * 1024
const CREATE_BUDGET_PER_MINUTE = 10
const OAUTH_START_BUDGET_PER_MINUTE = 10
const MAPPING_BUDGET_PER_MINUTE = 30

const takeCreateBudget = createMinuteBudget(
  CREATE_BUDGET_PER_MINUTE,
  'Too many calendar connection attempts. Try again in a minute',
)
const takeOAuthStartBudget = createMinuteBudget(
  OAUTH_START_BUDGET_PER_MINUTE,
  'Too many calendar sign-in attempts. Try again in a minute',
)
const takeMappingBudget = createMinuteBudget(
  MAPPING_BUDGET_PER_MINUTE,
  'Too many calendar mapping updates. Try again in a minute',
)

const CALLBACK_ERROR_CODES = new Set([
  'access_denied',
  'invalid_request',
  'invalid_state',
  'provider_not_configured',
  'unauthenticated',
  'failed',
])

/**
 * The provider sends the reader's browser here. It must be mounted after `loadSession` and it must not
 * require the client-origin header — a cross-site navigation cannot send one. The state row, not the
 * route, is what binds the reply to this session.
 */
calendarSyncRoutes.get('/oauth/callback', async (c) => {
  const userId = c.get('userId') as string | undefined
  if (!userId) return c.redirect(errorRedirect('unauthenticated'), 302)
  if (c.req.query('error')) return c.redirect(errorRedirect('access_denied'), 302)
  try {
    const completed = await completeOAuth(c.env, userId, {
      code: c.req.query('code'),
      state: c.req.query('state'),
      origin: new URL(c.req.url).origin,
    })
    return c.redirect(withConnectResult(completed.redirectTo, 'done'), 302)
  } catch (error) {
    if (error instanceof ApiError) return c.redirect(errorRedirect(callbackErrorCode(error)), 302)
    // The message could name a URL but never a token; only the error class is safe to keep.
    console.warn('[inkstone] Calendar OAuth callback failed:', error instanceof Error ? error.name : 'unknown')
    return c.redirect(errorRedirect('failed'), 302)
  }
})

calendarSyncRoutes.get('/connections', requireAuth, async (c) => {
  const connections = await listCalendarConnections(c.env.DB, c.get('userId'))
  return c.json({ connections })
})

/**
 * Create a CalDAV connection: validate the address, discover or derive the home, seal the password,
 * and insert the pair. Google and Outlook are created by the OAuth callback, not here.
 */
calendarSyncRoutes.post('/connections', requireAuth, async (c) => {
  const userId = c.get('userId')
  takeCreateBudget(userId)
  const body = await readJson<Record<string, unknown>>(c, CONNECTION_BODY_LIMIT)
  if (body.kind !== undefined && body.kind !== 'caldav') {
    throw ApiError.badRequest('Only CalDAV connections are created on this route')
  }
  const preset = body.preset === undefined ? 'custom' : body.preset
  if (!isCaldavPreset(preset)) throw ApiError.badRequest('Unknown calendar preset')
  if (body.writable !== undefined && typeof body.writable !== 'boolean') {
    throw ApiError.badRequest('writable must be a boolean')
  }
  if (body.label !== undefined && typeof body.label !== 'string') {
    throw ApiError.badRequest('The calendar connection name must be text')
  }
  const discovery = await discoverCalendarConnection({
    preset,
    // iCloud ignores this value; every other preset validates it.
    serverUrl: preset === 'icloud' ? ICLOUD_CALDAV_SERVER : body.serverUrl,
    username: body.username,
    password: body.password,
    // Least privilege: a caller that omits the flag gets a read-only connection, never write access
    // it did not ask for.
    writable: body.writable === true,
  })
  const password = validateCalendarPassword(body.password)
  const connectionId = newId()
  const ciphertext = await encryptCalendarCredential(c.env, connectionId, {
    kind: 'basic',
    username: discovery.username,
    password,
  })
  const connection = await createCalendarConnection(c.env.DB, userId, {
    id: connectionId,
    kind: 'caldav',
    label: typeof body.label === 'string' ? body.label : discovery.label,
    baseUrl: discovery.baseUrl,
    calendarHomeUrl: discovery.calendarHomeUrl,
    username: discovery.username,
    scope: discovery.writable ? 'write' : 'read',
    writable: discovery.writable,
    credential: { kind: 'basic', ciphertext },
  })
  return c.json({ connection })
})

calendarSyncRoutes.post('/connections/oauth/start', requireAuth, async (c) => {
  const userId = c.get('userId')
  takeOAuthStartBudget(userId)
  const body = await readJson<Record<string, unknown>>(c, OAUTH_BODY_LIMIT)
  if (!isCalendarOAuthProvider(body.provider)) throw ApiError.badRequest('Unknown calendar provider')
  if (body.writable !== undefined && typeof body.writable !== 'boolean') {
    throw ApiError.badRequest('writable must be a boolean')
  }
  if (body.redirectTo !== undefined && typeof body.redirectTo !== 'string') {
    throw ApiError.badRequest('The calendar return address must be an internal path')
  }
  const provider: CalendarOAuthProvider = body.provider
  const started = await startOAuth(c.env, userId, {
    provider,
    writable: body.writable === true,
    redirectTo: body.redirectTo,
    origin: new URL(c.req.url).origin,
  })
  return c.json({ url: started.url })
})

/**
 * The browser reports which local calendars its provider adapter owns. The cron only refreshes these
 * pairs; a missing or conflicting map is never guessed.
 */
calendarSyncRoutes.post('/connections/:id/calendars', requireAuth, async (c) => {
  const userId = c.get('userId')
  takeMappingBudget(userId)
  const connectionId = c.req.param('id')
  if (!isValidId(connectionId)) throw ApiError.notFound('Calendar connection not found')
  const connection = await getCalendarConnection(c.env.DB, userId, connectionId)
  if (!connection) throw ApiError.notFound('Calendar connection not found')
  const body = await readJson<Record<string, unknown>>(c, 64 * 1024)
  const mappings = parseProviderCalendarMappings(body.calendars)
  const calendars = await new CalendarStore(c.env.DB, userId).listCalendars()
  const byId = new Map(calendars.map(calendar => [calendar.id, calendar]))
  for (const mapping of mappings) {
    const calendar = byId.get(mapping.localId)
    if (!calendar) throw ApiError.notFound('A mapped calendar was not found')
    if (calendar.source !== connection.kind) {
      throw ApiError.badRequest('A mapped calendar does not belong to this provider')
    }
  }
  const mapped = await saveProviderCalendarMappings(c.env.DB, userId, connectionId, mappings)
  return c.json({ mapped })
})

calendarSyncRoutes.post('/connections/:id/proxy', requireAuth, async (c) => {
  const connectionId = c.req.param('id')
  if (!isValidId(connectionId)) throw ApiError.notFound('Calendar connection not found')
  const body = await readJson<Record<string, unknown>>(c, PROXY_JSON_BODY_LIMIT)
  try {
    const result = await proxyCalendarRequest(c.env, c.get('userId'), connectionId, {
      method: body.method,
      path: body.path,
      headers: body.headers,
      body: body.body,
    })
    return c.json(result)
  } catch (error) {
    if (error instanceof ApiError && (error.status === 429 || error.status === 503)) {
      c.header('Retry-After', '60')
      return c.json({ error: { code: error.code, message: error.message } }, error.status)
    }
    throw error
  }
})

/**
 * The client reports what its sync run saw. This never grants anything: the session and the calendar
 * rows remain the only authority, and the report is a status line for the settings screen.
 */
calendarSyncRoutes.post('/connections/:id/status', requireAuth, async (c) => {
  const connectionId = c.req.param('id')
  if (!isValidId(connectionId)) throw ApiError.notFound('Calendar connection not found')
  const body = await readJson<Record<string, unknown>>(c, STATUS_BODY_LIMIT)
  if (!isCalendarConnectionStatus(body.state)) throw ApiError.badRequest('Unknown calendar connection state')
  if (body.lastSyncedAt !== undefined && (
    typeof body.lastSyncedAt !== 'number'
    || !Number.isSafeInteger(body.lastSyncedAt)
    || body.lastSyncedAt < 0
  )) {
    throw ApiError.badRequest('Invalid last sync time')
  }
  if (body.errorCode !== undefined && body.errorCode !== null && (
    typeof body.errorCode !== 'string'
    || body.errorCode.length === 0
    || body.errorCode.length > 100
    || !/^[a-z0-9][a-z0-9_.:-]*$/.test(body.errorCode)
  )) {
    throw ApiError.badRequest('Invalid calendar error code')
  }
  const updated = await updateCalendarConnectionStatus(c.env.DB, c.get('userId'), connectionId, {
    status: body.state as CalendarConnectionStatus,
    lastSyncedAt: body.lastSyncedAt as number | undefined,
    errorCode: body.errorCode as string | null | undefined,
  })
  if (!updated) throw ApiError.notFound('Calendar connection not found')
  return c.body(null, 204)
})

calendarSyncRoutes.delete('/connections/:id', requireAuth, async (c) => {
  const connectionId = c.req.param('id')
  if (!isValidId(connectionId)) throw ApiError.notFound('Calendar connection not found')
  const userId = c.get('userId')
  const connection = await getCalendarConnection(c.env.DB, userId, connectionId)
  if (!connection) throw ApiError.notFound('Calendar connection not found')
  // Best-effort: the function logs a failed revoke and returns, so a provider outage cannot keep the
  // reader's own connection row alive after they asked for it to be gone.
  await revokeCalendarConnection(c.env, userId, connection)
  await deleteCalendarConnection(c.env.DB, userId, connectionId)
  return c.body(null, 204)
})

function errorRedirect(code: string): string {
  const safe = CALLBACK_ERROR_CODES.has(code) ? code : 'failed'
  return `/calendar?calendarConnect=error&code=${encodeURIComponent(safe)}`
}

function callbackErrorCode(error: ApiError): string {
  if (error.code === 'bad_request') return 'invalid_state'
  if (error.code === 'server_misconfigured') return 'provider_not_configured'
  if (error.code === 'unauthenticated') return 'unauthenticated'
  return 'failed'
}

function withConnectResult(path: string, result: 'done'): string {
  const url = new URL(path, 'https://calendar.invalid')
  url.searchParams.set('calendarConnect', result)
  return `${url.pathname}${url.search}`
}
