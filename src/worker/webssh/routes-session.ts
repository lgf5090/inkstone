// REST surface for WebSSH sessions: create, mint a one-time ticket, read status, and upgrade.
//
// The Worker side owns authentication, tickets and the Durable Object hand-off; the DO owns the SSH
// socket and the state machine. Every session lookup filters by `user_id`, so another account's id
// answers 404 even when the id exists.

import { Hono, type Context } from 'hono'
import type {
  WebsshSessionCreated,
  WebsshSessionTicket,
  WebsshSessionView,
} from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { readJson, requestClientIp } from '../lib/request'
import { hashAuditValue, recordAudit } from './audit'
import {
  WEBSSH_API_PREFIX,
  WEBSSH_IDLE_TIMEOUT_MS,
  WEBSSH_MAX_ACTIVE_SESSIONS_PER_USER,
} from './constants'
import {
  consumeTicket,
  isCanonicalOrigin,
  issueTicket,
  WEBSSH_TICKET_TOKEN_MAX_LENGTH,
} from './session-ticket'
import { normalizeTerminalSize } from './ssh/types'

export const websshSessionRoutes = new Hono<AppBindings>()

interface HostRow {
  id: string
  host: string
  port: number
  username: string
  auth_method: string
  credential_id: string
  key_id: string
  encoding: string
  term_type: string
  initial_command: string
}

interface AuditEvent {
  eventType: Parameters<typeof recordAudit>[1]['eventType']
  sessionId?: string
  hostId?: string
  metadata?: Record<string, string | number | boolean | null>
}

function audit(c: Context<AppBindings>, event: AuditEvent): void {
  const userId = c.get('userId')
  if (!userId) return
  void hashAuditValue(requestClientIp(c))
    .then((ipHash) => recordAudit(c.env.DB, { userId, ipHash, ...event }))
    .catch((error) => console.warn('[inkstone] WebSSH audit write failed:', (error as Error).message))
}

async function loadHost(c: Context<AppBindings>, userId: string, hostId: string): Promise<HostRow> {
  const row = await c.env.DB.prepare(
    `SELECT id, host, port, username, auth_method, credential_id, key_id, encoding, term_type, initial_command
       FROM webssh_hosts
      WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  )
    .bind(userId, hostId)
    .first<HostRow>()
  if (!row) throw ApiError.notFound('That host does not exist')
  return row
}

async function loadSession(
  c: Context<AppBindings>,
  userId: string,
  sessionId: string,
  columns: string,
): Promise<Record<string, unknown>> {
  const row = await c.env.DB.prepare(
    `SELECT ${columns} FROM webssh_sessions WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(sessionId, userId)
    .first<Record<string, unknown>>()
  if (!row) throw ApiError.notFound('That session does not exist')
  return row
}

websshSessionRoutes.post('/sessions', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ hostId?: unknown; cols?: unknown; rows?: unknown }>(c, 4096)
  if (typeof body.hostId !== 'string' || !isValidId(body.hostId)) throw ApiError.badRequest('Invalid host id')
  const size = normalizeTerminalSize(body.cols ?? 120, body.rows ?? 40)
  if (!size) throw ApiError.badRequest('Invalid terminal size')
  if (!c.env.WEBSSH_SESSION) throw new ApiError(503, 'storage_unavailable', 'The WebSSH session runtime is not bound')

  await loadHost(c, userId, body.hostId)
  const db = c.env.DB
  const now = Date.now()
  // Close rows whose owner never completed the upgrade (or whose DO vanished) before counting,
  // then count only the rows a client could still attach to.
  await db.prepare(
    `UPDATE webssh_sessions
        SET status = 'closed', ended_at = ?2, close_reason = 'stale'
      WHERE user_id = ?1 AND status IN ('pending', 'connecting', 'active') AND last_activity_at < ?3`,
  )
    .bind(userId, now, now - WEBSSH_IDLE_TIMEOUT_MS)
    .run()
  const active = await db.prepare(
    `SELECT COUNT(*) AS count FROM webssh_sessions
      WHERE user_id = ?1 AND status IN ('pending', 'connecting', 'active')`,
  )
    .bind(userId)
    .first<{ count: number }>()
  if (Number(active?.count ?? 0) >= WEBSSH_MAX_ACTIVE_SESSIONS_PER_USER) {
    throw new ApiError(
      429,
      'too_many_attempts',
      `At most ${WEBSSH_MAX_ACTIVE_SESSIONS_PER_USER} WebSSH sessions may be open at once`,
    )
  }

  const sessionId = newId()
  const ipHash = await hashAuditValue(requestClientIp(c))
  const userAgentHash = await hashAuditValue(c.req.header('User-Agent') ?? '')
  await db.prepare(
    `INSERT INTO webssh_sessions
       (id, user_id, host_id, status, client_ip_hash, user_agent_hash, started_at, last_activity_at)
     VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?6)`,
  )
    .bind(sessionId, userId, body.hostId, ipHash, userAgentHash, now)
    .run()
  audit(c, {
    eventType: 'session_create',
    sessionId,
    hostId: body.hostId,
    metadata: { cols: size.cols, rows: size.rows },
  })
  return c.json<WebsshSessionCreated>({ sessionId, status: 'pending' }, 201)
})

websshSessionRoutes.post('/sessions/:id/ticket', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  if (!isValidId(sessionId)) throw ApiError.badRequest('Invalid session id')
  const origin = c.req.header('Origin')
  if (!isCanonicalOrigin(origin) || origin !== new URL(c.req.url).origin) {
    throw ApiError.forbidden('The WebSocket origin is not trusted')
  }
  const row = await loadSession(c, userId, sessionId, 'status, started_at')
  if (row.status !== 'pending') throw ApiError.conflict('This session has already been attached')

  const ticket = await issueTicket(c.env.DB, { userId, sessionId, origin })
  audit(c, { eventType: 'ticket_issue', sessionId, metadata: { expiresAt: ticket.expiresAt } })
  return c.json<WebsshSessionTicket>({
    ticket: ticket.token,
    url: `${WEBSSH_API_PREFIX}/sessions/${sessionId}/ws?ticket=${encodeURIComponent(ticket.token)}`,
    expiresAt: ticket.expiresAt,
  })
})

websshSessionRoutes.get('/sessions/:id', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  if (!isValidId(sessionId)) throw ApiError.badRequest('Invalid session id')
  const row = await loadSession(
    c,
    userId,
    sessionId,
    'status, started_at, connected_at, ended_at, last_activity_at, close_reason, error_code, host_id',
  )
  return c.json<WebsshSessionView>({
    id: sessionId,
    hostId: String(row.host_id ?? ''),
    status: row.status as WebsshSessionView['status'],
    startedAt: Number(row.started_at),
    connectedAt: row.connected_at === null ? null : Number(row.connected_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    lastActivityAt: Number(row.last_activity_at),
    closeReason: String(row.close_reason ?? ''),
    errorCode: String(row.error_code ?? ''),
  })
})

/**
 * Precondition failures on the upgrade route answer as ordinary HTTP before any socket exists.
 * Throwing here would be correct for JSON routes but leaves a WebSocket client with a closed
 * transport instead of the reason, which is the one place a caller cannot read a body from.
 */
function upgradeError(
  c: Context<AppBindings>,
  status: 400 | 403 | 404 | 409 | 503,
  code: 'bad_request' | 'forbidden' | 'not_found' | 'conflict' | 'storage_unavailable',
  message: string,
): Response {
  return c.json({ error: { code, message } }, status)
}

/** The upgrade route. The ticket is consumed here, then the request is handed to the session DO. */
websshSessionRoutes.get('/sessions/:id/ws', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return upgradeError(c, 400, 'bad_request', 'This endpoint accepts only WebSocket upgrade requests')
  }
  const origin = c.req.header('Origin')
  if (!isCanonicalOrigin(origin) || origin !== new URL(c.req.url).origin) {
    return upgradeError(c, 403, 'forbidden', 'The WebSocket origin is not trusted')
  }
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  if (!isValidId(sessionId)) return upgradeError(c, 400, 'bad_request', 'Invalid session id')
  const ticket = c.req.query('ticket')
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > WEBSSH_TICKET_TOKEN_MAX_LENGTH) {
    return upgradeError(c, 400, 'bad_request', 'A WebSocket ticket is required')
  }
  if (!c.env.WEBSSH_SESSION) {
    return upgradeError(c, 503, 'storage_unavailable', 'The WebSSH session runtime is not bound')
  }

  const row = await c.env.DB.prepare(
    `SELECT status FROM webssh_sessions WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(sessionId, userId)
    .first<{ status: string }>()
  if (!row) return upgradeError(c, 404, 'not_found', 'That session does not exist')
  if (row.status !== 'pending') return upgradeError(c, 409, 'conflict', 'This session has already been attached')

  const consumed = await consumeTicket(c.env.DB, { userId, sessionId, token: ticket, origin })
  if (consumed !== 'ok') {
    audit(c, { eventType: 'ticket_rejected', sessionId, metadata: { reason: consumed } })
    if (consumed === 'origin_mismatch') {
      return upgradeError(c, 403, 'forbidden', 'The WebSocket origin does not match the ticket')
    }
    return upgradeError(c, 404, 'not_found', 'This WebSocket ticket is not valid')
  }
  audit(c, { eventType: 'ticket_consumed', sessionId })

  // The session id is both the Durable Object name's second half and the D1 row key, so one
  // browser session always lands on one DO instance.
  const stub = c.env.WEBSSH_SESSION.get(c.env.WEBSSH_SESSION.idFromName(`${userId}:${sessionId}`))
  const forwardedUrl = new URL(c.req.url)
  forwardedUrl.searchParams.set('u', userId)
  forwardedUrl.searchParams.set('s', sessionId)
  return stub.fetch(new Request(forwardedUrl.toString(), c.req.raw))
})
