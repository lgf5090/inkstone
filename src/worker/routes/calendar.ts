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
import { MAX_EVENTS_PER_BATCH } from '@shared/calendar/model'
import type { AppBindings } from '../env'
import { CalendarStore } from '../calendar/store'
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
  parsePreferences,
  parseRange,
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

async function fallbackTimeZone(s: CalendarStore): Promise<string> {
  return (await s.preferences()).timeZone
}

// ------------------------------------------------------------- meta and preferences

calendarRoutes.get('/meta', async (c) => {
  return c.json(await store(c).meta())
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
  if (!q && !calendarIds && kindRaw === undefined && fromMs === undefined) {
    throw ApiError.badRequest('q or a filter is required')
  }
  const answer = await store(c).searchEvents(q, limit, {
    ...(calendarIds ? { calendarIds } : {}),
    ...(fromMs === undefined ? {} : { fromMs, toMs }),
    ...(kindRaw === undefined ? {} : { kind: kindRaw }),
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
  const expansion = expandRecurringEvents(result.events, range.fromMs, range.toMs, timeZone)
  return c.json({
    events: result.events,
    occurrences: expansion.occurrences,
    truncated: result.truncated,
    recurrenceTruncated: expansion.truncated,
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
  const inputs = body.events.map((event) => parseEventInput(event, { defaultTimeZone: timeZone }))
  return c.json({ events: await s.createEvents(inputs, body.mode) })
})

calendarRoutes.post('/events', async (c) => {
  const s = store(c)
  const timeZone = await fallbackTimeZone(s)
  const input = parseEventInput(await readJson<unknown>(c, EVENT_BODY_LIMIT), { defaultTimeZone: timeZone })
  return c.json({ event: await s.createEvent(input) })
})

calendarRoutes.patch('/events/:id', async (c) => {
  const id = pathId(c)
  const s = store(c)
  const timeZone = await fallbackTimeZone(s)
  const patch = parseEventPatch(await readJson<unknown>(c, EVENT_BODY_LIMIT), { defaultTimeZone: timeZone })
  return c.json({ event: await s.updateEvent(id, patch) })
})

calendarRoutes.delete('/events/:id', async (c) => {
  const id = pathId(c)
  const rev = parseRevQuery(c.req.query('rev'))
  if (rev === null) throw ApiError.badRequest('rev is required')
  await store(c).deleteEvent(id, rev)
  return noContent(c)
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
