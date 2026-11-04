/**
 * The range arithmetic the statistics screen and its routes share.
 *
 * A range is one of three named windows, never an arbitrary pair of dates: the SQL and the chart
 * labels have to agree on how many buckets a window holds, and an unbounded input would turn a
 * dashboard request into a full-table scan. The caller's own timezone is not applied here — the
 * buckets are UTC days, which is what D1 stores and what a public distribution's visitors span.
 */

import type { ScriptStatsRange } from './types'

export const SCRIPT_STATS_RANGES: readonly ScriptStatsRange[] = ['7d', '30d', '365d']

export const SCRIPT_STATS_DAYS: Readonly<Record<ScriptStatsRange, number>> = {
  '7d': 7,
  '30d': 30,
  '365d': 365,
}

/** The number of days a range covers, and the only numbers the route accepts. */
export function parseScriptStatsRange(value: unknown): ScriptStatsRange {
  return typeof value === 'string' && (SCRIPT_STATS_RANGES as readonly string[]).includes(value)
    ? value as ScriptStatsRange
    : '30d'
}

/** The first instant in the window, in milliseconds. */
export function scriptStatsSince(range: ScriptStatsRange, now = Date.now()): number {
  return now - SCRIPT_STATS_DAYS[range] * 24 * 60 * 60 * 1000
}

/** The first instant in the window, in seconds, for the event table's `at` column. */
export function scriptStatsSinceSeconds(range: ScriptStatsRange, now = Date.now()): number {
  return Math.floor(scriptStatsSince(range, now) / 1000)
}

/** How many points a daily trend may hold; the chart never draws more than this. */
export function scriptStatsDailyLimit(range: ScriptStatsRange): number {
  return SCRIPT_STATS_DAYS[range]
}

/** The day a trend row is labelled with, from the SQL `date(...)` answer. */
export function scriptStatsDayLabel(day: unknown): string {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '1970-01-01'
}

/** The share of published snippets, floored to a whole percent and guarded against a zero denominator. */
export function publishedShare(published: number, snippets: number): number {
  if (!snippets) return 0
  return Math.round((published / snippets) * 100)
}
