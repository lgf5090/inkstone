import { xgetCategoryOf } from '@shared/development/xget/catalog'
import type {
  XgetCategory,
  XgetStatsCategoryTrend,
  XgetStatsSummary,
} from '@shared/development/xget/types'

const DAY_MS = 86_400_000

function utcDay(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function emptyCategoryCounts(): Record<XgetCategory, number> {
  return { code: 0, package: 0, linux: 0, misc: 0, ai: 0, registry: 0 }
}

function buildDayRange(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00.000Z`)
  const end = Date.parse(`${to}T00:00:00.000Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return []
  const days: string[] = []
  for (let cursor = start; cursor <= end; cursor += DAY_MS) {
    days.push(new Date(cursor).toISOString().slice(0, 10))
  }
  return days
}

export async function recordProxyStat(
  db: D1Database,
  platform: string | null,
  status: number,
): Promise<void> {
  try {
    const ok = status >= 200 && status < 400 ? 1 : 0
    await db
      .prepare(
        `INSERT INTO development_xget_stats (day, platform, ok, count)
         VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(day, platform, ok) DO UPDATE SET count = count + 1`,
      )
      .bind(utcDay(), platform ?? 'unknown', ok)
      .run()
  } catch (error) {
    console.warn('[inkstone] xget recordProxyStat failed', error)
  }
}

export async function readStatsSummary(
  db: D1Database,
  days: number | null,
): Promise<XgetStatsSummary> {
  const today = utcDay()
  const since = days ? utcDay(Date.now() - (days - 1) * DAY_MS) : null
  const dayFilter = since === null ? '' : 'WHERE day >= ?1'
  const dayParams = since === null ? [] : [since]

  const totalRow = await db
    .prepare(
      `SELECT COALESCE(SUM(count), 0) AS total,
              COALESCE(SUM(CASE WHEN ok = 1 THEN count ELSE 0 END), 0) AS ok
       FROM development_xget_stats ${dayFilter}`,
    )
    .bind(...dayParams)
    .first<{ total: number; ok: number }>()
  const todayRow = await db
    .prepare('SELECT COALESCE(SUM(count), 0) AS total FROM development_xget_stats WHERE day = ?1')
    .bind(today)
    .first<{ total: number }>()
  const platformRows = (
    await db
      .prepare(
        `SELECT platform, SUM(count) AS count, SUM(CASE WHEN ok = 1 THEN count ELSE 0 END) AS ok
         FROM development_xget_stats ${dayFilter}
         GROUP BY platform ORDER BY count DESC`,
      )
      .bind(...dayParams)
      .all<{ platform: string; count: number; ok: number }>()
  ).results
  const trendRows = (
    await db
      .prepare(
        `SELECT day, SUM(count) AS count, SUM(CASE WHEN ok = 1 THEN count ELSE 0 END) AS ok
         FROM development_xget_stats ${dayFilter}
         GROUP BY day ORDER BY day ASC`,
      )
      .bind(...dayParams)
      .all<{ day: string; count: number; ok: number }>()
  ).results
  const byDayPlatform = (
    await db
      .prepare(
        `SELECT day, platform, SUM(count) AS count
         FROM development_xget_stats ${dayFilter}
         GROUP BY day, platform ORDER BY day ASC`,
      )
      .bind(...dayParams)
      .all<{ day: string; platform: string; count: number }>()
  ).results

  const trendMap = new Map<string, Record<XgetCategory, number>>()
  for (const row of byDayPlatform) {
    const category = xgetCategoryOf(row.platform)
    if (category === null) continue
    let counts = trendMap.get(row.day)
    if (!counts) {
      counts = emptyCategoryCounts()
      trendMap.set(row.day, counts)
    }
    counts[category] += Number(row.count)
  }

  const trendCounts = new Map(
    trendRows.map((row) => [row.day, { count: Number(row.count), ok: Number(row.ok) }]),
  )
  const firstDay = trendRows[0]?.day
  const lastDay = trendRows.at(-1)?.day
  const trendDays =
    days !== null
      ? trendRows.length > 0
        ? buildDayRange(since!, today)
        : []
      : firstDay && lastDay
        ? buildDayRange(firstDay, lastDay)
        : []
  const trend = trendDays.map((day) => ({
    day,
    count: trendCounts.get(day)?.count ?? 0,
    ok: trendCounts.get(day)?.ok ?? 0,
  }))
  const hasCategoryData = byDayPlatform.some((row) => xgetCategoryOf(row.platform) !== null)
  const trendByCategory: XgetStatsCategoryTrend[] = hasCategoryData
    ? trendDays.map((day) => ({ day, ...(trendMap.get(day) ?? emptyCategoryCounts()) }))
    : []

  const total = Number(totalRow?.total ?? 0)
  const ok = Number(totalRow?.ok ?? 0)

  return {
    total,
    ok,
    okRate: total ? Math.round((ok / total) * 1000) / 10 : 0,
    today: Number(todayRow?.total ?? 0),
    platformCount: platformRows.length,
    platforms: platformRows.map((row) => {
      const count = Number(row.count)
      return {
        platform: row.platform,
        count,
        ok: Number(row.ok),
        pct: total ? Math.round((count / total) * 1000) / 10 : 0,
      }
    }),
    trend,
    trendByCategory,
  }
}
