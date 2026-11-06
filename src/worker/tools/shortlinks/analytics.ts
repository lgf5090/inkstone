/**
 * Time series analytics, bucket filling, delta computation, and statistics helpers.
 */

import type { TimelineBucket, TimelineRange } from '@shared/tools/shortlinks/types'

export const RANGE_SECONDS: Record<Exclude<TimelineRange, 'all'>, number> = {
  '24h': 86400,
  '7d': 7 * 86400,
  '30d': 30 * 86400,
  '90d': 90 * 86400,
  '1y': 365 * 86400,
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function rangeToSinceTs(range: TimelineRange | undefined, now?: number): number | undefined {
  if (!range || range === 'all') return undefined
  const seconds = RANGE_SECONDS[range]
  if (!seconds) return undefined
  const ts = now ?? Math.floor(Date.now() / 1000)
  return ts - seconds
}

export function computeDelta(current: number, previous: number): number | undefined {
  if (previous === 0) return undefined
  if (current === previous) return 0
  return Math.round(((current - previous) / previous) * 100)
}

export function formatAvgPerDay(
  totalClicks: number,
  range: TimelineRange,
  createdAt: number = Math.floor(Date.now() / 1000) - 86400,
  now: number = Math.floor(Date.now() / 1000),
): string {
  let days: number
  if (range !== 'all') {
    days = RANGE_SECONDS[range] / 86400
  } else {
    const seconds = Math.max(1, now - createdAt)
    days = Math.max(1, seconds / 86400)
  }
  const avg = totalClicks / days
  if (avg === 0) return '0'
  if (avg < 1) return avg.toFixed(2)
  if (avg < 10) return avg.toFixed(1)
  return Math.round(avg).toString()
}

export function fillBuckets(
  range: TimelineRange,
  dataMap: Map<string, number>,
  now: number = Math.floor(Date.now() / 1000),
): TimelineBucket[] {
  const buckets: TimelineBucket[] = []

  if (range === '24h') {
    for (let i = 23; i >= 0; i--) {
      const t = now - i * 3600
      const d = new Date(t * 1000)
      const label = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}`
      buckets.push({ label, count: dataMap.get(label) ?? 0 })
    }
    return buckets
  }

  if (range === '7d' || range === '30d' || range === '90d') {
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
    for (let i = days - 1; i >= 0; i--) {
      const t = now - i * 86400
      const d = new Date(t * 1000)
      const label = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
      buckets.push({ label, count: dataMap.get(label) ?? 0 })
    }
    return buckets
  }

  if (range === '1y') {
    const start = new Date((now - 365 * 86400) * 1000)
    const startDay = start.getUTCDay()
    const mondayOffset = startDay === 0 ? -6 : 1 - startDay
    start.setUTCDate(start.getUTCDate() + mondayOffset)
    const end = new Date(now * 1000)
    const cursor = new Date(start)
    while (cursor <= end) {
      const label = `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`
      buckets.push({ label, count: dataMap.get(label) ?? 0 })
      cursor.setUTCDate(cursor.getUTCDate() + 7)
    }
    return buckets
  }

  return buckets
}

export function fillBucketsAll(
  dataMap: Map<string, number>,
  now: number,
  earliest: number,
  kind: 'daily' | 'weekly' | 'monthly',
): TimelineBucket[] {
  const buckets: TimelineBucket[] = []
  if (dataMap.size === 0) return buckets

  if (kind === 'daily') {
    const start = new Date(earliest * 1000)
    start.setUTCHours(0, 0, 0, 0)
    const end = new Date(now * 1000)
    end.setUTCHours(0, 0, 0, 0)
    const cursor = new Date(start)
    while (cursor <= end) {
      const label = `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`
      buckets.push({ label, count: dataMap.get(label) ?? 0 })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    return buckets
  }

  if (kind === 'weekly') {
    const start = new Date(earliest * 1000)
    const startDay = start.getUTCDay()
    const mondayOffset = startDay === 0 ? -6 : 1 - startDay
    start.setUTCDate(start.getUTCDate() + mondayOffset)
    start.setUTCHours(0, 0, 0, 0)
    const end = new Date(now * 1000)
    const cursor = new Date(start)
    while (cursor <= end) {
      const label = `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`
      buckets.push({ label, count: dataMap.get(label) ?? 0 })
      cursor.setUTCDate(cursor.getUTCDate() + 7)
    }
    return buckets
  }

  // Monthly
  const keys = [...dataMap.keys()].sort()
  const firstMonth = keys[0]
  const nowDate = new Date(now * 1000)
  const endMonth = `${nowDate.getUTCFullYear()}-${pad2(nowDate.getUTCMonth() + 1)}`
  let [y, m] = firstMonth.split('-').map(Number)
  const [endY, endM] = endMonth.split('-').map(Number)
  while (y < endY || (y === endY && m <= endM)) {
    const label = `${y}-${pad2(m)}`
    buckets.push({ label, count: dataMap.get(label) ?? 0 })
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return buckets
}

export function fillMissingOptions<T extends { name: string; count: number }>(
  items: T[],
  alwaysOn: readonly string[],
): { name: string; count: number }[] {
  const seen = new Set(items.map((i) => i.name))
  const out: { name: string; count: number }[] = items.slice()
  for (const name of alwaysOn) {
    if (!seen.has(name)) out.push({ name, count: 0 })
  }
  return out
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string, withHour: boolean): Intl.DateTimeFormat {
  const key = `${withHour ? 'hour' : 'day'}|${timeZone}`
  const cached = formatterCache.get(key)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withHour ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}),
  })
  formatterCache.set(key, formatter)
  return formatter
}

/** A browser-supplied IANA zone is untrusted input; an invalid one falls back to UTC. */
export function isValidTimeZone(timeZone: string | undefined): timeZone is string {
  if (!timeZone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
    return true
  } catch {
    return false
  }
}

function localParts(ts: number, timeZone: string, withHour: boolean): Record<string, string> {
  const parts = formatterFor(timeZone, withHour).formatToParts(new Date(ts * 1000))
  const out: Record<string, string> = {}
  for (const part of parts) out[part.type] = part.value
  return out
}

function localDateKey(ts: number, timeZone: string): string {
  const p = localParts(ts, timeZone, false)
  return `${p.year}-${p.month}-${p.day}`
}

function localHourKey(ts: number, timeZone: string): string {
  const p = localParts(ts, timeZone, true)
  return `${p.year}-${p.month}-${p.day} ${p.hour}`
}

function localMonthKey(ts: number, timeZone: string): string {
  return localDateKey(ts, timeZone).slice(0, 7)
}

/** The Monday of the local week a calendar date belongs to, expressed as a date key. */
function weekStartKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const cursor = new Date(Date.UTC(year, month - 1, day))
  const weekday = cursor.getUTCDay()
  cursor.setUTCDate(cursor.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday))
  return `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`
}

function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const cursor = new Date(Date.UTC(year, month - 1, day + days))
  return `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`
}

function shiftMonthKey(monthKey: string, months: number): string {
  const [year, month] = monthKey.split('-').map(Number)
  const cursor = new Date(Date.UTC(year, month - 1 + months, 1))
  return `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}`
}

/**
 * Buckets raw click timestamps in the reader's own calendar, not the Worker's UTC one.
 *
 * SQLite's `date(..., 'unixepoch')` is fixed to UTC, which puts an Asia/Shanghai click made after
 * local midnight into the previous day. The raw column stays UTC; only the bucket key is local.
 */
export function timelineBuckets(
  rows: { clicked_at: number }[],
  range: TimelineRange,
  now: number = Math.floor(Date.now() / 1000),
  timeZone?: string,
): TimelineBucket[] {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC'
  if (rows.length === 0 && range === 'all') return []

  const earliest = rows.length > 0 ? Math.min(...rows.map((row) => row.clicked_at)) : now
  const spanDays = (now - earliest) / 86400

  let kind: 'hour' | 'daily' | 'weekly' | 'monthly'
  if (range === '24h') kind = 'hour'
  else if (range === '1y') kind = 'weekly'
  else if (range === 'all') kind = spanDays <= 92 ? 'daily' : spanDays <= 730 ? 'weekly' : 'monthly'
  else kind = 'daily'

  const keyFor = (ts: number): string => {
    if (kind === 'hour') return localHourKey(ts, tz)
    if (kind === 'weekly') return weekStartKey(localDateKey(ts, tz))
    if (kind === 'monthly') return localMonthKey(ts, tz)
    return localDateKey(ts, tz)
  }

  const dataMap = new Map<string, number>()
  for (const row of rows) {
    const key = keyFor(row.clicked_at)
    dataMap.set(key, (dataMap.get(key) ?? 0) + 1)
  }

  const buckets: TimelineBucket[] = []
  const push = (label: string) => buckets.push({ label, count: dataMap.get(label) ?? 0 })

  if (kind === 'hour') {
    for (let i = 23; i >= 0; i--) push(localHourKey(now - i * 3600, tz))
    return buckets
  }

  if (kind === 'weekly') {
    const start = range === '1y'
      ? weekStartKey(localDateKey(now - 365 * 86400, tz))
      : weekStartKey(localDateKey(earliest, tz))
    const end = weekStartKey(localDateKey(now, tz))
    for (let cursor = start; cursor <= end; cursor = shiftDateKey(cursor, 7)) push(cursor)
    return buckets
  }

  if (kind === 'monthly') {
    const start = localMonthKey(earliest, tz)
    const end = localMonthKey(now, tz)
    for (let cursor = start; cursor <= end; cursor = shiftMonthKey(cursor, 1)) push(cursor)
    return buckets
  }

  const start = range === 'all'
    ? localDateKey(earliest, tz)
    : localDateKey(now - (range === '7d' ? 6 : range === '30d' ? 29 : 89) * 86400, tz)
  const end = localDateKey(now, tz)
  for (let cursor = start; cursor <= end; cursor = shiftDateKey(cursor, 1)) push(cursor)
  return buckets
}
