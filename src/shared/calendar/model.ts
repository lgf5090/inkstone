import { Temporal } from 'temporal-polyfill'

export const CALENDAR_SOURCES = ['local', 'ics', 'caldav', 'google', 'outlook'] as const
export type CalendarSource = (typeof CALENDAR_SOURCES)[number]

export const CALENDAR_VIEWS = ['day', 'week', 'month', 'year', 'agenda'] as const
export type CalendarViewName = (typeof CALENDAR_VIEWS)[number]

export const CALENDAR_SYSTEMS = ['gregorian', 'jalali'] as const
export type CalendarSystem = (typeof CALENDAR_SYSTEMS)[number]

export const TIME_FORMATS = ['12h', '24h'] as const
export type TimeFormat = (typeof TIME_FORMATS)[number]

export const TASK_PRIORITIES = ['none', 'low', 'medium', 'high'] as const
export type CalendarTaskPriority = (typeof TASK_PRIORITIES)[number]

export const EVENT_KINDS = ['event', 'task'] as const
export type CalendarEventKind = (typeof EVENT_KINDS)[number]

export const TEMPORAL_KINDS = ['date', 'datetime', 'zoned'] as const
export type TemporalKind = (typeof TEMPORAL_KINDS)[number]

export const CALENDAR_SUBSCRIPTION_KINDS = ['ics', 'caldav', 'google', 'outlook'] as const
export type CalendarSubscriptionKind = (typeof CALENDAR_SUBSCRIPTION_KINDS)[number]

export const CALENDAR_CONNECTION_KINDS = ['caldav', 'google', 'outlook'] as const
export type CalendarConnectionKind = (typeof CALENDAR_CONNECTION_KINDS)[number]

export const CALENDAR_EVENT_TRIGGERS = ['click', 'dbClick'] as const
export type CalendarEventTrigger = (typeof CALENDAR_EVENT_TRIGGERS)[number]

export const MAX_CALENDAR_NAME = 80
export const MAX_GROUP_NAME = 50
export const MAX_EVENT_TITLE = 300
export const MAX_EVENT_DESCRIPTION = 20_000
export const MAX_EVENT_META_BYTES = 16 * 1024
export const MAX_CONFERENCE_URL = 2048
export const MAX_RECURRENCE_RULE = 1000
export const MAX_CALENDARS = 100
export const MAX_GROUPS = 50
export const MAX_CALENDAR_IDS_PER_EVENT = 20
export const MAX_EVENTS_PER_QUERY = 5000
export const MAX_EVENTS_PER_BATCH = 200
export const MAX_ICS_BYTES = 5 * 1024 * 1024
export const MAX_ICS_EVENTS = 5000
export const MAX_ICS_EXPORT_BYTES = 10 * 1024 * 1024
export const CALENDAR_RANGE_MAX_MS = 2 * 365 * 24 * 60 * 60 * 1000

export interface TemporalValue {
  value: string
  type: TemporalKind
  timeZone?: string
}

export interface CalendarDto {
  id: string
  name: string
  color: string
  darkColor: string
  icon: string | null
  groupId: string | null
  isDefault: boolean
  isVisible: boolean
  readOnly: boolean
  source: CalendarSource
  subscriptionId: string | null
  position: number
  rev: number
}

export interface CalendarGroupDto {
  id: string
  name: string
  position: number
}

export interface CalendarWriteInput {
  id?: string
  name: string
  color?: string
  darkColor?: string
  icon?: string | null
  groupId?: string | null
  isDefault?: boolean
  isVisible?: boolean
  readOnly?: boolean
}

export interface CalendarPatchInput {
  rev: number
  name?: string
  color?: string
  darkColor?: string
  icon?: string | null
  groupId?: string | null
  isDefault?: boolean
  isVisible?: boolean
  readOnly?: boolean
}

export interface CalendarGroupWriteInput {
  id?: string
  name: string
}

export interface CalendarTaskDto {
  completed?: boolean
  completedAt?: TemporalValue
  priority?: CalendarTaskPriority
}

export interface CalendarConferenceDto {
  provider?: string
  joinUrl: string
  meetingId?: string
  hostUrl?: string
  password?: string
  meta?: Record<string, unknown>
}

export interface CalendarEventDto {
  id: string
  title: string
  description: string
  kind: CalendarEventKind
  task: CalendarTaskDto | null
  conference: CalendarConferenceDto | null
  start: TemporalValue
  end: TemporalValue
  allDay: boolean
  calendarId: string
  calendarIds: string[]
  meta: Record<string, unknown>
  icon: boolean | null
  recurrenceRule: string | null
  rev: number
  source: CalendarSource
  externalId: string | null
}

export interface CalendarEventInput {
  id?: string
  title: string
  description?: string
  kind?: CalendarEventKind
  task?: CalendarTaskDto | null
  conference?: CalendarConferenceDto | null
  start: TemporalValue
  end: TemporalValue
  allDay?: boolean
  calendarId?: string
  calendarIds?: string[]
  meta?: Record<string, unknown>
  icon?: boolean | null
  recurrenceRule?: string | null
  rev?: number
  source?: CalendarSource
  externalId?: string | null
}

export interface CalendarEventPatch {
  title?: string
  description?: string
  kind?: CalendarEventKind
  task?: CalendarTaskDto | null
  conference?: CalendarConferenceDto | null
  start?: TemporalValue
  end?: TemporalValue
  allDay?: boolean
  calendarId?: string
  calendarIds?: string[]
  meta?: Record<string, unknown>
  icon?: boolean | null
  recurrenceRule?: string | null
  rev: number
}

export interface CalendarPreferences {
  defaultView: CalendarViewName
  weekStart: number
  showWeekends: boolean
  showWeekNumbers: boolean
  showHalfHourLines: boolean
  timeFormat: TimeFormat
  timeZone: string
  secondaryTimeZone: string | null
  calendarSystem: CalendarSystem
  enableTasks: boolean
  monthScroll: boolean
  snapToMonth: boolean
  dayHourHeight: number
  eventDetailDialog: boolean
  eventDetailTrigger: CalendarEventTrigger
  showMiniCalendar: boolean
  showEventDots: boolean
}

export interface CalendarSubscriptionDto {
  id: string
  calendarId: string
  kind: CalendarSubscriptionKind
  url: string | null
  enabled: boolean
  lastSyncAt: number | null
  lastErrorCode: string | null
  createdAt: number
  updatedAt: number
}

export interface CalendarConnectionDto {
  id: string
  kind: CalendarConnectionKind
  label: string
  baseUrl: string
  calendarHomeUrl: string | null
  username: string | null
  scope: 'read' | 'write'
  writable: boolean
  status: 'connected' | 'error' | 'expired' | 'disconnected'
  lastSyncedAt: number | null
  lastErrorCode: string | null
}

export interface CalendarMetaDto {
  calendars: CalendarDto[]
  groups: CalendarGroupDto[]
  subscriptions: CalendarSubscriptionDto[]
  connections: CalendarConnectionDto[]
  preferences: CalendarPreferences
}

export interface CalendarSearchResultDto {
  event: CalendarEventDto
  calendarName: string
  calendarColor: string
}

const CALENDAR_ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._~@#%+-]{0,199}$/

export function isCalendarEntityId(value: unknown): value is string {
  return typeof value === 'string' && CALENDAR_ENTITY_ID_RE.test(value) && !value.includes('::repeat-')
}

export function isCalendarSource(value: unknown): value is CalendarSource {
  return typeof value === 'string' && (CALENDAR_SOURCES as readonly string[]).includes(value)
}

export function isTemporalKind(value: unknown): value is TemporalKind {
  return typeof value === 'string' && (TEMPORAL_KINDS as readonly string[]).includes(value)
}

export function parseTemporalValue(input: TemporalValue) {
  if (input.type === 'date') return Temporal.PlainDate.from(input.value)
  if (input.type === 'datetime') return Temporal.PlainDateTime.from(input.value)
  return Temporal.ZonedDateTime.from(input.value)
}

export type CalendarTemporal =
  | Temporal.PlainDate
  | Temporal.PlainDateTime
  | Temporal.ZonedDateTime

export function temporalKind(value: CalendarTemporal): TemporalKind {
  if (value instanceof Temporal.PlainDate) return 'date'
  if (value instanceof Temporal.PlainDateTime) return 'datetime'
  return 'zoned'
}

export function toTemporalValue(value: CalendarTemporal): TemporalValue {
  const type = temporalKind(value)
  if (type === 'zoned') {
    const zoned = value as Temporal.ZonedDateTime
    return { value: zoned.toString({ smallestUnit: 'second' }), type, timeZone: zoned.timeZoneId }
  }
  return { value: value.toString(), type }
}

export function temporalToEpochMs(value: CalendarTemporal, fallbackTimeZone: string): number {
  if (value instanceof Temporal.ZonedDateTime) return value.epochMilliseconds
  if (value instanceof Temporal.PlainDateTime) {
    return value.toZonedDateTime(fallbackTimeZone).epochMilliseconds
  }
  return Temporal.ZonedDateTime.from({
    timeZone: fallbackTimeZone,
    year: value.year,
    month: value.month,
    day: value.day,
    hour: 0,
    minute: 0,
    second: 0,
  }).epochMilliseconds
}

export function temporalValueToEpochMs(input: TemporalValue, fallbackTimeZone: string): number {
  return temporalToEpochMs(parseTemporalValue(input), input.timeZone ?? fallbackTimeZone)
}

export function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function defaultCalendarPreferences(): CalendarPreferences {
  return {
    defaultView: 'week',
    weekStart: 1,
    showWeekends: true,
    showWeekNumbers: false,
    showHalfHourLines: false,
    timeFormat: '24h',
    timeZone: defaultTimeZone(),
    secondaryTimeZone: null,
    calendarSystem: 'gregorian',
    enableTasks: true,
    monthScroll: true,
    snapToMonth: false,
    dayHourHeight: 72,
    eventDetailDialog: false,
    eventDetailTrigger: 'dbClick',
    showMiniCalendar: true,
    showEventDots: true,
  }
}

export function normalizeCalendarPreferences(value: unknown): CalendarPreferences {
  const defaults = defaultCalendarPreferences()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  const record = value as Record<string, unknown>
  const view = CALENDAR_VIEWS.includes(record.defaultView as CalendarViewName)
    ? (record.defaultView as CalendarViewName)
    : defaults.defaultView
  const system = CALENDAR_SYSTEMS.includes(record.calendarSystem as CalendarSystem)
    ? (record.calendarSystem as CalendarSystem)
    : defaults.calendarSystem
  const timeFormat = TIME_FORMATS.includes(record.timeFormat as TimeFormat)
    ? (record.timeFormat as TimeFormat)
    : defaults.timeFormat
  const trigger = CALENDAR_EVENT_TRIGGERS.includes(record.eventDetailTrigger as CalendarEventTrigger)
    ? (record.eventDetailTrigger as CalendarEventTrigger)
    : defaults.eventDetailTrigger
  const weekStart = typeof record.weekStart === 'number' && Number.isInteger(record.weekStart)
    && record.weekStart >= 0 && record.weekStart <= 6
    ? record.weekStart
    : defaults.weekStart
  const hourHeight = typeof record.dayHourHeight === 'number'
    && Number.isFinite(record.dayHourHeight)
    && record.dayHourHeight >= 32
    && record.dayHourHeight <= 160
    ? Math.round(record.dayHourHeight)
    : defaults.dayHourHeight
  return {
    defaultView: view,
    weekStart,
    showWeekends: typeof record.showWeekends === 'boolean' ? record.showWeekends : defaults.showWeekends,
    showWeekNumbers: typeof record.showWeekNumbers === 'boolean' ? record.showWeekNumbers : defaults.showWeekNumbers,
    showHalfHourLines: typeof record.showHalfHourLines === 'boolean' ? record.showHalfHourLines : defaults.showHalfHourLines,
    timeFormat,
    timeZone: typeof record.timeZone === 'string' && record.timeZone ? record.timeZone : defaults.timeZone,
    secondaryTimeZone: typeof record.secondaryTimeZone === 'string' && record.secondaryTimeZone
      ? record.secondaryTimeZone
      : null,
    calendarSystem: system,
    enableTasks: typeof record.enableTasks === 'boolean' ? record.enableTasks : defaults.enableTasks,
    monthScroll: typeof record.monthScroll === 'boolean' ? record.monthScroll : defaults.monthScroll,
    snapToMonth: typeof record.snapToMonth === 'boolean' ? record.snapToMonth : defaults.snapToMonth,
    dayHourHeight: hourHeight,
    eventDetailDialog: typeof record.eventDetailDialog === 'boolean' ? record.eventDetailDialog : defaults.eventDetailDialog,
    eventDetailTrigger: trigger,
    showMiniCalendar: typeof record.showMiniCalendar === 'boolean' ? record.showMiniCalendar : defaults.showMiniCalendar,
    showEventDots: typeof record.showEventDots === 'boolean' ? record.showEventDots : defaults.showEventDots,
  }
}

const SECRET_META_KEYS = new Set([
  'accesstoken',
  'authorization',
  'cookie',
  'credentials',
  'password',
  'refreshtoken',
  'secret',
  'token',
])

export function containsSecretMetaKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsSecretMetaKey)
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    const normalized = key.toLowerCase().replaceAll(/[^a-z]/g, '')
    return SECRET_META_KEYS.has(normalized) || containsSecretMetaKey(child)
  })
}
