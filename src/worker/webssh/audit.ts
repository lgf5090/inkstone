// Append-only WebSSH audit trail (plan §5.5). Metadata never carries a password, private key or
// terminal output; it names ids, counts and result codes only.

import { newId } from '../lib/id'

export type WebsshAuditEventType =
  | 'session_create'
  | 'ticket_issue'
  | 'ticket_consumed'
  | 'ticket_rejected'
  | 'connect'
  | 'connect_blocked'
  | 'host_key_new'
  | 'host_key_changed'
  | 'host_key_trusted'
  | 'session_ready'
  | 'auth_fail'
  | 'disconnect'
  | 'session_error'

export interface WebsshAuditInput {
  userId: string
  eventType: WebsshAuditEventType
  sessionId?: string
  hostId?: string
  metadata?: Record<string, string | number | boolean | null>
  ipHash?: string
  now?: number
}

/** The per-account ceiling the retention rule in plan §5.3.1 states. */
export const WEBSSH_AUDIT_EVENT_LIMIT = 5_000
const METADATA_LIMIT = 2_048

/** SHA-256 hex of an IP or user agent, so the audit row can correlate without storing the raw value. */
export async function hashAuditValue(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  let out = ''
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, '0')
  return out
}

export async function recordAudit(db: D1Database, input: WebsshAuditInput): Promise<void> {
  const metadata = JSON.stringify(input.metadata ?? {})
  if (metadata.length > METADATA_LIMIT) throw new Error('invalid_webssh_audit_metadata')
  const now = input.now ?? Date.now()
  await db.batch([
    db.prepare(
      `INSERT INTO webssh_audit_events (id, user_id, session_id, host_id, event_type, metadata, ip_hash, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      newId(),
      input.userId,
      input.sessionId ?? '',
      input.hostId ?? '',
      input.eventType,
      metadata,
      input.ipHash ?? '',
      now,
    ),
    // Trim by count, not age: the newest rows are the audit trail an operator would need first.
    db.prepare(
      `DELETE FROM webssh_audit_events
        WHERE user_id = ?1 AND id IN (
          SELECT id FROM webssh_audit_events
           WHERE user_id = ?1
           ORDER BY created_at DESC, id DESC
           LIMIT -1 OFFSET ?2
        )`,
    ).bind(input.userId, WEBSSH_AUDIT_EVENT_LIMIT),
  ])
}
