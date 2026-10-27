/**
 * The audit trail, one row per action a reader would want to explain later.
 *
 * Writing the log must never be why an operation fails: the operation has already happened by the
 * time this runs, and a log line that could roll it back would be worse than a missing line. A failed
 * write is reported once, with the action, and swallowed deliberately.
 */
import type { Env } from '../env'
import { newId } from '../lib/id'
import { ApiError } from '../lib/errors'

export type AuditStatus = 'success' | 'error'

/** How much of a failure the trail keeps: enough to recognise it, never a whole upstream body. */
const FAILURE_SUMMARY_MAX_CHARS = 120

/**
 * The audit's line for a failure.
 *
 * The trail answers "which operation failed and how", not "what did Cloudflare say": the code is the
 * part a query can group by, and the summary is bounded so one upstream HTML page cannot become a log
 * row. The reader still gets the full sentence from the API answer.
 */
export function auditFailureDetail(error: unknown): string {
  const wrapped = (error instanceof ApiError ? error.details : undefined) as { cf_code?: unknown } | undefined
  const cfCode = (error as { cfCode?: unknown } | null)?.cfCode ?? wrapped?.cf_code
  const code = error instanceof ApiError
    ? error.code
    : typeof cfCode === 'number' ? 'cloudflare_upstream' : 'internal'
  const tag = typeof cfCode === 'number' ? `${code} cf=${cfCode}` : code
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
  return `${tag}: ${message.slice(0, FAILURE_SUMMARY_MAX_CHARS)}`
}

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
