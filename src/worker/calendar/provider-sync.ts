/**
 * The connection↔calendar map the background provider sync is allowed to touch.
 *
 * The browser discovers provider calendars and reports the remote/local id pair after it has created
 * the local rows. The server never invents this map: a calendar without a row here is read-only from
 * the cron's point of view. A local calendar may belong to one connection only, so two same-kind
 * accounts cannot both write the same rows.
 */
import type { D1Database } from '@cloudflare/workers-types'
import { ApiError } from '../lib/errors'
import { isCalendarEntityId } from '@shared/calendar/model'

export interface ProviderCalendarMapping {
  remoteId: string
  localId: string
}

export interface ProviderCalendarRow {
  connection_id: string
  remote_calendar_id: string
  local_calendar_id: string
  last_sync_at: number | null
  last_error_code: string | null
}

const MAX_MAPPINGS = 500
const MAX_REMOTE_ID = 4096

export function parseProviderCalendarMappings(value: unknown): ProviderCalendarMapping[] {
  if (!Array.isArray(value)) throw ApiError.badRequest('calendars must be an array')
  if (value.length > MAX_MAPPINGS) throw ApiError.badRequest('Too many calendars in one report')
  const mappings: ProviderCalendarMapping[] = []
  const remoteIds = new Set<string>()
  const localIds = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw ApiError.badRequest('Each calendar mapping must be an object')
    }
    const record = entry as Record<string, unknown>
    const remoteId = typeof record.remoteId === 'string' ? record.remoteId.trim() : ''
    const localId = record.localId
    if (!remoteId || remoteId.length > MAX_REMOTE_ID) {
      throw ApiError.badRequest('A remote calendar id is not valid')
    }
    if (!isCalendarEntityId(localId)) throw ApiError.badRequest('A local calendar id is not valid')
    if (remoteIds.has(remoteId)) throw ApiError.badRequest('A remote calendar is reported twice')
    if (localIds.has(localId)) throw ApiError.badRequest('A local calendar is reported twice')
    remoteIds.add(remoteId)
    localIds.add(localId)
    mappings.push({ remoteId, localId })
  }
  return mappings
}

/** Replace this connection's map; rows omitted from the report stop being background-synced. */
export async function saveProviderCalendarMappings(
  db: D1Database,
  userId: string,
  connectionId: string,
  mappings: readonly ProviderCalendarMapping[],
): Promise<number> {
  const existing = await db.prepare(
    `SELECT connection_id, local_calendar_id FROM calendar_provider_calendars
      WHERE user_id = ?1 AND local_calendar_id IN (
        SELECT value FROM json_each(?2)
      )`,
  ).bind(userId, JSON.stringify(mappings.map(mapping => mapping.localId))).all<{
    connection_id: string
    local_calendar_id: string
  }>()
  const conflicts = (existing.results ?? [])
    .filter(row => row.connection_id !== connectionId)
    .map(row => row.local_calendar_id)
  if (conflicts.length > 0) {
    throw ApiError.conflict('A calendar is already mapped to another connection')
  }

  const now = Date.now()
  const statements = [
    db.prepare(
      `DELETE FROM calendar_provider_calendars
        WHERE user_id = ?1 AND connection_id = ?2
          AND remote_calendar_id NOT IN (SELECT value FROM json_each(?3))`,
    ).bind(userId, connectionId, JSON.stringify(mappings.map(mapping => mapping.remoteId))),
  ]
  for (const mapping of mappings) {
    statements.push(db.prepare(
      `INSERT INTO calendar_provider_calendars
        (user_id, connection_id, remote_calendar_id, local_calendar_id, last_sync_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)
       ON CONFLICT(user_id, connection_id, remote_calendar_id) DO UPDATE SET
         local_calendar_id = excluded.local_calendar_id,
         updated_at = excluded.updated_at`,
    ).bind(userId, connectionId, mapping.remoteId, mapping.localId, now))
  }
  try {
    await db.batch(statements)
  } catch {
    throw ApiError.conflict('A calendar is already mapped to another connection')
  }
  return mappings.length
}

export async function listProviderCalendarMappings(
  db: D1Database,
  userId: string,
  connectionId: string,
): Promise<ProviderCalendarRow[]> {
  const { results } = await db.prepare(
    `SELECT connection_id, remote_calendar_id, local_calendar_id, last_sync_at, last_error_code
       FROM calendar_provider_calendars
      WHERE user_id = ?1 AND connection_id = ?2
      ORDER BY local_calendar_id ASC`,
  ).bind(userId, connectionId).all<ProviderCalendarRow>()
  return results ?? []
}

import {
  createCalDAVAdapter,
  createCalDAVSync,
  mapCalDAVEventToDayFlow,
  type CalDAVDeletedEvent,
} from '@dayflow/caldav'
import { createGoogleSync, createGoogleSyncAdapter } from '@dayflow/google-sync'
import { createOutlookSync, createOutlookSyncAdapter } from '@dayflow/outlook-sync'
import { Temporal } from 'temporal-polyfill'
import {
  TASK_PRIORITIES,
  toTemporalValue,
  type CalendarConferenceDto,
  type CalendarEventInput,
  type CalendarSource,
  type CalendarTaskDto,
  type CalendarTaskPriority,
} from '@shared/calendar/model'
import { sha256Hex } from '../lib/encoding'
import { proxyCalendarRequest } from './proxy'
import { CalendarStore } from './store'
import { parseEventInput } from './validation'
import { getCalendarConnection, updateCalendarConnectionStatus, type CalendarConnectionRecord } from './connections'
import type { Env } from '../env'

const PROVIDER_SYNC_INTERVAL_MS = 15 * 60 * 1000
const PROVIDER_SYNC_LIMIT = 2
const PROVIDER_RANGE_PAST_MS = 30 * 24 * 60 * 60 * 1000
const PROVIDER_RANGE_FUTURE_MS = 365 * 24 * 60 * 60 * 1000
const PROVIDER_EVENT_CHUNK = 100
const RENDER_ONLY_META_KEYS = new Set([
  'day',
  '_originalStartHour',
  '_originalEndHour',
  '_recurrenceMasterId',
  '_recurrenceKey',
])

/** The provider libraries get the same authenticated, path-scoped proxy the browser uses. */
function providerFetch(env: Env, userId: string, connectionId: string): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : null
    const url = new URL(request?.url ?? String(input), 'https://calendar.invalid')
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(new Headers(init?.headers ?? request?.headers).entries())
    const rawBody = init?.body
    let body: string | undefined
    if (typeof rawBody === 'string') body = rawBody
    else if (rawBody instanceof URLSearchParams) body = rawBody.toString()
    else if (rawBody !== undefined && rawBody !== null) {
      throw new Error('The provider sent a request body the server proxy cannot carry')
    }
    const result = await proxyCalendarRequest(env, userId, connectionId, {
      method,
      path: `${url.pathname}${url.search}`,
      headers,
      body,
    })
    const nullBody = result.status === 204 || result.status === 205 || result.status === 304
    return new Response(nullBody ? null : result.body, { status: result.status, headers: result.headers })
  }
}

function providerId(event: { meta?: Record<string, unknown> }, source: CalendarSource): string | null {
  const meta = event.meta
  if (!meta) return null
  if (source === 'caldav') {
    const value = meta.caldav
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const uid = record.uid
    const href = record.href
    return typeof uid === 'string' && uid ? uid : typeof href === 'string' && href ? href : null
  }
  const value = meta[source]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const eventId = (value as Record<string, unknown>).eventId
  return typeof eventId === 'string' && eventId ? eventId : null
}

async function externalIdFor(raw: string): Promise<string> {
  if (isCalendarEntityId(raw)) return raw
  return `provider:${await sha256Hex(raw)}`
}

function cleanMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (!RENDER_ONLY_META_KEYS.has(key)) out[key] = value
  }
  return out
}

function taskFor(event: { task?: { completed?: boolean; completedAt?: unknown; priority?: string } }): CalendarTaskDto | null {
  if (!event.task) return null
  const completed = event.task.completed === true
  const completedAt = completed && event.task.completedAt
    ? toTemporalValue(event.task.completedAt as Temporal.ZonedDateTime)
    : undefined
  const priority = (TASK_PRIORITIES as readonly string[]).includes(event.task.priority ?? '')
    ? event.task.priority as CalendarTaskPriority
    : undefined
  return {
    completed,
    ...(completedAt ? { completedAt } : {}),
    ...(priority ? { priority } : {}),
  }
}

function conferenceFor(event: { conference?: Record<string, unknown> }): CalendarConferenceDto | null {
  const source = event.conference
  if (!source) return null
  const joinUrl = source.joinUrl
  if (typeof joinUrl !== 'string' || !/^https:\/\//i.test(joinUrl)) return null
  return {
    joinUrl,
    ...(typeof source.provider === 'string' ? { provider: source.provider } : {}),
    ...(typeof source.meetingId === 'string' ? { meetingId: source.meetingId } : {}),
    ...(typeof source.hostUrl === 'string' ? { hostUrl: source.hostUrl } : {}),
    ...(typeof source.password === 'string' ? { password: source.password } : {}),
  }
}

type ProviderRemoteEvent = {
  title?: string
  description?: string
  kind?: 'event' | 'task'
  task?: { completed?: boolean; completedAt?: unknown; priority?: string }
  conference?: Record<string, unknown>
  start: Temporal.ZonedDateTime | Temporal.PlainDateTime | Temporal.PlainDate
  end: Temporal.ZonedDateTime | Temporal.PlainDateTime | Temporal.PlainDate
  allDay?: boolean
  meta?: Record<string, unknown>
  icon?: boolean | { toString(): string }
}

async function providerEventInput(
  event: ProviderRemoteEvent,
  source: CalendarSource,
  localCalendarId: string,
): Promise<CalendarEventInput | null> {
  const rawId = providerId(event, source)
  if (!rawId) return null
  const meta = cleanMeta(event.meta)
  return {
    title: (event.title ?? '').trim() || 'Untitled',
    description: event.description ?? '',
    kind: event.kind ?? 'event',
    task: taskFor(event),
    conference: conferenceFor(event),
    start: toTemporalValue(event.start),
    end: toTemporalValue(event.end),
    allDay: event.allDay ?? event.start instanceof Temporal.PlainDate,
    calendarId: localCalendarId,
    calendarIds: [localCalendarId],
    meta,
    icon: typeof event.icon === 'boolean' ? event.icon : null,
    recurrenceRule: typeof meta.recurrenceRule === 'string' ? meta.recurrenceRule : null,
    source,
    externalId: await externalIdFor(rawId),
  }
}

/** Remove provider rows that the full-range answer no longer names; local-only rows have no external id. */
async function mirrorProviderCalendar(
  env: Env,
  userId: string,
  localCalendarId: string,
  source: CalendarSource,
  keepExternalIds: ReadonlySet<string>,
  rangeStart: number,
  rangeEnd: number,
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT external_id FROM calendar_events
      WHERE user_id = ?1 AND calendar_source = ?2 AND external_scope = ?3
        AND external_id IS NOT NULL
        AND ((start_ms BETWEEN ?4 AND ?5) OR recurrence_rule IS NOT NULL)`,
  ).bind(userId, source, localCalendarId, rangeStart, rangeEnd).all<{ external_id: string }>()
  const stale = (results ?? [])
    .map(row => row.external_id)
    .filter((externalId): externalId is string => Boolean(externalId) && !keepExternalIds.has(externalId))
  if (stale.length === 0) return 0
  return deleteProviderEvents(env, userId, localCalendarId, source, stale)
}

export interface ProviderSyncResult {
  connections: number
  calendars: number
  events: number
  deleted: number
  failed: number
}

async function deleteProviderEvents(
  env: Env,
  userId: string,
  localCalendarId: string,
  source: CalendarSource,
  externalIds: readonly string[],
): Promise<number> {
  let deleted = 0
  for (let index = 0; index < externalIds.length; index += 60) {
    const ids = externalIds.slice(index, index + 60)
    const placeholders = ids.map((_, offset) => `?${offset + 4}`).join(', ')
    await env.DB.prepare(
      `DELETE FROM calendar_event_calendars
        WHERE user_id = ?1 AND event_id IN (
          SELECT id FROM calendar_events
           WHERE user_id = ?1 AND calendar_source = ?2 AND external_scope = ?3
             AND external_id IN (${placeholders})
        )`,
    ).bind(userId, source, localCalendarId, ...ids).run()
    const removed = await env.DB.prepare(
      `DELETE FROM calendar_events
        WHERE user_id = ?1 AND calendar_source = ?2 AND external_scope = ?3
          AND external_id IN (${placeholders})`,
    ).bind(userId, source, localCalendarId, ...ids).run()
    deleted += removed.meta.changes ?? 0
  }
  return deleted
}

async function syncConnection(
  env: Env,
  userId: string,
  connection: CalendarConnectionRecord,
  mappings: readonly ProviderCalendarRow[],
  now: number,
): Promise<{ events: number; deleted: number; failed: number }> {
  const store = new CalendarStore(env.DB, userId)
  const timeZone = (await store.preferences()).timeZone
  const fetchImpl = providerFetch(env, userId, connection.id)
  let events = 0
  let deleted = 0
  let failed = 0
  const rangeStart = new Date(now - PROVIDER_RANGE_PAST_MS)
  const rangeEnd = new Date(now + PROVIDER_RANGE_FUTURE_MS)

  for (const mapping of mappings) {
    try {
      let mapped: ProviderRemoteEvent[]
      let deletedRefs: Array<string | CalDAVDeletedEvent>
      if (connection.kind === 'caldav') {
        const adapter = createCalDAVAdapter({ calendarHomeUrl: connection.calendarHomeUrl ?? '', fetch: fetchImpl })
        const sync = createCalDAVSync({ adapter })
        const result = await sync.syncEvents({ calendarId: mapping.remote_calendar_id, range: { start: rangeStart, end: rangeEnd } })
        mapped = result.events
          .map(data => mapCalDAVEventToDayFlow(data) as ProviderRemoteEvent | null)
          .filter((event): event is ProviderRemoteEvent => Boolean(event))
        deletedRefs = result.deleted
      } else if (connection.kind === 'google') {
        const sync = createGoogleSync(createGoogleSyncAdapter({ fetch: fetchImpl }))
        const result = await sync.syncEvents(mapping.remote_calendar_id, {
          start: rangeStart.toISOString(),
          end: rangeEnd.toISOString(),
        })
        mapped = result.events as ProviderRemoteEvent[]
        deletedRefs = result.deleted
      } else {
        const sync = createOutlookSync(createOutlookSyncAdapter({ fetch: fetchImpl }))
        const result = await sync.syncEvents(mapping.remote_calendar_id, {
          start: rangeStart.toISOString(),
          end: rangeEnd.toISOString(),
        })
        mapped = result.events as ProviderRemoteEvent[]
        deletedRefs = result.deleted
      }
      const inputs = []
      const keepExternalIds = new Set<string>()
      for (const event of mapped) {
        const input = await providerEventInput(event, connection.kind, mapping.local_calendar_id)
        if (!input) continue
        try {
          const parsed = parseEventInput(input, { defaultTimeZone: timeZone })
          inputs.push(parsed)
          if (parsed.externalId) keepExternalIds.add(parsed.externalId)
        } catch (error) {
          console.warn('[inkstone] Provider event skipped:', error instanceof Error ? error.message : error)
        }
      }
      for (let index = 0; index < inputs.length; index += PROVIDER_EVENT_CHUNK) {
        const chunk = inputs.slice(index, index + PROVIDER_EVENT_CHUNK)
        events += (await store.createEvents(chunk, 'upsert')).length
      }
      const rawDeleted = deletedRefs.map(ref => typeof ref === 'string'
        ? ref
        : (ref.uid ?? ref.href))
      const externalIds = []
      for (const raw of rawDeleted) {
        if (raw) externalIds.push(await externalIdFor(raw))
      }
      deleted += await deleteProviderEvents(env, userId, mapping.local_calendar_id, connection.kind, externalIds)
      deleted += await mirrorProviderCalendar(
        env,
        userId,
        mapping.local_calendar_id,
        connection.kind,
        keepExternalIds,
        rangeStart.getTime(),
        rangeEnd.getTime(),
      )
      await env.DB.prepare(
        `UPDATE calendar_provider_calendars
            SET last_sync_at = ?4, last_error_code = NULL, updated_at = ?4
          WHERE user_id = ?1 AND connection_id = ?2 AND remote_calendar_id = ?3`,
      ).bind(userId, connection.id, mapping.remote_calendar_id, now).run()
    } catch (error) {
      failed += 1
      console.warn('[inkstone] Provider calendar sync failed:', {
        connection: connection.id,
        calendar: mapping.remote_calendar_id,
        error: error instanceof Error ? error.message : error,
      })
      await env.DB.prepare(
        `UPDATE calendar_provider_calendars
            SET last_error_code = ?4, updated_at = ?5
          WHERE user_id = ?1 AND connection_id = ?2 AND remote_calendar_id = ?3`,
      ).bind(userId, connection.id, mapping.remote_calendar_id, 'sync_failed', now).run()
    }
  }
  return { events, deleted, failed }
}

export async function syncDueProviderConnections(
  env: Env,
  now = Date.now(),
): Promise<ProviderSyncResult> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT connection_id, user_id
       FROM calendar_provider_calendars
      WHERE last_sync_at IS NULL OR last_sync_at <= ?1
      ORDER BY last_sync_at ASC
      LIMIT ?2`,
  ).bind(now - PROVIDER_SYNC_INTERVAL_MS, PROVIDER_SYNC_LIMIT).all<{
    connection_id: string
    user_id: string
  }>()
  let connections = 0
  let calendars = 0
  let events = 0
  let deleted = 0
  let failed = 0
  for (const row of results ?? []) {
    const connection = await getCalendarConnection(env.DB, row.user_id, row.connection_id)
    if (!connection || connection.status === 'disconnected' || connection.status === 'expired') continue
    const mappings = await listProviderCalendarMappings(env.DB, row.user_id, row.connection_id)
    if (mappings.length === 0) continue
    connections += 1
    calendars += mappings.length
    try {
      const result = await syncConnection(env, row.user_id, connection, mappings, now)
      events += result.events
      deleted += result.deleted
      failed += result.failed
      await updateCalendarConnectionStatus(env.DB, row.user_id, row.connection_id, {
        status: 'connected',
        lastSyncedAt: now,
        errorCode: null,
      })
    } catch (error) {
      failed += 1
      await updateCalendarConnectionStatus(env.DB, row.user_id, row.connection_id, {
        status: 'error',
        lastSyncedAt: now,
        errorCode: 'sync_failed',
      })
      console.warn('[inkstone] Provider connection sync failed:', {
        connection: row.connection_id,
        error: error instanceof Error ? error.message : error,
      })
    }
  }
  return { connections, calendars, events, deleted, failed }
}
