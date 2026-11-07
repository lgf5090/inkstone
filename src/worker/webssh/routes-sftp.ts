// W5 SFTP REST surface. Every route first resolves the session by (id, user_id), so another
// account's session answers 404 even when the id exists. Transfers are staged in R2 under
// `webssh/documents/uploads/<user>/<transfer>/`; the Durable Object streams them to the host.
//
// Shapes for the eventual file-manager UI live in `@shared/webssh/types` and §8.5 of the plan.

import { Hono, type Context } from 'hono'
import type {
  WebsshSftpMutationResult,
  WebsshSftpStatResponse,
  WebsshSftpUploadCreated,
  WebsshSftpUploadStatus,
} from '@shared/webssh/types'
import type { ApiErrorCode } from '@shared/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { readJson } from '../lib/request'
import {
  WEBSSH_SFTP_MAX_BLOCK_BYTES,
  WEBSSH_SFTP_MAX_FILE_BYTES,
  WEBSSH_SFTP_UPLOAD_PREFIX,
} from './sftp/limits'
import { normalizeSftpPath, SftpPathError } from './sftp/paths'

export const websshSftpRoutes = new Hono<AppBindings>()

/** Paths may be 4 KiB, and rename carries two of them, so the JSON body bound is wider than 4 KiB. */
const SFTP_JSON_LIMIT = 16 * 1024

interface SessionRow {
  status: string
  host_id: string
}

interface UploadMeta {
  path: string
  size: number
  transferId: string
  createdAt: number
}

async function loadOwnedSession(c: Context<AppBindings>, userId: string, sessionId: string): Promise<SessionRow> {
  if (!isValidId(sessionId)) throw ApiError.badRequest('Invalid session id')
  const row = await c.env.DB.prepare(
    `SELECT status, host_id FROM webssh_sessions WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(sessionId, userId)
    .first<SessionRow>()
  if (!row) throw ApiError.notFound('That session does not exist')
  return row
}

function requireActive(row: SessionRow): void {
  if (row.status !== 'active') {
    throw new ApiError(409, 'session_not_ready', 'The SSH session is not active yet')
  }
}

function uploadPrefix(userId: string, transferId: string): string {
  return `${WEBSSH_SFTP_UPLOAD_PREFIX}/${userId}/${transferId}/`
}

function partKey(prefix: string, offset: number): string {
  return `${prefix}parts/${offset.toString().padStart(12, '0')}`
}

function badPath(error: unknown): never {
  if (error instanceof SftpPathError) throw new ApiError(400, 'invalid_path', error.message)
  throw error
}

const API_ERROR_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  'bad_request', 'forbidden', 'not_found', 'conflict', 'payload_too_large', 'session_not_ready',
  'sftp_error', 'invalid_path', 'file_too_large', 'block_too_large', 'invalid_range', 'size_mismatch',
  'upload_not_found', 'upload_incomplete', 'storage_unavailable', 'internal',
])

function apiStatus(status: number): 400 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503 {
  if (status === 400 || status === 403 || status === 404 || status === 409 || status === 413
    || status === 422 || status === 429 || status === 500 || status === 502 || status === 503) {
    return status
  }
  return 502
}

/** Calls the per-session Durable Object's internal SFTP op endpoint and forwards its answer. */
async function callSessionSftp(
  c: Context<AppBindings>,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const namespace = c.env.WEBSSH_SESSION
  if (!namespace) throw new ApiError(503, 'storage_unavailable', 'The WebSSH session runtime is not bound')
  const userId = c.get('userId')
  const stub = namespace.get(namespace.idFromName(`${userId}:${sessionId}`))
  const url = `https://webssh.internal/internal/sftp?u=${encodeURIComponent(userId)}&s=${encodeURIComponent(sessionId)}`
  const response = await stub.fetch(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  if (response.ok) return response

  let code: ApiErrorCode = 'sftp_error'
  let message = 'The SFTP operation failed'
  try {
    const payload = await response.json() as { error?: { code?: string; message?: string } }
    if (typeof payload.error?.code === 'string' && API_ERROR_CODES.has(payload.error.code)) {
      code = payload.error.code as ApiErrorCode
    }
    if (typeof payload.error?.message === 'string') message = payload.error.message
  } catch {
    // A non-JSON body still maps to the generic SFTP error below.
  }
  throw new ApiError(apiStatus(response.status), code, message)
}

async function readUploadMeta(r2: R2Bucket, prefix: string): Promise<UploadMeta | null> {
  const object = await r2.get(`${prefix}meta.json`)
  if (!object) return null
  try {
    const parsed: unknown = await object.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const meta = parsed as Record<string, unknown>
    if (typeof meta.path !== 'string' || typeof meta.size !== 'number' || !Number.isSafeInteger(meta.size)) return null
    if (typeof meta.transferId !== 'string' || !isValidId(meta.transferId)) return null
    return {
      path: meta.path,
      size: meta.size,
      transferId: meta.transferId,
      createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
    }
  } catch {
    return null
  }
}

async function listUploadParts(r2: R2Bucket, prefix: string): Promise<R2Object[]> {
  const parts: R2Object[] = []
  let cursor: string | undefined
  do {
    const listed = await r2.list({ prefix: `${prefix}parts/`, cursor })
    parts.push(...listed.objects)
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
  return parts.sort((left, right) => left.key.localeCompare(right.key))
}

async function deleteUploadPrefix(r2: R2Bucket, prefix: string): Promise<void> {
  for (;;) {
    const listed = await r2.list({ prefix })
    if (listed.objects.length === 0) return
    await r2.delete(listed.objects.map((object) => object.key))
    if (!listed.truncated) return
  }
}

function requireFiles(c: Context<AppBindings>): R2Bucket {
  if (!c.env.FILES) throw new ApiError(503, 'storage_unavailable', 'R2 staging is not bound')
  return c.env.FILES
}

// ---- directory listing ------------------------------------------------------------------------

websshSftpRoutes.get('/sessions/:id/sftp/list', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const row = await loadOwnedSession(c, userId, sessionId)
  requireActive(row)
  let path: string
  try {
    path = normalizeSftpPath(c.req.query('path') ?? '/')
  } catch (error) {
    badPath(error)
  }
  const response = await callSessionSftp(c, sessionId, { op: 'list', path })
  return new Response(response.body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})

websshSftpRoutes.get('/sessions/:id/sftp/download', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const row = await loadOwnedSession(c, userId, sessionId)
  requireActive(row)
  let path: string
  try {
    path = normalizeSftpPath(c.req.query('path'))
  } catch (error) {
    badPath(error)
  }
  const offset = parseNonNegative(c.req.query('offset'), 0)
  const length = c.req.query('length') === undefined ? undefined : parseNonNegative(c.req.query('length'), 0)
  if (length !== undefined && length > WEBSSH_SFTP_MAX_BLOCK_BYTES) {
    throw new ApiError(413, 'block_too_large', 'A download block may not exceed 64 MiB')
  }
  const response = await callSessionSftp(c, sessionId, { op: 'download', path, offset, ...(length === undefined ? {} : { length }) })
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'private, no-store')
  return new Response(response.body, { status: 200, headers })
})

websshSftpRoutes.post('/sessions/:id/sftp/stat', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const row = await loadOwnedSession(c, userId, sessionId)
  requireActive(row)
  const body = await readJson<{ path?: unknown }>(c, SFTP_JSON_LIMIT)
  let path: string
  try {
    path = normalizeSftpPath(body.path)
  } catch (error) {
    badPath(error)
  }
  const response = await callSessionSftp(c, sessionId, { op: 'stat', path })
  return c.json<WebsshSftpStatResponse>(await response.json() as WebsshSftpStatResponse)
})

function parseNonNegative(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) throw new ApiError(400, 'invalid_range', 'The range must be a non-negative integer')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new ApiError(400, 'invalid_range', 'The range is too large')
  return parsed
}

// ---- mutations ---------------------------------------------------------------------------------

websshSftpRoutes.post('/sessions/:id/sftp/mkdir', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const row = await loadOwnedSession(c, userId, sessionId)
  requireActive(row)
  const body = await readJson<{ path?: unknown }>(c, SFTP_JSON_LIMIT)
  let path: string
  try {
    path = normalizeSftpPath(body.path)
  } catch (error) {
    badPath(error)
  }
  await callSessionSftp(c, sessionId, { op: 'mkdir', path })
  return c.json<WebsshSftpMutationResult>({ ok: true })
})

websshSftpRoutes.post('/sessions/:id/sftp/remove', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const row = await loadOwnedSession(c, userId, sessionId)
  requireActive(row)
  const body = await readJson<{ path?: unknown; kind?: unknown }>(c, SFTP_JSON_LIMIT)
  let path: string
  try {
    path = normalizeSftpPath(body.path)
  } catch (error) {
    badPath(error)
  }
  const kind = body.kind === 'directory' ? 'directory' : 'file'
  await callSessionSftp(c, sessionId, { op: 'remove', path, kind })
  return c.json<WebsshSftpMutationResult>({ ok: true })
})

websshSftpRoutes.post('/sessions/:id/sftp/rename', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const row = await loadOwnedSession(c, userId, sessionId)
  requireActive(row)
  const body = await readJson<{ from?: unknown; to?: unknown; overwrite?: unknown }>(c, SFTP_JSON_LIMIT)
  let from: string
  let to: string
  try {
    from = normalizeSftpPath(body.from)
    to = normalizeSftpPath(body.to)
  } catch (error) {
    badPath(error)
  }
  await callSessionSftp(c, sessionId, { op: 'rename', from, to, overwrite: body.overwrite === true })
  return c.json<WebsshSftpMutationResult>({ ok: true })
})

// ---- chunked upload staging --------------------------------------------------------------------

websshSftpRoutes.post('/sessions/:id/sftp/uploads', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const row = await loadOwnedSession(c, userId, sessionId)
  requireActive(row)
  const r2 = requireFiles(c)
  const body = await readJson<{ path?: unknown; size?: unknown }>(c, SFTP_JSON_LIMIT)
  let path: string
  try {
    path = normalizeSftpPath(body.path)
  } catch (error) {
    badPath(error)
  }
  const size = body.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new ApiError(400, 'bad_request', 'The upload size must be a non-negative integer')
  }
  if (size > WEBSSH_SFTP_MAX_FILE_BYTES) {
    throw new ApiError(413, 'file_too_large', 'A single file may not exceed 2 GiB')
  }

  const transferId = newId()
  const prefix = uploadPrefix(userId, transferId)
  const meta: UploadMeta = { path, size, transferId, createdAt: Date.now() }
  await r2.put(`${prefix}meta.json`, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } })
  return c.json<WebsshSftpUploadCreated>({
    transferId,
    size,
    chunkSize: WEBSSH_SFTP_MAX_BLOCK_BYTES,
  }, 201)
})

websshSftpRoutes.put('/sessions/:id/sftp/uploads/:transferId', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const row = await loadOwnedSession(c, userId, sessionId)
  requireActive(row)
  const r2 = requireFiles(c)
  const transferId = c.req.param('transferId')
  if (!isValidId(transferId)) throw ApiError.badRequest('Invalid transfer id')
  const prefix = uploadPrefix(userId, transferId)
  const meta = await readUploadMeta(r2, prefix)
  if (!meta) throw new ApiError(404, 'upload_not_found', 'That upload transfer does not exist')

  const offset = parseNonNegative(c.req.header('x-webssh-offset'), -1)
  if (offset < 0) throw new ApiError(400, 'invalid_range', 'An x-webssh-offset header is required')
  const declaredLength = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > WEBSSH_SFTP_MAX_BLOCK_BYTES) {
    throw new ApiError(413, 'block_too_large', 'An upload block may not exceed 64 MiB')
  }
  const bytes = new Uint8Array(await c.req.raw.arrayBuffer())
  if (bytes.byteLength === 0) throw new ApiError(400, 'bad_request', 'An upload block may not be empty')
  if (bytes.byteLength > WEBSSH_SFTP_MAX_BLOCK_BYTES) {
    throw new ApiError(413, 'block_too_large', 'An upload block may not exceed 64 MiB')
  }
  if (offset + bytes.byteLength > meta.size) {
    throw new ApiError(409, 'size_mismatch', 'The upload block extends past the declared file size')
  }
  await r2.put(partKey(prefix, offset), bytes, { httpMetadata: { contentType: 'application/octet-stream' } })
  return c.json<WebsshSftpUploadStatus>({
    transferId,
    received: offset + bytes.byteLength,
    size: meta.size,
  })
})

websshSftpRoutes.get('/sessions/:id/sftp/uploads/:transferId', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const row = await loadOwnedSession(c, userId, sessionId)
  requireActive(row)
  const r2 = requireFiles(c)
  const transferId = c.req.param('transferId')
  if (!isValidId(transferId)) throw ApiError.badRequest('Invalid transfer id')
  const prefix = uploadPrefix(userId, transferId)
  const meta = await readUploadMeta(r2, prefix)
  if (!meta) throw new ApiError(404, 'upload_not_found', 'That upload transfer does not exist')
  return c.json<WebsshSftpUploadStatus>({
    transferId,
    received: await stagedBytes(r2, prefix),
    size: meta.size,
  })
})

websshSftpRoutes.post('/sessions/:id/sftp/uploads/:transferId/complete', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  const row = await loadOwnedSession(c, userId, sessionId)
  requireActive(row)
  const r2 = requireFiles(c)
  const transferId = c.req.param('transferId')
  if (!isValidId(transferId)) throw ApiError.badRequest('Invalid transfer id')
  const prefix = uploadPrefix(userId, transferId)
  const meta = await readUploadMeta(r2, prefix)
  if (!meta) throw new ApiError(404, 'upload_not_found', 'That upload transfer does not exist')
  const received = await stagedBytes(r2, prefix)
  if (received !== meta.size) {
    throw new ApiError(409, 'upload_incomplete', `The staged upload holds ${received} of ${meta.size} bytes`, {
      received,
      size: meta.size,
    })
  }
  await callSessionSftp(c, sessionId, {
    op: 'upload',
    path: meta.path,
    size: meta.size,
    transferId,
  })
  await deleteUploadPrefix(r2, prefix)
  return c.json<WebsshSftpMutationResult>({ ok: true })
})

websshSftpRoutes.delete('/sessions/:id/sftp/uploads/:transferId', async (c) => {
  const userId = c.get('userId')
  const sessionId = c.req.param('id')
  await loadOwnedSession(c, userId, sessionId)
  const r2 = requireFiles(c)
  const transferId = c.req.param('transferId')
  if (!isValidId(transferId)) throw ApiError.badRequest('Invalid transfer id')
  const prefix = uploadPrefix(userId, transferId)
  if (!await readUploadMeta(r2, prefix)) throw new ApiError(404, 'upload_not_found', 'That upload transfer does not exist')
  await deleteUploadPrefix(r2, prefix)
  return c.json<WebsshSftpMutationResult>({ ok: true })
})

async function stagedBytes(r2: R2Bucket, prefix: string): Promise<number> {
  const parts = await listUploadParts(r2, prefix)
  let total = 0
  for (const part of parts) total += part.size
  return total
}
