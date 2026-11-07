// Live monitor routes for one owned session. Every lookup filters by `user_id`; the Durable Object
// re-checks the same row before it opens an exec channel, so a closed or foreign session never
// reaches the host.

import { Hono, type Context } from 'hono'
import type { WebsshMonitorKillResult, WebsshMonitorSnapshot } from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { readJson } from '../lib/request'

export const websshMonitorRoutes = new Hono<AppBindings>()

interface SessionRow {
  status: string
}

async function loadOwnedSession(c: Context<AppBindings>, userId: string, sessionId: string): Promise<SessionRow> {
  if (!isValidId(sessionId)) throw ApiError.badRequest('Invalid session id')
  const row = await c.env.DB.prepare(
    `SELECT status FROM webssh_sessions WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(sessionId, userId)
    .first<SessionRow>()
  if (!row) throw ApiError.notFound('That session does not exist')
  return row
}

async function callSessionMonitor(
  c: Context<AppBindings>,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const namespace = c.env.WEBSSH_SESSION
  if (!namespace) throw new ApiError(503, 'storage_unavailable', 'The WebSSH session runtime is not bound')
  const userId = c.get('userId')
  const stub = namespace.get(namespace.idFromName(`${userId}:${sessionId}`))
  const url = `https://webssh.internal/internal/monitor?u=${encodeURIComponent(userId)}&s=${encodeURIComponent(sessionId)}`
  const response = await stub.fetch(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  if (response.ok) return response
  let message = 'The monitor operation failed'
  try {
    const payload = await response.json() as { error?: { message?: string } }
    if (typeof payload.error?.message === 'string') message = payload.error.message
  } catch {
    // A non-JSON body still maps to the status-based message below.
  }
  if (response.status === 400) throw ApiError.badRequest(message)
  if (response.status === 404) throw ApiError.notFound(message)
  if (response.status === 409) throw new ApiError(409, 'session_not_ready', message)
  throw new ApiError(502, 'internal', message)
}

websshMonitorRoutes.get('/sessions/:id/monitor', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const row = await loadOwnedSession(c, userId, sessionId)
  if (row.status !== 'active') throw new ApiError(409, 'session_not_ready', 'The SSH session is not active yet')
  const response = await callSessionMonitor(c, sessionId, { op: 'snapshot' })
  return c.json<WebsshMonitorSnapshot>(await response.json() as WebsshMonitorSnapshot)
})

websshMonitorRoutes.post('/sessions/:id/monitor/kill', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const row = await loadOwnedSession(c, userId, sessionId)
  if (row.status !== 'active') throw new ApiError(409, 'session_not_ready', 'The SSH session is not active yet')
  const body = await readJson<Record<string, unknown>>(c, 4096)
  const pid = Number(body.pid)
  if (!Number.isSafeInteger(pid) || pid <= 1) throw ApiError.badRequest('The process id must be an integer above 1')
  const response = await callSessionMonitor(c, sessionId, { op: 'kill', pid })
  return c.json<WebsshMonitorKillResult>(await response.json() as WebsshMonitorKillResult)
})
