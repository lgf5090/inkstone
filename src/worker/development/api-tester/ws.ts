import { Hono } from 'hono'
import { isBlockedTarget } from '@shared/ai-proxy-guard'
import { newApiTesterId } from '@shared/development/api-tester/ids'
import {
  MAX_WS_FRAME_BYTES,
  WS_IDLE_TIMEOUT_MS,
  WS_TICKET_RATE_LIMIT,
  WS_TICKET_TTL_MS,
} from '@shared/development/api-tester/limits'
import { WS_TICKET_JSON_LIMIT, WsTicketRequestSchema } from '@shared/development/api-tester/schemas'
import type { WsTicketResponse } from '@shared/development/api-tester/types'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { readJson } from '../../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../../lib/throttle'
import { openWsTicket, sealWsTicket } from './crypto'

export const wsRoutes = new Hono<AppBindings>()

const TICKET_PATH = '/api/development/api-tester/ws'
/** A WebSocket handshake is a header exchange; a target that stalls it must not pin the request. */
const WS_HANDSHAKE_TIMEOUT_MS = 15_000

/**
 * Headers the relay writes itself or that belong to the connection between hops.
 *
 * A user header with one of these names would fight the handshake the platform is composing, so the
 * ticket route refuses it before anything is encrypted. Header names are case-insensitive.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

interface WsTicketPayload {
  url: string
  headers: Array<{ key: string; value: string }>
}

function parseTicketRequest(raw: unknown): WsTicketPayload {
  const result = WsTicketRequestSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.join('.') || 'body'
    throw ApiError.badRequest(`${path}: ${issue?.message ?? 'Invalid value'}`)
  }
  return { url: result.data.url, headers: result.data.headers }
}

/**
 * A target the relay may open: ws(s), without embedded credentials, on a host that is not a
 * literal private or internal address. Called once when the ticket is minted and again when it is
 * redeemed, so a payload written by an older build still meets today's rule.
 */
function assertSocketTarget(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ApiError(400, 'bad_request', 'invalid_url')
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new ApiError(400, 'bad_request', 'invalid_url')
  }
  if (url.username || url.password) {
    throw new ApiError(400, 'bad_request', 'invalid_url')
  }
  if (isBlockedTarget(url.hostname)) {
    throw new ApiError(403, 'apitester_blocked_target', 'blocked_target')
  }
  return url
}

function assertForwardableHeaders(headers: WsTicketPayload['headers']): void {
  for (const header of headers) {
    const key = header.key.trim().toLowerCase()
    if (!key || HOP_BY_HOP_HEADERS.has(key)) {
      throw ApiError.badRequest(`Invalid header: ${header.key}`)
    }
  }
}

function ticketResponse(ticket: string): WsTicketResponse {
  return { ticket, url: `${TICKET_PATH}?ticket=${encodeURIComponent(ticket)}` }
}

wsRoutes.post('/ws-tickets', async (c) => {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()

  await assertAttemptBudget(
    () =>
      consumeAttemptBudget(c.env.DB, [
        { key: `apitester-ws-ticket:${userId}`, ...WS_TICKET_RATE_LIMIT },
      ]),
    'Too many WebSocket tickets',
  )

  const input = parseTicketRequest(await readJson<unknown>(c, WS_TICKET_JSON_LIMIT))
  assertSocketTarget(input.url)
  assertForwardableHeaders(input.headers)

  const ticket = newApiTesterId()
  // The URL and headers may carry credentials for the target, so the database only ever sees the
  // vault's ciphertext. The vault scope is the ticket id, which is also what makes the row useless
  // to another ticket.
  const data = await sealWsTicket(c.env, ticket, input)
  const now = Date.now()
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM development_apitester_ws_tickets WHERE expires_at <= ?1').bind(now),
    c.env.DB.prepare(
      `INSERT INTO development_apitester_ws_tickets (id, user_id, data, expires_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(ticket, userId, data, now + WS_TICKET_TTL_MS),
  ])
  return c.json(ticketResponse(ticket))
})

/**
 * The moment a queued connection becomes a socket.
 *
 * The ticket is deleted by the lookup itself, so two upgrades racing for one ticket cannot both
 * win. The user id is part of the lookup, so a ticket leaked to another account is simply absent.
 */
async function consumeTicket(env: AppBindings['Bindings'], userId: string, ticket: string) {
  const { results } = await env.DB.prepare(
    `DELETE FROM development_apitester_ws_tickets
     WHERE user_id = ?1 AND id = ?2
     RETURNING data, expires_at`,
  )
    .bind(userId, ticket)
    .all<{ data: string; expires_at: number }>()
  return results[0]
}

function frameByteLength(data: unknown): number | null {
  if (typeof data === 'string') return new TextEncoder().encode(data).byteLength
  if (data instanceof ArrayBuffer) return data.byteLength
  return null
}

/** Codes a peer may send; the reserved ones (1004-1006, 1015) throw if written to close(). */
function relayCloseCode(event: Event): number {
  const code = (event as CloseEvent).code
  if (typeof code !== 'number') return 1000
  if (code >= 1000 && code <= 1003) return code
  if (code >= 1007 && code <= 1014) return code
  if (code >= 3000 && code <= 4999) return code
  return 1000
}

/**
 * Bridges one accepted upstream socket and one browser socket.
 *
 * Both directions share one lifecycle: the first close or error wins, the other side is closed, and
 * the idle timer is cleared so a finished connection leaves no work behind. Frames are forwarded
 * without being buffered anywhere, and an oversized frame closes the pair with 1009 instead of
 * being read into memory.
 */
export function pipeWebSockets(upstream: WebSocket, server: WebSocket): void {
  upstream.accept()
  server.accept()

  let closed = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const finish = (code: number, reason: string): void => {
    if (closed) return
    closed = true
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    try {
      server.close(code, reason)
    } catch {
      // The browser side may already be gone; the upstream close below is still worth trying.
    }
    try {
      upstream.close(code, reason)
    } catch {
      // Same for the upstream side; `closed` above keeps this from being attempted twice.
    }
  }

  const touch = (): void => {
    if (closed) return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => finish(1000, 'idle timeout'), WS_IDLE_TIMEOUT_MS)
  }

  const relay = (to: WebSocket) => (event: MessageEvent): void => {
    if (closed) return
    const data: unknown = event.data
    const bytes = frameByteLength(data)
    if (bytes === null) {
      finish(1003, 'unsupported frame')
      return
    }
    if (bytes > MAX_WS_FRAME_BYTES) {
      finish(1009, 'frame too large')
      return
    }
    touch()
    try {
      to.send(data as string | ArrayBuffer)
    } catch {
      finish(1011, 'relay send failed')
    }
  }

  upstream.addEventListener('message', relay(server))
  server.addEventListener('message', relay(upstream))
  upstream.addEventListener('close', (event) => finish(relayCloseCode(event), 'upstream closed'))
  server.addEventListener('close', (event) => finish(relayCloseCode(event), 'client closed'))
  upstream.addEventListener('error', () => finish(1011, 'upstream error'))
  server.addEventListener('error', () => finish(1011, 'client error'))
  touch()
}

wsRoutes.get('/ws', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    throw new ApiError(400, 'apitester_upgrade_required', 'This endpoint accepts only WebSocket upgrade requests')
  }
  const origin = c.req.header('Origin')
  if (!origin || origin !== new URL(c.req.url).origin) {
    throw new ApiError(403, 'apitester_origin_not_trusted', 'The WebSocket connection origin is not trusted')
  }
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  const ticket = c.req.query('ticket')
  if (!ticket) throw ApiError.badRequest('A WebSocket ticket is required')

  const row = await consumeTicket(c.env, userId, ticket)
  if (!row) {
    throw new ApiError(404, 'apitester_ticket_not_found', 'This WebSocket ticket does not exist')
  }
  if (row.expires_at <= Date.now()) {
    throw new ApiError(404, 'apitester_ticket_expired', 'This WebSocket ticket has expired')
  }

  const payload = await openWsTicket<WsTicketPayload>(c.env, ticket, row.data)
  const input = parseTicketRequest(payload)
  // The payload predates this request's checks by design (it was written by the ticket route), but
  // a ciphertext is still untrusted data at the boundary it is read on.
  assertForwardableHeaders(input.headers)

  // Workers fetch a WebSocket as an HTTP upgrade, not as a ws(s):// URL.
  const target = assertSocketTarget(input.url)
  target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
  const headers: Record<string, string> = Object.fromEntries(
    input.headers.map((header) => [header.key, header.value]),
  )
  headers.Upgrade = 'websocket'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WS_HANDSHAKE_TIMEOUT_MS)
  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(target.toString(), { headers, signal: controller.signal })
  } catch {
    console.warn('[inkstone] API tester WebSocket target could not be reached:', target.hostname)
    throw new ApiError(502, 'apitester_upstream_unreachable', 'The WebSocket target could not be reached')
  } finally {
    clearTimeout(timer)
  }

  const upstream = upstreamResponse.webSocket
  if (!upstream) {
    console.warn('[inkstone] API tester WebSocket target refused the upgrade:', target.hostname, upstreamResponse.status)
    throw new ApiError(
      502,
      'apitester_upstream_unreachable',
      `The WebSocket target refused the connection (HTTP ${upstreamResponse.status})`,
    )
  }

  const pair = new WebSocketPair()
  const client = pair[0]
  const server = pair[1]
  pipeWebSockets(upstream, server)
  return new Response(null, { status: 101, webSocket: client })
})
