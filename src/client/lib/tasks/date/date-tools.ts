import { dateKey } from '../../../lib/time'

/**
 * The `YYYY-MM-DD` a task line carries, or nothing when there is no date to write.
 *
 * An invalid date also answers empty here, which is deliberately *not* what the serializer writes:
 * dropping `📅 2022-02-30` on a round-trip would quietly edit the reader's note, so the serializer
 * keeps the original text instead. See the invalid-date rule in the port plan.
 */
export function formatTaskDate(date: Date | null): string {
  return date === null || !Number.isFinite(date.getTime()) ? '' : dateKey(date)
}

/** A date that was written in the right shape but names no real day, such as `2022-02-30`. */
export function isInvalidTaskDate(date: Date | null): boolean {
  return date !== null && !Number.isFinite(date.getTime())
}

/**
 * Order two task dates.
 *
 * Dated tasks come before undated ones, and among dated tasks the unparseable shape sorts first:
 * a reader scanning a list wants the broken dates where they can be seen, not parked at the end.
 */
export function compareTaskDates(a: Date | null, b: Date | null): -1 | 0 | 1 {
  if (a !== null && b === null) return -1
  if (a === null && b !== null) return 1
  if (a === null || b === null) return 0
  const aInvalid = !Number.isFinite(a.getTime())
  const bInvalid = !Number.isFinite(b.getTime())
  if (aInvalid && !bInvalid) return -1
  if (!aInvalid && bInvalid) return 1
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
