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
  const ts = now ?? Math.floor(Date.now() / 1000)
  return ts - RANGE_SECONDS[range]
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
