// Periodic cleanup for the WebSSH session runtime. Ticket rows live for seconds, and a session row
// whose DO never attached (or was evicted) must not keep counting against the owner's limit.

import type { Env } from '../env'
import { WEBSSH_IDLE_TIMEOUT_MS } from './constants'

const CONSUMED_TICKET_KEEP_MS = 60 * 60 * 1000

export async function runWebsshRetention(env: Env, now: number): Promise<number> {
  let removed = 0
  const tickets = await env.DB.prepare(
    `DELETE FROM webssh_session_tickets WHERE expires_at <= ?1 OR consumed_at <= ?2`,
  )
    .bind(now, now - CONSUMED_TICKET_KEEP_MS)
    .run()
  removed += Number(tickets.meta.changes ?? 0)

  const stalePending = await env.DB.prepare(
    `UPDATE webssh_sessions
        SET status = 'closed', ended_at = ?1, close_reason = 'stale'
      WHERE status IN ('pending', 'connecting') AND started_at < ?2`,
  )
    .bind(now, now - WEBSSH_IDLE_TIMEOUT_MS)
    .run()
  removed += Number(stalePending.meta.changes ?? 0)

  // An active row is only stale when its DO stopped refreshing activity; the live DO persists at
  // least every thirty seconds, so the twenty-minute floor cannot race a healthy session.
  const staleActive = await env.DB.prepare(
    `UPDATE webssh_sessions
        SET status = 'closed', ended_at = ?1, close_reason = 'idle', error_code = 'idle_timeout'
      WHERE status = 'active' AND last_activity_at < ?2`,
  )
    .bind(now, now - WEBSSH_IDLE_TIMEOUT_MS)
    .run()
  removed += Number(staleActive.meta.changes ?? 0)

  return removed
}
