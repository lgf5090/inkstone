/**
 * The three date conversions §6.6 requires, in one place so the picker, the calendar grid, the table
 * cell and the date filter all agree on which day a stored stamp means.
 *
 * A date value is stored at noon in the zone it was picked in, and carries that zone, so a board opened
 * in another country shows the author's day. A legacy value without a zone keeps the older reading —
 * UTC noon adjusted by the runtime offset, which is the same day for every zone within twelve hours.
 * `includeTime` values keep their instant and skip both shifts.
 */
import type { ProjectDateValue } from './model'

export const PROJECT_ONE_DAY_MS = 86_400_000

export function projectTimeZoneOffset(stamp: number): number {
  return new Date(stamp).getTimezoneOffset() * 60_000
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>()

/**
 * The IANA zone this runtime is in, recorded with every date a person picks. A Worker runs in UTC, so
 * "the zone the value was written in" is the only fact that lets a stored day survive a viewer sitting
 * somewhere else.
 */
export function projectTimeZoneName(): string {
  const fromEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TZ
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function wallFormattersFor(timeZone: string): Intl.DateTimeFormat {
  const cached = wallFormatters.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  wallFormatters.set(timeZone, formatter)
  return formatter
}

function wallClock(stamp: number, timeZone: string): { year: number, month: number, day: number, hour: number, minute: number, second: number } {
  const parts = wallFormattersFor(timeZone).formatToParts(new Date(stamp))
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute'), second: read('second') }
}

/** The zone's offset at that instant, including whatever DST was in force then. */
function zoneOffsetMs(stamp: number, timeZone: string): number {
  const wall = wallClock(stamp, timeZone)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - stamp
}

/** Writer: a picked calendar day becomes the stored stamp, noon in the zone it was picked in. */
export function projectDayToStamp(day: Date, includeTime = false, timeZone?: string): number {
  if (!timeZone || includeTime) {
    const noon = new Date(day)
    noon.setHours(12, 0, 0, 0)
    const stamp = noon.getTime()
    return stamp - (includeTime ? 0 : projectTimeZoneOffset(stamp))
  }
  const noonUtc = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 12)
  return noonUtc - zoneOffsetMs(noonUtc, timeZone)
}

/** Reader: a stored stamp becomes the calendar day it was picked on, in the zone it was picked in. */
export function projectStampToDay(stamp: number, includeTime = false, timeZone?: string): Date {
  if (timeZone) {
    const wall = wallClock(stamp, timeZone)
    return new Date(wall.year, wall.month - 1, wall.day)
  }
  const day = new Date(stamp + (includeTime ? 0 : projectTimeZoneOffset(stamp)))
  day.setHours(0, 0, 0, 0)
  return day
}

/**
 * The value a writer stores: a day, an optional end day and the zone they were picked in. Keeping the
 * zone on the value rather than on the request is what lets a board opened in another country show the
 * same day the author saw.
 */
export function projectDateValue(
  day: Date,
  options: { includeTime?: boolean, to?: Date, timeZone?: string } = {},
): ProjectDateValue {
  const includeTime = options.includeTime === true
  const timeZone = options.timeZone ?? projectTimeZoneName()
  const value: ProjectDateValue = { from: projectDayToStamp(day, includeTime, timeZone) }
  if (options.to !== undefined) value.to = projectDayToStamp(options.to, includeTime, timeZone)
  if (includeTime) value.includeTime = true
  value.timeZone = timeZone
  return value
}

/** The reference also accepts a bare millisecond string, so every reader takes both shapes. */
export function parseProjectDateValue(raw: string): ProjectDateValue | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed === null || typeof parsed !== 'object') return null
      const record = parsed as { from?: unknown, to?: unknown, includeTime?: unknown, timeZone?: unknown }
      const from = typeof record.from === 'number' ? record.from : undefined
      const to = typeof record.to === 'number' ? record.to : undefined
      if (from === undefined && to === undefined) return null
      return {
        from,
        to,
        includeTime: record.includeTime === true,
        timeZone: typeof record.timeZone === 'string' ? record.timeZone : undefined,
      }
    } catch {
      return null
    }
  }
  const stamp = Number(trimmed)
  return Number.isFinite(stamp) ? { from: stamp } : null
}

/** `yyyy-mm-dd` for a native date input, read back through the same local-day conversion. */
export function projectStampToInput(stamp: number, includeTime = false, timeZone?: string): string {
  const day = projectStampToDay(stamp, includeTime, timeZone)
  const month = String(day.getMonth() + 1).padStart(2, '0')
  const date = String(day.getDate()).padStart(2, '0')
  return `${day.getFullYear()}-${month}-${date}`
}

export function projectInputToStamp(input: string, includeTime = false, timeZone?: string): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (!parts) return null
  const day = new Date(`${input}T00:00:00`)
  // V8 normalises an impossible day (2026-02-30) into March instead of failing, so compare back.
  if (Number.isNaN(day.getTime()) || day.getFullYear() !== Number(parts[1]) || day.getMonth() + 1 !== Number(parts[2]) || day.getDate() !== Number(parts[3])) return null
  return projectDayToStamp(day, includeTime, timeZone)
}

/**
 * Calendar writer: the grid's end is exclusive, so it loses a day on the way back into storage, and a
 * single-day drag stores no `to` at all (§6.6, `createDatePropertyFromCalendarDates`).
 */
export function projectCalendarRangeToValue(start: Date, end: Date, timeZone?: string): ProjectDateValue {
  const from = projectDayToStamp(start, false, timeZone)
  const last = new Date(end)
  last.setDate(last.getDate() - 1)
  const to = projectDayToStamp(last, false, timeZone)
  if (!timeZone) return to === from ? { from } : { from, to }
  return to === from ? { from, timeZone } : { from, to, timeZone }
}

/** Calendar reader: no `to` means the range covers exactly the `from` day. */
export function projectValueToCalendarRange(value: ProjectDateValue): { start: Date, end: Date } | null {
  if (value.from === undefined) return null
  const start = projectStampToDay(value.from, value.includeTime === true)
  const end = value.to === undefined
    ? new Date(start)
    : projectStampToDay(value.to, value.includeTime === true)
  end.setDate(end.getDate() + 1)
  return { start, end }
}

/**
 * The same value moved to a new start: `to` travels the same distance, so editing a start day cannot
 * silently shorten a range to a single day. `includeTime`/`timeZone` ride along because they decide
 * which of the two conversions above every reader applies.
 */
export function moveProjectDateValue(value: ProjectDateValue, from: number): ProjectDateValue {
  const moved: ProjectDateValue = { from }
  if (value.to !== undefined) moved.to = value.to + (value.from === undefined ? 0 : from - value.from)
  if (value.includeTime === true) moved.includeTime = true
  if (value.timeZone !== undefined) moved.timeZone = value.timeZone
  return moved
}