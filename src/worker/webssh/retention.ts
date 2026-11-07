// Periodic cleanup for the WebSSH session runtime. Ticket rows live for seconds, and a session row
// whose DO never attached (or was evicted) must not keep counting against the owner's limit.

import type { Env } from '../env'
import { WEBSSH_IDLE_TIMEOUT_MS } from './constants'
import { purgeExpiredRecordings } from './recording/retention'
import { purgeExpiredShares } from './shares'
import { purgeStagingUploads } from './staging'

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

  // Recordings follow the same sweep: mark the D1 row first, then remove its R2 object. A failure
  // leaves the row marked so the next fire retries instead of losing the reference.
  removed += await purgeExpiredRecordings(env, now).catch((error) => {
    console.warn('[inkstone] WebSSH recording retention failed:', (error as Error).message)
    return 0
  })

  // Links that outlived their recording (or their own expiry) go in the same fire, so a revoked or
  // expired address is never left pointing at an object the sweep above just removed.
  removed += await purgeExpiredShares(env.DB, now).catch((error) => {
    console.warn('[inkstone] WebSSH share retention failed:', (error as Error).message)
    return 0
  })

  // Abandoned staged uploads from interrupted SFTP transfers. The sweep checks D1 for a live session
  // before deleting anything, because that is the only row that could still complete the transfer.
  removed += await purgeStagingUploads(env, now).catch((error) => {
    console.warn('[inkstone] WebSSH staging retention failed:', (error as Error).message)
    return 0
  })

  return removed
}
