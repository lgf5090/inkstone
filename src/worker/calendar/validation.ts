/**
 * The calendar routes' input boundary.
 *
 * Every parser here takes `unknown` from a JSON body or a query string, returns a normalized value
 * the store can bind, and refuses anything else with `ApiError.badRequest`. The rules live here rather
 * than in the store because they are properties of the request ("a title is 1–300 characters"), while
 * the store owns the rules that must hold whatever the caller sent (membership, revisions, scoping).
 *
 * Temporal values are parsed once, here, and both the canonical string and the epoch milliseconds the
 * range query needs are returned together, so the store never re-derives time from text. Nothing in
 * this file logs or echoes the raw upstream text of a parse failure.
 */

import { Temporal } from 'temporal-polyfill'
import {
  CALENDAR_EVENT_TRIGGERS,
  CALENDAR_SYSTEMS,
  CALENDAR_VIEWS,
  CALENDAR_YEAR_VIEW_MODES,
  containsSecretMetaKey,
  defaultCalendarPreferences,
  defaultTimeZone,
  isCalendarEntityId,
  isCalendarSource,
  isTemporalKind,
  CALENDAR_RANGE_MAX_MS,
  MAX_CALENDAR_IDS_PER_EVENT,
  MAX_CALENDAR_NAME,
  MAX_CONFERENCE_URL,
  MAX_EVENT_DESCRIPTION,
  MAX_EVENT_META_BYTES,
  MAX_EVENT_TITLE,
  MAX_GROUP_NAME,
  MAX_RECURRENCE_RULE,
  MAX_EVENTS_PER_BATCH,
  normalizeCalendarPreferences,
  temporalToEpochMs,
  TIME_FORMATS,
  toTemporalValue,
  type CalendarConferenceDto,
  type CalendarEventKind,
  type CalendarPreferences,
  type CalendarSource,
  type CalendarSystem,
  type CalendarEventTrigger,
  type CalendarTaskPriority,
  type CalendarViewName,
  type TemporalKind,
  type TemporalValue,
} from '@shared/calendar/model'
import { TASK_PRIORITIES } from '@shared/calendar/model'
import { utf8ByteLength } from '@shared/text-utils'
import { ApiError } from '../lib/errors'
import type {
  CalendarEventPatchInput,
  CalendarEventWriteInput,
  CalendarGroupWriteInput,
  CalendarPatchInput,
  CalendarTaskWrite,
  CalendarWriteInput,
} from './store'

export interface ParseEventOptions {
  /** The account's display zone, used when the value carries no zone of its own. */
  defaultTimeZone?: string
}

interface ParsedTemporal {
  value: TemporalValue
  ms: number
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function entityId(value: unknown, field: string): string {
  if (!isCalendarEntityId(value)) throw ApiError.badRequest(`${field} is not a valid id`)
  return value
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${field} must be true or false`)
  return value
}

function integerValue(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw ApiError.badRequest(`${field} must be a whole number between ${min} and ${max}`)
  }
  return value
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function eventTitle(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('title must be text')
  const title = value.trim()
  if (!title) throw ApiError.badRequest('title is required')
  if (title.length > MAX_EVENT_TITLE) {
    throw ApiError.badRequest(`title is longer than ${MAX_EVENT_TITLE} characters`)
  }
  if (CONTROL_CHARS.test(title)) throw ApiError.badRequest('title must not contain control characters')
  return title
}

function eventDescription(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest('description must be text')
  if (value.length > MAX_EVENT_DESCRIPTION) {
    throw ApiError.badRequest(`description is longer than ${MAX_EVENT_DESCRIPTION} characters`)
  }
  if (value.includes('\u0000')) throw ApiError.badRequest('description must not contain NUL characters')
  return value
}

function eventKind(value: unknown): CalendarEventKind {
  if (value === undefined || value === null) return 'event'
  if (value === 'event' || value === 'task') return value
  throw ApiError.badRequest('kind must be event or task')
}

function taskPriority(value: unknown): CalendarTaskPriority {
  if (typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value)) {
    return value as CalendarTaskPriority
  }
  throw ApiError.badRequest('task priority must be none, low, medium or high')
}

function assertTimeZone(zone: string, field: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
  } catch {
    throw ApiError.badRequest(`${field} is not a known time zone`)
  }
}

function parseTemporalField(value: unknown, field: string, fallbackTimeZone: string): ParsedTemporal {
  const record = requireRecord(value, field)
  if (typeof record.value !== 'string' || !isTemporalKind(record.type)) {
    throw ApiError.badRequest(`${field} must be a Temporal value with a type`)
  }
  const kind: TemporalKind = record.type
  const raw = record.value
  if (record.timeZone !== undefined && record.timeZone !== null) {
    if (typeof record.timeZone !== 'string' || !record.timeZone) {
      throw ApiError.badRequest(`${field}.timeZone must be text`)
    }
  }
  let parsed: Temporal.PlainDate | Temporal.PlainDateTime | Temporal.ZonedDateTime
  try {
    if (kind === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error('date')
      parsed = Temporal.PlainDate.from(raw)
    } else if (kind === 'datetime') {
      if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) || raw.includes('[')) throw new Error('datetime')
      parsed = Temporal.PlainDateTime.from(raw)
    } else {
      const zone = typeof record.timeZone === 'string' ? record.timeZone : null
      if (raw.includes('[')) {
        parsed = Temporal.ZonedDateTime.from(raw)
      } else {
        if (!zone) throw new Error('zone')
        assertTimeZone(zone, `${field}.timeZone`)
        parsed = Temporal.PlainDateTime.from(raw).toZonedDateTime(zone)
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest(`${field} is not a valid ${kind} value`)
  }
  const normalized = toTemporalValue(parsed)
  if (normalized.type === 'zoned' && normalized.timeZone) assertTimeZone(normalized.timeZone, `${field}.timeZone`)
  let ms: number
  try {
    ms = temporalToEpochMs(parsed, normalized.timeZone ?? fallbackTimeZone)
  } catch {
    throw ApiError.badRequest(`${field} could not be placed on the timeline`)
  }
  return { value: normalized, ms }
}

function ensureEndNotBeforeStart(start: ParsedTemporal, end: ParsedTemporal): void {
  if (end.ms < start.ms) throw ApiError.badRequest('An event cannot end before it starts')
}

function allDayFlag(value: unknown, start: TemporalValue, end: TemporalValue): boolean {
  const bothDates = start.type === 'date' && end.type === 'date'
  const requested = value === undefined ? bothDates : booleanValue(value, 'allDay')
  if (requested !== bothDates) {
    throw ApiError.badRequest('An all-day event must use date values for start and end')
  }
  return requested
}

function parseIcon(value: unknown): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw ApiError.badRequest('icon must be true, false or null')
  return value
}

function parseIconName(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !value.trim()) throw ApiError.badRequest('icon must be text or null')
  if (value.length > 100) throw ApiError.badRequest('icon is too long')
  if (CONTROL_CHARS.test(value)) throw ApiError.badRequest('icon must not contain control characters')
  return value
}

function parseCalendarIds(record: Record<string, unknown>, required: boolean): string[] | undefined {
  const hasList = record.calendarIds !== undefined
  const hasOne = record.calendarId !== undefined
  if (!hasList && !hasOne) {
    if (required) throw ApiError.badRequest('An event needs at least one calendar')
    return undefined
  }
  let values: unknown[] = []
  if (hasList) {
    if (!Array.isArray(record.calendarIds)) throw ApiError.badRequest('calendarIds must be an array')
    values = record.calendarIds
  } else {
    values = [record.calendarId]
  }
  const ids: string[] = []
  for (const value of values) {
    const id = entityId(value, 'calendarIds')
    if (!ids.includes(id)) ids.push(id)
  }
  if (ids.length === 0) throw ApiError.badRequest('An event needs at least one calendar')
  if (ids.length > MAX_CALENDAR_IDS_PER_EVENT) {
    throw ApiError.badRequest(`An event may belong to at most ${MAX_CALENDAR_IDS_PER_EVENT} calendars`)
  }
  return ids
}

function parseMeta(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  const meta = requireRecord(value, 'meta')
  if (utf8ByteLength(JSON.stringify(meta)) > MAX_EVENT_META_BYTES) {
    throw ApiError.badRequest('meta is too large')
  }
  if (containsSecretMetaKey(meta)) {
    throw ApiError.badRequest('meta must not contain secret-looking keys')
  }
  return meta
}

function normalizeRecurrence(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be text`)
  let rule = value.trim()
  if (!rule) return null
  rule = rule.replace(/^RRULE:/i, '')
  if (!rule) return null
  if (rule.length > MAX_RECURRENCE_RULE) {
    throw ApiError.badRequest(`${field} is longer than ${MAX_RECURRENCE_RULE} characters`)
  }
  if (!/(?:^|;)FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;|$)/i.test(rule)) {
    throw ApiError.badRequest(`${field} must name a daily, weekly, monthly or yearly frequency`)
  }
  return rule
}

function applyRecurrenceMeta(meta: Record<string, unknown>, rule: string | null): void {
  if (rule) meta.recurrenceRule = rule
  else delete meta.recurrenceRule
}

function parseTask(value: unknown, fallbackTimeZone: string): CalendarTaskWrite | null {
  if (value === undefined || value === null) return null
  const record = requireRecord(value, 'task')
  const completed = record.completed === undefined ? false : booleanValue(record.completed, 'task.completed')
  const priority = record.priority === undefined || record.priority === null
    ? null
    : taskPriority(record.priority)
  if (record.completedAt !== undefined && record.completedAt !== null) {
    if (!completed) throw ApiError.badRequest('task.completedAt is only valid on a completed task')
    const parsed = parseTemporalField(record.completedAt, 'task.completedAt', fallbackTimeZone)
    return { completed, completedAt: parsed.value, completedAtMs: parsed.ms, priority }
  }
  return { completed, completedAt: null, completedAtMs: null, priority }
}

function httpsUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw ApiError.badRequest(`${field} must be a URL`)
  if (value.length > MAX_CONFERENCE_URL) throw ApiError.badRequest(`${field} is too long`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw ApiError.badRequest(`${field} is not a valid URL`)
  }
  if (parsed.protocol !== 'https:') throw ApiError.badRequest(`${field} must use https`)
  if (parsed.username || parsed.password) throw ApiError.badRequest(`${field} must not carry credentials`)
  return value
}

function optionalShortText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be text`)
  if (value.length > max) throw ApiError.badRequest(`${field} is too long`)
  return value
}

function parseConference(value: unknown): CalendarConferenceDto | null {
  if (value === undefined || value === null) return null
  const record = requireRecord(value, 'conference')
  const joinUrl = httpsUrl(record.joinUrl, 'conference.joinUrl')
  const hostUrl = record.hostUrl === undefined || record.hostUrl === null
    ? undefined
    : httpsUrl(record.hostUrl, 'conference.hostUrl')
  const provider = optionalShortText(record.provider, 'conference.provider', 100)
  const meetingId = optionalShortText(record.meetingId, 'conference.meetingId', 500)
  const password = optionalShortText(record.password, 'conference.password', 500)
  let meta: Record<string, unknown> | undefined
  if (record.meta !== undefined && record.meta !== null) {
    meta = requireRecord(record.meta, 'conference.meta')
    if (utf8ByteLength(JSON.stringify(meta)) > MAX_EVENT_META_BYTES) {
      throw ApiError.badRequest('conference.meta is too large')
    }
  }
  return {
    joinUrl,
    ...(provider === undefined ? {} : { provider }),
    ...(meetingId === undefined ? {} : { meetingId }),
    ...(hostUrl === undefined ? {} : { hostUrl }),
    ...(password === undefined ? {} : { password }),
    ...(meta === undefined ? {} : { meta }),
  }
}

function parseSource(value: unknown): CalendarSource {
  if (!isCalendarSource(value)) throw ApiError.badRequest('source is not a known calendar source')
  return value
}

function recurringRuleFrom(
  record: Record<string, unknown>,
  meta: Record<string, unknown>,
): string | null {
  const explicit = record.recurrenceRule === undefined
    ? null
    : normalizeRecurrence(record.recurrenceRule, 'recurrenceRule')
  const fromMeta = normalizeRecurrence(meta.recurrenceRule, 'meta.recurrenceRule')
  const rule = explicit ?? fromMeta
  applyRecurrenceMeta(meta, rule)
  return rule
}

export function parseEventInput(value: unknown, options: ParseEventOptions = {}): CalendarEventWriteInput {
  const record = requireRecord(value, 'event')
  const fallback = options.defaultTimeZone ?? defaultTimeZone()
  const id = record.id === undefined || record.id === null ? undefined : entityId(record.id, 'Event id')
  if (record.start === undefined || record.end === undefined) {
    throw ApiError.badRequest('An event needs a start and an end')
  }
  const start = parseTemporalField(record.start, 'start', fallback)
  const end = parseTemporalField(record.end, 'end', fallback)
  ensureEndNotBeforeStart(start, end)
  const meta = parseMeta(record.meta)
  const kind = eventKind(record.kind)
  const task = parseTask(record.task, fallback) ?? (kind === 'task'
    ? { completed: false, completedAt: null, completedAtMs: null, priority: null }
    : null)
  const recurrenceRule = recurringRuleFrom(record, meta)
  return {
    ...(id === undefined ? {} : { id }),
    title: eventTitle(record.title),
    description: eventDescription(record.description),
    kind,
    task,
    conference: parseConference(record.conference),
    start: start.value,
    end: end.value,
    startMs: start.ms,
    endMs: end.ms,
    allDay: allDayFlag(record.allDay, start.value, end.value),
    calendarIds: parseCalendarIds(record, true)!,
    meta,
    icon: parseIcon(record.icon),
    recurrenceRule,
    source: record.source === undefined ? 'local' : parseSource(record.source),
    externalId: record.externalId === undefined || record.externalId === null
      ? null
      : entityId(record.externalId, 'External id'),
  }
}

export function parseEventPatch(value: unknown, options: ParseEventOptions = {}): CalendarEventPatchInput {
  const record = requireRecord(value, 'patch')
  const fallback = options.defaultTimeZone ?? defaultTimeZone()
  const rev = integerValue(record.rev, 'rev', 1, Number.MAX_SAFE_INTEGER)
  const patch: CalendarEventPatchInput = { rev }
  let touched = false
  if (record.title !== undefined) {
    patch.title = eventTitle(record.title)
    touched = true
  }
  if (record.description !== undefined) {
    patch.description = eventDescription(record.description)
    touched = true
  }
  if (record.kind !== undefined) {
    patch.kind = eventKind(record.kind)
    touched = true
  }
  if ('task' in record) {
    patch.task = parseTask(record.task, fallback)
    touched = true
  }
  if (patch.kind === 'task' && patch.task === null) {
    patch.task = { completed: false, completedAt: null, completedAtMs: null, priority: null }
  }
  if ('conference' in record) {
    patch.conference = parseConference(record.conference)
    touched = true
  }
  if (record.start !== undefined) {
    const start = parseTemporalField(record.start, 'start', fallback)
    patch.start = start.value
    patch.startMs = start.ms
    touched = true
  }
  if (record.end !== undefined) {
    const end = parseTemporalField(record.end, 'end', fallback)
    patch.end = end.value
    patch.endMs = end.ms
    touched = true
  }
  if (record.allDay !== undefined) {
    patch.allDay = booleanValue(record.allDay, 'allDay')
    touched = true
  }
  if (record.calendarId !== undefined || record.calendarIds !== undefined) {
    patch.calendarIds = parseCalendarIds(record, true)!
    touched = true
  }
  if (record.meta !== undefined) {
    const meta = parseMeta(record.meta)
    if (record.recurrenceRule === undefined) {
      applyRecurrenceMeta(meta, normalizeRecurrence(meta.recurrenceRule, 'meta.recurrenceRule'))
    }
    patch.meta = meta
    touched = true
  }
  if (record.icon !== undefined) {
    patch.icon = parseIcon(record.icon)
    touched = true
  }
  if (record.recurrenceRule !== undefined) {
    patch.recurrenceRule = normalizeRecurrence(record.recurrenceRule, 'recurrenceRule')
    touched = true
  }
  if (!touched) throw ApiError.badRequest('The patch does not change anything')
  return patch
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function calendarColor(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw ApiError.badRequest(`${field} must be a hex colour`)
  }
  return value
}

export function parseCalendarInput(value: unknown): CalendarWriteInput {
  const record = requireRecord(value, 'calendar')
  if (typeof record.name !== 'string') throw ApiError.badRequest('name must be text')
  const name = record.name.trim()
  if (!name) throw ApiError.badRequest('name is required')
  if (name.length > MAX_CALENDAR_NAME) {
    throw ApiError.badRequest(`name is longer than ${MAX_CALENDAR_NAME} characters`)
  }
  if (CONTROL_CHARS.test(name)) throw ApiError.badRequest('name must not contain control characters')
  const input: CalendarWriteInput = { name }
  if (record.id !== undefined && record.id !== null) input.id = entityId(record.id, 'Calendar id')
  if (record.color !== undefined) input.color = calendarColor(record.color, 'color')
  if (record.darkColor !== undefined) input.darkColor = calendarColor(record.darkColor, 'darkColor')
  if (record.icon !== undefined) input.icon = parseIconName(record.icon)
  if (record.groupId !== undefined) {
    input.groupId = record.groupId === null ? null : entityId(record.groupId, 'groupId')
  }
  if (record.isDefault !== undefined) input.isDefault = booleanValue(record.isDefault, 'isDefault')
  if (record.isVisible !== undefined) input.isVisible = booleanValue(record.isVisible, 'isVisible')
  if (record.readOnly !== undefined) input.readOnly = booleanValue(record.readOnly, 'readOnly')
  if (record.source !== undefined) input.source = parseSource(record.source)
  return input
}

export function parseCalendarPatch(value: unknown): CalendarPatchInput {
  const record = requireRecord(value, 'calendar patch')
  const patch: CalendarPatchInput = {
    rev: integerValue(record.rev, 'rev', 1, Number.MAX_SAFE_INTEGER),
  }
  let touched = false
  if (record.name !== undefined) {
    const input = parseCalendarInput({ name: record.name })
    patch.name = input.name
    touched = true
  }
  if (record.color !== undefined) {
    patch.color = calendarColor(record.color, 'color')
    touched = true
  }
  if (record.darkColor !== undefined) {
    patch.darkColor = calendarColor(record.darkColor, 'darkColor')
    touched = true
  }
  if (record.icon !== undefined) {
    patch.icon = parseIconName(record.icon)
    touched = true
  }
  if (record.groupId !== undefined) {
    patch.groupId = record.groupId === null ? null : entityId(record.groupId, 'groupId')
    touched = true
  }
  if (record.isDefault !== undefined) {
    patch.isDefault = booleanValue(record.isDefault, 'isDefault')
    touched = true
  }
  if (record.isVisible !== undefined) {
    patch.isVisible = booleanValue(record.isVisible, 'isVisible')
    touched = true
  }
  if (record.readOnly !== undefined) {
    patch.readOnly = booleanValue(record.readOnly, 'readOnly')
    touched = true
  }
  if (!touched) throw ApiError.badRequest('The patch does not change anything')
  return patch
}

export function parseGroupInput(value: unknown): CalendarGroupWriteInput {
  const record = requireRecord(value, 'group')
  if (typeof record.name !== 'string') throw ApiError.badRequest('name must be text')
  const name = record.name.trim()
  if (!name) throw ApiError.badRequest('name is required')
  if (name.length > MAX_GROUP_NAME) {
    throw ApiError.badRequest(`name is longer than ${MAX_GROUP_NAME} characters`)
  }
  if (CONTROL_CHARS.test(name)) throw ApiError.badRequest('name must not contain control characters')
  const input: CalendarGroupWriteInput = { name }
  if (record.id !== undefined && record.id !== null) input.id = entityId(record.id, 'Group id')
  return input
}

export function parseGroupPatch(value: unknown): { name: string } {
  const record = requireRecord(value, 'group patch')
  if (typeof record.name !== 'string') throw ApiError.badRequest('name must be text')
  const name = record.name.trim()
  if (!name) throw ApiError.badRequest('name is required')
  if (name.length > MAX_GROUP_NAME) {
    throw ApiError.badRequest(`name is longer than ${MAX_GROUP_NAME} characters`)
  }
  if (CONTROL_CHARS.test(name)) throw ApiError.badRequest('name must not contain control characters')
  return { name }
}

/**
 * The full preference shape, with every supplied value checked and every omitted value taken from the
 * defaults. Unknown keys are refused rather than silently dropped: a client that sends a setting this
 * server does not know is a version mismatch worth reporting, not a no-op.
 */
export function parsePreferences(value: unknown): CalendarPreferences {
  const record = requireRecord(value, 'preferences')
  const defaults = defaultCalendarPreferences()
  const known = new Set(Object.keys(defaults))
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw ApiError.badRequest(`Unknown preference: ${key}`)
  }
  const result: CalendarPreferences = { ...defaults }
  if (record.defaultView !== undefined) {
    if (!(CALENDAR_VIEWS as readonly unknown[]).includes(record.defaultView)) {
      throw ApiError.badRequest('defaultView is not a known view')
    }
    result.defaultView = record.defaultView as CalendarViewName
  }
  if (record.weekStart !== undefined) result.weekStart = integerValue(record.weekStart, 'weekStart', 0, 6)
  if (record.showWeekNumbers !== undefined) result.showWeekNumbers = booleanValue(record.showWeekNumbers, 'showWeekNumbers')
  if (record.showHalfHourLines !== undefined) {
    result.showHalfHourLines = booleanValue(record.showHalfHourLines, 'showHalfHourLines')
  }
  if (record.enableTasks !== undefined) result.enableTasks = booleanValue(record.enableTasks, 'enableTasks')
  if (record.monthScroll !== undefined) result.monthScroll = booleanValue(record.monthScroll, 'monthScroll')
  if (record.snapToMonth !== undefined) result.snapToMonth = booleanValue(record.snapToMonth, 'snapToMonth')
  if (record.eventDetailDialog !== undefined) {
    result.eventDetailDialog = booleanValue(record.eventDetailDialog, 'eventDetailDialog')
  }
  if (record.showMiniCalendar !== undefined) {
    result.showMiniCalendar = booleanValue(record.showMiniCalendar, 'showMiniCalendar')
  }
  if (record.showEventDots !== undefined) result.showEventDots = booleanValue(record.showEventDots, 'showEventDots')
  if (record.timeFormat !== undefined) {
    if (!(TIME_FORMATS as readonly unknown[]).includes(record.timeFormat)) {
      throw ApiError.badRequest('timeFormat must be 12h or 24h')
    }
    result.timeFormat = record.timeFormat as CalendarPreferences['timeFormat']
  }
  if (record.timeZone !== undefined) {
    if (typeof record.timeZone !== 'string' || !record.timeZone) {
      throw ApiError.badRequest('timeZone must be text')
    }
    assertTimeZone(record.timeZone, 'timeZone')
    result.timeZone = record.timeZone
  }
  if (record.secondaryTimeZone !== undefined) {
    if (record.secondaryTimeZone === null || record.secondaryTimeZone === '') {
      result.secondaryTimeZone = null
    } else if (typeof record.secondaryTimeZone === 'string') {
      assertTimeZone(record.secondaryTimeZone, 'secondaryTimeZone')
      result.secondaryTimeZone = record.secondaryTimeZone
    } else {
      throw ApiError.badRequest('secondaryTimeZone must be text or null')
    }
  }
  if (record.calendarSystem !== undefined) {
    if (!(CALENDAR_SYSTEMS as readonly unknown[]).includes(record.calendarSystem)) {
      throw ApiError.badRequest('calendarSystem must be gregorian or jalali')
    }
    result.calendarSystem = record.calendarSystem as CalendarSystem
  }
  if (record.dayHourHeight !== undefined) {
    result.dayHourHeight = integerValue(record.dayHourHeight, 'dayHourHeight', 32, 160)
  }
  if (record.yearViewMode !== undefined) {
    if (!(CALENDAR_YEAR_VIEW_MODES as readonly unknown[]).includes(record.yearViewMode)) {
      throw ApiError.badRequest('yearViewMode is not a known year view mode')
    }
    result.yearViewMode = record.yearViewMode as CalendarPreferences['yearViewMode']
  }
  if (record.yearShowTimedEvents !== undefined) {
    result.yearShowTimedEvents = booleanValue(record.yearShowTimedEvents, 'yearShowTimedEvents')
  }
  if (record.yearHeatmapLevels !== undefined) {
    result.yearHeatmapLevels = integerValue(record.yearHeatmapLevels, 'yearHeatmapLevels', 3, 7)
  }
  if (record.agendaDays !== undefined) {
    result.agendaDays = integerValue(record.agendaDays, 'agendaDays', 1, 365)
  }
  if (record.agendaShowEmptyDays !== undefined) {
    result.agendaShowEmptyDays = booleanValue(record.agendaShowEmptyDays, 'agendaShowEmptyDays')
  }
  if (record.eventDetailTrigger !== undefined) {
    if (!(CALENDAR_EVENT_TRIGGERS as readonly unknown[]).includes(record.eventDetailTrigger)) {
      throw ApiError.badRequest('eventDetailTrigger must be click or dbClick')
    }
    result.eventDetailTrigger = record.eventDetailTrigger as CalendarEventTrigger
  }
  return normalizeCalendarPreferences(result)
}

export interface ParsedRange {
  fromMs: number
  toMs: number
}

function instant(raw: string | undefined, field: string): number {
  if (raw === undefined || !raw.trim()) throw ApiError.badRequest(`${field} is required`)
  const text = raw.trim()
  const value = /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : Date.parse(text)
  if (!Number.isFinite(value)) throw ApiError.badRequest(`${field} is not a date or an epoch instant`)
  return Math.trunc(value)
}

/** A range of at most two years, with both ends given as epoch milliseconds or ISO instants. */
export function parseRange(from: string | undefined, to: string | undefined): ParsedRange {
  const fromMs = instant(from, 'from')
  const toMs = instant(to, 'to')
  if (fromMs >= toMs) throw ApiError.badRequest('from must be before to')
  if (toMs - fromMs > CALENDAR_RANGE_MAX_MS) {
    throw ApiError.badRequest('The range may not span more than two years')
  }
  return { fromMs, toMs }
}

/** The `calendarIds` query parameter: a comma-separated list of entity ids, or nothing. */
export function parseCalendarIdList(raw: string | undefined): string[] | undefined {
  if (raw === undefined || !raw.trim()) return undefined
  const ids: string[] = []
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const id = entityId(trimmed, 'calendarIds')
    if (!ids.includes(id)) ids.push(id)
  }
  if (ids.length === 0) return undefined
  if (ids.length > 1_000) throw ApiError.badRequest('Too many calendars named')
  return ids
}

export function parseReorder(value: unknown): string[] {
  const record = requireRecord(value, 'order')
  if (!Array.isArray(record.ids)) throw ApiError.badRequest('ids must be an array')
  if (record.ids.length === 0) throw ApiError.badRequest('ids may not be empty')
  if (record.ids.length > MAX_EVENTS_PER_BATCH) throw ApiError.badRequest('ids is too long')
  const ids = record.ids.map((id) => entityId(id, 'ids'))
  if (new Set(ids).size !== ids.length) throw ApiError.badRequest('ids must not repeat')
  return ids
}

/** A revision query parameter, or null when the caller did not send one. */
export function parseRevQuery(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw ApiError.badRequest('rev must be a positive integer')
  return value
}

/** Kept for the route's 404-on-malformed decision; the shared predicate is the single authority. */
export function parseEntityId(value: unknown, field: string): string {
  return entityId(value, field)
}
