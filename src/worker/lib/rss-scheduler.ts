import { fetchFeed } from './rss-fetch'
import { parseServerFeed } from './rss-parse'
import { saveServerRssArticles } from './rss-store'
import { consumeAttemptBudget } from './throttle'

interface DueFeed {
  user_id: string
  id: string
  url: string
  title: string
  title_locked: number
  etag: string
  last_modified: string
}

const TICK_BATCH = 100
const TICK_CONCURRENCY = 5

/** Claim and refresh feeds whose account setting has enabled server-side scheduling. */
export async function runRssSchedulerTick(db: D1Database, now = Date.now()): Promise<{ refreshed: number, failed: number }> {
  const { results } = await db.prepare(
    `SELECT f.* FROM rss_feed f
       JOIN users u ON u.id = f.user_id
      WHERE f.paused = 0
        AND CAST(CASE WHEN json_valid(u.settings) THEN json_extract(u.settings, '$.rss.refreshIntervalMinutes') ELSE 0 END AS INTEGER) > 0
        AND f.last_attempt_at <= ?1 - CAST(CASE WHEN json_valid(u.settings) THEN json_extract(u.settings, '$.rss.refreshIntervalMinutes') ELSE 0 END AS INTEGER) * 60000
      ORDER BY f.last_attempt_at ASC, f.user_id ASC, f.id ASC LIMIT ?2`,
  ).bind(now, TICK_BATCH).all<DueFeed>()
  const feeds = results
  if (!feeds.length) return { refreshed: 0, failed: 0 }
  await db.batch(feeds.map(feed => db.prepare('UPDATE rss_feed SET last_attempt_at = ?1 WHERE user_id = ?2 AND id = ?3').bind(now, feed.user_id, feed.id)))
  let refreshed = 0
  let failed = 0
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const feed = feeds[cursor++]
      if (!feed) return
      try {
        await consumeAttemptBudget(db, [
          { key: `rss-fetch:${feed.user_id}`, maxAttempts: 1500, windowMs: 600_000, lockMs: 120_000 },
          { key: `rss-fetch-url:${feed.user_id}:${feed.id}`, maxAttempts: 30, windowMs: 600_000, lockMs: 120_000 },
        ])
        const result = await fetchFeed({ url: feed.url, etag: feed.etag, lastModified: feed.last_modified })
        if (!result.ok || !result.xml) {
          failed++
          await db.prepare(`UPDATE rss_feed SET error = ?1, error_count = error_count + 1, last_error_at = ?2 WHERE user_id = ?3 AND id = ?4`)
            .bind((result.reason ?? 'unreachable').slice(0, 240), now, feed.user_id, feed.id).run()
          continue
        }
        if (result.status !== 304) {
          const parsed = parseServerFeed(result.xml, feed.id, result.finalUrl ?? feed.url)
          await saveServerRssArticles(db, feed.user_id, feed.id, parsed.entries, now)
          await db.prepare(`UPDATE rss_feed SET title = ?1, site_url = ?2, image_url = ?3, url = ?4, etag = ?5, last_modified = ?6,
            updated_at = ?7, error = '', error_count = 0, last_error_at = 0 WHERE user_id = ?8 AND id = ?9 AND title_locked = 0`)
            .bind(parsed.title || feed.title, parsed.siteUrl, parsed.imageUrl, result.finalUrl ?? feed.url, result.etag ?? '', result.lastModified ?? '', now, feed.user_id, feed.id).run()
          await db.prepare(`UPDATE rss_feed SET url = ?1, etag = ?2, last_modified = ?3, updated_at = ?4, error = '', error_count = 0, last_error_at = 0
            WHERE user_id = ?5 AND id = ?6 AND title_locked = 1`)
            .bind(result.finalUrl ?? feed.url, result.etag ?? '', result.lastModified ?? '', now, feed.user_id, feed.id).run()
        }
        refreshed++
      }
      catch (error) {
        failed++
        console.warn('[inkstone] RSS scheduled refresh failed', { userId: feed.user_id, feedId: feed.id, error })
        await db.prepare('UPDATE rss_feed SET error_count = error_count + 1, last_error_at = ?1 WHERE user_id = ?2 AND id = ?3')
          .bind(now, feed.user_id, feed.id).run()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(TICK_CONCURRENCY, feeds.length) }, worker))
  return { refreshed, failed }
}
