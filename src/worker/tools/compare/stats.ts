/**
 * Shapes the raw counts the statistics queries return into the answer the screen draws.
 *
 * The queries count what is there; this fills the days that are not. A seven-day trend that skipped
 * the day the reader did nothing would draw a line between two distant points and call it a trend,
 * so every day in the range is present with its real count — zero included.
 */
import type { CompareKind, CompareStats, CompareTrendBucket, CompareStatsRows, StatsRange } from '@shared/tools/compare/types'
import { COMPARE_KINDS } from '@shared/tools/compare/types'

const RANGE_DAYS: Readonly<Record<StatsRange, number>> = { '7d': 7, '30d': 30 }

function dayKey(timestampMs: number): string {
  const date = new Date(timestampMs)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** The last `days` UTC days, oldest first, ending with the day `now` falls in. */
export function trendDays(range: StatsRange, now: number): string[] {
  const days = RANGE_DAYS[range]
  const out: string[] = []
  for (let offset = days - 1; offset >= 0; offset--) out.push(dayKey(now - offset * 86_400_000))
  return out
}

export function shapeStats(range: StatsRange, raw: CompareStatsRows, now = Date.now()): CompareStats {
  const byKind = Object.fromEntries(COMPARE_KINDS.map((kind) => [kind, 0])) as Record<CompareKind, number>
  for (const entry of Object.entries(raw.byKind)) {
    if ((COMPARE_KINDS as readonly string[]).includes(entry[0])) byKind[entry[0] as CompareKind] = entry[1]
  }

  const trendMap = new Map(raw.trend.map((bucket) => [bucket.day, bucket.count]))
  const trend: CompareTrendBucket[] = trendDays(range, now).map((day) => ({ day, count: trendMap.get(day) ?? 0 }))

  return {
    range,
    total: raw.total,
    identical: raw.identical,
    byKind,
    averageChangedLines: raw.changedRuns > 0 ? Math.round((raw.changedLinesTotal / raw.changedRuns) * 10) / 10 : 0,
    topExtensions: raw.extensions.slice(0, 8),
    trend,
  }
}
