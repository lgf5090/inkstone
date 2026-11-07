// One-time WebSocket tickets for the WebSSH session runtime.
//
// The ticket's database id is the SHA-256 of the token (plan §5.3.1). The token also carries the
// canonical origin that minted it, so the upgrade can compare that origin with the request's own
// `Origin` without a schema column: changing the origin changes the hash, and the row lookup fails.

import { isValidId, newId } from '../lib/id'
import { WEBSSH_TICKET_TTL_MS } from './constants'

export const WEBSSH_TICKET_TOKEN_MAX_LENGTH = 192

export interface IssuedTicket {
  token: string
  id: string
  expiresAt: number
}

export type TicketConsumeResult = 'ok' | 'missing' | 'expired' | 'consumed' | 'origin_mismatch'

function base64UrlEncode(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  return atob(padded)
}

/** A value a browser may send as `Origin`: scheme + host + port, with nothing after it. */
export function isCanonicalOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false
  try {
    const url = new URL(value)
    return url.origin === value && !url.username && !url.password
  } catch {
    return false
  }
}

export function createTicketToken(origin: string): string {
  if (!isCanonicalOrigin(origin)) throw new Error('invalid_webssh_ticket_origin')
  return `${newId()}.${base64UrlEncode(origin)}`
}

/** The origin a token was minted for, or null when the token is not in the expected shape. */
export function ticketOrigin(token: string): string | null {
  const separator = token.indexOf('.')
  if (separator < 1) return null
  const nonce = token.slice(0, separator)
  if (!isValidId(nonce)) return null
  try {
    const origin = base64UrlDecode(token.slice(separator + 1))
    return isCanonicalOrigin(origin) ? origin : null
  } catch {
    return null
  }
}

export async function ticketId(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  let binary = ''
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return base64UrlEncode(binary)
}

export async function issueTicket(
  db: D1Database,
  input: { userId: string; sessionId: string; origin: string; now?: number },
): Promise<IssuedTicket> {
  if (!isValidId(input.userId) || !isValidId(input.sessionId)) throw new Error('invalid_webssh_ticket_scope')
  const now = input.now ?? Date.now()
  const token = createTicketToken(input.origin)
  const id = await ticketId(token)
  const expiresAt = now + WEBSSH_TICKET_TTL_MS
  await db.batch([
    // A consumed ticket has already served its one upgrade; keeping it around only grows the table.
    db.prepare(
      `DELETE FROM webssh_session_tickets
        WHERE user_id = ?1 AND session_id = ?2 AND (expires_at <= ?3 OR consumed_at IS NOT NULL)`,
    ).bind(input.userId, input.sessionId, now),
    db.prepare(
      `INSERT INTO webssh_session_tickets (id, user_id, session_id, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(id, input.userId, input.sessionId, expiresAt, now),
  ])
  return { token, id, expiresAt }
}

/**
 * Consume a ticket exactly once.
 *
 * The origin check happens before the row is touched, so a wrong-origin attempt does not burn a
 * legitimate ticket. The update is the single-use gate: `consumed_at IS NULL` lets one concurrent
 * upgrade win, and `expires_at > now` refuses an expired row in the same statement.
 */
export async function consumeTicket(
  db: D1Database,
  input: { userId: string; sessionId: string; token: string; origin: string; now?: number },
): Promise<TicketConsumeResult> {
  if (!isValidId(input.userId) || !isValidId(input.sessionId)) return 'missing'
  if (input.token.length > WEBSSH_TICKET_TOKEN_MAX_LENGTH) return 'missing'
  const tokenOrigin = ticketOrigin(input.token)
  if (tokenOrigin === null) return 'missing'
  if (tokenOrigin !== input.origin) return 'origin_mismatch'

  const now = input.now ?? Date.now()
  const id = await ticketId(input.token)
  const consumed = await db.prepare(
    `UPDATE webssh_session_tickets SET consumed_at = ?5
      WHERE id = ?1 AND user_id = ?2 AND session_id = ?3
        AND consumed_at IS NULL AND expires_at > ?4
      RETURNING expires_at`,
  )
    .bind(id, input.userId, input.sessionId, now, now)
    .first<{ expires_at: number }>()
  if (consumed) return 'ok'

  const row = await db.prepare(
    `SELECT expires_at, consumed_at FROM webssh_session_tickets
      WHERE id = ?1 AND user_id = ?2 AND session_id = ?3`,
  )
    .bind(id, input.userId, input.sessionId)
    .first<{ expires_at: number; consumed_at: number | null }>()
  if (!row) return 'missing'
  return row.consumed_at !== null ? 'consumed' : 'expired'
}
