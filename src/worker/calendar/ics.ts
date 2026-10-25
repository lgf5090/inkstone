import ICAL from 'ical.js'
import { Temporal } from 'temporal-polyfill'
import {
  MAX_CALENDAR_NAME,
  MAX_CONFERENCE_URL,
  MAX_EVENT_META_BYTES,
  MAX_ICS_BYTES,
  MAX_ICS_EVENTS,
  MAX_RECURRENCE_RULE,
  isTemporalKind,
  temporalValueToEpochMs,
  toTemporalValue,
} from '@shared/calendar/model'
import type { CalendarEventInput, TemporalValue } from '@shared/calendar/model'

type IcalComponent = InstanceType<typeof ICAL.Component>
type IcalProperty = InstanceType<typeof ICAL.Property>
type IcalTime = InstanceType<typeof ICAL.Time>

const MAX_ICS_LINE_CHARS = 16 * 1024
const MAX_ICS_PROPERTY_CHARS = 64 * 1024
const MAX_ICS_COMPONENT_DEPTH = 4
const MAX_CATEGORIES = 100
const MAX_META_DATES = 500
const MAX_FLATTEN_ITERATIONS = 100_000
const MAX_ZONE_CACHE_ENTRIES = 500
const FLATTEN_WINDOW_YEARS = 2

export type IcsWarningCode =
  | 'cancelled_event'
  | 'duplicate_uid'
  | 'flattened'
  | 'invalid_event'
  | 'invalid_property'
  | 'invalid_recurrence'
  | 'invalid_timezone'
  | 'missing_uid'
  | 'unknown_timezone'
  | 'unsupported_component'

export interface IcsWarning {
  line: number
  uid?: string
  code: IcsWarningCode
  message: string
}

export type IcsParseErrorCode = 'invalid_ics' | 'too_large' | 'too_many_events'

export class IcsParseError extends Error {
  readonly code: IcsParseErrorCode

  constructor(code: IcsParseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'IcsParseError'
    this.code = code
  }
}

export interface IcsParseInput {
  content: string
  defaultTimeZone: string
  maxEvents: number
}

export interface IcsParseResult {
  name?: string
  events: CalendarEventInput[]
  warnings: IcsWarning[]
}

export interface IcsSerializeInput {
  name: string
  events: readonly CalendarEventInput[]
  timeZone: string
}

type TimeContext =
  | { mode: 'date' }
  | { mode: 'floating' }
  | { mode: 'zoned', zone: string, useInstant: boolean }

interface WarningContext {
  warnings: IcsWarning[]
  uid?: string
  line: number
}

const ianaZoneCache = new Map<string, string | null>()

function isIanaZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0)
    return true
  } catch {
    return false
  }
}

function normalizeIanaZone(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const cached = ianaZoneCache.get(trimmed)
  if (cached !== undefined) return cached
  let resolved: string | null = null
  if (isIanaZone(trimmed)) {
    resolved = trimmed
  } else {
    const parts = trimmed.split('/').filter(Boolean)
    for (let i = 1; i < parts.length && resolved === null; i++) {
      const candidate = parts.slice(i).join('/')
      if (isIanaZone(candidate)) resolved = candidate
    }
  }
  ianaZoneCache.set(trimmed, resolved)
  if (ianaZoneCache.size > MAX_ZONE_CACHE_ENTRIES) ianaZoneCache.clear()
  return resolved
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDate(time: IcalTime): string {
  return `${String(time.year).padStart(4, '0')}-${pad(time.month)}-${pad(time.day)}`
}

function formatDateTime(time: IcalTime): string {
  return `${formatDate(time)}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`
}

function temporalValueFor(time: IcalTime, context: TimeContext): TemporalValue {
  if (context.mode === 'date') {
    return { value: formatDate(time), type: 'date' }
  }
  if (context.mode === 'floating') {
    return { value: formatDateTime(time), type: 'datetime' }
  }
  if (context.useInstant) {
    const zoned = Temporal.Instant
      .fromEpochMilliseconds(time.toJSDate().getTime())
      .toZonedDateTimeISO(context.zone)
    return toTemporalValue(zoned)
  }
  return toTemporalValue(Temporal.ZonedDateTime.from({
    timeZone: context.zone,
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
  }))
}

function addWarning(context: WarningContext, code: IcsWarningCode, message: string): void {
  context.warnings.push({
    line: Math.max(1, context.line),
    ...(context.uid ? { uid: context.uid } : {}),
    code,
    message,
  })
}

function readTimeProperty(
  component: IcalComponent,
  name: string,
  context: WarningContext,
): { property: IcalProperty, time: IcalTime } | null {
  const property = component.getFirstProperty(name)
  if (!property) return null
  try {
    const value = property.getFirstValue()
    if (value instanceof ICAL.Time) return { property, time: value }
    addWarning(context, 'invalid_property', `${name.toUpperCase()} is not a date or date-time.`)
  } catch {
    addWarning(context, 'invalid_property', `${name.toUpperCase()} could not be read.`)
  }
  return null
}

function readText(
  component: IcalComponent,
  name: string,
  context: WarningContext,
): string | undefined {
  const property = component.getFirstProperty(name)
  if (!property) return undefined
  try {
    const value = property.getFirstValue()
    if (typeof value !== 'string') return undefined
    if (value.length > MAX_ICS_PROPERTY_CHARS) {
      throw new IcsParseError('invalid_ics', `${name.toUpperCase()} exceeds the property size limit.`)
    }
    return value
  } catch (error) {
    if (error instanceof IcsParseError) throw error
    addWarning(context, 'invalid_property', `${name.toUpperCase()} could not be read.`)
    return undefined
  }
}

function sourceFor(
  component: IcalComponent,
  fallback: IcalComponent | undefined,
  name: string,
): IcalComponent {
  return component.hasProperty(name) || !fallback ? component : fallback
}

function readRecurrenceRule(
  component: IcalComponent,
  context: WarningContext,
): string | null {
  const property = component.getFirstProperty('rrule')
  if (!property) return null
  try {
    const value = property.getFirstValue()
    const raw = value instanceof ICAL.Recur
      ? value.toString()
      : typeof value === 'string' ? value : ''
    const rule = raw.replace(/^RRULE:/i, '').trim()
    if (!rule) return null
    if (rule.length > MAX_RECURRENCE_RULE) {
      addWarning(context, 'invalid_recurrence', 'The recurrence rule exceeds the size limit and was ignored.')
      return null
    }
    return rule
  } catch {
    addWarning(context, 'invalid_recurrence', 'The recurrence rule could not be read and was ignored.')
    return null
  }
}

function readCategories(
  component: IcalComponent,
  fallback: IcalComponent | undefined,
  context: WarningContext,
): string[] {
  const source = sourceFor(component, fallback, 'categories')
  const categories: string[] = []
  for (const property of source.getAllProperties('categories')) {
    try {
      for (const value of property.getValues()) {
        if (typeof value !== 'string') continue
        const category = value.trim().slice(0, 200)
        if (category && !categories.includes(category) && categories.length < MAX_CATEGORIES) {
          categories.push(category)
        }
      }
    } catch {
      addWarning(context, 'invalid_property', 'CATEGORIES could not be read.')
    }
  }
  return categories
}

function readDatesProperty(
  component: IcalComponent,
  name: 'exdate' | 'rdate',
  context: WarningContext,
): TemporalValue[] {
  const dates: TemporalValue[] = []
  for (const property of component.getAllProperties(name)) {
    const tzid = asString(property.getFirstParameter('tzid')) ?? ''
    const zone = tzid ? normalizeIanaZone(tzid) : null
    try {
      for (const value of property.getValues()) {
        if (!(value instanceof ICAL.Time)) continue
        const timeContext: TimeContext = value.isDate
          ? { mode: 'date' }
          : zone
            ? { mode: 'zoned', zone, useInstant: false }
            : value.zone?.tzid === 'UTC'
              ? { mode: 'zoned', zone: 'UTC', useInstant: false }
              : { mode: 'floating' }
        dates.push(temporalValueFor(value, timeContext))
        if (dates.length >= MAX_META_DATES) return dates
      }
    } catch {
      addWarning(context, 'invalid_property', `${name.toUpperCase()} could not be read.`)
    }
  }
  return dates
}

function isCancelled(component: IcalComponent, context: WarningContext): boolean {
  const status = readText(component, 'status', context)
  return typeof status === 'string' && status.trim().toUpperCase() === 'CANCELLED'
}

function safeHttpUrl(value: unknown, httpsOnly: boolean): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_CONFERENCE_URL) return null
  try {
    const url = new URL(value)
    if (httpsOnly ? url.protocol !== 'https:' : (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      return null
    }
    if (url.username || url.password) return null
    return value
  } catch {
    return null
  }
}

function resolveTimeContext(
  property: IcalProperty | null,
  time: IcalTime,
  defaultTimeZone: string,
  context: WarningContext,
): TimeContext {
  if (time.isDate) return { mode: 'date' }
  const tzid = property ? asString(property.getFirstParameter('tzid'))?.trim() ?? '' : ''
  if (tzid) {
    const zone = normalizeIanaZone(tzid)
    if (zone) return { mode: 'zoned', zone, useInstant: false }
    const embeddedZone = time.zone?.tzid ?? ''
    addWarning(
      context,
      'unknown_timezone',
      `The time zone "${tzid}" is not recognized; the event was converted to ${defaultTimeZone}.`,
    )
    return {
      mode: 'zoned',
      zone: defaultTimeZone,
      useInstant: embeddedZone !== '' && embeddedZone !== 'floating' && embeddedZone !== 'UTC',
    }
  }
  if (time.zone?.tzid === 'UTC') return { mode: 'zoned', zone: 'UTC', useInstant: false }
  return { mode: 'floating' }
}

interface MapEventOptions {
  component: IcalComponent
  fallback?: IcalComponent
  uid: string
  uidLine: number
  startTime: IcalTime
  endTime: IcalTime | null
  timeContext: TimeContext
  recurrenceId?: IcalTime
  recurrenceIdContext?: TimeContext
  keepRecurrenceRule: boolean
  flattened: boolean
  warnings: IcsWarning[]
}

function mapEvent(options: MapEventOptions): CalendarEventInput {
  const warningContext: WarningContext = {
    warnings: options.warnings,
    uid: options.uid,
    line: options.uidLine,
  }
  const { component, fallback } = options
  const summary = readText(sourceFor(component, fallback, 'summary'), 'summary', warningContext)?.trim()
  const title = summary ? summary : '(Untitled)'
  const description = readText(
    sourceFor(component, fallback, 'description'),
    'description',
    warningContext,
  ) ?? ''
  const location = readText(
    sourceFor(component, fallback, 'location'),
    'location',
    warningContext,
  )?.trim()
  const categories = readCategories(component, fallback, warningContext)
  const url = readText(sourceFor(component, fallback, 'url'), 'url', warningContext)
  const conferenceUrl = readText(
    sourceFor(component, fallback, 'x-google-conference'),
    'x-google-conference',
    warningContext,
  )
  const joinUrl = safeHttpUrl(conferenceUrl, true) ?? safeHttpUrl(url, true)
  const httpUrl = safeHttpUrl(url, false)

  const start = temporalValueFor(options.startTime, options.timeContext)
  const endTime = options.endTime && options.endTime.compare(options.startTime) >= 0
    ? options.endTime
    : options.startTime
  const end = temporalValueFor(endTime, options.timeContext)
  const allDay = options.timeContext.mode === 'date'

  let recurrenceRule: string | null = null
  if (options.keepRecurrenceRule) {
    recurrenceRule = readRecurrenceRule(component, warningContext)
  }

  const meta: Record<string, unknown> = options.uid ? { originalUid: options.uid } : {}
  if (location) meta.location = location
  if (categories.length > 0) meta.categories = categories
  if (httpUrl) meta.url = httpUrl
  if (recurrenceRule) meta.recurrenceRule = recurrenceRule
  if (options.recurrenceId) {
    meta.recurrenceId = temporalValueFor(
      options.recurrenceId,
      options.recurrenceIdContext ?? options.timeContext,
    )
  }
  if (!options.flattened) {
    const exdates = readDatesProperty(component, 'exdate', warningContext)
    const rdates = readDatesProperty(component, 'rdate', warningContext)
    if (exdates.length > 0) meta.exdates = exdates
    if (rdates.length > 0) meta.rdates = rdates
  }
  if (JSON.stringify(meta).length > MAX_EVENT_META_BYTES) {
    throw new IcsParseError('invalid_ics', 'Event metadata exceeds the size limit.')
  }

  return {
    title,
    description,
    kind: 'event',
    task: null,
    conference: joinUrl ? { joinUrl } : null,
    start,
    end,
    allDay,
    meta,
    recurrenceRule,
  }
}

function mapSingleEvent(
  component: IcalComponent,
  uid: string | null,
  uidLine: number,
  defaultTimeZone: string,
  warnings: IcsWarning[],
): CalendarEventInput | null {
  const warningContext: WarningContext = { warnings, ...(uid ? { uid } : {}), line: uidLine }
  if (isCancelled(component, warningContext)) {
    addWarning(warningContext, 'cancelled_event', 'The cancelled event was skipped.')
    return null
  }
  const start = readTimeProperty(component, 'dtstart', warningContext)
  if (!start) {
    addWarning(warningContext, 'invalid_event', 'The event has no usable DTSTART and was skipped.')
    return null
  }
  let icalEvent: InstanceType<typeof ICAL.Event>
  try {
    icalEvent = new ICAL.Event(component)
  } catch {
    addWarning(warningContext, 'invalid_event', 'The event could not be read and was skipped.')
    return null
  }
  const endTime = icalEvent.endDate ?? start.time
  const recurrenceId = readTimeProperty(component, 'recurrence-id', warningContext)
  return mapEvent({
    component,
    uid: uid ?? '',
    uidLine,
    startTime: start.time,
    endTime,
    timeContext: resolveTimeContext(start.property, start.time, defaultTimeZone, warningContext),
    ...(recurrenceId ? { recurrenceId: recurrenceId.time } : {}),
    keepRecurrenceRule: !recurrenceId,
    flattened: false,
    warnings,
  })
}

interface EventGroup {
  uid: string | null
  line: number
  master: IcalComponent | null
  exceptions: IcalComponent[]
  duplicateMasters: IcalComponent[]
}

function flattenSeries(
  group: EventGroup,
  defaultTimeZone: string,
  limit: number,
  events: CalendarEventInput[],
  warnings: IcsWarning[],
): void {
  const master = group.master
  if (!master) return
  const uid = group.uid
  const warningContext: WarningContext = { warnings, ...(uid ? { uid } : {}), line: group.line }
  const masterStart = readTimeProperty(master, 'dtstart', warningContext)
  if (!masterStart) {
    addWarning(warningContext, 'invalid_event', 'The recurring event has no usable DTSTART and was skipped.')
    return
  }
  let icalEvent: InstanceType<typeof ICAL.Event>
  try {
    icalEvent = new ICAL.Event(master)
  } catch {
    addWarning(warningContext, 'invalid_event', 'The recurring event could not be read and was skipped.')
    return
  }
  for (const exception of group.exceptions) {
    try {
      icalEvent.relateException(exception)
    } catch {
      addWarning(warningContext, 'invalid_event', 'A recurrence exception could not be related to its series.')
    }
  }

  const masterContext = resolveTimeContext(
    masterStart.property,
    masterStart.time,
    defaultTimeZone,
    warningContext,
  )
  const windowEnd = masterStart.time.clone()
  windowEnd.year = masterStart.time.year + FLATTEN_WINDOW_YEARS
  const exceptionContexts = new Map<IcalComponent, TimeContext>()
  const iterator = icalEvent.iterator()
  let emitted = 0
  let iterations = 0

  try {
    for (;;) {
      const next = iterator.next() as IcalTime | null
      if (!next) break
      iterations += 1
      if (iterations > MAX_FLATTEN_ITERATIONS) {
        throw new IcsParseError('too_many_events', 'The recurring event expands beyond the supported occurrence limit.')
      }
      if (next.compare(windowEnd) > 0) break
      const details = icalEvent.getOccurrenceDetails(next)
      const item = details.item
      if (isCancelled(item.component, warningContext)) {
        addWarning(warningContext, 'cancelled_event', 'A cancelled occurrence was skipped.')
        continue
      }
      let timeContext: TimeContext
      if (item === icalEvent) {
        timeContext = masterContext
      } else {
        const cached = exceptionContexts.get(item.component)
        if (cached) {
          timeContext = cached
        } else {
          const dtstart = readTimeProperty(item.component, 'dtstart', warningContext)
          timeContext = dtstart
            ? resolveTimeContext(dtstart.property, dtstart.time, defaultTimeZone, warningContext)
            : masterContext
          exceptionContexts.set(item.component, timeContext)
        }
      }
      if (events.length >= limit) {
        throw new IcsParseError('too_many_events', `The calendar has more than ${limit} events.`)
      }
      events.push(mapEvent({
        component: item.component,
        fallback: master,
        uid: uid ?? '',
        uidLine: group.line,
        startTime: details.startDate,
        endTime: details.endDate,
        timeContext,
        recurrenceId: details.recurrenceId,
        recurrenceIdContext: masterContext,
        keepRecurrenceRule: false,
        flattened: true,
        warnings,
      }))
      emitted += 1
    }
  } catch (error) {
    if (error instanceof IcsParseError) throw error
    addWarning(warningContext, 'invalid_recurrence', 'The recurrence rule could not be expanded and the series was skipped.')
    return
  }

  addWarning(
    warningContext,
    'flattened',
    `The recurring event was flattened to ${emitted} independent occurrences within a ${FLATTEN_WINDOW_YEARS}-year window.`,
  )
}

function assertComponentDepth(node: unknown, depth: number): void {
  if (!Array.isArray(node)) return
  const [name, properties] = node
  if (typeof name !== 'string' || !Array.isArray(properties)) return
  if (depth > MAX_ICS_COMPONENT_DEPTH) {
    throw new IcsParseError('invalid_ics', 'The calendar contains components nested too deeply.')
  }
  for (let index = 2; index < node.length; index++) {
    assertComponentDepth(node[index], depth + 1)
  }
}

function buildUidLines(lines: readonly string[]): Map<string, number> {
  const uidLines = new Map<string, number>()
  lines.forEach((line, index) => {
    const match = /^UID:(.*)$/i.exec(line)
    const uid = match?.[1]?.trim()
    if (uid && !uidLines.has(uid)) uidLines.set(uid, index + 1)
  })
  return uidLines
}

export function parseIcsCalendar(input: IcsParseInput): IcsParseResult {
  const content = input.content.replace(/^\uFEFF/, '')
  const byteLength = new TextEncoder().encode(content).byteLength
  if (byteLength > MAX_ICS_BYTES) {
    throw new IcsParseError('too_large', `The calendar exceeds the ${MAX_ICS_BYTES} byte limit.`)
  }
  const lines = content.split(/\r\n|\n|\r/)
  for (const line of lines) {
    if (line.length > MAX_ICS_LINE_CHARS) {
      throw new IcsParseError('invalid_ics', 'The calendar contains a line that is too long.')
    }
  }
  if (!/BEGIN:VCALENDAR/i.test(content)) {
    throw new IcsParseError('invalid_ics', 'The content is not an iCalendar document.')
  }

  let jCal: unknown
  try {
    jCal = ICAL.parse(content)
  } catch (error) {
    throw new IcsParseError('invalid_ics', 'The calendar could not be parsed.', { cause: error })
  }
  if (Array.isArray(jCal) && Array.isArray(jCal[0])) {
    throw new IcsParseError('invalid_ics', 'Only a single VCALENDAR document is supported.')
  }
  assertComponentDepth(jCal, 0)

  let root: IcalComponent
  try {
    root = new ICAL.Component(jCal as unknown[])
  } catch (error) {
    throw new IcsParseError('invalid_ics', 'The calendar could not be read.', { cause: error })
  }
  if (root.name !== 'vcalendar') {
    throw new IcsParseError('invalid_ics', 'The content is not an iCalendar document.')
  }

  const warnings: IcsWarning[] = []
  const registeredZones: string[] = []
  for (const timezone of root.getAllSubcomponents('vtimezone')) {
    try {
      const tzid = asString(timezone.getFirstPropertyValue('tzid'))?.trim()
      if (!tzid) continue
      const existed = ICAL.TimezoneService.has(tzid)
      ICAL.TimezoneService.register(timezone)
      if (!existed) registeredZones.push(tzid)
    } catch {
      warnings.push({
        line: 1,
        code: 'invalid_timezone',
        message: 'An embedded VTIMEZONE could not be registered and was ignored.',
      })
    }
  }

  try {
    const uidLines = buildUidLines(lines)
    const defaultTimeZone = normalizeIanaZone(input.defaultTimeZone) ?? 'UTC'
    const limit = Number.isInteger(input.maxEvents) && input.maxEvents >= 0
      ? Math.min(input.maxEvents, MAX_ICS_EVENTS)
      : MAX_ICS_EVENTS
    const calendarName = (
      asString(root.getFirstPropertyValue('x-wr-calname'))
      ?? asString(root.getFirstPropertyValue('name'))
      ?? ''
    ).trim()
    const events: CalendarEventInput[] = []

    const groups = new Map<string, EventGroup>()
    const supported = new Set(['vevent', 'vtimezone'])
    let eventIndex = 0
    for (const component of root.getAllSubcomponents()) {
      if (component.name !== 'vevent') {
        if (!supported.has(component.name)) {
          warnings.push({
            line: 1,
            code: 'unsupported_component',
            message: `The ${component.name.toUpperCase()} component is not imported.`,
          })
        }
        continue
      }
      eventIndex += 1
      const uidValue = asString(component.getFirstPropertyValue('uid'))?.trim() ?? ''
      const uid = uidValue || null
      const line = uid ? uidLines.get(uid) ?? 1 : 1
      if (!uid) {
        warnings.push({
          line,
          code: 'missing_uid',
          message: 'The event has no UID; it was imported with a calendar-local identity.',
        })
      }
      const recurrenceId = component.getFirstProperty('recurrence-id')
      const key = uid ?? `\u0000missing-${eventIndex}`
      let group = groups.get(key)
      if (!group) {
        group = { uid, line, master: null, exceptions: [], duplicateMasters: [] }
        groups.set(key, group)
      }
      if (recurrenceId) {
        group.exceptions.push(component)
      } else if (!group.master) {
        group.master = component
      } else {
        group.duplicateMasters.push(component)
      }
    }

    for (const group of groups.values()) {
      if (group.duplicateMasters.length > 0) {
        warnings.push({
          line: group.line,
          ...(group.uid ? { uid: group.uid } : {}),
          code: 'duplicate_uid',
          message: 'Additional events with the same UID were skipped.',
        })
      }
      if (!group.master) {
        for (const exception of group.exceptions) {
          const event = mapSingleEvent(exception, group.uid, group.line, defaultTimeZone, warnings)
          if (!event) continue
          if (events.length >= limit) {
            throw new IcsParseError('too_many_events', `The calendar has more than ${limit} events.`)
          }
          events.push(event)
        }
        continue
      }
      const masterWarningContext: WarningContext = {
        warnings,
        ...(group.uid ? { uid: group.uid } : {}),
        line: group.line,
      }
      if (isCancelled(group.master, masterWarningContext)) {
        addWarning(masterWarningContext, 'cancelled_event', 'The cancelled event was skipped.')
        continue
      }
      const hasExceptions = group.exceptions.length > 0
        || group.master.hasProperty('exdate')
        || group.master.hasProperty('rdate')
      if (hasExceptions) {
        flattenSeries(group, defaultTimeZone, limit, events, warnings)
        continue
      }
      const event = mapSingleEvent(group.master, group.uid, group.line, defaultTimeZone, warnings)
      if (!event) continue
      if (events.length >= limit) {
        throw new IcsParseError('too_many_events', `The calendar has more than ${limit} events.`)
      }
      events.push(event)
    }

    return {
      ...(calendarName ? { name: calendarName.slice(0, MAX_CALENDAR_NAME) } : {}),
      events,
      warnings,
    }
  } finally {
    for (const tzid of registeredZones) {
      ICAL.TimezoneService.remove(tzid)
    }
  }
}

function metaOf(event: CalendarEventInput): Record<string, unknown> {
  const meta = event.meta
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : {}
}

function temporalValueFrom(value: unknown): TemporalValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.value !== 'string' || !isTemporalKind(record.type)) return null
  if (record.timeZone !== undefined && typeof record.timeZone !== 'string') return null
  return {
    value: record.value,
    type: record.type,
    ...(typeof record.timeZone === 'string' && record.timeZone ? { timeZone: record.timeZone } : {}),
  }
}

function metaDates(meta: Record<string, unknown>, key: 'exdates' | 'rdates'): TemporalValue[] {
  const raw = meta[key]
  if (!Array.isArray(raw)) return []
  return raw
    .map(temporalValueFrom)
    .filter((value): value is TemporalValue => value !== null)
    .slice(0, MAX_META_DATES)
}

function zonedFrom(value: TemporalValue): Temporal.ZonedDateTime {
  if (value.value.includes('[')) return Temporal.ZonedDateTime.from(value.value)
  const plain = Temporal.PlainDateTime.from(value.value)
  return Temporal.ZonedDateTime.from({
    timeZone: value.timeZone ?? 'UTC',
    year: plain.year,
    month: plain.month,
    day: plain.day,
    hour: plain.hour,
    minute: plain.minute,
    second: plain.second,
  })
}

function addTimeProperty(
  component: IcalComponent,
  name: string,
  value: TemporalValue,
): void {
  if (value.type === 'date') {
    const time = ICAL.Time.fromDateString(Temporal.PlainDate.from(value.value).toString())
    component.addPropertyWithValue(name, time)
    return
  }
  if (value.type === 'datetime') {
    const time = ICAL.Time.fromDateTimeString(
      Temporal.PlainDateTime.from(value.value).toString({ smallestUnit: 'second' }),
    )
    component.addPropertyWithValue(name, time)
    return
  }
  const zoned = zonedFrom(value)
  if (zoned.timeZoneId === 'UTC') {
    const time = ICAL.Time.fromJSDate(new Date(zoned.epochMilliseconds), true)
    component.addPropertyWithValue(name, time)
    return
  }
  const time = ICAL.Time.fromDateTimeString(
    zoned.toPlainDateTime().toString({ smallestUnit: 'second' }),
  )
  const property = component.addPropertyWithValue(name, time)
  property.setParameter('tzid', zoned.timeZoneId)
}

function uidFor(event: CalendarEventInput, index: number): string {
  const meta = metaOf(event)
  const originalUid = meta.originalUid
  if (typeof originalUid === 'string' && originalUid.trim()) return originalUid.trim()
  if (typeof event.id === 'string' && event.id) return event.id
  return `inkstone-${index + 1}@calendar.local`
}

function sortKey(event: CalendarEventInput, fallbackTimeZone: string, index: number): number {
  try {
    return temporalValueToEpochMs(event.start, fallbackTimeZone)
  } catch {
    return index
  }
}

function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function serializeIcsCalendar(input: IcsSerializeInput): string {
  const calendar = new ICAL.Component(['vcalendar', [], []])
  calendar.updatePropertyWithValue('version', '2.0')
  calendar.updatePropertyWithValue('prodid', '-//Inkstone//Calendar//EN')
  calendar.updatePropertyWithValue('calscale', 'GREGORIAN')
  const name = input.name.trim().slice(0, MAX_CALENDAR_NAME)
  if (name) calendar.updatePropertyWithValue('x-wr-calname', name)

  const ordered = input.events
    .map((event, index) => ({
      event,
      index,
      key: sortKey(event, input.timeZone, index),
      uid: uidFor(event, index),
    }))
    .sort((left, right) => left.key - right.key
      || compareText(left.uid, right.uid)
      || compareText(left.event.title, right.event.title)
      || left.index - right.index)

  const usedUids = new Set<string>()
  for (const { event, uid: baseUid } of ordered) {
    const meta = metaOf(event)
    let uid = baseUid
    let suffix = 1
    while (usedUids.has(uid)) {
      suffix += 1
      uid = `${baseUid}-${suffix}`
    }
    usedUids.add(uid)

    const vevent = new ICAL.Component('vevent')
    vevent.updatePropertyWithValue('uid', uid)
    vevent.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
    addTimeProperty(vevent, 'dtstart', event.start)
    addTimeProperty(vevent, 'dtend', event.end)
    const recurrenceId = temporalValueFrom(meta.recurrenceId)
    if (recurrenceId) addTimeProperty(vevent, 'recurrence-id', recurrenceId)

    const rule = (event.recurrenceRule
      ?? (typeof meta.recurrenceRule === 'string' ? meta.recurrenceRule : null))
      ?.replace(/^RRULE:/i, '').trim()
    if (rule) {
      if (rule.length > MAX_RECURRENCE_RULE) {
        throw new IcsParseError('invalid_ics', 'The recurrence rule exceeds the size limit.')
      }
      vevent.addPropertyWithValue('rrule', ICAL.Recur.fromString(rule))
    }
    for (const exdate of metaDates(meta, 'exdates')) addTimeProperty(vevent, 'exdate', exdate)
    for (const rdate of metaDates(meta, 'rdates')) addTimeProperty(vevent, 'rdate', rdate)

    vevent.updatePropertyWithValue('summary', event.title || '(Untitled)')
    if (event.description) vevent.updatePropertyWithValue('description', event.description)
    const location = meta.location
    if (typeof location === 'string' && location) {
      vevent.updatePropertyWithValue('location', location)
    }
    const categories = meta.categories
    if (Array.isArray(categories)) {
      let added = 0
      for (const category of categories) {
        if (typeof category !== 'string' || !category.trim()) continue
        vevent.addPropertyWithValue('categories', category.trim().slice(0, 200))
        added += 1
        if (added >= MAX_CATEGORIES) break
      }
    }

    const joinUrl = safeHttpUrl(event.conference?.joinUrl, true)
      ?? safeHttpUrl(meta.url, true)
    const pageUrl = safeHttpUrl(meta.url, false)
    const url = joinUrl ?? pageUrl
    if (url) vevent.updatePropertyWithValue('url', url)

    calendar.addSubcomponent(vevent)
  }

  return ICAL.stringify(calendar.jCal)
}
