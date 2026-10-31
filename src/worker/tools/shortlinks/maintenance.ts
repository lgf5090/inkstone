import type { Env } from '../../env'

export const CLICK_RETENTION_DAYS_DEFAULT = 365
const PURGE_CHUNK = 5000
const PURGE_ROUNDS = 20

export function retentionDays(env: Env): number {
  const parsed = Number.parseInt(env.SHORTLINKS_CLICK_RETENTION_DAYS ?? '', 10)
  if (!Number.isFinite(parsed)) return CLICK_RETENTION_DAYS_DEFAULT
  return Math.max(0, parsed)
}

export async function purgeClicksBefore(db: D1Database, before: number): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM tools_shortlinks_clicks
        WHERE rowid IN (SELECT rowid FROM tools_shortlinks_clicks WHERE clicked_at < ? LIMIT ?)`,
    )
    .bind(before, PURGE_CHUNK)
    .run()
  return result.meta.changes ?? 0
}

/** Deletes click rows past the retention window in bounded chunks so one fire never blocks the tick. */
export async function runShortlinksRetention(env: Env, nowMs: number): Promise<number> {
  const days = retentionDays(env)
  if (days <= 0) return 0
  const before = Math.floor(nowMs / 1000) - days * 86400
  let removed = 0
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    const chunk = await purgeClicksBefore(env.DB, before)
    removed += chunk
    if (chunk < PURGE_CHUNK) break
  }
  return removed
}
