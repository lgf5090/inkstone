/**
 * The calendar tools the assistant can call.
 *
 * Every tool here goes through `CalendarStore`, which owns the account scoping, the read-only rule and
 * the revision check; nothing in this file builds SQL or trusts a calendar id the model made up. Times
 * arrive as the reader's wall clock ("2026-11-04T15:00") and are placed on the timeline with the
 * account's calendar time zone, because a meeting typed in Shanghai must not land an hour off in a
 * browser set to another zone.
 *
 * A repeating event is listed as both its series and the occurrences inside the queried range. An
 * occurrence id carries its series and start (`<id>::repeat-<startMs>`), so moving or deleting one
 * answers through `applyRecurrenceChange` with the "this occurrence" scope instead of silently
 * rewriting the whole series.
 */

import { Temporal } from 'temporal-polyfill'
import {
  CALENDAR_RANGE_MAX_MS,
  isSharedCalendarId,
  parseSharedCalendarId,
  sharedCalendarId,
  temporalValueToEpochMs,
  type CalendarDto,
  type CalendarEventDto,
  type CalendarEventKind,
  type TemporalValue,
} from '@shared/calendar/model'
import { parseLocalTime, toLocalMinute } from '@shared/assistant-time'
import { expandRecurringEvents } from '../calendar/ics'
import { CalendarStore } from '../calendar/store'
import { parseEventInput, parseEventPatch } from '../calendar/validation'
import { ApiError } from '../lib/errors'
import { ToolError, type FieldSpec, type PreparedTarget, type ToolContext, type ToolDefinition } from './tools'

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/
const MINUTE_TEXT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/
const OCCURRENCE_MARK = '::repeat-'
const DEFAULT_EVENT_MINUTES = 60
const DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_LISTED_EVENTS = 200
const MAX_SLOT_RESULTS = 20
const MAX_DATE_RANGE_DAYS = 62

/** A local date or local minute, as the model writes it. */
const localDateField = (description: string, optional = true): FieldSpec => ({
  type: 'string',
  description: `${description} Local to the reader: YYYY-MM-DD, or YYYY-MM-DDTHH:MM for a time.`,
  maxLength: 32,
  ...(optional ? { optional: true } : {}),
})

const CALENDAR_ID_FIELD: FieldSpec = {
  type: 'string',
  description: 'Calendar id from calendar_list_calendars. Omit to use the default calendar.',
  maxLength: 64,
  optional: true,
}

const CALENDAR_IDS_FIELD: FieldSpec = {
  type: 'array',
  description: 'Calendar ids to include or create the event in. Omit to use the default calendar.',
  items: 'string',
  maxItems: 20,
  optional: true,
}

interface WriteTarget {
  store: CalendarStore
  calendarIds: string[]
  /** Set on a shared write: the synthetic ids the reader sees, mapped back to the owner's raw ids. */
  ownerId?: string
}

interface FoundEvent {
  store: CalendarStore
  event: CalendarEventDto
  /** The id the model was given: an own id, a shared synthetic id, or an occurrence id. */
  visibleId: string
  /** The id the owning store's methods take. */
  rawId: string
  /** Set when `visibleId` names one occurrence of a series. */
  occurrenceStartMs?: number
}

interface CalendarIndex {
  calendars: CalendarDto[]
  byId: Map<string, CalendarDto>
}

function storeOf(ctx: ToolContext): CalendarStore {
  return new CalendarStore(ctx.env.DB, ctx.store.userId)
}

/** Store calls answer with `ApiError` for a refusal; the model reads a tool error, not an HTTP status. */
async function ask<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ToolError) throw error
    if (error instanceof ApiError) throw new ToolError(error.message)
    throw error
  }
}

function assertTimeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    throw new ToolError(`"${zone}" is not a known time zone.`)
  }
}

async function zoneOf(ctx: ToolContext, requested?: unknown): Promise<string> {
  if (typeof requested === 'string' && requested.trim()) return assertTimeZone(requested.trim())
  const preferences = await ask(() => storeOf(ctx).preferences())
  return preferences.timeZone || assertTimeZone(ctx.timezone)
}

async function calendarIndex(ctx: ToolContext): Promise<CalendarIndex> {
  const meta = await ask(() => storeOf(ctx).meta())
  const calendars = meta.calendars
  return { calendars, byId: new Map(calendars.map((calendar) => [calendar.id, calendar])) }
}

function calendarNameFor(calendarId: string, index: CalendarIndex): string {
  const direct = index.byId.get(calendarId)
  if (direct) return direct.name
  const raw = parseSharedCalendarId(calendarId)?.calendarId
  if (raw) {
    for (const calendar of index.calendars) {
      if (isSharedCalendarId(calendar.id) && parseSharedCalendarId(calendar.id)?.calendarId === raw) {
        return calendar.name
      }
    }
  }
  return calendarId
}

function fullDateText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ToolError(`"${field}" must be text.`)
  const text = value.trim()
  let day: string | null = null
  if (DATE_TEXT.test(text)) day = text
  else if (MINUTE_TEXT.test(text)) day = text.slice(0, 10)
  if (!day) throw new ToolError(`"${field}" must be YYYY-MM-DD or YYYY-MM-DDTHH:MM.`)
  try {
    Temporal.PlainDate.from(day)
  } catch {
    throw new ToolError(`"${field}" is not a real calendar date.`)
  }
  return day
}

function minuteMs(value: string, zone: string): number {
  const parsed = parseLocalTime(value, zone)
  if (parsed === null) throw new ToolError(`Could not understand the time "${value.slice(0, 40)}".`)
  return parsed
}

function dayStartMs(day: string, zone: string): number {
  return minuteMs(`${day}T00:00`, zone)
}

function zonedValue(instantMs: number, zone: string): TemporalValue {
  const value = Temporal.Instant.fromEpochMilliseconds(instantMs).toZonedDateTimeISO(zone)
  return { type: 'zoned', value: value.toString({ smallestUnit: 'minute' }), timeZone: zone }
}

function dateValue(day: string): TemporalValue {
  return { type: 'date', value: day }
}

interface Timeline {
  start: TemporalValue
  end: TemporalValue
  allDay: boolean
  startMs: number
  endMs: number
}

/**
 * One start/end pair as the calendar stores it.
 *
 * A start with no time, and an end with no time, is an all-day event; `allDay` overrides that. A
 * timed start with no end keeps the caller's duration, or the hour an ordinary meeting takes.
 */
function timelineFrom(
  startValue: unknown,
  endValue: unknown,
  durationMinutes: unknown,
  allDayFlag: unknown,
  zone: string,
): Timeline {
  if (typeof startValue !== 'string' || !startValue.trim()) throw new ToolError('"start" must be text.')
  const startText = startValue.trim()
  const endText = typeof endValue === 'string' && endValue.trim() ? endValue.trim() : null
  const startIsDate = DATE_TEXT.test(startText)
  const endIsDate = endText === null ? startIsDate : DATE_TEXT.test(endText)
  const allDay = allDayFlag === true || (allDayFlag !== false && startIsDate && endIsDate)
  const duration = durationMinutes === undefined ? null : Number(durationMinutes)
  if (duration !== null && (!Number.isFinite(duration) || duration < 1)) {
    throw new ToolError('"durationMinutes" must be a positive number.')
  }
  if (allDay) {
    const startDay = fullDateText(startText, 'start')
    let endDay: string | null = endText ? fullDateText(endText, 'end') : null
    let days = duration === null ? 1 : Math.max(1, Math.ceil(duration / 1440))
    if (endDay) {
      // The stored end is exclusive, so an end the reader names as the same day still means one day.
      const span = Temporal.PlainDate.from(startDay).until(Temporal.PlainDate.from(endDay)).days
      if (span > 0) days = span
    }
    endDay = Temporal.PlainDate.from(startDay).add({ days }).toString()
    return {
      start: dateValue(startDay),
      end: dateValue(endDay),
      allDay: true,
      startMs: dayStartMs(startDay, zone),
      endMs: dayStartMs(endDay, zone),
    }
  }
  const startMs = minuteMs(startIsDate ? `${startText}T09:00` : startText, zone)
  const resolvedEndMs = endText
    ? minuteMs(DATE_TEXT.test(endText) ? `${endText}T23:59` : endText, zone)
    : startMs + (duration === null ? DEFAULT_EVENT_MINUTES : duration) * 60_000
  if (resolvedEndMs < startMs) throw new ToolError('An event cannot end before it starts.')
  return {
    start: zonedValue(startMs, zone),
    end: zonedValue(resolvedEndMs, zone),
    allDay: false,
    startMs,
    endMs: resolvedEndMs,
  }
}

function eventStartMs(event: CalendarEventDto, zone: string): number {
  return temporalValueToEpochMs(event.start, event.start.timeZone ?? zone)
}

function eventEndMs(event: CalendarEventDto, zone: string): number {
  return temporalValueToEpochMs(event.end, event.end.timeZone ?? event.start.timeZone ?? zone)
}

function locationOf(event: CalendarEventDto): string | null {
  const value = event.meta.location
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function recurrenceOf(event: CalendarEventDto): string | null {
  const rule = event.recurrenceRule
    ?? (typeof event.meta.recurrenceRule === 'string' ? event.meta.recurrenceRule : null)
  return rule ? rule.replace(/^RRULE:/i, '').trim() : null
}

function occurrenceOf(id: string): { masterId: string; startMs: number } | null {
  const index = id.indexOf(OCCURRENCE_MARK)
  if (index < 0) return null
  const startMs = Number(id.slice(index + OCCURRENCE_MARK.length))
  if (!Number.isFinite(startMs)) return null
  return { masterId: id.slice(0, index), startMs }
}

function seriesIdOf(id: string): string | null {
  return occurrenceOf(id)?.masterId ?? null
}

function presentEvent(event: CalendarEventDto, visibleId: string, index: CalendarIndex, zone: string): Record<string, unknown> {
  const startMs = eventStartMs(event, zone)
  const endMs = eventEndMs(event, zone)
  const location = locationOf(event)
  const recurrence = recurrenceOf(event)
  return {
    id: visibleId,
    title: event.title,
    kind: event.kind,
    all_day: event.allDay,
    start: event.allDay ? event.start.value : toLocalMinute(startMs, zone),
    end: event.allDay ? event.end.value : toLocalMinute(endMs, zone),
    start_ms: startMs,
    end_ms: endMs,
    time_zone: zone,
    calendars: event.calendarIds.map((calendarId) => calendarNameFor(calendarId, index)),
    calendar_ids: [...event.calendarIds],
    ...(location ? { location } : {}),
    ...(recurrence ? { recurrence_rule: recurrence } : {}),
    ...(event.description ? { description: event.description.slice(0, 400) } : {}),
    ...(seriesIdOf(visibleId) ? { series_id: seriesIdOf(visibleId) } : {}),
  }
}

function calendarIdsOf(args: Record<string, unknown>): string[] | undefined {
  const list = Array.isArray(args.calendarIds)
    ? args.calendarIds.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : []
  const one = typeof args.calendarId === 'string' && args.calendarId.trim() ? [args.calendarId.trim()] : []
  const ids = [...new Set([...one, ...list])]
  return ids.length > 0 ? ids : undefined
}

/** The default calendar, creating the account's first one when it has none. */
async function defaultCalendarIds(ctx: ToolContext): Promise<string[]> {
  const meta = await ask(() => storeOf(ctx).meta())
  const owned = meta.calendars.filter((calendar) => !isSharedCalendarId(calendar.id))
  const chosen = owned.find((calendar) => calendar.isDefault) ?? owned[0]
  if (!chosen) throw new ToolError('This account has no calendar yet. Open the calendar app once, then try again.')
  if (chosen.readOnly) throw new ToolError('The default calendar is read-only.')
  return [chosen.id]
}

async function assertSharedWriter(ctx: ToolContext, ownerId: string, rawCalendarIds: readonly string[]): Promise<void> {
  const writable = await ask(() => storeOf(ctx).sharedWriterCalendarIds(ownerId, rawCalendarIds))
  if (rawCalendarIds.some((calendarId) => !writable.has(calendarId))) {
    throw new ToolError('The shared calendar is read-only for this account.')
  }
}

async function createTarget(ctx: ToolContext, ids: string[] | undefined): Promise<WriteTarget> {
  if (!ids || ids.length === 0) return { store: storeOf(ctx), calendarIds: await defaultCalendarIds(ctx) }
  if (ids.some(isSharedCalendarId)) {
    if (ids.some((id) => !isSharedCalendarId(id))) {
      throw new ToolError('A shared write cannot mix shared and own calendars.')
    }
    const parsed = ids.map((id) => parseSharedCalendarId(id))
    const owners = new Set(parsed.map((entry) => entry!.ownerId))
    if (owners.size !== 1) throw new ToolError('A shared write must name one owner.')
    const ownerId = [...owners][0]!
    const raw = parsed.map((entry) => entry!.calendarId)
    await assertSharedWriter(ctx, ownerId, raw)
    return { store: new CalendarStore(ctx.env.DB, ownerId), calendarIds: raw, ownerId }
  }
  return { store: storeOf(ctx), calendarIds: ids }
}

async function loadEvent(ctx: ToolContext, visibleId: string, needWrite: boolean): Promise<FoundEvent> {
  const own = storeOf(ctx)
  if (isSharedCalendarId(visibleId)) {
    const shared = await ask(() => own.sharedEvent(visibleId))
    if (!shared) throw new ToolError('That shared event is not visible to this account any more.')
    if (needWrite) await assertSharedWriter(ctx, shared.ownerId, shared.event.calendarIds)
    return {
      store: new CalendarStore(ctx.env.DB, shared.ownerId),
      event: shared.event,
      visibleId,
      rawId: shared.eventId,
    }
  }
  const event = await ask(() => own.getEvent(visibleId))
  if (!event) throw new ToolError('No event has that id. Call calendar_search or calendar_list_events for the ids.')
  return { store: own, event, visibleId, rawId: visibleId }
}

function rangeFrom(args: Record<string, unknown>, zone: string, clock: number): { fromMs: number; toMs: number } {
  const now = clock
  const fromValue = args.from
  const toValue = args.to
  let fromMs = now
  let toMs = now + DEFAULT_RANGE_MS
  if (fromValue !== undefined) {
    const text = typeof fromValue === 'string' ? fromValue.trim() : ''
    fromMs = DATE_TEXT.test(text) ? dayStartMs(text, zone) : minuteMs(text, zone)
  }
  if (toValue !== undefined) {
    const text = typeof toValue === 'string' ? toValue.trim() : ''
    if (DATE_TEXT.test(text)) {
      toMs = dayStartMs(Temporal.PlainDate.from(fullDateText(text, 'to')).add({ days: 1 }).toString(), zone)
    } else {
      toMs = minuteMs(text, zone)
    }
  }
  if (toMs <= fromMs) throw new ToolError('"to" must be after "from".')
  if (toMs - fromMs > CALENDAR_RANGE_MAX_MS) toMs = fromMs + CALENDAR_RANGE_MAX_MS
  return { fromMs, toMs }
}

async function findEvent(args: Record<string, unknown>, ctx: ToolContext, zone: string, needWrite: boolean): Promise<FoundEvent> {
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (id) {
    const occurrence = occurrenceOf(id)
    if (occurrence) {
      const master = await loadEvent(ctx, occurrence.masterId, needWrite)
      if (!recurrenceOf(master.event)) throw new ToolError('That is not an occurrence of a repeating event.')
      return { ...master, visibleId: id, occurrenceStartMs: occurrence.startMs }
    }
    return loadEvent(ctx, id, needWrite)
  }
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) throw new ToolError('Name the event by "id" (preferred) or "query".')
  // A title search may mean something the reader did last month as easily as next Friday, so a query
  // looks wider than the default listing range rather than quietly hiding the older row.
  const now = Date.now()
  const fromMs = typeof args.from === 'string' && args.from.trim()
    ? (DATE_TEXT.test(args.from.trim()) ? dayStartMs(args.from.trim(), zone) : minuteMs(args.from.trim(), zone))
    : now - 90 * 24 * 60 * 60 * 1000
  const toMs = typeof args.to === 'string' && args.to.trim()
    ? (DATE_TEXT.test(args.to.trim())
      ? dayStartMs(Temporal.PlainDate.from(args.to.trim()).add({ days: 1 }).toString(), zone)
      : minuteMs(args.to.trim(), zone))
    : now + 365 * 24 * 60 * 60 * 1000
  const found = await ask(() => storeOf(ctx).searchEvents(query, 20, { fromMs, toMs }))
  const results = found.results
  if (results.length === 0) throw new ToolError(`No event matches "${query.slice(0, 60)}". Call calendar_search to look wider.`)
  if (results.length > 1) {
    const candidates = results.slice(0, 5)
      .map((hit) => `${hit.event.title} (${toLocalMinute(eventStartMs(hit.event, zone), zone)}) id=${hit.event.id}`)
      .join('; ')
    throw new ToolError(`More than one event matches "${query.slice(0, 60)}". Call again with one id: ${candidates}`)
  }
  const hit = results[0]!
  return { store: storeOf(ctx), event: hit.event, visibleId: hit.event.id, rawId: hit.event.id }
}

function existingDurationMinutes(event: CalendarEventDto, zone: string): number {
  if (event.allDay) {
    const days = Temporal.PlainDate.from(event.start.value).until(Temporal.PlainDate.from(event.end.value)).days
    return Math.max(1, days) * 1440
  }
  const span = eventEndMs(event, zone) - eventStartMs(event, zone)
  return Math.max(1, Math.round(span / 60_000))
}

function metaWithLocation(event: CalendarEventDto, location: unknown): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...event.meta }
  if (location === undefined || location === null || location === '') delete meta.location
  else if (typeof location === 'string') meta.location = location.trim().slice(0, 300)
  return meta
}

/**
 * The recurrence rule as the calendar stores it: the body of an RRULE.
 *
 * The model is asked for the standard spelling rather than a weekend of keyword parsing here; a rule
 * the expander cannot read would otherwise be stored and silently never repeat.
 */
function recurrenceRuleOf(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new ToolError('"recurrenceRule" must be text such as FREQ=WEEKLY;BYDAY=MO.')
  const rule = value.trim().replace(/^RRULE:/i, '').toUpperCase()
  if (!/^[A-Z]+=[A-Z0-9,;:/+-]+(?:;[A-Z]+=[A-Z0-9,;:/+-]+)*$/.test(rule)) {
    throw new ToolError('"recurrenceRule" must be an RRULE such as FREQ=WEEKLY;BYDAY=MO,WE.')
  }
  if (rule.length > 1000) throw new ToolError('"recurrenceRule" is too long.')
  return rule
}

async function collectEvents(
  ctx: ToolContext,
  fromMs: number,
  toMs: number,
  calendarIds?: readonly string[],
): Promise<{ rows: Array<{ event: CalendarEventDto; startMs: number; endMs: number }>; truncated: boolean; zone: string }> {
  const zone = await zoneOf(ctx)
  const found = await ask(() => storeOf(ctx).listEvents(fromMs, toMs, calendarIds))
  const expansion = expandRecurringEvents(found.events, fromMs, toMs, zone)
  const rows = [...found.events, ...expansion.occurrences]
    .filter((event) => !event.recurrenceCancelled)
    .map((event) => ({
      event,
      startMs: eventStartMs(event, zone),
      endMs: eventEndMs(event, zone),
    }))
    .filter((row) => row.startMs <= toMs && row.endMs >= fromMs)
    .sort((left, right) => left.startMs - right.startMs || left.event.id.localeCompare(right.event.id))
  return { rows, truncated: found.truncated || expansion.truncated, zone }
}

function mergeBusy(blocks: ReadonlyArray<{ startMs: number; endMs: number }>): Array<{ startMs: number; endMs: number }> {
  const merged: Array<{ startMs: number; endMs: number }> = []
  for (const block of [...blocks].sort((left, right) => left.startMs - right.startMs)) {
    const last = merged[merged.length - 1]
    if (last && block.startMs <= last.endMs) last.endMs = Math.max(last.endMs, block.endMs)
    else merged.push({ ...block })
  }
  return merged
}

async function busyBlocks(
  ctx: ToolContext,
  fromMs: number,
  toMs: number,
  calendarIds?: readonly string[],
): Promise<{ blocks: Array<{ startMs: number; endMs: number }>; zone: string }> {
  const collected = await collectEvents(ctx, fromMs, toMs, calendarIds)
  const blocks = collected.rows
    .filter((row) => row.event.kind !== 'task')
    .map((row) => ({
      startMs: Math.max(row.startMs, fromMs),
      endMs: Math.min(row.endMs, toMs),
    }))
    .filter((block) => block.endMs > block.startMs)
  return { blocks: mergeBusy(blocks), zone: collected.zone }
}

// ---------------------------------------------------------------- tools

export const CALENDAR_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'calendar_list_calendars',
    description: 'List the calendars this account can see, with ids, names, the default, read-only state and shared role. Call this before creating or moving an event unless the page context already names the calendar.',
    permission: 'read',
    fields: {},
    async run(_args, ctx) {
      const index = await calendarIndex(ctx)
      const preferences = await ask(() => storeOf(ctx).preferences())
      return {
        calendars: index.calendars.map((calendar) => ({
          id: calendar.id,
          name: calendar.name,
          default: calendar.isDefault,
          visible: calendar.isVisible,
          read_only: calendar.readOnly,
          source: calendar.source,
          ...(calendar.ownerName ? { owner: calendar.ownerName, shared_role: calendar.sharedRole } : {}),
        })),
        time_zone: preferences.timeZone,
      }
    },
  },
  {
    name: 'calendar_list_events',
    description: 'List events and tasks in a time range, expanding repeating series into real occurrences. Defaults to the next seven days. Use it to see what is on the calendar before answering or changing it.',
    permission: 'read',
    fields: {
      from: localDateField('Start of the range; defaults to now.'),
      to: localDateField('End of the range; defaults to seven days from now.'),
      calendarId: CALENDAR_ID_FIELD,
      calendarIds: CALENDAR_IDS_FIELD,
      kind: { type: 'string', enum: ['event', 'task'], description: 'Only events, or only tasks.', optional: true },
      limit: { type: 'integer', description: 'Maximum rows to return, 1–200. Default 100.', minimum: 1, maximum: MAX_LISTED_EVENTS, optional: true },
    },
    async run(args, ctx) {
      const zone = await zoneOf(ctx)
      const { fromMs, toMs } = rangeFrom(args, zone, ctx.now ?? Date.now())
      const limit = typeof args.limit === 'number' ? Math.min(MAX_LISTED_EVENTS, Math.max(1, args.limit)) : 100
      const kind = args.kind as CalendarEventKind | undefined
      const collected = await collectEvents(ctx, fromMs, toMs, calendarIdsOf(args))
      const index = await calendarIndex(ctx)
      const rows = collected.rows.filter((row) => (kind ? row.event.kind === kind : true))
      return {
        from: toLocalMinute(fromMs, collected.zone),
        to: toLocalMinute(toMs, collected.zone),
        time_zone: collected.zone,
        events: rows.slice(0, limit).map((row) => presentEvent(row.event, row.event.id, index, collected.zone)),
        ...(rows.length > limit || collected.truncated ? { truncated: true, note: `Only ${limit} rows are shown; narrow the range for the rest.` } : {}),
      }
    },
  },
  {
    name: 'calendar_search',
    description: 'Search events this account owns by title, description, attendee or location, optionally within a range. Recurring series match here but only their stored series row does; calendar_list_events expands occurrences.',
    permission: 'read',
    fields: {
      query: { type: 'string', description: 'Words from the title or description.', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', description: 'Maximum results, 1–50. Default 20.', minimum: 1, maximum: 50, optional: true },
      from: localDateField('Only events starting on or after this local day.'),
      to: localDateField('Only events starting on or before this local day.'),
      calendarId: CALENDAR_ID_FIELD,
      calendarIds: CALENDAR_IDS_FIELD,
      kind: { type: 'string', enum: ['event', 'task'], description: 'Only events, or only tasks.', optional: true },
      attendee: { type: 'string', description: 'Attendee name or email fragment.', maxLength: 200, optional: true },
      location: { type: 'string', description: 'Location text.', maxLength: 200, optional: true },
      recurring: { type: 'boolean', description: 'True for repeating series, false for one-off events.', optional: true },
      taskStatus: { type: 'string', enum: ['open', 'done'], description: 'For task rows: still open, or already done.', optional: true },
    },
    async run(args, ctx) {
      const zone = await zoneOf(ctx)
      const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, args.limit)) : 20
      const fromMs = typeof args.from === 'string'
        ? (DATE_TEXT.test(args.from.trim()) ? dayStartMs(args.from.trim(), zone) : minuteMs(args.from.trim(), zone))
        : undefined
      const toMs = typeof args.to === 'string'
        ? (DATE_TEXT.test(args.to.trim())
          ? dayStartMs(Temporal.PlainDate.from(args.to.trim()).add({ days: 1 }).toString(), zone)
          : minuteMs(args.to.trim(), zone))
        : undefined
      const found = await ask(() => storeOf(ctx).searchEvents(String(args.query), limit, {
        ...(calendarIdsOf(args) ? { calendarIds: calendarIdsOf(args) } : {}),
        ...(fromMs === undefined ? {} : { fromMs }),
        ...(toMs === undefined ? {} : { toMs }),
        ...(args.kind ? { kind: args.kind as CalendarEventKind } : {}),
        ...(typeof args.attendee === 'string' ? { attendee: args.attendee } : {}),
        ...(typeof args.location === 'string' ? { location: args.location } : {}),
        ...(args.recurring === undefined ? {} : { recurring: args.recurring === true }),
        ...(args.taskStatus ? { taskStatus: args.taskStatus as 'open' | 'done' } : {}),
      }))
      const index = await calendarIndex(ctx)
      return {
        results: found.results.map((hit) => ({
          ...presentEvent(hit.event, hit.event.id, index, zone),
          calendar: hit.calendarName,
        })),
        ...(found.truncated ? { truncated: true } : {}),
      }
    },
  },
  {
    name: 'calendar_create_event',
    description: 'Create a real calendar event (or task) in D1. Give the title and a local start; a missing end defaults to one hour. A date without a time makes an all-day event. Location is stored on the event meta and shows in the calendar.',
    permission: 'write',
    fields: {
      title: { type: 'string', description: 'Event title.', minLength: 1, maxLength: 300 },
      start: localDateField('Start, local to the reader.', false),
      end: localDateField('End, local to the reader. Omit to use durationMinutes, or one hour.'),
      durationMinutes: { type: 'integer', description: 'Length in minutes when end is omitted. Default 60.', minimum: 5, maximum: 1440, optional: true },
      timeZone: { type: 'string', description: 'IANA zone for the times. Omit to use the calendar settings zone.', maxLength: 64, optional: true },
      allDay: { type: 'boolean', description: 'Force an all-day event, or force a timed one.', optional: true },
      location: { type: 'string', description: 'Where it happens, shown on the event.', maxLength: 300, optional: true },
      description: { type: 'string', description: 'Notes carried on the event.', maxLength: 20_000, optional: true },
      recurrenceRule: { type: 'string', description: 'An RRULE body such as FREQ=WEEKLY;BYDAY=MO,WE. Omit for a one-off event.', maxLength: 1000, optional: true },
      calendarId: CALENDAR_ID_FIELD,
      calendarIds: CALENDAR_IDS_FIELD,
      kind: { type: 'string', enum: ['event', 'task'], description: 'Write an event or a task row. Default event.', optional: true },
    },
    async run(args, ctx) {
      const zone = await zoneOf(ctx, args.timeZone)
      const target = await createTarget(ctx, calendarIdsOf(args))
      const timeline = timelineFrom(args.start, args.end, args.durationMinutes, args.allDay, zone)
      const meta: Record<string, unknown> = {}
      if (typeof args.location === 'string' && args.location.trim()) meta.location = args.location.trim()
      const recurrenceRule = recurrenceRuleOf(args.recurrenceRule)
      const input = parseEventInput({
        title: args.title,
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
        ...(args.kind ? { kind: args.kind } : {}),
        start: timeline.start,
        end: timeline.end,
        allDay: timeline.allDay,
        calendarIds: target.calendarIds,
        meta,
        ...(recurrenceRule === undefined ? {} : { recurrenceRule }),
        source: 'local',
      }, { defaultTimeZone: zone })
      const event = await ask(() => target.store.createEvent(input))
      const index = await calendarIndex(ctx)
      return {
        created: true,
        event: presentEvent(event, target.ownerId ? sharedCalendarId(target.ownerId, event.id) : event.id, index, zone),
      }
    },
  },
  {
    name: 'calendar_update_event',
    description: 'Edit an existing event: title, description, location, times, recurrence rule or calendars. Pass the event id from a list/search, or a distinct query. Repeating series: pass the series id to edit all of it, or an occurrence id to edit only that occurrence.',
    permission: 'write',
    fields: {
      id: { type: 'string', description: 'Event id from calendar_list_events or calendar_search.', maxLength: 96, optional: true },
      query: { type: 'string', description: 'Title words when the id is unknown. Must match exactly one event.', maxLength: 200, optional: true },
      from: localDateField('Range used with query, defaults to the last seven days through the next year.'),
      to: localDateField('Range used with query.'),
      title: { type: 'string', description: 'New title.', minLength: 1, maxLength: 300, optional: true },
      description: { type: 'string', description: 'New notes; an empty string clears them.', maxLength: 20_000, optional: true },
      location: { type: 'string', description: 'New location; an empty string clears it.', maxLength: 300, optional: true },
      start: localDateField('New start. The existing length is kept unless end or durationMinutes is given.'),
      end: localDateField('New end. Requires start.'),
      durationMinutes: { type: 'integer', description: 'New length in minutes. Requires start.', minimum: 5, maximum: 1440, optional: true },
      allDay: { type: 'boolean', description: 'Switch to an all-day event (with a date start) or to a timed one (with a time start).', optional: true },
      recurrenceRule: { type: 'string', description: 'New RRULE body; null clears the repeat.', maxLength: 1000, optional: true, nullable: true },
      calendarId: CALENDAR_ID_FIELD,
      calendarIds: CALENDAR_IDS_FIELD,
    },
    async run(args, ctx) {
      const zone = await zoneOf(ctx)
      const found = await findEvent(args, ctx, zone, true)
      if (found.occurrenceStartMs !== undefined) {
        return updateOccurrence(found, args, zone, ctx)
      }
      const event = found.event
      const record: Record<string, unknown> = { rev: event.rev }
      let touched = false
      if (typeof args.title === 'string') {
        record.title = args.title
        touched = true
      }
      if (typeof args.description === 'string') {
        record.description = args.description
        touched = true
      }
      if (args.location !== undefined) {
        record.meta = metaWithLocation(event, args.location)
        touched = true
      }
      if (args.start !== undefined) {
        const durationMinutes = typeof args.durationMinutes === 'number'
          ? args.durationMinutes
          : typeof args.end === 'string' ? undefined : existingDurationMinutes(event, zone)
        const timeline = timelineFrom(
          args.start,
          args.end,
          durationMinutes,
          args.allDay === undefined ? event.allDay : args.allDay,
          zone,
        )
        record.start = timeline.start
        record.end = timeline.end
        record.allDay = timeline.allDay
        touched = true
      } else if (args.end !== undefined || args.durationMinutes !== undefined || args.allDay !== undefined) {
        throw new ToolError('Pass "start" together with a new end, duration or all-day switch.')
      }
      const recurrenceRule = recurrenceRuleOf(args.recurrenceRule)
      if (recurrenceRule !== undefined) {
        record.recurrenceRule = recurrenceRule
        touched = true
      }
      const calendarIds = calendarIdsOf(args)
      if (calendarIds) {
        if (calendarIds.some(isSharedCalendarId)) {
          throw new ToolError('Changing the calendars of an event is only supported for this account\'s own calendars.')
        }
        record.calendarIds = calendarIds
        touched = true
      }
      if (!touched) throw new ToolError('Nothing was changed. Name at least one field to edit.')
      const patch = parseEventPatch(record, { defaultTimeZone: zone })
      const updated = await ask(() => found.store.updateEvent(found.rawId, patch))
      const index = await calendarIndex(ctx)
      return { updated: true, event: presentEvent(updated, found.visibleId, index, zone) }
    },
  },
  {
    name: 'calendar_move_event',
    description: 'Move an event to a new start while keeping its length, or give it a new length too. This is the tool for "move Friday\'s review to Monday at 10". Pass an occurrence id to move only that occurrence of a series.',
    permission: 'write',
    fields: {
      id: { type: 'string', description: 'Event id from calendar_list_events or calendar_search.', maxLength: 96, optional: true },
      query: { type: 'string', description: 'Title words when the id is unknown. Must match exactly one event.', maxLength: 200, optional: true },
      from: localDateField('Range used with query, defaults to the last seven days through the next year.'),
      to: localDateField('Range used with query.'),
      start: localDateField('New start, local to the reader.', false),
      durationMinutes: { type: 'integer', description: 'New length in minutes; omit to keep the current length.', minimum: 5, maximum: 1440, optional: true },
      timeZone: { type: 'string', description: 'IANA zone for the new start. Omit to use the calendar settings zone.', maxLength: 64, optional: true },
    },
    async run(args, ctx) {
      const zone = await zoneOf(ctx, args.timeZone)
      const found = await findEvent(args, ctx, zone, true)
      if (found.occurrenceStartMs !== undefined) return moveOccurrence(found, args, zone, ctx)
      const event = found.event
      const allDay = DATE_TEXT.test(String(args.start))
      const durationMinutes = typeof args.durationMinutes === 'number'
        ? args.durationMinutes
        : existingDurationMinutes(event, zone)
      const timeline = timelineFrom(args.start, undefined, durationMinutes, allDay, zone)
      const patch = parseEventPatch({
        rev: event.rev,
        start: timeline.start,
        end: timeline.end,
        allDay: timeline.allDay,
      }, { defaultTimeZone: zone })
      const updated = await ask(() => found.store.updateEvent(found.rawId, patch))
      const index = await calendarIndex(ctx)
      return { moved: true, event: presentEvent(updated, found.visibleId, index, zone) }
    },
  },
  {
    name: 'calendar_free_busy',
    description: 'Return the busy stretches in a range, merged across the named calendars, so a gap can be reasoned about honestly. Tasks are excluded, exactly as the calendar\'s booking page excludes them.',
    permission: 'read',
    fields: {
      from: localDateField('Start of the range; defaults to now.'),
      to: localDateField('End of the range; defaults to seven days from now.'),
      calendarId: CALENDAR_ID_FIELD,
      calendarIds: CALENDAR_IDS_FIELD,
    },
    async run(args, ctx) {
      const zone = await zoneOf(ctx)
      const { fromMs, toMs } = rangeFrom(args, zone, ctx.now ?? Date.now())
      const { blocks } = await busyBlocks(ctx, fromMs, toMs, calendarIdsOf(args))
      return {
        from: toLocalMinute(fromMs, zone),
        to: toLocalMinute(toMs, zone),
        time_zone: zone,
        busy: blocks.map((block) => ({ start: toLocalMinute(block.startMs, zone), end: toLocalMinute(block.endMs, zone), start_ms: block.startMs, end_ms: block.endMs })),
      }
    },
  },
  {
    name: 'calendar_find_slot',
    description: 'Find real free slots in a range for a meeting of a given length, inside working hours and on the requested weekdays. It reads the stored events and returns actual times, not a guess.',
    permission: 'read',
    fields: {
      durationMinutes: { type: 'integer', description: 'Meeting length, 5–480. Default 30.', minimum: 5, maximum: 480, optional: true },
      from: localDateField('First day to consider; defaults to now.'),
      to: localDateField('Last day to consider; defaults to seven days from now.'),
      dayStartHour: { type: 'integer', description: 'Earliest hour of the working window, 0–23. Default 9.', minimum: 0, maximum: 23, optional: true },
      dayEndHour: { type: 'integer', description: 'Latest hour of the working window, 1–24. Default 18.', minimum: 1, maximum: 24, optional: true },
      days: { type: 'string', description: 'Weekdays as 0=Sunday…6=Saturday, comma separated. Default 1,2,3,4,5.', maxLength: 32, optional: true },
      stepMinutes: { type: 'integer', description: 'Granularity of the search, 5–60. Default 15.', minimum: 5, maximum: 60, optional: true },
      limit: { type: 'integer', description: 'How many slots to return, 1–20. Default 5.', minimum: 1, maximum: MAX_SLOT_RESULTS, optional: true },
      calendarId: CALENDAR_ID_FIELD,
      calendarIds: CALENDAR_IDS_FIELD,
    },
    async run(args, ctx) {
      const zone = await zoneOf(ctx)
      const clock = ctx.now ?? Date.now()
      const { fromMs, toMs } = rangeFrom(args, zone, clock)
      const duration = typeof args.durationMinutes === 'number' ? args.durationMinutes : 30
      const startHour = typeof args.dayStartHour === 'number' ? args.dayStartHour : 9
      const endHour = typeof args.dayEndHour === 'number' ? args.dayEndHour : 18
      const step = typeof args.stepMinutes === 'number' ? args.stepMinutes : 15
      const limit = typeof args.limit === 'number' ? Math.min(MAX_SLOT_RESULTS, Math.max(1, args.limit)) : 5
      if (endHour <= startHour) throw new ToolError('"dayEndHour" must come after "dayStartHour".')
      const allowedDays = typeof args.days === 'string' && args.days.trim()
        ? args.days.split(',').map((entry) => Number(entry.trim())).filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 6)
        : [1, 2, 3, 4, 5]
      if (allowedDays.length === 0) throw new ToolError('"days" must name weekdays from 0 to 6.')
      const { blocks } = await busyBlocks(ctx, fromMs, toMs, calendarIdsOf(args))
      // "Not in the past" is measured against the turn's clock, so a fixed test day keeps the same
      // answer whatever hour the suite runs at.
      const earliest = Math.max(fromMs, clock + 60_000)
      const firstDay = Temporal.Instant.fromEpochMilliseconds(earliest).toZonedDateTimeISO(zone).toPlainDate()
      const lastDay = Temporal.Instant.fromEpochMilliseconds(toMs).toZonedDateTimeISO(zone).toPlainDate()
      const slots: Array<{ start: string; end: string; start_ms: number; end_ms: number; day: string }> = []
      let day = firstDay
      for (let offset = 0; offset < MAX_DATE_RANGE_DAYS && slots.length < limit; offset += 1) {
        if (Temporal.PlainDate.compare(day, lastDay) > 0) break
        if (allowedDays.includes(day.dayOfWeek % 7)) {
          // Build the window from the wall clock, not by adding elapsed hours to midnight: on a DST
          // changeover day an exact-hour add would move "9:00" to 8:00 or 10:00, and 24:00 to 23:00.
          const windowStart = day.toZonedDateTime({ timeZone: zone, plainTime: { hour: startHour } }).epochMilliseconds
          const windowEnd = endHour === 24
            ? day.add({ days: 1 }).toZonedDateTime(zone).epochMilliseconds
            : day.toZonedDateTime({ timeZone: zone, plainTime: { hour: endHour } }).epochMilliseconds
          const stride = step * 60_000
          let cursor = Math.max(windowStart, earliest)
          cursor = windowStart + Math.ceil((cursor - windowStart) / stride) * stride
          while (cursor + duration * 60_000 <= windowEnd && slots.length < limit) {
            const slotEnd = cursor + duration * 60_000
            if (!blocks.some((block) => block.startMs < slotEnd && block.endMs > cursor)) {
              slots.push({
                start: toLocalMinute(cursor, zone),
                end: toLocalMinute(slotEnd, zone),
                start_ms: cursor,
                end_ms: slotEnd,
                day: day.toString(),
              })
              // One gap per day: "which gaps does this week have" is answered by five days, not by the
              // five overlapping starts a quarter-hour step would put on the first free morning.
              break
            }
            cursor += stride
          }
        }
        day = day.add({ days: 1 })
      }
      return {
        from: toLocalMinute(fromMs, zone),
        to: toLocalMinute(toMs, zone),
        time_zone: zone,
        duration_minutes: duration,
        slots,
        ...(slots.length === 0 ? { note: 'No free slot fits that window. Widen the range, shorten the meeting, or move the working hours.' } : {}),
      }
    },
  },
  {
    name: 'calendar_delete_event',
    description: 'Erase one event from the calendar. This is not undoable, so it is proposed for approval rather than run: the card names the event and its time. Pass an occurrence id to remove only that occurrence of a series.',
    permission: 'destructive',
    fields: {
      id: { type: 'string', description: 'Event id from calendar_list_events or calendar_search.', maxLength: 96, optional: true },
      query: { type: 'string', description: 'Title words when the id is unknown. Must match exactly one event.', maxLength: 200, optional: true },
      from: localDateField('Range used with query, defaults to the last seven days through the next year.'),
      to: localDateField('Range used with query.'),
    },
    async prepare(args, ctx): Promise<PreparedTarget> {
      const zone = await zoneOf(ctx)
      const found = await findEvent(args, ctx, zone, true)
      const index = await calendarIndex(ctx)
      const view = presentEvent(found.event, found.visibleId, index, zone)
      const when = found.occurrenceStartMs === undefined
        ? `${view.start}–${view.end}`
        : `${toLocalMinute(found.occurrenceStartMs, zone)}–${toLocalMinute(found.occurrenceStartMs + existingDurationMinutes(found.event, zone) * 60_000, zone)}`
      return { targetId: found.visibleId, targetLabel: `${found.event.title} · ${when}` }
    },
    async commit(targetId, ctx) {
      const zone = await zoneOf(ctx)
      const found = await loadEvent(ctx, targetId, true)
      if (found.occurrenceStartMs !== undefined) {
        const duration = existingDurationMinutes(found.event, zone)
        await ask(() => found.store.applyRecurrenceChange(found.rawId, {
          occurrenceStart: zonedValue(found.occurrenceStartMs!, zone),
          occurrenceEnd: zonedValue(found.occurrenceStartMs! + duration * 60_000, zone),
          scope: 'this',
          action: 'cancel',
          patch: null,
        }))
      } else {
        await ask(() => found.store.deleteEvent(found.rawId, found.event.rev))
      }
      return { deleted: true, id: targetId, title: found.event.title }
    },
  },
]

async function updateOccurrence(
  found: FoundEvent,
  args: Record<string, unknown>,
  zone: string,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const occurrenceStartMs = found.occurrenceStartMs!
  const duration = existingDurationMinutes(found.event, zone)
  const record: Record<string, unknown> = { rev: found.event.rev }
  if (typeof args.title === 'string') record.title = args.title
  if (typeof args.description === 'string') record.description = args.description
  if (args.location !== undefined) record.meta = metaWithLocation(found.event, args.location)
  let startMs = occurrenceStartMs
  let endMs = occurrenceStartMs + duration * 60_000
  let allDay = false
  if (args.start !== undefined) {
    const timeline = timelineFrom(
      args.start,
      args.end,
      typeof args.durationMinutes === 'number' ? args.durationMinutes : duration,
      args.allDay === undefined ? false : args.allDay,
      zone,
    )
    record.start = timeline.start
    record.end = timeline.end
    record.allDay = timeline.allDay
    startMs = timeline.startMs
    endMs = timeline.endMs
    allDay = timeline.allDay
  }
  if (Object.keys(record).length === 1) throw new ToolError('Nothing was changed. Name at least one field to edit.')
  const patch = parseEventPatch(record, { defaultTimeZone: zone })
  const answer = await ask(() => found.store.applyRecurrenceChange(found.rawId, {
    occurrenceStart: zonedValue(occurrenceStartMs, zone),
    occurrenceEnd: zonedValue(occurrenceStartMs + duration * 60_000, zone),
    scope: 'this',
    action: 'update',
    patch,
  }))
  const index = await calendarIndex(ctx)
  return {
    updated: true,
    series_id: answer.masterId,
    occurrence: presentEvent({ ...found.event, start: zonedValue(startMs, zone), end: zonedValue(endMs, zone), allDay }, found.visibleId, index, zone),
  }
}

async function moveOccurrence(
  found: FoundEvent,
  args: Record<string, unknown>,
  zone: string,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const duration = typeof args.durationMinutes === 'number' ? args.durationMinutes : existingDurationMinutes(found.event, zone)
  const allDay = DATE_TEXT.test(String(args.start))
  const timeline = timelineFrom(args.start, undefined, duration, allDay, zone)
  const patch = parseEventPatch({
    rev: found.event.rev,
    start: timeline.start,
    end: timeline.end,
    allDay: timeline.allDay,
  }, { defaultTimeZone: zone })
  const answer = await ask(() => found.store.applyRecurrenceChange(found.rawId, {
    occurrenceStart: zonedValue(found.occurrenceStartMs!, zone),
    occurrenceEnd: zonedValue(found.occurrenceStartMs! + existingDurationMinutes(found.event, zone) * 60_000, zone),
    scope: 'this',
    action: 'update',
    patch,
  }))
  const index = await calendarIndex(ctx)
  return {
    moved: true,
    series_id: answer.masterId,
    occurrence: presentEvent(
      { ...found.event, start: timeline.start, end: timeline.end, allDay: timeline.allDay },
      found.visibleId,
      index,
      zone,
    ),
  }
}
