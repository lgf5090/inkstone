/**
 * The deployment's YouTube quota panel.
 *
 * The ledger is instance-wide because the key is: a reader sees what the whole deployment spent,
 * never who spent it. Seven UTC days are always returned, today included, so the week chart has a
 * bar for every day even when nothing ran; an unconfigured deployment still answers 200 with
 * `configured: false` so the app can explain the missing key instead of showing zeros.
 */
import { Hono } from 'hono'
import {
  YOUTUBE_QUOTA_COSTS,
  type YouTubeQuotaBreakdown,
  type YouTubeQuotaData,
} from '@shared/youtube/model'
import type { AppBindings } from '../env'
import {
  utcDate,
  youtubeConfigured,
  youtubeDailyLimit,
} from './upstream'

export const youtubeQuotaRoutes = new Hono<AppBindings>()

const HISTORY_DAYS = 7
const MS_PER_DAY = 86_400_000

interface TodayRow {
  endpoint: string
  units: number
  count: number
}

interface HistoryRow {
  date: string
  units: number
  count: number
}

interface WeekRow {
  endpoint: string
  units: number
  count: number
}

function lastSevenUtcDates(today: string): string[] {
  const end = Date.parse(`${today}T00:00:00.000Z`)
  return Array.from(
    { length: HISTORY_DAYS },
    (_, index) => new Date(end - (HISTORY_DAYS - 1 - index) * MS_PER_DAY).toISOString().slice(0, 10),
  )
}

function breakdownOf(row: TodayRow | WeekRow): YouTubeQuotaBreakdown {
  return {
    endpoint: row.endpoint,
    units: Number(row.units) || 0,
    count: Number(row.count) || 0,
    cost: YOUTUBE_QUOTA_COSTS[row.endpoint] ?? 1,
  }
}

youtubeQuotaRoutes.get('/', async (c) => {
  const limit = youtubeDailyLimit(c.env)
  const today = utcDate()
  const dates = lastSevenUtcDates(today)
  const first = dates[0]!
  const last = dates[dates.length - 1]!

  const todayRows = await c.env.DB.prepare(
    'SELECT endpoint, units, count FROM youtube_quota_usage WHERE date = ? ORDER BY units DESC',
  )
    .bind(today)
    .all<TodayRow>()

  const historyRows = await c.env.DB.prepare(
    `SELECT date, COALESCE(SUM(units), 0) AS units, COALESCE(SUM(count), 0) AS count
       FROM youtube_quota_usage
      WHERE date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date ASC`,
  )
    .bind(first, last)
    .all<HistoryRow>()

  const weekRows = await c.env.DB.prepare(
    `SELECT endpoint, COALESCE(SUM(units), 0) AS units, COALESCE(SUM(count), 0) AS count
       FROM youtube_quota_usage
      WHERE date >= ? AND date <= ?
      GROUP BY endpoint
      ORDER BY units DESC`,
  )
    .bind(first, last)
    .all<WeekRow>()

  const breakdown = (todayRows.results ?? []).map(breakdownOf)
  const total = breakdown.reduce((sum, row) => sum + row.units, 0)
  const stored = new Map<string, HistoryRow>()
  for (const row of historyRows.results ?? []) stored.set(row.date, row)
  const history = dates.map((date) => {
    const row = stored.get(date)
    return {
      date,
      units: Number(row?.units ?? 0),
      count: Number(row?.count ?? 0),
    }
  })
  const weekBreakdown = (weekRows.results ?? []).map(breakdownOf)

  const payload: YouTubeQuotaData = {
    configured: youtubeConfigured(c.env),
    limit,
    today: {
      date: today,
      total,
      remaining: Math.max(0, limit - total),
      breakdown,
    },
    history,
    weekBreakdown,
    quotaCosts: { ...YOUTUBE_QUOTA_COSTS },
  }
  return c.json(payload)
})
