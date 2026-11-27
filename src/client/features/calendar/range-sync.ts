import { CALENDAR_RANGE_MAX_MS } from '@shared/calendar/model'
import { RANGE_PADDING_DAYS } from './model'

export interface CalendarRange {
  from: number
  to: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Whether one already-loaded interval completely contains the requested interval. */
export function rangeIsCovered(intervals: Array<[number, number]>, from: number, to: number): boolean {
  return intervals.some(([start, end]) => start <= from && end >= to)
}

/** The fetch window around a visible period, capped to the server's maximum answer size. */
export function paddedCalendarRange(start: number, end: number): CalendarRange {
  let from = start - RANGE_PADDING_DAYS * DAY_MS
  let to = end + RANGE_PADDING_DAYS * DAY_MS
  if (to - from > CALENDAR_RANGE_MAX_MS) {
    const center = (start + end) / 2
    from = center - CALENDAR_RANGE_MAX_MS / 2
    to = center + CALENDAR_RANGE_MAX_MS / 2
  }
  return { from, to }
}

/** Four unchanged fingerprints are free; the fifth refresh reads the rows as a backstop. */
export function canProbeRangeRevision(probedRefreshes: number): boolean {
  return probedRefreshes < 4
}

export function nextRevisionProbeCount(probedRefreshes: number, unchanged: boolean): number {
  if (probedRefreshes >= 4) return 0
  return unchanged ? probedRefreshes + 1 : probedRefreshes
}
