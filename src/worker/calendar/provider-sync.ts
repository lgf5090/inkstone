import { listProviderCalendarMappings, type ProviderCalendarRow } from './provider-mappings'
import {
  createCalDAVAdapter,
  mapCalDAVEventToDayFlow,
  type CalDAVDeletedEvent,
  type CalDAVEventData,
} from '@dayflow/caldav'
import { createGoogleSync, createGoogleSyncAdapter } from '@dayflow/google-sync'
import { createOutlookSync, createOutlookSyncAdapter } from '@dayflow/outlook-sync'
import { Temporal } from 'temporal-polyfill'
import {
  TASK_PRIORITIES,
  isCalendarEntityId,
  toTemporalValue,
  type CalendarAttendeeDto,
  type CalendarConferenceDto,
  type CalendarEventInput,
  type CalendarSource,
  type CalendarTaskDto,
  type CalendarTaskPriority,
} from '@shared/calendar/model'
import { sha256Hex } from '../lib/encoding'
import { proxyCalendarRequest } from './proxy'
import { CalendarStore } from './store'
import { normalizeEventAttendees } from './attendees'
import { parseEventInput } from './validation'
import {
  assertCalendarConnectionKind,
  calendarConnectionBase,
  getCalendarConnection,
  updateCalendarConnectionStatus,
  type CalendarConnectionRecord,
} from './connections'
import { syncProjectCardForCalendarEvent } from '../project/project-calendar'
import type { Env } from '../env'

const PROVIDER_SYNC_INTERVAL_MS = 15 * 60 * 1000
const PROVIDER_SYNC_LIMIT = 2
const PROVIDER_RANGE_PAST_MS = 30 * 24 * 60 * 60 * 1000
const PROVIDER_RANGE_FUTURE_MS = 365 * 24 * 60 * 60 * 1000
const PROVIDER_EVENT_CHUNK = 100
const MAX_PROVIDER_SYNC_TOKEN_CHARS = 16 * 1024
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
  const completedAt = completed && event.task.completedAt instanceof Temporal.ZonedDateTime
    ? toTemporalValue(event.task.completedAt)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isProviderTemporal(value: unknown): value is ProviderRemoteEvent['start'] {
  return value instanceof Temporal.ZonedDateTime
    || value instanceof Temporal.PlainDateTime
    || value instanceof Temporal.PlainDate
}

/** Validate the vendor's mapped shape before any field is trusted or written to D1. */
function isProviderRemoteEvent(value: unknown): value is ProviderRemoteEvent {
  if (!isRecord(value) || !isProviderTemporal(value.start) || !isProviderTemporal(value.end)) return false
  if (value.meta !== undefined && !isRecord(value.meta)) return false
  if (value.task !== undefined && value.task !== null && !isRecord(value.task)) return false
  if (isRecord(value.task) && value.task.completedAt != null && !(value.task.completedAt instanceof Temporal.ZonedDateTime)) {
    return false
  }
  return value.conference === undefined || value.conference === null || isRecord(value.conference)
}

function validateProviderSyncResult(
  value: unknown,
  source: CalendarSource,
): { events: unknown[]; deleted: Array<string | CalDAVDeletedEvent>; token?: string } {
  if (!isRecord(value) || !Array.isArray(value.events) || !Array.isArray(value.deleted)) {
    throw new Error(`${source} sync result must contain events and deleted arrays`)
  }
  const tokenKey = source === 'outlook' ? 'deltaToken' : 'syncToken'
  const rawToken = value[tokenKey]
  if (rawToken !== undefined && (
    typeof rawToken !== 'string'
    || !rawToken.trim()
    || rawToken.length > MAX_PROVIDER_SYNC_TOKEN_CHARS
  )) {
    throw new Error(`${source} sync result has an invalid ${tokenKey}`)
  }
  const deleted: Array<string | CalDAVDeletedEvent> = []
  for (const ref of value.deleted) {
    if (source === 'caldav') {
      if (!isRecord(ref)
        || typeof ref.calendarId !== 'string'
        || typeof ref.href !== 'string'
        || (ref.uid !== undefined && typeof ref.uid !== 'string')) {
        throw new Error('caldav sync result has an invalid deleted event')
      }
      deleted.push(ref as unknown as CalDAVDeletedEvent)
    } else {
      if (typeof ref !== 'string' || !ref) throw new Error(`${source} sync result has an invalid deleted event`)
      deleted.push(ref)
    }
  }
  return {
    events: value.events,
    deleted,
    ...(typeof rawToken === 'string' ? { token: rawToken } : {}),
  }
}

function validMappedEvents(events: readonly unknown[], source: CalendarSource, calendarId: string): ProviderRemoteEvent[] {
  const valid: ProviderRemoteEvent[] = []
  events.forEach((event, index) => {
    if (!isProviderRemoteEvent(event)) {
      console.warn('[inkstone] Provider event skipped:', { provider: source, calendarId, index, reason: 'invalid mapped event' })
      return
    }
    valid.push(event)
  })
  return valid
}

function isCalDAVEventData(value: unknown): value is CalDAVEventData {
  return isRecord(value)
    && typeof value.calendarId === 'string'
    && typeof value.uid === 'string'
    && typeof value.href === 'string'
    && typeof value.icalData === 'string'
    && (value.etag === undefined || typeof value.etag === 'string')
}

async function providerEventInput(
  event: ProviderRemoteEvent,
  source: CalendarSource,
  localCalendarId: string,
): Promise<(CalendarEventInput & { attendees?: CalendarAttendeeDto[] }) | null> {
  const rawId = providerId(event, source)
  if (!rawId) return null
  const meta = cleanMeta(event.meta)
  return {
    title: typeof event.title === 'string' ? event.title.trim() || 'Untitled' : 'Untitled',
    description: typeof event.description === 'string' ? event.description : '',
    kind: event.kind === 'task' ? 'task' : 'event',
    task: taskFor(event),
    conference: conferenceFor(event),
    start: toTemporalValue(event.start),
    end: toTemporalValue(event.end),
    allDay: typeof event.allDay === 'boolean' ? event.allDay : event.start instanceof Temporal.PlainDate,
    calendarId: localCalendarId,
    calendarIds: [localCalendarId],
    meta,
    attendees: normalizeEventAttendees(meta.attendees),
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
  const store = new CalendarStore(env.DB, userId)
  let deleted = 0
  for (let index = 0; index < externalIds.length; index += 60) {
    const ids = externalIds.slice(index, index + 60)
    const placeholders = ids.map((_, offset) => `?${offset + 4}`).join(', ')
    const { results } = await env.DB.prepare(
      `SELECT id FROM calendar_events
        WHERE user_id = ?1 AND calendar_source = ?2 AND external_scope = ?3
          AND external_id IN (${placeholders})`,
    ).bind(userId, source, localCalendarId, ...ids).all<{ id: string }>()
    deleted += await store.removeEventMembershipsAndDeleteOrphans(
      localCalendarId,
      (results ?? []).map(row => row.id),
    )
  }
  return deleted
}

async function deleteCalDAVEventsByHref(
  env: Env,
  userId: string,
  localCalendarId: string,
  refs: readonly CalDAVDeletedEvent[],
): Promise<number> {
  const hrefs = [...new Set(refs.map(ref => ref.href).filter(Boolean))]
  const store = new CalendarStore(env.DB, userId)
  let deleted = 0
  for (let index = 0; index < hrefs.length; index += 60) {
    const chunk = hrefs.slice(index, index + 60)
    const placeholders = chunk.map((_, offset) => `?${offset + 3}`).join(', ')
    const { results } = await env.DB.prepare(
      `SELECT id FROM calendar_events
        WHERE user_id = ?1 AND calendar_source = 'caldav' AND external_scope = ?2
          AND json_extract(meta_json, '$.caldav.href') IN (${placeholders})`,
    ).bind(userId, localCalendarId, ...chunk).all<{ id: string }>()
    deleted += await store.removeEventMembershipsAndDeleteOrphans(
      localCalendarId,
      (results ?? []).map(row => row.id),
    )
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
  const baseUrl = calendarConnectionBase(env, connection)
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
      let mapped: ProviderRemoteEvent[] = []
      let deletedRefs: Array<string | CalDAVDeletedEvent> = []
      let token: string | undefined
      const incremental = Boolean(mapping.sync_token)
      switch (connection.kind) {
        case 'caldav': {
          const adapter = createCalDAVAdapter({ calendarHomeUrl: baseUrl, fetch: fetchImpl })
          const result = validateProviderSyncResult(
            await adapter.syncEvents({
              calendarId: mapping.remote_calendar_id,
              range: incremental ? undefined : { start: rangeStart, end: rangeEnd },
              syncToken: mapping.sync_token ?? undefined,
            }),
            connection.kind,
          )
          token = result.token
          mapped = []
          result.events.forEach((data, index) => {
            if (!isCalDAVEventData(data)) {
              console.warn('[inkstone] Provider event skipped:', {
                provider: connection.kind, calendarId: mapping.remote_calendar_id, index, reason: 'invalid CalDAV resource',
              })
              return
            }
            try {
              const event = mapCalDAVEventToDayFlow(data)
              if (event) mapped.push(event as unknown as ProviderRemoteEvent)
              else console.warn('[inkstone] Provider event skipped:', {
                provider: connection.kind, calendarId: mapping.remote_calendar_id, index, reason: 'unmappable VEVENT',
              })
            } catch (error) {
              console.warn('[inkstone] Provider event skipped:', {
                provider: connection.kind, calendarId: mapping.remote_calendar_id, index,
                error: error instanceof Error ? error.message : error,
              })
            }
          })
          mapped = validMappedEvents(mapped, connection.kind, mapping.remote_calendar_id)
          deletedRefs = result.deleted
          break
        }
        case 'google': {
          const sync = createGoogleSync(createGoogleSyncAdapter({ fetch: fetchImpl }))
          const result = validateProviderSyncResult(
            await sync.syncEvents(
              mapping.remote_calendar_id,
              incremental ? undefined : { start: rangeStart.toISOString(), end: rangeEnd.toISOString() },
              mapping.sync_token ?? undefined,
            ),
            connection.kind,
          )
          mapped = validMappedEvents(result.events, connection.kind, mapping.remote_calendar_id)
          deletedRefs = result.deleted
          token = result.token
          break
        }
        case 'outlook': {
          const sync = createOutlookSync(createOutlookSyncAdapter({ baseUrl, fetch: fetchImpl }))
          const result = validateProviderSyncResult(
            await sync.syncEvents(
              mapping.remote_calendar_id,
              incremental ? undefined : { start: rangeStart.toISOString(), end: rangeEnd.toISOString() },
              mapping.sync_token ?? undefined,
            ),
            connection.kind,
          )
          mapped = validMappedEvents(result.events, connection.kind, mapping.remote_calendar_id)
          deletedRefs = result.deleted
          token = result.token
          break
        }
        default:
          assertCalendarConnectionKind(connection.kind)
      }
      const inputs = []
      const keepExternalIds = new Set<string>()
      for (const [index, event] of mapped.entries()) {
        try {
          const input = await providerEventInput(event, connection.kind, mapping.local_calendar_id)
          if (!input) continue
          const parsed = parseEventInput(input, { defaultTimeZone: timeZone })
          inputs.push(parsed)
          if (parsed.externalId) keepExternalIds.add(parsed.externalId)
        } catch (error) {
          console.warn('[inkstone] Provider event skipped:', {
            provider: connection.kind, calendarId: mapping.remote_calendar_id, index,
            error: error instanceof Error ? error.message : error,
          })
        }
      }
      for (let index = 0; index < inputs.length; index += PROVIDER_EVENT_CHUNK) {
        const chunk = inputs.slice(index, index + PROVIDER_EVENT_CHUNK)
        const created = await store.createEvents(chunk, 'upsert')
        events += created.length
        for (const event of created) {
          await syncProjectCardForCalendarEvent(env.DB, userId, event.id).catch((error: unknown) => {
            console.warn('[inkstone] Provider-to-project calendar sync failed:', error instanceof Error ? error.message : error)
          })
        }
      }
      const rawDeleted = deletedRefs.map(ref => typeof ref === 'string'
        ? ref
        : (ref.uid ?? ref.href))
      const externalIds = []
      for (const raw of rawDeleted) {
        if (raw) externalIds.push(await externalIdFor(raw))
      }
      if (connection.kind === 'caldav') {
        deleted += await deleteCalDAVEventsByHref(
          env, userId, mapping.local_calendar_id,
          deletedRefs.filter((ref): ref is CalDAVDeletedEvent => typeof ref !== 'string'),
        )
      }
      deleted += await deleteProviderEvents(env, userId, mapping.local_calendar_id, connection.kind, externalIds)
      // A delta names changes, not the complete remote calendar. Absence from it is never a deletion.
      if (!incremental) {
        deleted += await mirrorProviderCalendar(
          env,
          userId,
          mapping.local_calendar_id,
          connection.kind,
          keepExternalIds,
          rangeStart.getTime(),
          rangeEnd.getTime(),
        )
      }
      await env.DB.prepare(
        `UPDATE calendar_provider_calendars
            SET last_sync_at = ?4, sync_token = COALESCE(?5, sync_token),
                last_error_code = NULL, updated_at = ?4
          WHERE user_id = ?1 AND connection_id = ?2 AND remote_calendar_id = ?3`,
      ).bind(userId, connection.id, mapping.remote_calendar_id, now, token ?? null).run()
    } catch (error) {
      failed += 1
      console.warn('[inkstone] Provider calendar sync failed:', {
        connection: connection.id,
        calendar: mapping.remote_calendar_id,
        error: error instanceof Error ? error.message : error,
      })
      await env.DB.prepare(
        `UPDATE calendar_provider_calendars
            SET last_sync_at = ?4, last_error_code = ?5, updated_at = ?4
          WHERE user_id = ?1 AND connection_id = ?2 AND remote_calendar_id = ?3`,
      ).bind(userId, connection.id, mapping.remote_calendar_id, now, 'sync_failed').run()
    }
  }
  return { events, deleted, failed }
}

export async function syncDueProviderConnections(
  env: Env,
  now = Date.now(),
): Promise<ProviderSyncResult> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT m.connection_id, m.user_id
       FROM calendar_provider_calendars m
       JOIN calendar_connections c
         ON c.user_id = m.user_id AND c.id = m.connection_id
      WHERE c.status IN ('connected', 'error')
        AND (m.last_sync_at IS NULL OR m.last_sync_at <= ?1)
      ORDER BY m.last_sync_at ASC
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
        status: result.failed > 0 ? 'error' : 'connected',
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
