/**
 * Wall-clock schedules for the assistant's automations.
 *
 * Every rule is stored as a wall-clock time plus the owner's IANA timezone, because "remind me at
 * 09:00" means nine o'clock *where the reader is*, not nine o'clock in UTC. The conversions below
 * are the only place that answer that question, so a reminder, a task due date and the cron tick all
 * agree about what "today" is.
 *
 * Daylight saving:
 *  - a wall time inside the spring-forward gap runs at the first valid instant after the gap;
 *  - a wall time that occurs twice in the fall-back overlap runs once, at the earlier occurrence.
 */

import type { MessageKey } from './locales/en-US'

export type ScheduleType = 'once' | 'daily' | 'weekly' | 'monthly' | 'interval'

export interface ScheduleSpec {
  type: ScheduleType
  /** `once`: local `YYYY-MM-DDTHH:MM`. */
  at?: string
  /** `daily` / `weekly` / `monthly`: `HH:MM`, 24h. */
  time?: string
  /** `weekly`: 0 = Sunday. */
  days?: number[]
  /** `monthly`: 1-31; a month without that day uses its last day. */
  day?: number
  /** `interval`: minutes between runs. */
  minutes?: number
}

export const SCHEDULE_TYPES = ['once', 'daily', 'weekly', 'monthly', 'interval'] as const

export const INTERVAL_MIN_MINUTES = 15
export const INTERVAL_MAX_MINUTES = 60 * 24 * 31

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

/**
 * The number of days in a calendar month.
 *
 * Exported because the todo module repeats a due date by calendar month, and "the 31st in a month
 * with 30 days" has one answer in this app.
 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Reads a schedule from anything the client (or an imported file) sent. Returns null rather than
 * throwing: a stored row that does not parse must not take the whole automation list down with it.
 */
export function parseScheduleSpec(value: unknown): ScheduleSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  switch (raw.type) {
    case 'once': {
      if (typeof raw.at !== 'string' || !LOCAL_MINUTE.test(raw.at)) return null
      const [year, month, day] = raw.at.slice(0, 10).split('-').map(Number)
      if (!isValidCalendarDate(year!, month!, day!)) return null
      return { type: 'once', at: raw.at }
    }
    case 'daily':
      return typeof raw.time === 'string' && HHMM.test(raw.time) ? { type: 'daily', time: raw.time } : null
    case 'weekly': {
      if (typeof raw.time !== 'string' || !HHMM.test(raw.time)) return null
      if (!Array.isArray(raw.days) || raw.days.length < 1 || raw.days.length > 7) return null
      const days = new Set<number>()
      for (const entry of raw.days) {
        if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 6) return null
        days.add(entry)
      }
      return { type: 'weekly', time: raw.time, days: [...days].sort((a, b) => a - b) }
    }
    case 'monthly': {
      if (typeof raw.time !== 'string' || !HHMM.test(raw.time)) return null
      if (typeof raw.day !== 'number' || !Number.isInteger(raw.day) || raw.day < 1 || raw.day > 31) return null
      return { type: 'monthly', time: raw.time, day: raw.day }
    }
    case 'interval': {
      if (typeof raw.minutes !== 'number' || !Number.isInteger(raw.minutes)) return null
      if (raw.minutes < INTERVAL_MIN_MINUTES || raw.minutes > INTERVAL_MAX_MINUTES) return null
      return { type: 'interval', minutes: raw.minutes }
    }
    default:
      return null
  }
}

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday. */
  weekday: number
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone)
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    formatterCache.set(timeZone, cached)
  }
  return cached
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {}
  for (const part of formatter(timeZone).formatToParts(date)) parts[part.type] = part.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // `hourCycle: 'h23'` still reports midnight as 24 on some ICU builds.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_NAMES.indexOf(parts.weekday ?? 'Sun'),
  }
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
export function timeZoneOffsetMs(instant: number, timeZone: string): number {
  const parts = getZonedParts(new Date(instant), timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - Math.floor(instant / 1000) * 1000
}

/** A wall-clock reading in `timeZone` as a UTC instant, applying the DST rules above. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const before = timeZoneOffsetMs(wall - 36 * 3_600_000, timeZone)
  const after = timeZoneOffsetMs(wall + 36 * 3_600_000, timeZone)
  const candidates = [...new Set([wall - before, wall - after])]
    .filter((instant) => {
      const parts = getZonedParts(new Date(instant), timeZone)
      return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute
    })
    .sort((left, right) => left - right)
  if (candidates.length) return new Date(candidates[0]!)
  return new Date(wall - before)
}

function parseTime(time: string): [number, number] {
  const [hour, minute] = time.split(':').map(Number)
  return [hour!, minute!]
}

/** The next instant strictly after `after`, or null when the schedule is spent. */
export function computeNextRun(spec: ScheduleSpec, timeZone: string, after: Date): Date | null {
  if (spec.type === 'interval') {
    return new Date(after.getTime() + (spec.minutes ?? INTERVAL_MIN_MINUTES) * 60_000)
  }
  if (spec.type === 'once') {
    const parsed = parseLocalMinute(spec.at ?? '')
    if (!parsed) return null
    const instant = zonedTimeToUtc(parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute, timeZone)
    return instant.getTime() > after.getTime() ? instant : null
  }
  const [hour, minute] = parseTime(spec.time ?? '09:00')
  const start = getZonedParts(after, timeZone)
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day))
  // Walking local calendar days covers a 31-day month rule and a weekly rule that has to wait a
  // whole week; 400 steps is more than a year of days, which is the longest gap any rule can open.
  for (let step = 0; step < 400; step++) {
    const year = cursor.getUTCFullYear()
    const month = cursor.getUTCMonth() + 1
    const day = cursor.getUTCDate()
    const weekday = cursor.getUTCDay()
    const matches
      = spec.type === 'daily'
        || (spec.type === 'weekly' && (spec.days ?? []).includes(weekday))
        || (spec.type === 'monthly' && day === Math.min(spec.day ?? 1, daysInMonth(year, month)))
    if (matches) {
      const instant = zonedTimeToUtc(year, month, day, hour, minute, timeZone)
      if (instant.getTime() > after.getTime()) return instant
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return null
}

export function parseLocalMinute(value: string): { year: number, month: number, day: number, hour: number, minute: number } | null {
  if (!LOCAL_MINUTE.test(value)) return null
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  const [hour, minute] = value.slice(11).split(':').map(Number)
  if (!isValidCalendarDate(year!, month!, day!)) return null
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute! }
}

/**
 * Which locale message describes a schedule, with the parts a translation needs. The sentence itself
 * lives in the catalog: this module has no business owning interface copy, and the reference project
 * it came from hardcoded English here.
 *
 * The weekday list is the one part a caller has to name, because joining day names is locale work —
 * a Chinese reader and an English reader share neither the day words nor the separator between them. Without a
 * formatter this falls back to the English abbreviations, which is a legible last resort and nothing
 * more.
 */
export function scheduleSummary(
  spec: ScheduleSpec,
  describeDays?: (days: number[]) => string,
): { key: MessageKey, params?: Record<string, string | number> } {
  switch (spec.type) {
    case 'once':
      return { key: 'assistant.schedule.once', params: { at: (spec.at ?? '').replace('T', ' ') } }
    case 'daily':
      return { key: 'assistant.schedule.daily', params: { time: spec.time ?? '' } }
    case 'weekly': {
      const days = [...(spec.days ?? [])].sort((left, right) => left - right)
      if (days.length === 7) return { key: 'assistant.schedule.daily', params: { time: spec.time ?? '' } }
      const named = describeDays ? describeDays(days) : days.map((day) => WEEKDAY_NAMES[day]).join(', ')
      return { key: 'assistant.schedule.weekly', params: { days: named, time: spec.time ?? '' } }
    }
    case 'monthly':
      return { key: 'assistant.schedule.monthly', params: { day: spec.day ?? 1, time: spec.time ?? '' } }
    case 'interval': {
      const minutes = spec.minutes ?? INTERVAL_MIN_MINUTES
      return minutes % 60 === 0
        ? { key: 'assistant.schedule.every_hours', params: { hours: minutes / 60 } }
        : { key: 'assistant.schedule.every_minutes', params: { minutes } }
    }
    default:
      return { key: 'assistant.schedule.unknown' }
  }
}

export const WEEKDAY_ORDER = WEEKDAY_NAMES
