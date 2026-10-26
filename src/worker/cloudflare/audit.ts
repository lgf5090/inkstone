/**
 * The audit trail, one row per action a reader would want to explain later.
 *
 * Writing the log must never be why an operation fails: the operation has already happened by the
 * time this runs, and a log line that could roll it back would be worse than a missing line. A failed
 * write is reported once, with the action, and swallowed deliberately.
 */
import type { Env } from '../env'
import { newId } from '../lib/id'

export type AuditStatus = 'success' | 'error'

export async function createAuditLog(
  env: Env,
  userId: string,
  accountId: string | null,
  action: string,
  target: string | null,
  detail: string | null,
  status: AuditStatus,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO cloudflare_log (id, user_id, account_id, action, target, detail, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(newId(), userId, accountId, action, target, detail, status, Date.now())
      .run()
  } catch (error) {
    // Best-effort by design: the action already succeeded or failed on its own terms.
    console.error(`[inkstone] Cloudflare audit log write failed (${action}):`, (error as Error)?.message)
  }
}
