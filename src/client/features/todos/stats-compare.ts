/**
 * The equal-length window before the one on screen, and how the two differ.
 *
 * The comparison is a second read rather than one wider request: the route buckets the days it is
 * given, and a doubled range sliced in the browser would put both periods in one bucket grid whose
 * first and last buckets are partial, so the two halves would not line up with the two windows. Two
 * reads also let the comparison fall over on its own — the range's own numbers stay on screen.
 *
 * The arithmetic is deliberately cautious. A count that grew from zero has no percentage, and a rate
 * whose earlier denominator was zero has no points to compare; both answer `null` so the screen can
 * print a dash instead of an invented infinity. Rates are compared in percentage points and counts in
 * percent, because "the on-time rate rose 5 points" is the honest sentence and "rose 8%" is not.
 */
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { TaskStatsBucket, TodoStats } from '@shared/todos/model'
import { shiftDay } from './due-range'

const DAY_MS = 86_400_000

export interface StatsDayRange {
  from: string
  to: string
}

/** Inclusive calendar days in a range; a malformed pair counts as one day rather than dividing by zero. */
export function rangeLengthDays(range: StatsDayRange): number {
  const from = Date.parse(`${range.from}T00:00:00Z`)
  const to = Date.parse(`${range.to}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 1
  return Math.max(1, Math.round((to - from) / DAY_MS) + 1)
}

/** The equally long window immediately before `range`, both ends inclusive. */
export function previousRange(range: StatsDayRange): StatsDayRange {
  const days = rangeLengthDays(range)
  const to = shiftDay(range.from, -1)
  return { from: shiftDay(to, -(days - 1)), to }
}

/** Percent change between two counts; null when the earlier window was zero. */
export function countDeltaPercent(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null
  return ((current - previous) / previous) * 100
}

/** Percentage-point change between two rates; null when the earlier rate had no denominator. */
export function rateDeltaPoints(
  currentRate: number,
  previousRate: number,
  previousDenominator: number,
): number | null {
  if (!Number.isFinite(currentRate) || !Number.isFinite(previousRate) || previousDenominator <= 0) return null
  return (currentRate - previousRate) * 100
}

export type PreviousStatsStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

export interface PreviousStats {
  status: PreviousStatsStatus
  /** The earlier answer, once it landed. */
  stats: TodoStats | null
  /** The window the read names, known before the answer arrives. */
  range: StatsDayRange | null
  /** Why the comparison could not be read; shown beside the dash rather than swallowed. */
  error: string | null
}

export interface StatsRangeQuery extends StatsDayRange {
  bucket: TaskStatsBucket
}

/**
 * Read the window before `range`.
 *
 * The effect is keyed on the calendar days and the bucket, and its cleanup cancels the answer it
 * started: a reader who moves the range while the old comparison is on the wire must not see the old
 * numbers land over the new screen. A failure is a value here, not an exception — the screen keeps the
 * current KPIs and says the comparison is unavailable.
 */
export function usePreviousStats(range: StatsRangeQuery | null): PreviousStats {
  const from = range?.from ?? null
  const to = range?.to ?? null
  const bucket = range?.bucket ?? null
  const [answer, setAnswer] = useState<PreviousStats>({ status: 'idle', stats: null, range: null, error: null })
  useEffect(() => {
    if (!from || !to || !bucket) {
      setAnswer({ status: 'idle', stats: null, range: null, error: null })
      return
    }
    const window = previousRange({ from, to })
    let cancelled = false
    setAnswer({ status: 'loading', stats: null, range: window, error: null })
    api.todos.stats({ from: window.from, to: window.to, bucket }).then(
      (stats) => {
        if (!cancelled) setAnswer({ status: 'ready', stats, range: window, error: null })
      },
      (error: unknown) => {
        // The range's own numbers do not depend on this read, so the failure is reported inside the
        // comparison instead of taking the screen down; the message travels with the state.
        if (!cancelled) {
          setAnswer({
            status: 'unavailable',
            stats: null,
            range: window,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    )
    return () => { cancelled = true }
  }, [from, to, bucket])
  return answer
}
