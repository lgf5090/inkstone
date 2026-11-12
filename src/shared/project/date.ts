/**
 * The three date conversions §6.6 requires, in one place so the picker, the calendar grid, the table
 * cell and the date filter all agree on which day a stored stamp means.
 *
 * A date value is stored at UTC noon: the writer takes the picked day at LOCAL noon (so a DST switch
 * cannot move it to the previous day) and subtracts the zone offset; the reader adds the offset back
 * and floors to local midnight. `includeTime` values keep their instant and skip both shifts.
 */
import type { ProjectDateValue } from './model'

export const PROJECT_ONE_DAY_MS = 86_400_000

export function projectTimeZoneOffset(stamp: number): number {
  return new Date(stamp).getTimezoneOffset() * 60_000
}

/** Writer: a picked calendar day becomes the stored stamp. */
export function projectDayToStamp(day: Date, includeTime = false): number {
  const noon = new Date(day)
  noon.setHours(12, 0, 0, 0)
  const stamp = noon.getTime()
  return stamp - (includeTime ? 0 : projectTimeZoneOffset(stamp))
}

/** Reader: a stored stamp becomes the local calendar day it was picked on. */
export function projectStampToDay(stamp: number, includeTime = false): Date {
  const day = new Date(stamp + (includeTime ? 0 : projectTimeZoneOffset(stamp)))
  day.setHours(0, 0, 0, 0)
  return day
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
export function projectStampToInput(stamp: number, includeTime = false): string {
  const day = projectStampToDay(stamp, includeTime)
  const month = String(day.getMonth() + 1).padStart(2, '0')
  const date = String(day.getDate()).padStart(2, '0')
  return `${day.getFullYear()}-${month}-${date}`
}

export function projectInputToStamp(input: string, includeTime = false): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (!parts) return null
  const day = new Date(`${input}T00:00:00`)
  // V8 normalises an impossible day (2026-02-30) into March instead of failing, so compare back.
  if (Number.isNaN(day.getTime()) || day.getFullYear() !== Number(parts[1]) || day.getMonth() + 1 !== Number(parts[2]) || day.getDate() !== Number(parts[3])) return null
  return projectDayToStamp(day, includeTime)
}

/**
 * Calendar writer: the grid's end is exclusive, so it loses a day on the way back into storage, and a
 * single-day drag stores no `to` at all (§6.6, `createDatePropertyFromCalendarDates`).
 */
export function projectCalendarRangeToValue(start: Date, end: Date): ProjectDateValue {
  const from = projectDayToStamp(start)
  const last = new Date(end)
  last.setDate(last.getDate() - 1)
  const to = projectDayToStamp(last)
  return to === from ? { from } : { from, to }
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