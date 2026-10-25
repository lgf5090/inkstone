/**
 * The seam between the calendar API's DTOs and DayFlow's in-memory types.
 *
 * DayFlow works with Temporal values and keeps its own render-only fields on an event; the API works
 * with `{ value, type, timeZone }` records and revisions. Everything that crosses that line goes
 * through this module so a field can never be dropped by one screen and remembered by another.
 */
import {
  getCalendarColorsForHex,
  type CalendarSearchEvent,
  type CalendarType,
  type Event,
  type EventConference,
  type EventTask,
  type KnownMeetingProviderId,
} from '@dayflow/react'
import { Temporal } from 'temporal-polyfill'
import {
  defaultTimeZone,
  parseTemporalValue,
  toTemporalValue,
  type CalendarEventDto,
  type CalendarEventInput,
  type CalendarSearchResultDto,
  type CalendarTaskDto,
  type CalendarDto,
  type CalendarSource,
  type TemporalValue,
} from '@shared/calendar/model'

/** How far around today the first fetch reaches. Navigation fetches more, padded by the same idea. */
export const INITIAL_RANGE_DAYS = 90
/** Extra days fetched on either side of a visible range, so a small scroll does not refetch. */
export const RANGE_PADDING_DAYS = 30
/** Events drawn per row in the month grid; the rest live behind DayFlow's "more" popup. */
export const MONTH_EVENT_HEIGHT = 18
/** The three density choices the settings panel offers. */
export const DAY_HOUR_HEIGHTS = [48, 72, 96] as const

/** Preset calendar colours. These are calendar data, not design tokens; the API stores the hex. */
export const CALENDAR_COLOR_PRESETS = [
  '#e5484d',
  '#f76b15',
  '#f5b800',
  '#46a758',
  '#12a594',
  '#0091ff',
  '#3e63dd',
  '#8e4ec6',
  '#d6409f',
  '#8d8d8d',
] as const

const KNOWN_MEETING_PROVIDERS = new Set<KnownMeetingProviderId>([
  'google-meet',
  'zoom',
  'microsoft-teams',
  'webex',
  'whereby',
  'jitsi',
])

/** DayFlow's render-only fields are not event data and must never travel to the server. */
const RENDER_ONLY_META_KEYS = new Set([
  'day',
  '_originalStartHour',
  '_originalEndHour',
  '_recurrenceMasterId',
  '_recurrenceKey',
])

export function stripRenderOnlyMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (!RENDER_ONLY_META_KEYS.has(key)) out[key] = value
  }
  return out
}

function conferenceFromDto(input: NonNullable<CalendarEventDto['conference']>): EventConference | undefined {
  // The server is the trust boundary for this field; the client still refuses to hand DayFlow a
  // scheme it cannot render as a link.
  if (!/^https:\/\//i.test(input.joinUrl)) return undefined
  const provider = input.provider
  return {
    ...(provider
      ? { provider: KNOWN_MEETING_PROVIDERS.has(provider as KnownMeetingProviderId) ? provider as KnownMeetingProviderId : 'custom' }
      : {}),
    joinUrl: input.joinUrl,
    ...(input.meetingId ? { meetingId: input.meetingId } : {}),
    ...(input.hostUrl ? { hostUrl: input.hostUrl } : {}),
    ...(input.password ? { password: input.password } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  }
}

function conferenceToDto(input: Event['conference']): CalendarEventInput['conference'] {
  if (!input || !/^https:\/\//i.test(input.joinUrl)) return null
  return {
    ...(input.provider ? { provider: input.provider } : {}),
    joinUrl: input.joinUrl,
    ...(input.meetingId ? { meetingId: input.meetingId } : {}),
    ...(input.hostUrl ? { hostUrl: input.hostUrl } : {}),
    ...(input.password ? { password: input.password } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  }
}

function zonedAt(value: TemporalValue, timeZone: string): Temporal.ZonedDateTime | undefined {
  try {
    const parsed = parseTemporalValue(value)
    if (parsed instanceof Temporal.ZonedDateTime) return parsed
    if (parsed instanceof Temporal.PlainDateTime) return parsed.toZonedDateTime(timeZone)
    return Temporal.ZonedDateTime.from({
      timeZone,
      year: parsed.year,
      month: parsed.month,
      day: parsed.day,
      hour: 0,
      minute: 0,
      second: 0,
    })
  } catch {
    // A timestamp the API could not validate is not worth failing the whole event load over; the
    // server is the final validator, and losing only "completed at" keeps the task readable.
    return undefined
  }
}

function taskFromDto(task: CalendarTaskDto | null, timeZone: string): EventTask | undefined {
  if (!task) return undefined
  const completedAt = task.completed && task.completedAt ? zonedAt(task.completedAt, timeZone) : undefined
  return {
    completed: Boolean(task.completed),
    ...(completedAt ? { completedAt } : {}),
    ...(task.priority ? { priority: task.priority } : {}),
  }
}

function taskToDto(task: Event['task']): CalendarTaskDto | null {
  if (!task) return null
  const completed = Boolean(task.completed)
  return {
    completed,
    ...(completed && task.completedAt ? { completedAt: toTemporalValue(task.completedAt) } : {}),
    ...(task.priority ? { priority: task.priority } : {}),
  }
}

/** Calendar IDs in DayFlow's order: the primary first, duplicates removed. */
export function eventCalendarIds(event: Pick<Event, 'calendarId' | 'calendarIds'>): string[] {
  const ids = [...(event.calendarId ? [event.calendarId] : []), ...(event.calendarIds ?? [])]
  return ids.filter((id, index) => id.length > 0 && ids.indexOf(id) === index)
}

/** One API event as DayFlow draws it. */
export function toDayFlowEvent(dto: CalendarEventDto, timeZone: string = defaultTimeZone()): Event {
  const meta = { ...dto.meta }
  if (dto.recurrenceRule) meta.recurrenceRule = dto.recurrenceRule
  const calendarIds = [dto.calendarId, ...dto.calendarIds].filter((id, index, all) => id.length > 0 && all.indexOf(id) === index)
  return {
    id: dto.id,
    title: dto.title,
    description: dto.description || undefined,
    kind: dto.kind,
    task: taskFromDto(dto.task, timeZone),
    conference: dto.conference ? conferenceFromDto(dto.conference) : undefined,
    start: parseTemporalValue(dto.start),
    end: parseTemporalValue(dto.end),
    allDay: dto.allDay,
    calendarId: dto.calendarId,
    calendarIds,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
    icon: dto.icon ?? undefined,
  }
}

/** One API calendar as DayFlow's registry expects it. */
export function toCalendarType(dto: CalendarDto): CalendarType {
  const light = getCalendarColorsForHex(dto.color)
  const dark = getCalendarColorsForHex(dto.darkColor)
  return {
    id: dto.id,
    name: dto.name,
    colors: light.colors,
    darkColors: dark.darkColors ?? dark.colors,
    ...(dto.icon ? { icon: dto.icon } : {}),
    isDefault: dto.isDefault,
    isVisible: dto.isVisible,
    readOnly: dto.readOnly,
    source: dto.source,
  }
}

/** The companion dark colour the API stores beside a light calendar colour. */
export function deriveDarkColor(color: string): string {
  return getCalendarColorsForHex(color).darkColors?.eventColor ?? color
}

/** DayFlow and the provider mappers label sources for people; the API stores a small enum. */
export function calendarSourceOf(source: string | undefined): CalendarSource {
  switch (source?.toLowerCase()) {
    case 'caldav':
      return 'caldav'
    case 'google':
      return 'google'
    case 'outlook':
      return 'outlook'
    case 'ics':
      return 'ics'
    default:
      return 'local'
  }
}

function providerEventIdentity(event: Event): { source: CalendarSource; externalId: string | null } {
  const meta = event.meta
  if (!meta) return { source: 'local', externalId: null }
  const caldav = meta.caldav
  if (caldav && typeof caldav === 'object' && !Array.isArray(caldav)) {
    const uid = (caldav as Record<string, unknown>).uid
    if (typeof uid === 'string' && uid) return { source: 'caldav', externalId: uid }
  }
  for (const source of ['google', 'outlook'] as const) {
    const provider = meta[source]
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue
    const eventId = (provider as Record<string, unknown>).eventId
    if (typeof eventId === 'string' && eventId) return { source, externalId: eventId }
  }
  return { source: 'local', externalId: null }
}

export interface EventSerializationOptions {
  /** The server refuses an empty title; quick-created events arrive with one until typed over. */
  fallbackTitle: string
  /** Used only for a task's completed-at when the stored value is wall-clock time. */
  timeZone: string
}

/** DayFlow event -> API create payload. */
export function toEventInput(event: Event, options: EventSerializationOptions): CalendarEventInput {
  const calendarIds = eventCalendarIds(event)
  const meta = stripRenderOnlyMeta(event.meta)
  const recurrenceRule = typeof meta.recurrenceRule === 'string' && meta.recurrenceRule.trim()
    ? meta.recurrenceRule.trim()
    : null
  const identity = providerEventIdentity(event)
  return {
    id: event.id,
    title: event.title.trim() || options.fallbackTitle,
    description: event.description ?? '',
    kind: event.kind ?? 'event',
    task: taskToDto(event.task),
    conference: conferenceToDto(event.conference),
    start: toTemporalValue(event.start),
    end: toTemporalValue(event.end),
    allDay: event.allDay ?? event.start instanceof Temporal.PlainDate,
    calendarId: calendarIds[0] ?? '',
    calendarIds,
    meta,
    icon: typeof event.icon === 'boolean' ? event.icon : null,
    recurrenceRule,
    ...(identity.source === 'local' ? {} : { source: identity.source }),
    ...(identity.externalId ? { externalId: identity.externalId } : {}),
  }
}

/**
 * A full mutable-field snapshot, used both to replace an event from the server and to replay an
 * undo entry through `app.applyEventsChanges`. Temporal values stay Temporal here: this never
 * crosses the API.
 */
export function toEventUpdates(event: Event): Partial<Event> {
  return {
    title: event.title,
    description: event.description,
    kind: event.kind,
    task: event.task,
    conference: event.conference,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    calendarId: event.calendarId,
    calendarIds: event.calendarIds,
    meta: stripRenderOnlyMeta(event.meta),
    icon: typeof event.icon === 'boolean' ? event.icon : undefined,
  }
}

/** A search hit gets DayFlow's result colour, which is the owning calendar's line colour. */
export function toSearchEvent(result: CalendarSearchResultDto, timeZone: string = defaultTimeZone()): CalendarSearchEvent {
  return { ...toDayFlowEvent(result.event, timeZone), color: result.calendarColor }
}

/** The plain date an event falls on in the account's display timezone. */
export function eventDateInZone(
  value: Event['start'],
  timeZone: string,
): Temporal.PlainDate {
  if (value instanceof Temporal.PlainDate) return value
  if (value instanceof Temporal.PlainDateTime) return value.toPlainDate()
  return value.withTimeZone(timeZone).toPlainDate()
}
