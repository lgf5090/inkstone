import type { Env } from '../../env'

export const CLICK_RETENTION_DAYS_DEFAULT = 365
const PURGE_CHUNK = 5000
const PURGE_ROUNDS = 20
const STALE_BUCKET_SECONDS = 2 * 86400
const RECONCILE_BATCH = 50

export function retentionDays(env: Env): number {
  const parsed = Number.parseInt(env.SHORTLINKS_CLICK_RETENTION_DAYS ?? '', 10)
  if (!Number.isFinite(parsed)) return CLICK_RETENTION_DAYS_DEFAULT
  return Math.max(0, parsed)
}

/**
 * Drops click rows past the retention window and keeps `links.total_clicks` truthful.
 *
 * The counter was incremented per click and never touched by the sweep, so after a year the list
 * showed a lifetime number while the analytics range showed the surviving rows. RETURNING hands
 * back exactly which links lost rows, and those counters are adjusted in bounded batches.
 */
export async function purgeClicksBefore(db: D1Database, before: number): Promise<number> {
  const { results } = await db
    .prepare(
      `DELETE FROM tools_shortlinks_clicks
        WHERE rowid IN (SELECT rowid FROM tools_shortlinks_clicks WHERE clicked_at < ? LIMIT ?)
        RETURNING link_id, user_id`,
    )
    .bind(before, PURGE_CHUNK)
    .all<{ link_id: number; user_id: string }>()

  const removed = results ?? []
  if (removed.length === 0) return 0

  const lost = new Map<string, { userId: string; linkId: number; count: number }>()
  for (const row of removed) {
    const key = `${row.user_id}|${row.link_id}`
    const entry = lost.get(key)
    if (entry) entry.count++
    else lost.set(key, { userId: row.user_id, linkId: row.link_id, count: 1 })
  }

  const updates = [...lost.values()]
  for (let offset = 0; offset < updates.length; offset += RECONCILE_BATCH) {
    const chunk = updates.slice(offset, offset + RECONCILE_BATCH)
    await db.batch(
      chunk.map((entry) =>
        db
          .prepare(
            `UPDATE tools_shortlinks_links
                SET total_clicks = CASE WHEN total_clicks >= ? THEN total_clicks - ? ELSE 0 END
              WHERE id = ? AND user_id = ?`,
          )
          .bind(entry.count, entry.count, entry.linkId, entry.userId),
      ),
    )
  }

  return removed.length
}

/** Rate-limit and password-attempt buckets are keyed forever unless the sweep retires them. */
export async function sweepStaleShortlinkBuckets(db: D1Database, before: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM tools_shortlinks_rate_limits WHERE window_start < ?').bind(before),
    db.prepare('DELETE FROM tools_shortlinks_password_attempts WHERE window_start < ?').bind(before),
  ])
}

/** Deletes click rows past the retention window in bounded chunks so one fire never blocks the tick. */
export async function runShortlinksRetention(env: Env, nowMs: number): Promise<number> {
  const now = Math.floor(nowMs / 1000)
  await sweepStaleShortlinkBuckets(env.DB, now - STALE_BUCKET_SECONDS).catch(() => {
    // The tick runs every hour; a failed sweep leaves the same expired buckets for the next pass.
  })

  const days = retentionDays(env)
  if (days <= 0) return 0
  const before = now - days * 86400
  let removed = 0
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    const chunk = await purgeClicksBefore(env.DB, before)
    removed += chunk
    if (chunk < PURGE_CHUNK) break
  }
  return removed
}
