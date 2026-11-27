/**
 * One span of time cut at the account's own midnights.
 *
 * A night shift is two days' work, and filing it whole against either one is the mistake the to-do
 * app's `completed_on` column exists to prevent: a ledger that says "three hours on Tuesday" when two
 * of them were Wednesday's is a report nobody can act on. Every segment lands on exactly one calendar
 * day, and the day is the one its start instant falls on.
 *
 * It lives here rather than beside either caller because two ledgers need it — the task time entries
 * and the habit stopwatches — and two copies of a midnight rule would disagree for exactly the hours
 * around midnight. The boundaries come from the account's zone, not UTC.
 */
import { localDate, localDayBounds } from '../assistant-time'

export interface DaySegment {
  day: string
  startAt: number
  endAt: number
}

/**
 * The segments of `[startAt, endAt)`, one per calendar day, in order.
 *
 * A zero-length span is one segment on its day — a timer started and stopped within one clock reading
 * is still a row the client can point at. A clock that went backwards produces the same single
 * segment rather than a loop, because `Math.min(endAt, bounds.end)` cannot move the cursor past its
 * own end.
 */
export function splitByLocalDay(startAt: number, endAt: number, timeZone: string): DaySegment[] {
  const segments: DaySegment[] = []
  let cursor = startAt
  do {
    const bounds = localDayBounds(timeZone, new Date(cursor))
    const segmentEnd = Math.min(endAt, bounds.end)
    segments.push({ day: localDate(cursor, timeZone), startAt: cursor, endAt: segmentEnd })
    cursor = segmentEnd
  } while (cursor < endAt)
  return segments
}
