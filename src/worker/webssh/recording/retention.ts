// Recording retention (plan §5.4): the D1 row is marked deleted *before* the R2 object is removed,
// so a reader can never be handed metadata for an object that is already gone. Re-running the sweep
// is safe: marking is a no-op on a marked row and an R2 delete of a missing key is not an error.

import type { Env } from '../../env'
import { recordAudit } from '../audit'
import { WEBSSH_RECORDING_PURGE_BATCH } from '../constants'
import { deleteSharesForRecording } from '../shares'

export interface ExpiredRecordingRow {
  id: string
  user_id: string
  session_id: string
  host_id: string
  r2_key: string
  status: string
  deleted_at: number | null
}

function report(error: unknown): void {
  console.warn('[inkstone] WebSSH recording retention failed:', (error as Error).message)
}

/**
 * Delete one recording's object and then close its row. Answers `true` when the row is now
 * `deleted`; an R2 failure leaves the row marked and retries on the next sweep.
 */
export async function purgeExpiredRecording(env: Env, row: ExpiredRecordingRow, now: number): Promise<boolean> {
  if (row.status === 'deleted') return true
  await env.DB
    .prepare(
      `UPDATE webssh_recordings SET deleted_at = COALESCE(deleted_at, ?3)
        WHERE id = ?1 AND user_id = ?2 AND status != 'deleted'`,
    )
    .bind(row.id, row.user_id, now)
    .run()
  // A deployment without R2 cannot have written a recording; leave the marked row for a sweep that
  // does have the binding rather than claiming an object was removed.
  if (!env.FILES) return false
  try {
    await env.FILES.delete(row.r2_key)
  } catch (error) {
    report(error)
    // The object outlives its retention window; the local health view counts this until a sweep wins.
    await recordAudit(env.DB, {
      userId: row.user_id,
      sessionId: row.session_id,
      hostId: row.host_id,
      eventType: 'retention_fail',
      metadata: { scope: 'recording', recordingId: row.id, reason: 'r2_delete' },
      now,
    }).catch(() => undefined)
    return false
  }
  await env.DB
    .prepare(
      `UPDATE webssh_recordings SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?3)
        WHERE id = ?1 AND user_id = ?2`,
    )
    .bind(row.id, row.user_id, now)
    .run()
  // The link is part of the recording's life: once the object is gone, a share that still resolved
  // would hand a visitor a broken player. Dropped before the audit so the two cannot disagree.
  await deleteSharesForRecording(env.DB, row.id).catch(report)
  await recordAudit(env.DB, {
    userId: row.user_id,
    sessionId: row.session_id,
    hostId: row.host_id,
    eventType: 'recording_delete',
    metadata: { recordingId: row.id },
    now,
  }).catch(() => undefined)
  return true
}

/** One bounded retention fire. Marked-but-not-yet-removed rows are retried here too. */
export async function purgeExpiredRecordings(
  env: Env,
  now: number,
  limit = WEBSSH_RECORDING_PURGE_BATCH,
): Promise<number> {
  const rows = await env.DB
    .prepare(
      `SELECT id, user_id, session_id, host_id, r2_key, status, deleted_at
         FROM webssh_recordings
        WHERE status != 'deleted' AND (deleted_at IS NOT NULL OR expires_at <= ?1)
        ORDER BY expires_at ASC
        LIMIT ?2`,
    )
    .bind(now, Math.max(1, limit))
    .all<ExpiredRecordingRow>()
  let removed = 0
  for (const row of rows.results) {
    if (await purgeExpiredRecording(env, row, now)) removed += 1
  }
  return removed
}
