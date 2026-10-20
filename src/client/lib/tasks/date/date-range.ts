import {
  addUnits,
  dateKey,
  endOfDay,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  endOfYear,
  startOfDay,
  startOfMonth,
  startOfIsoWeek,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  type WeekStartDay,
} from '../../../lib/time'

/** ISO-8601 weeks, which is what `last week` and `2026-W10` both have to agree on. */
const ISO_WEEK_START: WeekStartDay = 1

export type RelativeUnit = 'week' | 'month' | 'quarter' | 'year'

/**
 * An inclusive span between two civil days.
 *
 * Both bounds are normalised to local midnight so a range compares cleanly against a task date that
 * has been stripped to its day, and a reversed pair is silently re-ordered because the reader's
 * intent is the span, not its direction. Invalid input stays invalid rather than collapsing to a
 * real day, so `due date is invalid` remains answerable.
 */
export class DateRange {
  start: Date
  end: Date

  constructor(start: Date, end: Date) {
    const earlier = end < start ? end : start
    const later = end < start ? start : end
    this.start = startOfDay(earlier)
    this.end = startOfDay(later)
  }

  /** The span of the week, month, quarter or year that `now` falls in. */
  static buildRelative(unit: RelativeUnit, now: Date): DateRange {
    switch (unit) {
      case 'week':
        return new DateRange(startOfWeek(now, ISO_WEEK_START), endOfWeek(now, ISO_WEEK_START))
      case 'month':
        return new DateRange(startOfMonth(now), endOfMonth(now))
      case 'quarter':
        return new DateRange(startOfQuarter(now), endOfQuarter(now))
      case 'year':
        return new DateRange(startOfYear(now), endOfYear(now))
    }
  }

  /** A range that answers false to `isValid()`, used once every parser has failed. */
  static buildInvalid(): DateRange {
    const invalid = new Date(Number.NaN)
    return new DateRange(invalid, invalid)
  }

  isValid(): boolean {
    return Number.isFinite(this.start.getTime()) && Number.isFinite(this.end.getTime())
  }

  /**
   * Step the whole range back by one `unit`.
   *
   * Months and quarters are re-widened afterwards because their day counts differ, so stepping a
   * range that already spans a whole month lands on the previous whole month, not a short one.
   */
  moveToPrevious(unit: RelativeUnit): void {
    this.start = startOfDay(addUnits(this.start, -1, unit))
    this.end = startOfDay(addUnits(this.end, -1, unit))
    if (unit === 'month' || unit === 'quarter') {
      this.end = startOfDay(unit === 'month' ? endOfMonth(this.end) : endOfQuarter(this.end))
    }
  }

  moveToNext(unit: RelativeUnit): void {
    this.start = startOfDay(addUnits(this.start, 1, unit))
    this.end = startOfDay(addUnits(this.end, 1, unit))
    if (unit === 'month' || unit === 'quarter') {
      this.end = startOfDay(unit === 'month' ? endOfMonth(this.end) : endOfQuarter(this.end))
    }
  }

  /** `YYYY-MM-DD to YYYY-MM-DD`, for error messages and the explain tree. */
  describe(): string {
    if (!this.isValid()) return 'invalid'
    return `${dateKey(this.start)} to ${dateKey(this.end)}`
  }
}

/**
 * The whole span named by a numbered date: `2022`, `2022-03`, `2022-Q2` or `2022-W10`.
 *
 * Weeks are ISO-8601, so `2026-W01` is the Monday-based row holding this year's first Thursday
 * rather than the row holding January 1st.
 */
export function numberedDateRange(input: string): DateRange | null {
  const trimmed = input.trim()

  if (/^\d{4}$/.test(trimmed)) {
    const year = Number(trimmed)
    return new DateRange(new Date(year, 0, 1), endOfDay(new Date(year, 11, 31)))
  }

  const quarter = /^(\d{4})-Q([1-4])$/i.exec(trimmed)
  if (quarter) {
    const start = new Date(Number(quarter[1]), Number(quarter[2]) * 3 - 3, 1)
    return new DateRange(start, endOfQuarter(start))
  }

  const month = /^(\d{4})-(\d{2})$/.exec(trimmed)
  if (month) {
    const monthNumber = Number(month[2])
    if (monthNumber < 1 || monthNumber > 12) return null
    const start = new Date(Number(month[1]), monthNumber - 1, 1)
    return new DateRange(start, endOfMonth(start))
  }

  const week = /^(\d{4})-W(\d{2})$/i.exec(trimmed)
  if (week) {
    const weekNumber = Number(week[2])
    if (weekNumber < 1 || weekNumber > 53) return null
    const start = startOfIsoWeek(Number(week[1]), weekNumber)
    return new DateRange(start, endOfWeek(start, ISO_WEEK_START))
  }

  return null
}
