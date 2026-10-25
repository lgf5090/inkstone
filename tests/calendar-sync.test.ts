// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CALENDAR_SCHEMA_STATEMENTS } from '../src/worker/calendar/schema'
import {
  createCalendarConnection,
  getCalendarConnection,
  listCalendarConnections,
  loadCalendarCredential,
} from '../src/worker/calendar/connections'
import {
  discoverCalendarHome,
  parseCalendarPrivileges,
  resolvePreset,
  validateConnectionUrl,
} from '../src/worker/calendar/discovery'
import {
  assertInternalRedirect,
  completeOAuth,
  ensureAccessToken,
  safeInternalPath,
  startOAuth,
  type CalendarOAuthCredential,
} from '../src/worker/calendar/oauth'
import {
  decryptCalendarCredential,
  decryptCalendarOAuthVerifier,
  encryptCalendarCredential,
  encryptCalendarOAuthVerifier,
} from '../src/worker/lib/crypto'
import { sha256Hex } from '../src/worker/lib/encoding'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import type { AppBindings, Env } from '../src/worker/env'
import { calendarSyncRoutes } from '../src/worker/routes/calendar-sync'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'a'.repeat(26)
const OTHER = 'b'.repeat(26)
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar'
const GOOGLE_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

const mocks = vi.hoisted(() => ({ userId: 'a'.repeat(26) }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    if (!mocks.userId) {
      const { ApiError } = await import('../src/worker/lib/errors')
      throw new ApiError(401, 'unauthenticated', 'Authentication required')
    }
    c.set('userId', mocks.userId)
    await next()
  },
}))

interface Vault {
  namespace: DurableObjectNamespace
  entries: Map<string, { scope: string; value: unknown }>
}

function makeVault(): Vault {
  const entries = new Map<string, { scope: string; value: unknown }>()
  let sequence = 0
  const namespace = testDurableObjectNamespace(async (request) => {
    const url = new URL(request.url)
    const body = await request.json() as { scope?: string; value?: unknown; ciphertext?: string }
    if (url.pathname === '/encrypt') {
      const ciphertext = `vault-${++sequence}`
      entries.set(ciphertext, { scope: body.scope ?? '', value: body.value })
      return Response.json({ ciphertext })
    }
    if (url.pathname === '/decrypt') {
      const entry = entries.get(body.ciphertext ?? '')
      if (!entry || entry.scope !== body.scope) return Response.json({}, { status: 422 })
      return Response.json({ value: entry.value })
    }
    return new Response('not found', { status: 404 })
  })
  return { namespace, entries }
}

let sqlite: DatabaseSync
let db: D1Database
let vault: Vault
let env: Env

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
// The real application installs `loadSession` before this router; the callback depends on that, so
// the test installs the same half of it instead of letting the callback read an empty context.
app.use('/api/calendar/*', async (c, next) => {
  if (mocks.userId) c.set('userId', mocks.userId)
  await next()
})
app.route('/api/calendar', calendarSyncRoutes)

beforeEach(() => {
  vi.unstubAllGlobals()
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CALENDAR_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  vault = makeVault()
  env = testBindings(db, {
    CREDENTIAL_VAULT: vault.namespace,
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    OUTLOOK_CLIENT_ID: 'outlook-client',
    OUTLOOK_CLIENT_SECRET: 'outlook-secret',
  })
  mocks.userId = USER
})

async function request(path: string, init?: RequestInit, bindings: Env = env): Promise<Response> {
  return app.request(`/api/calendar${path}`, init, bindings)
}

function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

function multistatus(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:propstat><D:prop>${inner}</D:prop></D:propstat></D:response>
</D:multistatus>`
}

function stubDiscovery(home = '/calendars/alice/', principal = '/principals/alice/'): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (calls.length === 1) {
      return new Response(multistatus(`<D:current-user-principal><D:href>${principal}</D:href></D:current-user-principal>`), {
        status: 207,
      })
    }
    return new Response(multistatus(
      `<C:calendar-home-set><D:href>${home}</D:href></C:calendar-home-set>`
      + '<D:current-user-privilege-set><D:privilege><D:write/></D:privilege><D:privilege><D:bind/></D:privilege></D:current-user-privilege-set>',
    ), { status: 207 })
  })
  return calls
}

async function seedBasic(connectionId = newId(), password = 'app-specific-password'): Promise<{ id: string; password: string }> {
  const ciphertext = await encryptCalendarCredential(env, connectionId, {
    kind: 'basic',
    username: 'alice',
    password,
  })
  await createCalendarConnection(db, USER, {
    id: connectionId,
    kind: 'caldav',
    label: 'Home server',
    baseUrl: 'https://dav.example.com/',
    calendarHomeUrl: 'https://dav.example.com/calendars/alice/',
    username: 'alice',
    scope: 'write',
    writable: true,
    credential: { kind: 'basic', ciphertext },
  })
  return { id: connectionId, password }
}

async function seedOAuth(options: {
  id?: string
  userId?: string
  expiresAt?: number
  accessToken?: string
  refreshToken?: string
} = {}): Promise<{ id: string; credential: CalendarOAuthCredential }> {
  const id = options.id ?? newId()
  const userId = options.userId ?? USER
  const credential = {
    kind: 'oauth' as const,
    accessToken: options.accessToken ?? 'access-old',
    refreshToken: options.refreshToken ?? 'refresh-old',
    expiresAt: options.expiresAt ?? Date.now() + 3_600_000,
    scope: GOOGLE_SCOPE,
    tokenType: 'Bearer',
  }
  const ciphertext = await encryptCalendarCredential(env, id, credential)
  await createCalendarConnection(db, userId, {
    id,
    kind: 'google',
    label: 'Google Calendar',
    baseUrl: 'https://www.googleapis.com/calendar/v3/',
    calendarHomeUrl: 'https://www.googleapis.com/calendar/v3/',
    username: null,
    scope: 'write',
    writable: true,
    credential: { kind: 'oauth', ciphertext },
  })
  return { id, credential }
}

describe('CalDAV presets and address validation', () => {
  it('derives the documented home for the presets that have one', () => {
    expect(resolvePreset('nextcloud', 'https://cloud.example.com', 'alice').calendarHomeUrl)
      .toBe('https://cloud.example.com/remote.php/dav/calendars/alice/')
    expect(resolvePreset('radicale', 'https://dav.example.com/base', 'alice').calendarHomeUrl)
      .toBe('https://dav.example.com/base/alice/')
    expect(resolvePreset('fastmail', 'https://caldav.fastmail.com', 'alice@example.com').calendarHomeUrl)
      .toBe('https://caldav.fastmail.com/dav/principals/user/alice%40example.com/')
    expect(resolvePreset('icloud', '', 'alice').calendarHomeUrl).toBeNull()
    expect(resolvePreset('custom', 'https://dav.example.com/', 'alice').calendarHomeUrl).toBeNull()
  })

  it.each([
    ['plain http', 'http://dav.example.com/'],
    ['credentials in the address', 'https://alice:secret@dav.example.com/'],
    ['a non-standard port', 'https://dav.example.com:8443/'],
    ['a loopback address', 'https://127.0.0.1/'],
    ['an IPv6 loopback address', 'https://[::1]/'],
    ['a cloud metadata address', 'https://169.254.169.254/latest/meta-data/'],
    ['a private network name', 'https://nas.local/'],
    ['a localhost with a root dot', 'https://localhost./'],
    ['a query string', 'https://dav.example.com/?token=x'],
    ['a fragment', 'https://dav.example.com/#x'],
    ['a non-URL', 'not a url'],
  ])('refuses %s', (_label, value) => {
    expect(() => validateConnectionUrl(value)).toThrow()
  })

  it('accepts an explicit 443 and a path', () => {
    const url = validateConnectionUrl('https://dav.example.com:443/remote.php/dav/')
    expect(url.port).toBe('')
    expect(url.pathname).toBe('/remote.php/dav/')
  })
})

describe('CalDAV discovery', () => {
  it('sends Basic auth, follows the principal to the home, and never returns the password', async () => {
    const calls = stubDiscovery()
    const result = await discoverCalendarHome(new URL('https://dav.example.com/'), 'alice', 'secret-password')
    expect(result.calendarHomeUrl).toBe('https://dav.example.com/calendars/alice/')
    expect(result.username).toBe('alice')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.init?.method).toBe('PROPFIND')
    expect((calls[0]!.init?.headers as Record<string, string>).depth).toBe('1')
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toMatch(/^Basic /)
    expect(JSON.stringify(result)).not.toContain('secret-password')
  })

  it('refuses a home on a host the reader did not name', async () => {
    stubDiscovery('https://evil.example/calendars/alice/')
    await expect(discoverCalendarHome(new URL('https://dav.example.com/'), 'alice', 'secret-password'))
      .rejects.toMatchObject({ status: 502 })
  })

  it('allows an Apple shard when the server itself is Apple', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input))
      if (calls.length === 1) {
        return new Response(multistatus(
          '<D:current-user-principal><D:href>https://p01-caldav.icloud.com/123/principal/</D:href></D:current-user-principal>',
        ), { status: 207 })
      }
      return new Response(multistatus(
        '<C:calendar-home-set><D:href>https://p01-caldav.icloud.com/123/calendars/</D:href></C:calendar-home-set>',
      ), { status: 207 })
    })
    const result = await discoverCalendarHome(new URL('https://caldav.icloud.com/'), 'alice', 'secret-password')
    expect(result.calendarHomeUrl).toBe('https://p01-caldav.icloud.com/123/calendars/')
  })

  it('refuses redirects and oversized answers', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }))
    await expect(discoverCalendarHome(new URL('https://dav.example.com/'), 'alice', 'secret-password'))
      .rejects.toMatchObject({ status: 502 })

    vi.stubGlobal('fetch', async () => new Response('x'.repeat(64 * 1024 + 1), { status: 207 }))
    await expect(discoverCalendarHome(new URL('https://dav.example.com/'), 'alice', 'secret-password'))
      .rejects.toMatchObject({ status: 502 })
  })

  it('parses privileges without knowing the server prefix', () => {
    const xml = multistatus(
      '<D:current-user-privilege-set><D:privilege><D:read/></D:privilege></D:current-user-privilege-set>',
    )
    expect(parseCalendarPrivileges(xml)).toEqual({ canCreate: false, canUpdate: false, canDelete: false })
    expect(parseCalendarPrivileges(multistatus('<D:prop/>'))).toBeNull()
  })
})

describe('calendar credentials', () => {
  it('seals a password under the connection id and refuses another connection', async () => {
    const id = newId()
    const ciphertext = await encryptCalendarCredential(env, id, {
      kind: 'basic',
      username: 'alice',
      password: 'synthetic-password',
    })
    expect(ciphertext).not.toContain('synthetic-password')
    expect(vault.entries.size).toBe(1)
    await expect(decryptCalendarCredential(env, id, ciphertext)).resolves.toEqual({
      kind: 'basic',
      username: 'alice',
      password: 'synthetic-password',
    })
    await expect(decryptCalendarCredential(env, newId(), ciphertext)).resolves.toBeNull()
  })

  it('answers 503 when the deployment has no vault, and never puts the secret in a DTO', async () => {
    const noVault = testBindings(db)
    await expect(encryptCalendarCredential(noVault, newId(), {
      kind: 'basic',
      username: 'alice',
      password: 'synthetic-password',
    })).rejects.toMatchObject({ status: 503, code: 'server_misconfigured' })

    const seeded = await seedBasic()
    const listed = await listCalendarConnections(db, USER)
    expect(JSON.stringify(listed)).not.toContain(seeded.password)
    expect(JSON.stringify(listed)).not.toContain('synthetic-password')
  })

  it('round-trips the PKCE verifier under the state hash', async () => {
    const hash = await sha256Hex('state-value')
    const ciphertext = await encryptCalendarOAuthVerifier(env, hash, 'v'.repeat(43))
    expect(ciphertext).not.toContain('v'.repeat(43))
    await expect(decryptCalendarOAuthVerifier(env, hash, ciphertext)).resolves.toBe('v'.repeat(43))
    await expect(decryptCalendarOAuthVerifier(env, await sha256Hex('other'), ciphertext)).resolves.toBeNull()
  })
})

describe('OAuth start and callback', () => {
  it('builds a PKCE authorization URL and stores only a hash plus a sealed verifier', async () => {
    const started = await startOAuth(env, USER, {
      provider: 'google',
      writable: true,
      redirectTo: '/calendar?view=week',
      origin: 'https://notes.example.com',
    })
    const url = new URL(started.url)
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('https://notes.example.com/api/calendar/oauth/callback')
    expect(url.searchParams.get('scope')).toBe(GOOGLE_SCOPE)
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const state = url.searchParams.get('state')!
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const hash = await sha256Hex(state)
    const row = sqlite.prepare(
      'SELECT verifier_ciphertext, redirect_to FROM calendar_oauth_states WHERE user_id = ? AND state_hash = ?',
    ).get(USER, hash) as { verifier_ciphertext: string; redirect_to: string }
    expect(row.redirect_to).toBe('/calendar?view=week')
    expect(row.verifier_ciphertext).not.toContain(state)
    await expect(decryptCalendarOAuthVerifier(env, hash, row.verifier_ciphertext)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('uses the read scope when writable is false', async () => {
    const started = await startOAuth(env, USER, {
      provider: 'google',
      writable: false,
      origin: 'https://notes.example.com',
    })
    expect(new URL(started.url).searchParams.get('scope')).toBe(GOOGLE_READ_SCOPE)
  })

  it('refuses an external return address and a missing provider configuration', async () => {
    await expect(startOAuth(env, USER, {
      provider: 'google',
      writable: false,
      redirectTo: 'https://evil.example/calendar',
      origin: 'https://notes.example.com',
    })).rejects.toMatchObject({ status: 400 })
    expect(() => assertInternalRedirect('//evil.example')).toThrow()
    expect(() => assertInternalRedirect('/%2F%2Fevil.example')).toThrow()
    expect(() => assertInternalRedirect('/%5Cevil.example')).toThrow()
    expect(() => assertInternalRedirect('/%25252F%25252Fevil.example')).toThrow()
    expect(safeInternalPath('https://evil.example')).toBe('/calendar')
    expect(safeInternalPath('/%2F%2Fevil.example')).toBe('/calendar')

    const unconfigured = testBindings(db, { CREDENTIAL_VAULT: vault.namespace })
    await expect(startOAuth(unconfigured, USER, {
      provider: 'google',
      writable: false,
      origin: 'https://notes.example.com',
    })).rejects.toMatchObject({ status: 503, code: 'server_misconfigured' })
  })

  it('exchanges the code, consumes the state once, and stores tokens only in the vault', async () => {
    const started = await startOAuth(env, USER, {
      provider: 'google',
      writable: true,
      origin: 'https://notes.example.com',
    })
    const state = new URL(started.url).searchParams.get('state')!
    let verifier = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://oauth2.googleapis.com/token')
      const form = init?.body as URLSearchParams
      verifier = form.get('code_verifier') ?? ''
      expect(form.get('grant_type')).toBe('authorization_code')
      expect(form.get('code')).toBe('synthetic-code')
      return Response.json({
        access_token: 'access-token-value',
        refresh_token: 'refresh-token-value',
        expires_in: 3600,
        scope: GOOGLE_SCOPE,
        token_type: 'Bearer',
      })
    })
    const completed = await completeOAuth(env, USER, {
      code: 'synthetic-code',
      state,
      origin: 'https://notes.example.com',
    })
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(completed.redirectTo).toBe('/calendar')
    expect(completed.redirectTo).not.toContain('access-token-value')
    const connection = await getCalendarConnection(db, USER, completed.connectionId)
    expect(connection?.kind).toBe('google')
    expect(connection?.writable).toBe(true)
    const ciphertext = await loadCalendarCredential(db, USER, completed.connectionId, 'oauth')
    await expect(decryptCalendarCredential(env, completed.connectionId, ciphertext!)).resolves.toMatchObject({
      kind: 'oauth',
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
    })
    const row = sqlite.prepare(
      'SELECT used_at FROM calendar_oauth_states WHERE user_id = ? AND state_hash = ?',
    ).get(USER, await sha256Hex(state)) as { used_at: number | null }
    expect(row.used_at).toBeTypeOf('number')

    await expect(completeOAuth(env, USER, {
      code: 'synthetic-code',
      state,
      origin: 'https://notes.example.com',
    })).rejects.toMatchObject({ status: 400 })
  })

  it('does not accept a state minted for another account or an expired one', async () => {
    const started = await startOAuth(env, USER, {
      provider: 'google',
      writable: false,
      origin: 'https://notes.example.com',
    })
    const state = new URL(started.url).searchParams.get('state')!
    await expect(completeOAuth(env, OTHER, {
      code: 'synthetic-code',
      state,
      origin: 'https://notes.example.com',
    })).rejects.toMatchObject({ status: 400 })

    const hash = await sha256Hex(state)
    sqlite.prepare('UPDATE calendar_oauth_states SET expires_at = ? WHERE user_id = ? AND state_hash = ?')
      .run(Date.now() - 1, USER, hash)
    await expect(completeOAuth(env, USER, {
      code: 'synthetic-code',
      state,
      origin: 'https://notes.example.com',
    })).rejects.toMatchObject({ status: 400 })
  })
})

describe('access token refresh', () => {
  it('refreshes within the skew window and writes the new bundle back sealed', async () => {
    const seeded = await seedOAuth({ expiresAt: Date.now() + 10_000 })
    const connection = await getCalendarConnection(db, USER, seeded.id)
    expect(connection).not.toBeNull()
    vi.stubGlobal('fetch', async () => Response.json({
      access_token: 'access-new',
      expires_in: 3600,
      scope: GOOGLE_SCOPE,
      token_type: 'Bearer',
    }))
    const fresh = await ensureAccessToken(env, USER, connection!, seeded.credential)
    expect(fresh.accessToken).toBe('access-new')
    expect(fresh.refreshToken).toBe('refresh-old')
    const ciphertext = await loadCalendarCredential(db, USER, seeded.id, 'oauth')
    const stored = await decryptCalendarCredential(env, seeded.id, ciphertext!)
    expect(stored).toMatchObject({ accessToken: 'access-new', refreshToken: 'refresh-old' })
    expect((await getCalendarConnection(db, USER, seeded.id))?.status).toBe('connected')
  })

  it('marks the connection expired when the refresh is refused', async () => {
    const seeded = await seedOAuth({ expiresAt: Date.now() - 1 })
    const connection = await getCalendarConnection(db, USER, seeded.id)
    vi.stubGlobal('fetch', async () => Response.json({ error: 'invalid_grant' }, { status: 400 }))
    await expect(ensureAccessToken(env, USER, connection!, seeded.credential))
      .rejects.toMatchObject({ status: 502 })
    expect((await getCalendarConnection(db, USER, seeded.id))?.status).toBe('expired')
    expect((await getCalendarConnection(db, USER, seeded.id))?.lastErrorCode).toBe('authorization_expired')
  })
})

describe('calendar sync routes', () => {
  it('requires a session for the connection surface', async () => {
    mocks.userId = ''
    expect((await request('/connections')).status).toBe(401)
  })

  it('lists only the session account, without credentials', async () => {
    const seeded = await seedBasic()
    await seedOAuth({ userId: OTHER })
    const response = await request('/connections')
    expect(response.status).toBe(200)
    const body = await response.json() as { connections: Array<Record<string, unknown>> }
    expect(body.connections).toHaveLength(1)
    expect(body.connections[0]!.id).toBe(seeded.id)
    expect(JSON.stringify(body)).not.toContain(seeded.password)
    expect(JSON.stringify(body)).not.toContain('ciphertext')
  })

  it('creates a CalDAV connection through discovery and returns a sanitized DTO', async () => {
    stubDiscovery()
    const response = await request('/connections', json({
      kind: 'caldav',
      preset: 'custom',
      serverUrl: 'https://dav.example.com/',
      username: 'alice',
      password: 'synthetic-password',
      label: 'Desk calendar',
      writable: true,
    }))
    expect(response.status).toBe(200)
    const body = await response.json() as { connection: Record<string, unknown> }
    expect(body.connection).toMatchObject({
      kind: 'caldav',
      label: 'Desk calendar',
      calendarHomeUrl: 'https://dav.example.com/calendars/alice/',
      username: 'alice',
      writable: true,
      status: 'connected',
    })
    expect(JSON.stringify(body)).not.toContain('synthetic-password')
    expect(JSON.stringify(body)).not.toContain('ciphertext')
  })

  it('starts OAuth and lands the callback on an internal path without tokens', async () => {
    const start = await request('/connections/oauth/start', json({ provider: 'google', writable: true }))
    expect(start.status).toBe(200)
    const { url } = await start.json() as { url: string }
    const state = new URL(url).searchParams.get('state')!
    vi.stubGlobal('fetch', async () => Response.json({
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      expires_in: 3600,
      scope: GOOGLE_SCOPE,
    }))
    const callback = await request(`/oauth/callback?code=synthetic-code&state=${encodeURIComponent(state)}`)
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/calendar?calendarConnect=done')
    expect(callback.headers.get('location')).not.toContain('token')
  })

  it('redirects a callback with no session to a safe error page', async () => {
    mocks.userId = ''
    const response = await request('/oauth/callback?code=x&state=y')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/calendar?calendarConnect=error&code=unauthenticated')
  })

  it('reports status, rejects an unknown state, and deletes credentials with the connection', async () => {
    const seeded = await seedBasic()
    const reported = await request(`/connections/${seeded.id}/status`, json({
      state: 'error',
      errorCode: 'upstream_unreachable',
      lastSyncedAt: Date.now(),
    }))
    expect(reported.status).toBe(204)
    expect((await getCalendarConnection(db, USER, seeded.id))?.status).toBe('error')
    expect((await getCalendarConnection(db, USER, seeded.id))?.lastErrorCode).toBe('upstream_unreachable')

    const refused = await request(`/connections/${seeded.id}/status`, json({ state: 'nonsense' }))
    expect(refused.status).toBe(400)

    const deleted = await request(`/connections/${seeded.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(204)
    expect(await getCalendarConnection(db, USER, seeded.id)).toBeNull()
    expect(await loadCalendarCredential(db, USER, seeded.id, 'basic')).toBeNull()
  })

  it('answers 404 for another account connection and a malformed id', async () => {
    const seeded = await seedOAuth({ userId: OTHER })
    expect((await request(`/connections/${seeded.id}/status`, json({ state: 'connected' }))).status).toBe(404)
    expect((await request('/connections/not-an-id/status', json({ state: 'connected' }))).status).toBe(404)
  })
})
