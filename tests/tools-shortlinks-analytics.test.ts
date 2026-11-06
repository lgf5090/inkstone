// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { timelineBuckets } from '../src/worker/tools/shortlinks/analytics'
import { purgeClicksBefore, sweepStaleShortlinkBuckets } from '../src/worker/tools/shortlinks/maintenance'
import { TOOLS_SHORTLINKS_SCHEMA_STATEMENTS } from '../src/worker/tools/shortlinks/schema'
import { ShortlinksStore } from '../src/worker/tools/shortlinks/store'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-analytics'
const TZ = 'Asia/Shanghai'

function utc(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000)
}

describe('Shortlinks analytics buckets', () => {
  it('fills an all-time range from the first click instead of returning an empty chart', () => {
    const now = utc('2026-11-07T12:00:00Z')
    const buckets = timelineBuckets(
      [
        { clicked_at: utc('2026-11-05T16:30:00Z') },
        { clicked_at: utc('2026-11-06T15:00:00Z') },
        { clicked_at: utc('2026-11-06T16:30:00Z') },
      ],
      'all',
      now,
      TZ,
    )
    expect(buckets.length).toBeGreaterThan(0)
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3)
    expect(buckets.find((bucket) => bucket.label === '2026-11-06')?.count).toBe(2)
    expect(buckets.find((bucket) => bucket.label === '2026-11-07')?.count).toBe(1)
  })

  it('moves a post-midnight Shanghai click to the local day, not the UTC day', () => {
    const now = utc('2026-11-07T12:00:00Z')
    const buckets = timelineBuckets([{ clicked_at: utc('2026-11-05T16:30:00Z') }], 'all', now, TZ)
    expect(buckets.find((bucket) => bucket.label === '2026-11-06')?.count).toBe(1)
    expect(buckets.find((bucket) => bucket.label === '2026-11-05')).toBeUndefined()
  })

  it('chooses weekly buckets for a long all-time span and monthly for a very long one', () => {
    const now = utc('2026-11-07T12:00:00Z')
    const weekly = timelineBuckets([{ clicked_at: now - 400 * 86400 }], 'all', now, 'UTC')
    expect(weekly[0].label).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const monthly = timelineBuckets([{ clicked_at: now - 900 * 86400 }], 'all', now, 'UTC')
    expect(monthly[0].label).toMatch(/^\d{4}-\d{2}$/)
  })

  it('falls back to UTC for an invalid zone', () => {
    const now = utc('2026-11-07T12:00:00Z')
    const buckets = timelineBuckets([{ clicked_at: utc('2026-11-05T23:30:00Z') }], 'all', now, 'Not/AZone')
    expect(buckets.find((bucket) => bucket.label === '2026-11-05')?.count).toBe(1)
  })

  it('keeps the fixed-size window for empty links but leaves all-time empty', () => {
    const now = utc('2026-11-07T12:00:00Z')
    expect(timelineBuckets([], '30d', now, TZ)).toHaveLength(30)
    expect(timelineBuckets([], '24h', now, TZ)).toHaveLength(24)
    expect(timelineBuckets([], 'all', now, TZ)).toHaveLength(0)
  })
})

describe('Shortlinks analytics store and retention', () => {
  let sqlite: DatabaseSync
  let store: ShortlinksStore

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    for (const statement of TOOLS_SHORTLINKS_SCHEMA_STATEMENTS) sqlite.exec(statement)
    store = new ShortlinksStore(makeD1(sqlite), USER)
  })

  afterEach(() => {
    sqlite.close()
  })

  function seedLink(totalClicks: number): number {
    const now = Math.floor(Date.now() / 1000)
    const row = sqlite
      .prepare('INSERT INTO tools_shortlinks_links (user_id, url, created_at, total_clicks) VALUES (?, ?, ?, ?)')
      .run(USER, 'https://analytics.example.com', now, totalClicks)
    const linkId = Number(row.lastInsertRowid)
    sqlite
      .prepare('INSERT INTO tools_shortlinks_slugs (slug, user_id, link_id, is_custom, is_primary, created_at) VALUES (?, ?, ?, 1, 1, ?)')
      .run('analytics-link', USER, linkId, now)
    return linkId
  }

  function seedClick(linkId: number, clickedAt: number, visitorFp: string | null): void {
    sqlite
      .prepare(
        `INSERT INTO tools_shortlinks_clicks (user_id, link_id, slug, clicked_at, visitor_fp, is_bot, is_self_referrer)
         VALUES (?, ?, 'analytics-link', ?, ?, 0, 0)`,
      )
      .run(USER, linkId, clickedAt, visitorFp)
  }

  it('reports unique visitors and an all-time timeline whose sum equals the click count', async () => {
    const now = Math.floor(Date.now() / 1000)
    const linkId = seedLink(3)
    seedClick(linkId, now - 30 * 3600, 'visitor-a')
    seedClick(linkId, now - 2 * 3600, 'visitor-a')
    seedClick(linkId, now - 3600, 'visitor-b')

    const stats = await store.getLinkAnalytics(linkId, 'all')
    expect(stats.total_clicks).toBe(3)
    expect(stats.unique_visitors).toBe(2)

    const timeline = await store.getTimeline(linkId, undefined, 'all', TZ)
    expect(timeline.buckets.length).toBeGreaterThan(0)
    expect(timeline.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(stats.total_clicks)
  })

  it('reconciles links.total_clicks when retention removes old click rows', async () => {
    const now = Math.floor(Date.now() / 1000)
    const linkId = seedLink(3)
    seedClick(linkId, now - 400 * 86400, 'old-a')
    seedClick(linkId, now - 390 * 86400, 'old-b')
    seedClick(linkId, now - 3600, 'recent')

    const removed = await purgeClicksBefore(makeD1(sqlite), now - 365 * 86400)
    expect(removed).toBe(2)
    const row = sqlite.prepare('SELECT total_clicks FROM tools_shortlinks_links WHERE id = ?').get(linkId) as {
      total_clicks: number
    }
    expect(row.total_clicks).toBe(1)
  })

  it('retires stale rate-limit and password-attempt buckets', async () => {
    const now = Math.floor(Date.now() / 1000)
    sqlite.prepare('INSERT INTO tools_shortlinks_rate_limits (bucket, count, window_start) VALUES (?, ?, ?)').run('old', 3, now - 3 * 86400)
    sqlite.prepare('INSERT INTO tools_shortlinks_rate_limits (bucket, count, window_start) VALUES (?, ?, ?)').run('fresh', 3, now - 60)
    sqlite.prepare('INSERT INTO tools_shortlinks_password_attempts (bucket, failures, window_start) VALUES (?, ?, ?)').run('old', 5, now - 3 * 86400)

    await sweepStaleShortlinkBuckets(makeD1(sqlite), now - 2 * 86400)
    expect((sqlite.prepare('SELECT COUNT(*) AS cnt FROM tools_shortlinks_rate_limits').get() as { cnt: number }).cnt).toBe(1)
    expect((sqlite.prepare('SELECT COUNT(*) AS cnt FROM tools_shortlinks_password_attempts').get() as { cnt: number }).cnt).toBe(0)
  })
})
