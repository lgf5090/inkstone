import { addUnits, startOfDay } from '../../../lib/time'

/**
 * The three dates a recurrence rule moves together.
 *
 * Only these three: `created`, `done` and `cancelled` describe what already happened to an
 * instance, so carrying them into the next occurrence would be rewriting history.
 */
export interface OccurrenceDates {
  startDate: Date | null
  scheduledDate: Date | null
  dueDate: Date | null
}

export interface OccurrenceOptions {
  /**
   * Whether the reader asked for the scheduled date to be dropped on each new occurrence.
   *
   * It changes which date the rule is anchored to, not merely which dates get written: if the
   * scheduled date is going to be deleted anyway, anchoring to it would drift the whole series.
   */
  removeScheduledDateOnRecurrence?: boolean
}

function valid(date: Date | null): date is Date {
  return date !== null && Number.isFinite(date.getTime())
}

/**
 * One instance of a recurring task, in terms of the dates that define when it is due.
 *
 * All three dates are civil days with the clock stripped, because every comparison the recurrence
 * layer makes is a comparison of days, and an instance that kept its creation time would answer
 * `due on 2026-10-19` differently depending on when the reader happened to tick it.
 */
export class Occurrence implements OccurrenceDates {
  readonly startDate: Date | null
  readonly scheduledDate: Date | null
  readonly dueDate: Date | null

  private readonly options: OccurrenceOptions

  constructor(dates: OccurrenceDates, options: OccurrenceOptions = {}) {
    this.startDate = dates.startDate === null ? null : startOfDay(dates.startDate)
    this.scheduledDate = dates.scheduledDate === null ? null : startOfDay(dates.scheduledDate)
    this.dueDate = dates.dueDate === null ? null : startOfDay(dates.dueDate)
    this.options = options
  }

  /**
   * The date the rest of the series is measured from: due beats scheduled beats start.
   *
   * A task that is due on Friday and starts on Monday is a Friday thing that happens to have a
   * lead time, and the reader expects the next occurrence to keep that lead time rather than the
   * Friday-to-Friday gap.
   */
  get referenceDate(): Date | null {
    const order = this.options.removeScheduledDateOnRecurrence
      ? [this.dueDate, this.startDate, this.scheduledDate]
      : [this.dueDate, this.scheduledDate, this.startDate]
    for (const date of order) {
      if (valid(date)) return date
    }
    return null
  }

  isIdenticalTo(other: Occurrence): boolean {
    return sameDay(this.startDate, other.startDate)
      && sameDay(this.scheduledDate, other.scheduledDate)
      && sameDay(this.dueDate, other.dueDate)
  }

  /**
   * The same series shifted onto a new reference date, keeping each date's distance from it.
   *
   * The distance is rounded to whole days rather than carried as an exact span, because a series
   * that crosses a daylight-saving change would otherwise arrive an hour early or late and land on
   * the wrong side of a `due before today` filter.
   */
  next(nextReferenceDate: Date): Occurrence {
    const reference = this.referenceDate
    if (reference === null) {
      return new Occurrence({ startDate: null, scheduledDate: null, dueDate: null }, this.options)
    }
    const hasStart = this.startDate !== null
    const hasDue = this.dueDate !== null
    const dropScheduled = this.options.removeScheduledDateOnRecurrence === true && (hasStart || hasDue)
    return new Occurrence({
      startDate: shift(this.startDate, reference, nextReferenceDate),
      scheduledDate: dropScheduled ? null : shift(this.scheduledDate, reference, nextReferenceDate),
      dueDate: shift(this.dueDate, reference, nextReferenceDate),
    }, this.options)
  }
}

function shift(date: Date | null, from: Date, to: Date): Date | null {
  if (date === null) return null
  const days = Math.round((date.getTime() - from.getTime()) / 86_400_000)
  return addUnits(startOfDay(to), days, 'day')
}

function sameDay(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b
  return a.getTime() === b.getTime()
}
