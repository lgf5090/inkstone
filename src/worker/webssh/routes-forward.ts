import { Hono, type Context } from 'hono'
import type {
  WebsshForwardGrant,
  WebsshForwardRule,
  WebsshForwardRuleListResponse,
  WebsshForwardStatusResponse,
} from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import type { ApiErrorCode } from '@shared/types'
import { isValidId, newId } from '../lib/id'
import { readJson } from '../lib/request'
import {
  WEBSSH_FORWARD_RULE_NAME_MAX,
  WEBSSH_FORWARD_MAX_REQUEST_BYTES,
} from './constants'
import { isForwardMethod, isLoopbackTargetHost, normalizeForwardHost, normalizeForwardPort } from './forwarding/proxy'

export const websshForwardRoutes = new Hono<AppBindings>()

const FORWARD_JSON_LIMIT = 8 * 1024

interface RuleRow {
  id: string
  name: string
  host_id: string
  target_host: string
  target_port: number
  mode: string
  created_at: number
  updated_at: number
}

function ruleView(row: RuleRow): WebsshForwardRule {
  return {
    id: row.id,
    name: row.name,
    hostId: row.host_id,
    targetHost: row.target_host,
    targetPort: Number(row.target_port),
    mode: 'trusted',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

async function loadOwnedSession(c: Context<AppBindings>, userId: string, sessionId: string): Promise<void> {
  if (!isValidId(sessionId)) throw ApiError.badRequest('Invalid session id')
  const row = await c.env.DB.prepare(
    `SELECT status FROM webssh_sessions WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(sessionId, userId)
    .first<{ status: string }>()
  if (!row) throw ApiError.notFound('That session does not exist')
  if (row.status !== 'active') throw new ApiError(409, 'session_not_ready', 'The SSH session is not active yet')
}

async function loadOwnedHost(c: Context<AppBindings>, userId: string, hostId: string): Promise<void> {
  if (!isValidId(hostId)) throw ApiError.badRequest('Invalid host id')
  const row = await c.env.DB.prepare(
    `SELECT id FROM webssh_hosts WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  )
    .bind(userId, hostId)
    .first<{ id: string }>()
  if (!row) throw ApiError.notFound('That host does not exist')
}

async function callSessionForward(
  c: Context<AppBindings>,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const namespace = c.env.WEBSSH_SESSION
  if (!namespace) throw new ApiError(503, 'storage_unavailable', 'The WebSSH session runtime is not bound')
  const userId = c.get('userId')
  const stub = namespace.get(namespace.idFromName(`${userId}:${sessionId}`))
  const url = `https://webssh.internal/internal/forward?u=${encodeURIComponent(userId)}&s=${encodeURIComponent(sessionId)}`
  const response = await stub.fetch(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  if (response.ok) return response
  throw await forwardError(response)
}

async function forwardError(response: Response): Promise<ApiError> {
  let code = 'forward_error'
  let message = 'The forward operation failed'
  try {
    const payload = await response.json() as { error?: { code?: string; message?: string } }
    if (typeof payload.error?.code === 'string') code = payload.error.code
    if (typeof payload.error?.message === 'string') message = payload.error.message
  } catch {
    code = code || 'forward_error'
  }
  const status = response.status === 400 || response.status === 403 || response.status === 404
    || response.status === 409 || response.status === 413 || response.status === 429
    || response.status === 500 || response.status === 502 || response.status === 503
    ? response.status
    : 502
  return new ApiError(status, code as ApiErrorCode, message)
}

websshForwardRoutes.get('/forward/rules', async (c) => {
  const userId = c.get('userId')
  const hostId = c.req.query('hostId') ?? ''
  const rows = hostId
    ? await c.env.DB.prepare(
      `SELECT id, name, host_id, target_host, target_port, mode, created_at, updated_at
         FROM webssh_forward_rules
        WHERE user_id = ?1 AND host_id = ?2
        ORDER BY created_at DESC`,
    ).bind(userId, hostId).all<RuleRow>()
    : await c.env.DB.prepare(
      `SELECT id, name, host_id, target_host, target_port, mode, created_at, updated_at
         FROM webssh_forward_rules
        WHERE user_id = ?1
        ORDER BY created_at DESC`,
    ).bind(userId).all<RuleRow>()
  return c.json<WebsshForwardRuleListResponse>({ items: (rows.results ?? []).map(ruleView) })
})

websshForwardRoutes.post('/forward/rules', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{
    name?: unknown
    hostId?: unknown
    targetHost?: unknown
    targetPort?: unknown
  }>(c, FORWARD_JSON_LIMIT)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length === 0 || name.length > WEBSSH_FORWARD_RULE_NAME_MAX) {
    throw new ApiError(400, 'bad_request', 'The rule name is invalid')
  }
  if (typeof body.hostId !== 'string' || !isValidId(body.hostId)) throw ApiError.badRequest('Invalid host id')
  await loadOwnedHost(c, userId, body.hostId)
  const targetHost = normalizeForwardHost(body.targetHost)
  const targetPort = normalizeForwardPort(body.targetPort)
  if (!targetHost || !targetPort) throw new ApiError(400, 'bad_request', 'The forward target host or port is invalid')
  const allowPrivate = (c.env.WEBSSH_DEV_ALLOW_PRIVATE_HOSTS ?? '').trim().toLowerCase() === '1'
  if (!isLoopbackTargetHost(targetHost) && !allowPrivate) {
    throw new ApiError(403, 'forward_blocked', 'Only loopback forward targets are allowed')
  }
  const existing = await c.env.DB.prepare(
    `SELECT id FROM webssh_forward_rules WHERE user_id = ?1 AND host_id = ?2 AND lower(name) = lower(?3)`,
  )
    .bind(userId, body.hostId, name)
    .first<{ id: string }>()
  if (existing) throw new ApiError(409, 'conflict', 'A forward rule with that name already exists')
  const now = Date.now()
  const id = newId()
  await c.env.DB.prepare(
    `INSERT INTO webssh_forward_rules (user_id, id, name, host_id, target_host, target_port, mode, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'trusted', ?7, ?7)`,
  )
    .bind(userId, id, name, body.hostId, targetHost, targetPort, now)
    .run()
  return c.json<{ rule: WebsshForwardRule }>({
    rule: {
      id, name, hostId: body.hostId, targetHost, targetPort, mode: 'trusted', createdAt: now, updatedAt: now,
    },
  }, 201)
})

websshForwardRoutes.delete('/forward/rules/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.badRequest('Invalid rule id')
  const deleted = await c.env.DB.prepare(
    `DELETE FROM webssh_forward_rules WHERE user_id = ?1 AND id = ?2 RETURNING id`,
  )
    .bind(userId, id)
    .first<{ id: string }>()
  if (!deleted) throw ApiError.notFound('That forward rule does not exist')
  return c.json<{ ok: true }>({ ok: true })
})

websshForwardRoutes.get('/sessions/:id/forward', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  await loadOwnedSession(c, userId, sessionId)
  const response = await callSessionForward(c, sessionId, { op: 'status' })
  return c.json<WebsshForwardStatusResponse>(await response.json() as WebsshForwardStatusResponse)
})

websshForwardRoutes.post('/sessions/:id/forward', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  await loadOwnedSession(c, userId, sessionId)
  const body = await readJson<{ host?: unknown; port?: unknown }>(c, FORWARD_JSON_LIMIT)
  const host = normalizeForwardHost(body.host)
  const port = normalizeForwardPort(body.port)
  if (!host || !port) throw ApiError.badRequest('The forward target host or port is invalid')
  const response = await callSessionForward(c, sessionId, { op: 'create', host, port })
  const payload = await response.json() as { grant: WebsshForwardGrant }
  return c.json<{ grant: WebsshForwardGrant }>(payload, 201)
})

websshForwardRoutes.delete('/sessions/:id/forward/:token', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  await loadOwnedSession(c, userId, sessionId)
  const token = c.req.param('token')
  if (!isValidId(token)) throw ApiError.badRequest('Invalid forward token')
  const response = await callSessionForward(c, sessionId, { op: 'stop', token })
  return c.json<{ stopped: boolean }>(await response.json() as { stopped: boolean })
})

async function forwardErrorResponse(response: Response): Promise<Response> {
  let code = 'forward_error'
  let message = 'The forward operation failed'
  try {
    const payload = await response.json() as { error?: { code?: string; message?: string } }
    if (typeof payload.error?.code === 'string') code = payload.error.code
    if (typeof payload.error?.message === 'string') message = payload.error.message
  } catch {
    code = code || 'forward_error'
  }
  return Response.json({ error: { code, message } }, { status: response.status })
}

async function proxyForward(c: Context<AppBindings>): Promise<Response> {
  const userId = c.get('userId')
  const sessionId = c.req.param('id') ?? ''
  await loadOwnedSession(c, userId, sessionId)
  const token = c.req.param('token') ?? ''
  if (!isValidId(token)) throw ApiError.badRequest('Invalid forward token')
  if (c.req.header('Upgrade')) {
    return Response.json({ error: { code: 'forward_method_blocked', message: 'WebSocket upgrades are not supported through a forward' } }, { status: 405 })
  }
  const method = c.req.method.toUpperCase()
  if (!isForwardMethod(method)) {
    return Response.json({ error: { code: 'forward_method_blocked', message: 'That HTTP method is not allowed through a forward' } }, { status: 405 })
  }
  const namespace = c.env.WEBSSH_SESSION
  if (!namespace) throw new ApiError(503, 'storage_unavailable', 'The WebSSH session runtime is not bound')

  const original = new URL(c.req.url)
  const segments = original.pathname.split('/')
  const forwardIndex = segments.indexOf('forward')
  const rest = segments.slice(forwardIndex + 2).join('/')
  const forwardPath = `/${rest}${original.search}`

  let body: ArrayBuffer | null = null
  if (method !== 'GET' && method !== 'HEAD') {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > WEBSSH_FORWARD_MAX_REQUEST_BYTES) {
      throw new ApiError(413, 'payload_too_large', 'The forwarded request body exceeds the size limit')
    }
    body = await c.req.arrayBuffer()
    if (body.byteLength > WEBSSH_FORWARD_MAX_REQUEST_BYTES) {
      throw new ApiError(413, 'payload_too_large', 'The forwarded request body exceeds the size limit')
    }
  }

  const stub = namespace.get(namespace.idFromName(`${userId}:${sessionId}`))
  const url = `https://webssh.internal/internal/forward/proxy?u=${encodeURIComponent(userId)}&s=${encodeURIComponent(sessionId)}&t=${encodeURIComponent(token)}`
  const headers = new Headers(c.req.raw.headers)
  headers.set('x-webssh-forward-path', forwardPath)
  const response = await stub.fetch(new Request(url, { method, headers, body }))
  if (!response.ok) return forwardErrorResponse(response)
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}

websshForwardRoutes.all('/sessions/:id/forward/:token', proxyForward)
websshForwardRoutes.all('/sessions/:id/forward/:token/*', proxyForward)
