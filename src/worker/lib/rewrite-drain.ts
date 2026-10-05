import type { Env } from '../env'
import { rewriteInboundWikiLinks } from '../routes/notes'
import { rewriteTagInNotes } from '../routes/tags'
import type { RewriteQueueKind } from '../db/writes'

interface RewriteQueueRow {
  user_id: string
  kind: RewriteQueueKind
  source_id: string
  old_value: string
  new_value: string
  created_at: number
}

// A rewrite still failing a day later needs an operator, not another cron slot.
const REQUEUE_HORIZON_MS = 24 * 60 * 60 * 1000

/**
 * Drains fan-out rewrites (note renames, tag renames/deletions) that were
 * deferred because they touched more notes than the inline budget allows.
 * Rows are claimed with a guarded DELETE ... RETURNING so overlapping cron
 * runs cannot double-process them.
 */
export async function drainRewriteQueues(
  env: Env,
  ftsEnabled: boolean,
  max = 5,
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT user_id, kind, source_id, old_value, new_value, created_at FROM rewrite_queue
      ORDER BY created_at ASC LIMIT ?1`,
  ).bind(max).all<RewriteQueueRow>()
  let processed = 0
  for (const row of results) {
    const claimed = await env.DB.prepare(
      `DELETE FROM rewrite_queue
        WHERE user_id = ?1 AND kind = ?2 AND source_id = ?3
      RETURNING user_id, kind, source_id, old_value, new_value, created_at`,
    ).bind(row.user_id, row.kind, row.source_id).first<RewriteQueueRow>()
    if (!claimed) continue
    try {
      if (claimed.kind === 'note-title') {
        await rewriteInboundWikiLinks(
          env.DB, claimed.user_id, claimed.source_id,
          claimed.old_value, claimed.new_value, ftsEnabled, true,
        )
      } else {
        await rewriteTagInNotes(
          env, ftsEnabled, claimed.user_id, claimed.source_id,
          claimed.old_value, claimed.kind === 'tag-delete' ? null : claimed.new_value, true,
        )
      }
      processed++
    } catch (error) {
      const age = Date.now() - claimed.created_at
      if (age > REQUEUE_HORIZON_MS) {
        console.warn('[inkstone] Deferred rewrite abandoned after', Math.round(age / 60_000), 'minutes:', error instanceof Error ? error.message : error)
      } else {
        console.warn('[inkstone] Deferred rewrite failed; requeued:', error instanceof Error ? error.message : error)
        await env.DB.prepare(
          `INSERT OR IGNORE INTO rewrite_queue (user_id, kind, source_id, old_value, new_value, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        ).bind(claimed.user_id, claimed.kind, claimed.source_id, claimed.old_value, claimed.new_value, claimed.created_at).run()
      }
    }
  }
  return processed
}
