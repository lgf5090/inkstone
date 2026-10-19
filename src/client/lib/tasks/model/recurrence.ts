import { RRule } from 'rrule'
import { addUnits, endOfDay, startOfDay } from '../../../lib/time'
import { asLocalWallClock, asUtcWallClock } from '../date/wall-clock'
import { Occurrence } from './occurrence'

/** Everything up to an optional ` when done`, which is the only part `rrule` cannot say. */
const RULE_AND_BASE_ON_TODAY = /^([a-zA-Z0-9, !]+?)( when done)?$/i

const MONTHLY = /every( \d+)? month(s)?(.*)?/
const YEARLY = /every( \d+)? year(s)?(.*)?/

/**
 * A repetition rule, in the reader's own words.
 *
 * The rule is stored rather than evaluated so that `toText()` can write it back unchanged: a reader
 * who typed `every month on the 2nd` should not find `every 1 month on the 2nd of the month` in
 * their note after ticking the box once.
 */
export class Recurrence {
  readonly occurrence: Occurrence

  private constructor(
    private readonly rule: RRule,
    readonly baseOnToday: boolean,
    occurrence: Occurrence,
  ) {
    this.occurrence = occurrence
  }

  /**
   * Parse an English recurrence rule, or null when it does not read as one.
   *
   * A half-typed rule is the common case — the reader is still writing `every 4 weeks on` — so
   * failing here is normal and must not surface as an error in the note.
   */
  static fromText({
    recurrenceRuleText,
    occurrence,
    now,
  }: {
    recurrenceRuleText: string
    occurrence: Occurrence
    now: Date
  }): Recurrence | null {
    const matched = RULE_AND_BASE_ON_TODAY.exec(recurrenceRuleText)
    if (matched === null) return null

    const isolated = matched[1]!.trim()
    const baseOnToday = matched[2] !== undefined

    try {
      const options = RRule.parseText(isolated)
      if (options === null) return null
      const reference = baseOnToday ? null : occurrence.referenceDate
      options.dtstart = asUtcWallClock(startOfDay(reference ?? now))
      return new Recurrence(new RRule(options), baseOnToday, occurrence)
    }
    catch {
      return null
    }
  }

  toText(): string {
    const text = this.rule.toText()
    return this.baseOnToday ? `${text} when done` : text
  }

  identicalTo(other: Recurrence): boolean {
    return this.baseOnToday === other.baseOnToday
      && this.occurrence.isIdenticalTo(other.occurrence)
      && this.toText() === other.toText()
  }

  /**
   * The dates of the next instance.
   *
   * Anchored either on the original series (`every week` keeps its phase no matter when the reader
   * got round to it) or on the completion day (`when done` restarts the clock from today), which is
   * the entire difference between the two spellings.
   */
  next(now: Date): Occurrence | null {
    const nextReference = this.nextReferenceDate(now)
    if (nextReference === null) return null
    return this.occurrence.next(nextReference)
  }

  private nextReferenceDate(now: Date): Date | null {
    if (this.baseOnToday) {
      const start = startOfDay(now)
      const rule = new RRule({ ...this.rule.origOptions, dtstart: asUtcWallClock(start) })
      return this.nextAfter(endOfDay(now), rule, start)
    }
    const start = startOfDay(this.occurrence.referenceDate ?? now)
    return this.nextAfter(endOfDay(start), this.rule, start)
  }

  /**
   * The next instance after `after`.
   *
   * Monthly and yearly rules are stepped here rather than asked of `rrule`, because `rrule` fixes the
   * day of month from `dtstart` and then omits any month too short to hold it: measured on rrule
   * 2.8.1, a task due 2022-01-31 set to `every month` answers 2022-03-31 and skips February whole.
   * Stepping a whole number of intervals from the *original* start and letting the target month clamp
   * answers 2022-02-28, and stepping from the original rather than from the previous answer is what
   * keeps the series on the 31st once February is past.
   *
   * A rule that names its own day (`every month on the 31st`) is left to `rrule`: there the omission
   * is nearer the instruction than a clamp to the 28th would be.
   */
  private nextAfter(after: Date, rule: RRule, start: Date): Date | null {
    const text = this.toText()
    const monthly = MONTHLY.exec(text)
    if (monthly !== null && !text.includes(' on ')) {
      return stepFromStart(start, repeatCount(monthly[1]), 'month', after)
    }
    const yearly = YEARLY.exec(text)
    if (yearly !== null) {
      return stepFromStart(start, repeatCount(yearly[1]), 'year', after)
    }
    const next = rule.after(asUtcWallClock(after))
    return next === null ? null : asLocalWallClock(next)
  }

}

/** The first clamped multiple of `interval` units from `start` that falls strictly after `after`. */
function stepFromStart(start: Date, interval: number, unit: 'month' | 'year', after: Date): Date | null {
  for (let multiple = 1; multiple <= MAX_SERIES_STEPS; multiple++) {
    const candidate = addUnits(start, interval * multiple, unit)
    if (candidate > after) return candidate
  }
  return null
}

/** Refuses to search forever for a later day, which a zero or negative interval would require. */
const MAX_SERIES_STEPS = 400

function repeatCount(raw: string | undefined): number {
  if (raw === undefined) return 1
  const parsed = Number.parseInt(raw.trim(), 10)
  return Number.isNaN(parsed) || parsed < 1 ? 1 : parsed
}
