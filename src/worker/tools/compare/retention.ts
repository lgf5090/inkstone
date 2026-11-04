/**
 * The hourly sweep for compare assets no project ever kept.
 *
 * An upload exists before the reader decides to save the comparison, so closing the tab leaves bytes
 * in R2 with no row that names them. Every hour we drop what has been unreferenced for a day: long
 * enough that a slow save still finds its objects, short enough that an abandoned upload does not
 * outlive the visit.
 */
import type { Env } from '../../env'

const ORPHAN_AGE_SECONDS = 24 * 60 * 60
const ORPHAN_BATCH = 200

export async function runCompareRetention(env: Env, scheduledTime: number): Promise<void> {
  if (!env.FILES) return
  const cutoff = Math.floor(scheduledTime / 1000) - ORPHAN_AGE_SECONDS
  const { results } = await env.DB
    .prepare(`SELECT a.id, a.user_id, a.r2_key
      FROM tools_compare_assets a
      WHERE a.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM tools_compare_projects p
          WHERE p.user_id = a.user_id
            AND (p.left_asset_id = a.id OR p.right_asset_id = a.id)
        )
      LIMIT ?`)
    .bind(cutoff, ORPHAN_BATCH)
    .all<{ id: string; user_id: string; r2_key: string }>()

  if (!results?.length) return
  await env.FILES.delete(results.map((row) => row.r2_key))
  const statements = results.map((row) =>
    env.DB.prepare('DELETE FROM tools_compare_assets WHERE user_id = ? AND id = ?').bind(row.user_id, row.id),
  )
  await env.DB.batch(statements)
}
