/**
 * The calendar app's HTTP surface.
 *
 * Static paths are registered before `/:id` because Hono matches in registration order. Everything
 * below `use` requires a session, every mutating method spends the caller's write budget, and every
 * query goes through `CalendarStore`, which scopes by the account the session named. A malformed id
 * is a 400 and an id this account does not own is a 404, never a 403 that confirms an id exists.
 *
 * Validation lives in `calendar/validation.ts` and SQL in `calendar/store.ts`; this file only reads
 * the request, names the operation and shapes the response.
 */

import { Hono, type Context } from 'hono'
import { MAX_CALENDAR_NAME, MAX_EVENTS_PER_BATCH, isSharedCalendarId, parseSharedCalendarId, sharedCalendarId, temporalValueToEpochMs } from '@shared/calendar/model'
import type { CalendarEventDto } from '@shared/calendar/model'
import type { AppBindings } from '../env'
import { CalendarStore } from '../calendar/store'
import { listEventAttachments } from '../calendar/attachments'
import { expandRecurringEvents } from '../calendar/ics'
import {
  parseCalendarIdList,
  parseCalendarInput,
  parseCalendarPatch,
  parseEntityId,
  parseEventInput,
  parseEventPatch,
  parseGroupInput,
  parseGroupPatch,
  parseAttendeeList,
  parsePreferences,
  parseReminderMinutes,
  parseRange,
  parseRecurrenceChange,
  parseReorder,
  parseRevQuery,
} from '../calendar/validation'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { clampInt, JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'

type Ctx = Context<AppBindings>

/** Enough for a fast client dragging events and checking boxes. */
export const CALENDAR_WRITE_BUDGET_PER_MINUTE = 120

const writeBudget = createMinuteBudget(CALENDAR_WRITE_BUDGET_PER_MINUTE, 'Too many calendar changes at once. Try again in a minute.')
/** A search box and range navigation are cheap; a scripted loop is not. */
const readBudget = createMinuteBudget(240, 'Too many calendar reads at once. Try again in a minute.')

/** A single event can carry a 20k description and a 16 KiB meta object. */
const EVENT_BODY_LIMIT = 64 * 1024
/** The plan's ceiling for one batch request: 200 events, or roughly 1 MiB of JSON. */
const BATCH_BODY_LIMIT = 1024 * 1024
const ORDER_BODY_LIMIT = 32 * 1024
const SEARCH_QUERY_MAX = 100

export const calendarRoutes = new Hono<AppBindings>()

calendarRoutes.use('*', requireAuth)

calendarRoutes.use('*', async (c, next) => {
  const method = c.req.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') writeBudget(c.get('userId'))
  await next()
})

function store(c: Ctx): CalendarStore {
  return new CalendarStore(c.env.DB, c.get('userId'))
}

function pathId(c: Ctx): string {
  return parseEntityId(c.req.param('id'), 'id')
}

function noContent(c: Ctx): Response {
  return c.body(null, 204)
}

interface SharedWriterTarget {
  ownerId: string
  store: CalendarStore
  /** Raw ids in the owner's own namespace. */
  calendarIds: string[]
}

/**
 * A write a guest points at a synthetic shared calendar id.
 *
 * Every named calendar must belong to the same owner and every membership must say writer; a reader
 * gets the same 403 an owner's read-only calendar gets. Mixing a guest's own calendar with a shared
 * one is refused because the response DTO cannot name two different owners in one id.
 */
async function sharedWriterIds(c: Ctx, ids: readonly string[]): Promise<SharedWriterTarget> {
  const parsed = ids.map(id => parseSharedCalendarId(id))
  if (parsed.some(entry => entry === null)) {
    throw ApiError.badRequest('A shared write cannot mix shared and owned calendars')
  }
  const owners = new Set(parsed.map(entry => entry!.ownerId))
  if (owners.size !== 1) throw ApiError.badRequest('A shared write must name one owner')
  const ownerId = [...owners][0]!
  const raw = parsed.map(entry => entry!.calendarId)
  const writable = await new CalendarStore(c.env.DB, c.get('userId')).sharedWriterCalendarIds(ownerId, raw)
  if (raw.some(calendarId => !writable.has(calendarId))) {
    throw ApiError.forbidden('The shared calendar is read-only for this account')
  }
  return { ownerId, store: new CalendarStore(c.env.DB, ownerId), calendarIds: raw }
}

function sharedEventDto(ownerId: string, event: CalendarEventDto): CalendarEventDto {
  return {
    ...event,
    id: sharedCalendarId(ownerId, event.id),
    calendarId: sharedCalendarId(ownerId, event.calendarId),
    calendarIds: event.calendarIds.map(calendarId => sharedCalendarId(ownerId, calendarId)),
  }
}

/** Rewrite synthetic calendar ids in a create/patch body before validation sees them. */
async function prepareSharedWrite(
  c: Ctx,
  body: Record<string, unknown>,
): Promise<{ body: Record<string, unknown>; target: SharedWriterTarget | null }> {
  const named = Array.isArray(body.calendarIds)
    ? body.calendarIds.filter((id): id is string => typeof id === 'string')
    : typeof body.calendarId === 'string' ? [body.calendarId] : []
  if (!named.some(isSharedCalendarId)) return { body, target: null }
  if (named.some(id => !isSharedCalendarId(id))) {
    throw ApiError.badRequest('A shared write cannot mix shared and owned calendars')
  }
  const target = await sharedWriterIds(c, named)
  const rawIds = target.calendarIds
  const next = { ...body }
  if (Array.isArray(body.calendarIds)) next.calendarIds = rawIds
  if (typeof body.calendarId === 'string') next.calendarId = rawIds[0]
  return { body: next, target }
}

async function sharedEventTarget(c: Ctx, id: string): Promise<{ ownerId: string; store: CalendarStore; eventId: string; event: CalendarEventDto } | null> {
  const parsed = parseSharedCalendarId(id)
  if (!parsed) return null
  const store = new CalendarStore(c.env.DB, parsed.ownerId)
  const event = await store.getEvent(parsed.calendarId)
  if (!event) return null
  const target = await sharedWriterIds(c, event.calendarIds.map(calendarId => sharedCalendarId(parsed.ownerId, calendarId)))
  return { ownerId: parsed.ownerId, store: target.store, eventId: event.id, event }
}

async function fallbackTimeZone(s: CalendarStore): Promise<string> {
  return (await s.preferences()).timeZone
}

// ------------------------------------------------------------- meta and preferences

calendarRoutes.get('/meta', async (c) => {
  const requested = c.req.query('defaultName')?.trim()
  const defaultName = requested
    && requested.length <= MAX_CALENDAR_NAME
    && !/[\u0000-\u001f\u007f]/.test(requested)
    ? requested
    : undefined
  return c.json(await store(c).meta(defaultName))
})

calendarRoutes.get('/preferences', async (c) => {
  return c.json({ preferences: await store(c).preferences() })
})

calendarRoutes.put('/preferences', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  // Accept both `{preferences: {...}}` and a bare preferences object. The wrapper exists because a
  // GET answers with it; unwrapping keeps old clients and the obvious PUT body working.
  const raw = body.preferences !== undefined && typeof body.preferences === 'object' && !Array.isArray(body.preferences)
    ? body.preferences
    : body
  const preferences = parsePreferences(raw)
  return c.json({ preferences: await store(c).savePreferences(preferences) })
})

// ------------------------------------------------------------- events

/**
 * Busy blocks across the calendars this account can read.
 *
 * Titles and descriptions never leave the store here: a shared calendar reveals that its owner is
 * busy, not what they are doing. The client turns these blocks into free windows itself.
 */
calendarRoutes.get('/free-busy', async (c) => {
  readBudget(c.get('userId'))
  const range = parseRange(c.req.query('from'), c.req.query('to'))
  const calendarIds = parseCalendarIdList(c.req.query('calendarIds'))
  const s = store(c)
  const result = await s.listEvents(range.fromMs, range.toMs, calendarIds)
  const timeZone = await fallbackTimeZone(s)
  const expansion = expandRecurringEvents(result.events, range.fromMs, range.toMs, timeZone)
  const seen = new Set<string>()
  const busy = [...result.events, ...expansion.occurrences]
    .filter(event => event.kind !== 'task')
    .flatMap(event => {
      const key = `${event.id}:${event.calendarId}:${event.start.value}`
      if (seen.has(key)) return []
      seen.add(key)
      return {
        calendarId: event.calendarId,
        startMs: temporalValueToEpochMs(event.start, timeZone),
        endMs: temporalValueToEpochMs(event.end, timeZone),
      }
    })
  return c.json({ busy, truncated: result.truncated || expansion.truncated })
})

calendarRoutes.get('/events/search', async (c) => {
  readBudget(c.get('userId'))
  const q = (c.req.query('q') ?? '').trim()
  if (q.length > SEARCH_QUERY_MAX) throw ApiError.badRequest(`q is longer than ${SEARCH_QUERY_MAX} characters`)
  const limit = clampInt(c.req.query('limit'), 1, 50, 20)
  const calendarIds = parseCalendarIdList(c.req.query('calendarIds'))
  const kindRaw = c.req.query('kind')
  if (kindRaw !== undefined && kindRaw !== 'event' && kindRaw !== 'task') {
    throw ApiError.badRequest('kind must be event or task')
  }
  let fromMs: number | undefined
  let toMs: number | undefined
  if (c.req.query('from') !== undefined || c.req.query('to') !== undefined) {
    const range = parseRange(c.req.query('from'), c.req.query('to'))
    fromMs = range.fromMs
    toMs = range.toMs
  }
  const hasExtraFilter = ['attendee', 'location', 'recurring', 'taskStatus']
    .some(key => c.req.query(key) !== undefined)
  if (!q && !calendarIds && kindRaw === undefined && fromMs === undefined && !hasExtraFilter) {
    throw ApiError.badRequest('q or a filter is required')
  }
  const attendee = (c.req.query('attendee') ?? '').trim()
  const location = (c.req.query('location') ?? '').trim()
  if (attendee.length > SEARCH_QUERY_MAX) throw ApiError.badRequest(`attendee is longer than ${SEARCH_QUERY_MAX} characters`)
  if (location.length > SEARCH_QUERY_MAX) throw ApiError.badRequest(`location is longer than ${SEARCH_QUERY_MAX} characters`)
  const recurringRaw = c.req.query('recurring')
  if (recurringRaw !== undefined && recurringRaw !== '1' && recurringRaw !== '0') {
    throw ApiError.badRequest('recurring must be 1 or 0')
  }
  const taskStatusRaw = c.req.query('taskStatus')
  if (taskStatusRaw !== undefined && taskStatusRaw !== 'open' && taskStatusRaw !== 'done') {
    throw ApiError.badRequest('taskStatus must be open or done')
  }
  const answer = await store(c).searchEvents(q, limit, {
    ...(calendarIds ? { calendarIds } : {}),
    ...(fromMs === undefined ? {} : { fromMs, toMs }),
    ...(kindRaw === undefined ? {} : { kind: kindRaw }),
    ...(attendee ? { attendee } : {}),
    ...(location ? { location } : {}),
    ...(recurringRaw === undefined ? {} : { recurring: recurringRaw === '1' }),
    ...(taskStatusRaw === undefined ? {} : { taskStatus: taskStatusRaw }),
  })
  return c.json(answer)
})

calendarRoutes.get('/events', async (c) => {
  readBudget(c.get('userId'))
  const range = parseRange(c.req.query('from'), c.req.query('to'))
  const calendarIds = parseCalendarIdList(c.req.query('calendarIds'))
  const s = store(c)
  const result = await s.listEvents(range.fromMs, range.toMs, calendarIds)
  const timeZone = await fallbackTimeZone(s)
  // The month view already expands recurring series in the library; asking the server to expand a
  // second copy is pure CPU and payload. Other views (and external clients) keep the default.
  const includeOccurrences = c.req.query('occurrences') !== '0'
  // A month view that only needs exception masters asks for exactly those; expanding every series
  // there would send the whole month back a second time.
  const occurrenceMasters = parseCalendarIdList(c.req.query('occurrenceMasters'))
  const expansion = includeOccurrences
    ? expandRecurringEvents(
        occurrenceMasters ? result.events.filter(event => occurrenceMasters.includes(event.id)) : result.events,
        range.fromMs,
        range.toMs,
        timeZone,
      )
    : { occurrences: [], truncated: false }
  return c.json({
    events: result.events,
    occurrences: expansion.occurrences,
    truncated: result.truncated,
    recurrenceTruncated: expansion.truncated,
    // Handed out with the rows so a client can remember what it holds without asking again; the probe
    // endpoint answers the same triple later.
    revision: await s.eventsRevision(range.fromMs, range.toMs, calendarIds),
  })
})

calendarRoutes.post('/events/batch', async (c) => {
  const body = await readJson<{ events?: unknown; mode?: unknown }>(c, BATCH_BODY_LIMIT)
  if (body.mode !== 'create' && body.mode !== 'upsert') {
    throw ApiError.badRequest('mode must be create or upsert')
  }
  if (!Array.isArray(body.events)) throw ApiError.badRequest('events must be an array')
  if (body.events.length === 0) throw ApiError.badRequest('events may not be empty')
  if (body.events.length > MAX_EVENTS_PER_BATCH) {
    throw ApiError.badRequest(`A batch may hold at most ${MAX_EVENTS_PER_BATCH} events`)
  }
  const s = store(c)
  const timeZone = await fallbackTimeZone(s)
  const prepared: Array<Record<string, unknown>> = []
  let shared: SharedWriterTarget | null = null
  for (const event of body.events) {
    const answer = await prepareSharedWrite(c, event as Record<string, unknown>)
    if (answer.target) {
      if (shared && shared.ownerId !== answer.target.ownerId) {
        throw ApiError.badRequest('A shared batch must name one owner')
      }
      shared = answer.target
    } else if (shared) {
      throw ApiError.badRequest('A shared batch cannot mix shared and owned calendars')
    }
    prepared.push(answer.body)
  }
  const inputs = prepared.map((event) => parseEventInput(event, { defaultTimeZone: timeZone }))
  const events = await (shared ? shared.store.createEvents(inputs, body.mode) : s.createEvents(inputs, body.mode))
  return c.json({ events: shared ? events.map(event => sharedEventDto(shared!.ownerId, event)) : events })
})

calendarRoutes.post('/events', async (c) => {
  const s = store(c)
  const timeZone = await fallbackTimeZone(s)
  const raw = await readJson<Record<string, unknown>>(c, EVENT_BODY_LIMIT)
  const prepared = await prepareSharedWrite(c, raw)
  const input = parseEventInput(prepared.body, { defaultTimeZone: timeZone })
  if (prepared.target) {
    const event = await prepared.target.store.createEvent(input)
    return c.json({ event: sharedEventDto(prepared.target.ownerId, event) })
  }
  return c.json({ event: await s.createEvent(input) })
})

/**
 * The fingerprint of a range, without the rows.
 *
 * Registered before `/events/:id`: Hono matches in order, and `revision` would otherwise arrive as an
 * event id.
 */
calendarRoutes.get('/events/revision', async (c) => {
  readBudget(c.get('userId'))
  const range = parseRange(c.req.query('from'), c.req.query('to'))
  const calendarIds = parseCalendarIdList(c.req.query('calendarIds'))
  return c.json({ revision: await store(c).eventsRevision(range.fromMs, range.toMs, calendarIds) })
})

calendarRoutes.get('/events/:id', async (c) => {
  readBudget(c.get('userId'))
  const id = pathId(c)
  const shared = await store(c).sharedEvent(id)
  if (shared) return c.json({ event: shared.event })
  const event = await store(c).getEvent(id)
  if (!event) throw ApiError.notFound('Event not found')
  return c.json({ event })
})

calendarRoutes.patch('/events/:id', async (c) => {
  const id = pathId(c)
  const s = store(c)
  const timeZone = await fallbackTimeZone(s)
  const target = await sharedEventTarget(c, id)
  const raw = await readJson<Record<string, unknown>>(c, EVENT_BODY_LIMIT)
  const prepared = await prepareSharedWrite(c, raw)
  const patch = parseEventPatch(prepared.body, { defaultTimeZone: timeZone })
  if (target) {
    if (patch.calendarIds && !patch.calendarIds.every(id => target.event.calendarIds.includes(id))) {
      throw ApiError.forbidden('A guest cannot move an event outside the shared calendars')
    }
    const event = await target.store.updateEvent(target.eventId, patch)
    return c.json({ event: sharedEventDto(target.ownerId, event) })
  }
  return c.json({ event: await s.updateEvent(id, patch) })
})

calendarRoutes.post('/events/:id/recurrence', async (c) => {
  const id = pathId(c)
  const s = store(c)
  const timeZone = await fallbackTimeZone(s)
  const target = await sharedEventTarget(c, id)
  const raw = await readJson<Record<string, unknown>>(c, EVENT_BODY_LIMIT)
  // A recurrence write is a PATCH of the master in disguise: its patch can name calendars, and those
  // have to be rewritten to the owner's raw ids before validation, exactly as the PATCH route does.
  let body = raw
  if (target && raw.patch && typeof raw.patch === 'object' && !Array.isArray(raw.patch)) {
    const prepared = await prepareSharedWrite(c, raw.patch as Record<string, unknown>)
    body = { ...raw, patch: prepared.body }
  }
  const change = parseRecurrenceChange(body, { defaultTimeZone: timeZone })
  if (target) {
    if (change.patch?.calendarIds && !change.patch.calendarIds.every(calendarId => target.event.calendarIds.includes(calendarId))) {
      throw ApiError.forbidden('A guest cannot move an event outside the shared calendars')
    }
    const answer = await target.store.applyRecurrenceChange(target.eventId, change)
    return c.json({
      masterId: answer.masterId === null ? null : sharedCalendarId(target.ownerId, answer.masterId),
    })
  }
  return c.json(await s.applyRecurrenceChange(id, change))
})

calendarRoutes.delete('/events/:id', async (c) => {
  const id = pathId(c)
  const rev = parseRevQuery(c.req.query('rev'))
  if (rev === null) throw ApiError.badRequest('rev is required')
  const target = await sharedEventTarget(c, id)
  if (target) await target.store.deleteEvent(target.eventId, rev)
  else await store(c).deleteEvent(id, rev)
  return noContent(c)
})

calendarRoutes.get('/events/:id/extras', async (c) => {
  readBudget(c.get('userId'))
  const id = pathId(c)
  const s = store(c)
  const shared = await s.sharedEvent(id)
  if (shared) {
    const owner = new CalendarStore(c.env.DB, shared.ownerId)
    const [reminders, attendees, attachments] = await Promise.all([
      owner.eventReminders([shared.eventId]),
      owner.eventAttendees(shared.eventId),
      listEventAttachments(c.env.DB, shared.ownerId, shared.eventId),
    ])
    return c.json({ event: shared.event, reminders: reminders.get(shared.eventId) ?? [], attendees, attachments })
  }
  const event = await s.getEvent(id)
  if (!event) throw ApiError.notFound('Event not found')
  const [reminders, attendees, attachments] = await Promise.all([
    s.eventReminders([id]),
    s.eventAttendees(id),
    listEventAttachments(c.env.DB, c.get('userId'), id),
  ])
  return c.json({ event, reminders: reminders.get(id) ?? [], attendees, attachments })
})

calendarRoutes.post('/events/:id/snooze', async (c) => {
  const id = pathId(c)
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const minutes = body.minutes
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw ApiError.badRequest('minutes must be a whole number between 1 and 1440')
  }
  return c.json(await store(c).snoozeEvent(id, minutes))
})

calendarRoutes.get('/events/:id/reminders', async (c) => {
  readBudget(c.get('userId'))
  const id = pathId(c)
  const s = store(c)
  if (!(await s.getEvent(id))) throw ApiError.notFound('Event not found')
  const found = await s.eventReminders([id])
  return c.json({ minutes: found.get(id) ?? [] })
})
calendarRoutes.put('/events/:id/reminders', async (c) => {
  const id = pathId(c)
  const target = await sharedEventTarget(c, id)
  const body = parseReminderMinutes(await readJson<unknown>(c, JSON_BODY_LIMITS.small))
  const answer = target
    ? await target.store.setEventReminders(target.eventId, body.minutes, body.rev)
    : await store(c).setEventReminders(id, body.minutes, body.rev)
  return c.json(target ? { ...answer, event: sharedEventDto(target.ownerId, answer.event) } : answer)
})

calendarRoutes.get('/events/:id/attendees', async (c) => {
  readBudget(c.get('userId'))
  const id = pathId(c)
  const s = store(c)
  if (!(await s.getEvent(id))) throw ApiError.notFound('Event not found')
  return c.json({ attendees: await s.eventAttendees(id) })
})

calendarRoutes.put('/events/:id/attendees', async (c) => {
  const id = pathId(c)
  const target = await sharedEventTarget(c, id)
  const body = parseAttendeeList(await readJson<unknown>(c, JSON_BODY_LIMITS.small))
  const answer = target
    ? await target.store.setEventAttendees(target.eventId, body.attendees, body.rev)
    : await store(c).setEventAttendees(id, body.attendees, body.rev)
  return c.json(target ? { ...answer, event: sharedEventDto(target.ownerId, answer.event) } : answer)
})

// ------------------------------------------------------------- calendars

calendarRoutes.post('/calendars', async (c) => {
  const input = parseCalendarInput(await readJson<unknown>(c, JSON_BODY_LIMITS.small))
  return c.json({ calendar: await store(c).createCalendar(input) })
})

calendarRoutes.put('/calendars/order', async (c) => {
  const ids = parseReorder(await readJson<unknown>(c, ORDER_BODY_LIMIT))
  await store(c).reorderCalendars(ids)
  return noContent(c)
})

calendarRoutes.patch('/calendars/:id', async (c) => {
  const id = pathId(c)
  const patch = parseCalendarPatch(await readJson<unknown>(c, JSON_BODY_LIMITS.small))
  return c.json({ calendar: await store(c).updateCalendar(id, patch) })
})

calendarRoutes.delete('/calendars/:id', async (c) => {
  const id = pathId(c)
  const mode = c.req.query('mode')
  if (mode !== 'merge' && mode !== 'delete') {
    throw ApiError.badRequest('mode must be merge or delete')
  }
  const targetId = mode === 'merge'
    ? parseEntityId(c.req.query('targetId'), 'targetId')
    : null
  await store(c).deleteCalendar(id, {
    mode,
    targetId,
    rev: parseRevQuery(c.req.query('rev')),
  })
  return noContent(c)
})

// ------------------------------------------------------------- groups

calendarRoutes.post('/groups', async (c) => {
  const input = parseGroupInput(await readJson<unknown>(c, JSON_BODY_LIMITS.small))
  return c.json({ group: await store(c).createGroup(input) })
})

calendarRoutes.put('/groups/order', async (c) => {
  const ids = parseReorder(await readJson<unknown>(c, ORDER_BODY_LIMIT))
  await store(c).reorderGroups(ids)
  return noContent(c)
})

calendarRoutes.patch('/groups/:id', async (c) => {
  const id = pathId(c)
  const { name } = parseGroupPatch(await readJson<unknown>(c, JSON_BODY_LIMITS.small))
  return c.json({ group: await store(c).renameGroup(id, name) })
})

calendarRoutes.delete('/groups/:id', async (c) => {
  await store(c).deleteGroup(pathId(c))
  return noContent(c)
})
