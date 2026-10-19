/**
 * Time zones, done once.
 *
 * Three rules, and every caller in this app follows them:
 *  - stored times are epoch milliseconds, so a comparison is a comparison and never a string parse;
 *  - "what day is it for this reader" is answered by resolving the instant into the account's zone and
 *    reading the calendar fields back, never by `Date.getDate()` on the server's own clock;
 *  - a bare `YYYY-MM-DD` input means midnight *in the reader's zone*, which is why
 *    `parseDateInputInTimezone` exists — `new Date('2026-05-24')` is UTC midnight, and a reader eight
 *    hours east would see the day before.
 *
 * The reference project learned the last one the hard way (its issue #166: a subscription created
 * between midnight and 08:00 got yesterday's default date). The implementation below is a port of the
 * module that fixed it, minus the compatibility shims nobody calls.
 */

export const MS_PER_HOUR = 1000 * 60 * 60
export const MS_PER_DAY = MS_PER_HOUR * 24

export interface TimezoneDateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export interface TimezoneNow {
  /** The instant itself. A `Date` is always an absolute moment; the zone only changes how it reads. */
  utc: Date
  parts: TimezoneDateParts
  hourString: string
  isoLocal: string
  timezone: string
}

export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || timezone.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

function safeTimezone(timezone: string | undefined): string {
  return timezone && isValidTimezone(timezone) ? timezone : 'UTC'
}

/**
 * The calendar fields of an instant, in a zone.
 *
 * `Intl` is the only implementation here on purpose: it carries the zone database, including the
 * daylight-saving rules a hand-rolled offset would get wrong twice a year.
 */
export function getTimezoneDateParts(date: Date | string | number, timezone = 'UTC'): TimezoneDateParts {
  const tz = safeTimezone(timezone)
  const value = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(value.getTime())) return getTimezoneDateParts(new Date(), tz)
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const parts = formatter.formatToParts(value)
    const pick = (type: Intl.DateTimeFormatPartTypes): number => {
      const part = parts.find((entry) => entry.type === type)
      return part ? Number(part.value) : 0
    }
    // Some runtimes print midnight as 24 under `hour12: false`; the field is 0-23 everywhere else.
    const hour = pick('hour') === 24 ? 0 : pick('hour')
    return {
      year: pick('year'),
      month: pick('month'),
      day: pick('day'),
      hour,
      minute: pick('minute'),
      second: pick('second'),
    }
  } catch {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
      hour: value.getUTCHours(),
      minute: value.getUTCMinutes(),
      second: value.getUTCSeconds(),
    }
  }
}

export function getNowInTimezone(timezone = 'UTC', now?: Date): TimezoneNow {
  const tz = safeTimezone(timezone)
  const utc = now instanceof Date ? new Date(now.getTime()) : new Date()
  const parts = getTimezoneDateParts(utc, tz)
  return {
    utc,
    parts,
    hourString: String(parts.hour).padStart(2, '0'),
    isoLocal: `${formatPartsAsDate(parts)}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`,
    timezone: tz,
  }
}

/** The `YYYY-MM-DD` a reader in this zone is looking at right now. */
export function getTodayDateStringInTimezone(timezone = 'UTC', now?: Date): string {
  return formatPartsAsDate(getNowInTimezone(timezone, now).parts)
}

/**
 * The UTC instant of the zone's own midnight for the day an instant falls on.
 *
 * Worked out by probing: take the calendar fields as if they were UTC, ask the zone what those fields
 * read as, and the difference is the offset in force that day — which is the only way to be right on
 * the two days a year the offset changes.
 */
export function getTimezoneMidnightTimestamp(date: Date | string | number, timezone = 'UTC'): number {
  const tz = safeTimezone(timezone)
  const { year, month, day } = getTimezoneDateParts(date, tz)
  const asUtc = Date.UTC(year, month - 1, day, 0, 0, 0)
  const probe = getTimezoneDateParts(new Date(asUtc), tz)
  const probeAsUtc = Date.UTC(probe.year, probe.month - 1, probe.day, probe.hour, probe.minute, probe.second)
  return asUtc - (probeAsUtc - asUtc)
}

/** How many local midnights lie between two instants. Negative when `to` is the earlier one. */
export function getDaysBetween(from: Date | string | number, to: Date | string | number, timezone = 'UTC'): number {
  const tz = safeTimezone(timezone)
  return Math.round((getTimezoneMidnightTimestamp(to, tz) - getTimezoneMidnightTimestamp(from, tz)) / MS_PER_DAY)
}

/** The instant a set of calendar fields names, in a zone. `NaN` when the fields do not exist. */
export function getTimestampForTimezoneParts(
  parts: Partial<TimezoneDateParts> & Pick<TimezoneDateParts, 'year' | 'month' | 'day'>,
  timezone = 'UTC',
): number {
  const tz = safeTimezone(timezone)
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  const hour = Number(parts.hour ?? 0)
  const minute = Number(parts.minute ?? 0)
  const second = Number(parts.second ?? 0)
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (
    Number.isNaN(probe.getTime())
    || probe.getUTCFullYear() !== year
    || probe.getUTCMonth() + 1 !== month
    || probe.getUTCDate() !== day
    || probe.getUTCHours() !== hour
  ) return Number.NaN
  const asUtc = probe.getTime()
  const probeParts = getTimezoneDateParts(probe, tz)
  const probeAsUtc = Date.UTC(probeParts.year, probeParts.month - 1, probeParts.day, probeParts.hour, probeParts.minute, probeParts.second)
  return asUtc - (probeAsUtc - asUtc)
}

/**
 * Read a date the way a reader typed it.
 *
 * A bare calendar date means that day's midnight in their zone; anything carrying a time or an offset
 * is an absolute instant and is taken at face value.
 */
export function parseDateInputInTimezone(value: Date | string | number, timezone = 'UTC'): Date {
  if (value instanceof Date) return new Date(value.getTime())
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim())
    if (match) {
      return new Date(getTimestampForTimezoneParts(
        { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
        timezone,
      ))
    }
  }
  return new Date(value)
}

/** The `YYYY-MM-DD` that belongs in a date input for an instant. */
export function formatDateInputInTimezone(value: Date | string | number, timezone = 'UTC'): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return formatPartsAsDate(getTimezoneDateParts(date, timezone))
}

/**
 * Add whole days, months or years the way a calendar does — in the reader's zone, from their midnight.
 *
 * `Date.setMonth` would carry the server's own offset into the result, and on the last day of a month
 * it rolls over into the next one. Going through the calendar fields fixes the offset; clamping the
 * day fixes the rollover, so "monthly from the 31st" lands on the 28th of February rather than the
 * third of March. The reference project left that rollover in place for solar cycles while its lunar
 * path clamped, which is the kind of difference a reader only notices a year later.
 */
export function addCalendarPeriodInTimezone(
  value: Date | string | number,
  amount: number,
  unit: 'day' | 'month' | 'year',
  timezone = 'UTC',
): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return new Date(Number.NaN)
  const parts = getTimezoneDateParts(date, timezone)
  let year = parts.year
  let month = parts.month
  let day = parts.day

  if (unit === 'day') {
    const shifted = new Date(Date.UTC(year, month - 1, day + amount))
    year = shifted.getUTCFullYear()
    month = shifted.getUTCMonth() + 1
    day = shifted.getUTCDate()
  } else {
    // The month is worked out arithmetically rather than by `setUTCMonth`, which rolls the 31st of
    // January into March before there is anything to clamp.
    const months = unit === 'month' ? amount : amount * 12
    const total = year * 12 + (month - 1) + months
    year = Math.floor(total / 12)
    month = (total % 12) + 1
    day = Math.min(day, daysInMonth(year, month))
  }

  return new Date(getTimestampForTimezoneParts({ year, month, day, hour: 0, minute: 0, second: 0 }, timezone))
}

/** Days in a solar month, February included. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export type DateFormat = 'date' | 'datetime' | 'full' | 'isoLocal'

/**
 * Format an instant for display, in a zone, without the browser's locale deciding the shape.
 *
 * The app ships two languages and a date that switches between `05/24/2026` and `2026/05/24` when the
 * interface language changes is a second, quieter localization nobody asked for. `YYYY-MM-DD` reads
 * the same in both.
 */
export function formatLocalDate(time: Date | string | number, timezone = 'UTC', format: DateFormat = 'full'): string {
  const date = time instanceof Date ? time : new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  const parts = getTimezoneDateParts(date, timezone)
  const time24 = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
  if (format === 'date') return formatPartsAsDate(parts)
  if (format === 'isoLocal') return `${formatPartsAsDate(parts)}T${time24}:${String(parts.second).padStart(2, '0')}`
  if (format === 'datetime') return `${formatPartsAsDate(parts)} ${time24}:${String(parts.second).padStart(2, '0')}`
  return `${formatPartsAsDate(parts)} ${time24}`
}

/** The zone's offset from UTC in whole hours, as of now. */
export function getTimezoneOffset(timezone = 'UTC'): number {
  const tz = safeTimezone(timezone)
  const now = new Date()
  const parts = getTimezoneDateParts(now, tz)
  const zoned = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((zoned - now.getTime()) / MS_PER_HOUR) + 0
}

/** `UTC+8`, `UTC-5`, `UTC+5.5` — the half-hour zones exist and a rounded label would be a lie. */
export function formatTimezoneOffset(timezone = 'UTC'): string {
  const offset = getTimezoneOffset(timezone)
  const sign = offset >= 0 ? '+' : '-'
  const absolute = Math.abs(offset)
  return `UTC${sign}${Number.isInteger(absolute) ? absolute : absolute.toFixed(1)}`
}

/** `YYYYMMDDHH` in a zone: the key a delivery is deduplicated on, one message per local hour. */
export function localHourKey(timezone = 'UTC', now?: Date): string {
  const parts = getNowInTimezone(timezone, now).parts
  return `${parts.year}${String(parts.month).padStart(2, '0')}${String(parts.day).padStart(2, '0')}${String(parts.hour).padStart(2, '0')}`
}

function formatPartsAsDate(parts: TimezoneDateParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}
