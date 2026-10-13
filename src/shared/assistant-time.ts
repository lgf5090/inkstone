/**
 * Conversions between what a reader types and what a database stores.
 *
 * Due dates and schedules are entered as wall-clock readings ("tomorrow at 9"), stored as UTC
 * milliseconds, and shown again in the reader's timezone. All three steps have to agree, or a task
 * written in Shanghai appears a day early in Berlin — which is why the helpers live in one shared
 * module rather than beside each caller.
 */

import { getZonedParts, isValidCalendarDate, zonedTimeToUtc } from './assistant-schedule'

const LOCAL_DATE_OR_MINUTE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/

/**
 * A local date, a local date-time, or a full ISO timestamp, as UTC milliseconds.
 *
 * A date with no time means "by the end of that day": a due date of 2026-03-05 that reads as midnight
 * is overdue before the day has started, which is not what anyone means by it.
 */
export function parseLocalTime(value: string, timeZone: string): number | null {
  const trimmed = value.trim()
  const match = LOCAL_DATE_OR_MINUTE.exec(trimmed)
  if (match) {
    const [, year, month, day, hour, minute] = match
    const hasTime = hour !== undefined
    if (!isValidCalendarDate(Number(year), Number(month), Number(day))) return null
    if (hasTime && (Number(hour) > 23 || Number(minute) > 59)) return null
    const instant = zonedTimeToUtc(
      Number(year), Number(month), Number(day),
      hasTime ? Number(hour) : 23, hasTime ? Number(minute) : 59,
      timeZone,
    )
    return Number.isNaN(instant.getTime()) ? null : instant.getTime()
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    const parsed = Date.parse(trimmed)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/** UTC millisecond boundaries of the reader's current local day. */
export function localDayBounds(timeZone: string, at = new Date()): { start: number, end: number } {
  const parts = getZonedParts(at, timeZone)
  const start = zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, timeZone)
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1))
  const end = zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone)
  return { start: start.getTime(), end: end.getTime() }
}

/** `YYYY-MM-DDTHH:MM` in the reader's timezone, for a datetime input's value. */
export function toLocalMinute(instant: number | Date, timeZone: string): string {
  const parts = getZonedParts(new Date(instant), timeZone)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`
}

/** A date the model can read back: the reader's calendar day, not a UTC one. */
export function localDate(instant: number | Date, timeZone: string): string {
  return toLocalMinute(instant, timeZone).slice(0, 10)
}

/** The clock line the system prompt carries. */
export function describeLocalTime(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      dateStyle: 'full',
      timeStyle: 'short',
      hourCycle: 'h23',
    }).format(instant)
  } catch {
    return instant.toISOString()
  }
}
