import type { Env } from '../env'
import { selectQueueUsersRoundRobin } from '../db/metadata'
import type { RewriteQueueKind } from '../db/writes'
import { rewriteInboundWikiLinks } from '../routes/notes'
import { rewriteTagInNotes } from '../routes/tags'
import type { D1Database } from '@cloudflare/workers-types'

interface RewriteQueueRow {
  kind: RewriteQueueKind
  source_id: string
  old_value: string
  new_value: string
  attempts: number
}

/** Notes a single queue row may rewrite per round; the tail is re-queued for the next one. */
export const REWRITE_ROW_BUDGET = 60
const REWRITE_ROWS_PER_RUN = 5
const REWRITE_USERS_PER_PASS = 5
const REWRITE_CLAIM_TTL_MS = 10 * 60_000
const REWRITE_MAX_ATTEMPTS = 5
const REWRITE_DRAIN_CURSOR_META_KEY = 'rewrite-drain-user-v1'

/**
 * Drains fan-out rewrites (note renames, tag renames/deletions) that were deferred
 * because they touched more notes than the inline budget allows. Rows are marked with
 * `claimed_at` rather than deleted up front, so an invocation killed mid-work leaves the
 * row recoverable; failures re-arm the row with a retry counter and are dropped after
 * REWRITE_MAX_ATTEMPTS instead of freezing the queue forever.
 */
export async function drainRewriteQueues(
  env: Env,
  ftsEnabled: boolean,
  maxRows = REWRITE_ROWS_PER_RUN,
  rowBudget = REWRITE_ROW_BUDGET,
): Promise<number> {
  const budget = Math.max(0, Math.trunc(maxRows))
  let processed = 0
  let claimedRows = 0
  while (claimedRows < budget) {
    const users = await selectQueueUsersRoundRobin(
      env.DB,
      'rewrite_queue',
      REWRITE_DRAIN_CURSOR_META_KEY,
      Math.min(REWRITE_USERS_PER_PASS, budget - claimedRows),
    )
    if (!users.length) break
    let claimedAny = false
    for (const userId of users) {
      if (claimedRows >= budget) break
      const row = await claimNextRow(env.DB, userId)
      if (!row) continue
      claimedAny = true
      claimedRows++
      const key = { userId, kind: row.kind, sourceId: row.source_id }
      try {
        const remaining = await runRewrite(env, ftsEnabled, row, userId, rowBudget)
        if (remaining > 0) {
          // Real progress: re-arm the row at attempt 0 so the next round continues.
          await rearmRow(env.DB, key, 0)
          continue
        }
        await forgetRow(env.DB, key)
        processed++
      } catch (error) {
        console.warn('[inkstone] Deferred rewrite failed; requeued:', error instanceof Error ? error.message : error)
        const attempts = row.attempts + 1
        if (attempts >= REWRITE_MAX_ATTEMPTS) {
          await forgetRow(env.DB, key)
          console.warn(`[inkstone] Dropped deferred rewrite ${row.kind}/${key.sourceId} after `
            + `${attempts} attempts; some notes may still reference the previous title or tag`)
        } else {
          await rearmRow(env.DB, key, attempts)
        }
      }
    }
    if (!claimedAny) break
  }
  return processed
}

async function claimNextRow(db: D1Database, userId: string): Promise<RewriteQueueRow | null> {
  const now = Date.now()
  const staleBefore = now - REWRITE_CLAIM_TTL_MS
  const { results } = await db.prepare(
    `SELECT kind, source_id, old_value, new_value, attempts FROM rewrite_queue
      WHERE user_id = ?1 AND (claimed_at IS NULL OR claimed_at <= ?2)
      ORDER BY created_at ASC LIMIT 1`,
  ).bind(userId, staleBefore).all<RewriteQueueRow>()
  const candidate = results[0]
  if (!candidate) return null
  // Guarded UPDATE ... RETURNING is the claim: a concurrent drain either sees the newer
  // claimed_at and gets no row, or proceeds on a different account.
  return await db.prepare(
    `UPDATE rewrite_queue SET claimed_at = ?4
      WHERE user_id = ?1 AND kind = ?2 AND source_id = ?3
        AND (claimed_at IS NULL OR claimed_at <= ?5)
      RETURNING kind, source_id, old_value, new_value, attempts`,
  ).bind(userId, candidate.kind, candidate.source_id, now, staleBefore).first<RewriteQueueRow>()
}

async function runRewrite(
  env: Env,
  ftsEnabled: boolean,
  row: RewriteQueueRow,
  userId: string,
  rowBudget: number,
): Promise<number> {
  if (row.kind === 'note-title') {
    const outcome = await rewriteInboundWikiLinks(
      env.DB, userId, row.source_id, row.old_value, row.new_value, ftsEnabled, true, rowBudget,
    )
    return outcome.remaining
  }
  const outcome = await rewriteTagInNotes(
    env, ftsEnabled, userId, row.source_id, row.old_value,
    row.kind === 'tag-delete' ? null : row.new_value, true, rowBudget,
  )
  return outcome.remaining
}

interface RowKey {
  userId: string
  kind: RewriteQueueKind
  sourceId: string
}

async function forgetRow(db: D1Database, key: RowKey): Promise<void> {
  await db.prepare(
    `DELETE FROM rewrite_queue WHERE user_id = ?1 AND kind = ?2 AND source_id = ?3`,
  ).bind(key.userId, key.kind, key.sourceId).run()
}

/**
 * Pushes a row to the tail for a later round while keeping its claim marker, so this run
 * cannot re-pick it. The row becomes claimable again once REWRITE_CLAIM_TTL_MS has
 * passed, which must stay shorter than the cron interval.
 */
async function rearmRow(db: D1Database, key: RowKey, attempts: number): Promise<void> {
  await db.prepare(
    `UPDATE rewrite_queue SET created_at = ?4, attempts = ?5
      WHERE user_id = ?1 AND kind = ?2 AND source_id = ?3`,
  ).bind(key.userId, key.kind, key.sourceId, Date.now(), attempts).run()
}
