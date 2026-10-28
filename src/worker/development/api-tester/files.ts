import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  FILE_CONTENT_TYPES,
  FILE_EXTENSIONS,
  FILE_KINDS,
  FILE_LIST_LIMIT,
  FILE_RATE_LIMIT,
  FILE_TTL_MS,
  IMAGE_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_FILE_BYTES_PER_USER,
  MAX_FILES_PER_USER,
} from '@shared/development/api-tester/limits'
import type { FileKind } from '@shared/development/api-tester/limits'
import { newApiTesterId } from '@shared/development/api-tester/ids'
import { FILE_UPLOAD_LIMIT, FileListQuerySchema } from '@shared/development/api-tester/schemas'
import type { ApiTesterFile } from '@shared/development/api-tester/types'
import type { AppBindings, Env } from '../../env'
import { ApiError } from '../../lib/errors'
import { readFormDataWithinLimit } from '../../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../../lib/throttle'

export const fileRoutes = new Hono<AppBindings>()

fileRoutes.use('/files', async (c, next) => {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  await assertAttemptBudget(
    () => consumeAttemptBudget(c.env.DB, [{ key: `apitester-files:${userId}`, ...FILE_RATE_LIMIT }]),
    'Too many file operations',
  )
  await next()
})
fileRoutes.use('/files/*', async (c, next) => {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  await assertAttemptBudget(
    () => consumeAttemptBudget(c.env.DB, [{ key: `apitester-files:${userId}`, ...FILE_RATE_LIMIT }]),
    'Too many file operations',
  )
  await next()
})

/** One path segment the server builds a key from: account ids and generated file ids only. */
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

interface FileRow {
  id: string
  kind: string
  name: string
  content_type: string
  size: number
  r2_key: string
  created_at: number
  expires_at: number
}

interface QuotaRow {
  file_count: number
  total_bytes: number
}

function requireUserId(c: Context<AppBindings>): string {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  return userId
}

function requireBucket(env: Env): R2Bucket {
  if (!env.FILES) {
    throw new ApiError(503, 'storage_unavailable', 'File storage is not configured on this deployment')
  }
  return env.FILES
}

function normalizeMime(value: string | undefined): string {
  return value?.split(';')[0]?.trim().toLowerCase() ?? ''
}

function imageExtension(mime: string | undefined): string {
  const normalized = normalizeMime(mime)
  if (!normalized) return FILE_EXTENSIONS.image
  return IMAGE_EXTENSIONS[normalized] ?? 'bin'
}

/**
 * The one place an object key is formed.
 *
 * The kind, the owner and the id are all path segments the server chose, and each is checked here
 * so no caller can smuggle a slash into a key. An image keeps the extension its MIME names; an
 * image whose type is unknown is stored as the opaque binary it effectively is.
 */
export function fileKey(kind: FileKind, userId: string, fileId: string, mime?: string): string {
  if (!FILE_KINDS.includes(kind)) throw ApiError.badRequest('Unsupported file kind')
  if (!SAFE_KEY_SEGMENT.test(userId) || !SAFE_KEY_SEGMENT.test(fileId)) {
    throw ApiError.badRequest('Invalid file key segment')
  }
  const extension = kind === 'image' ? imageExtension(mime) : FILE_EXTENSIONS[kind]
  return `development/apitester/${kind}/${userId}/${fileId}.${extension}`
}

function contentTypeFor(kind: FileKind, uploadType: string): string {
  if (kind !== 'image') return FILE_CONTENT_TYPES[kind]
  const mime = normalizeMime(uploadType)
  if (!mime) return FILE_CONTENT_TYPES.image
  return IMAGE_EXTENSIONS[mime] ? mime : FILE_CONTENT_TYPES.bin
}

function sanitizeFileName(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .trim()
  return cleaned.slice(0, 200) || 'file'
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`
}

function toFileView(row: FileRow): ApiTesterFile {
  return {
    id: row.id,
    kind: row.kind as FileKind,
    name: row.name,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    url: `/api/development/api-tester/files/${row.id}`,
  }
}

function findFileRow(db: D1Database, userId: string, id: string): Promise<FileRow | null> {
  return db
    .prepare(
      `SELECT id, kind, name, content_type, size, r2_key, created_at, expires_at
         FROM development_apitester_files
        WHERE user_id = ? AND id = ?`,
    )
    .bind(userId, id)
    .first<FileRow>()
}

/**
 * Drops expired rows and their objects. Cleanup is triggered by the routes that touch the library,
 * and a failure is logged rather than allowed to fail the user's own upload or listing.
 */
async function cleanupExpiredFiles(env: Env, userId: string): Promise<void> {
  const bucket = env.FILES
  if (!bucket) return
  const now = Date.now()
  let keys: string[]
  try {
    const { results } = await env.DB.prepare(
      `SELECT r2_key FROM development_apitester_files WHERE user_id = ? AND expires_at <= ?`,
    )
      .bind(userId, now)
      .all<{ r2_key: string }>()
    keys = results.map((row) => row.r2_key)
  } catch (error) {
    console.warn('[inkstone] Listing expired API tester files failed:', error)
    return
  }
  if (keys.length === 0) return
  try {
    await bucket.delete(keys)
  } catch (error) {
    // The rows still go: an expired file is unreachable either way, and an object R2 refuses to
    // delete now is a lifecycle-rule problem rather than a reason to keep serving it.
    console.warn('[inkstone] Removing expired API tester objects failed:', error)
  }
  try {
    await env.DB.prepare(
      `DELETE FROM development_apitester_files WHERE user_id = ? AND expires_at <= ?`,
    )
      .bind(userId, now)
      .run()
  } catch (error) {
    console.warn('[inkstone] Deleting expired API tester rows failed:', error)
  }
}

async function readQuota(db: D1Database, userId: string, now: number): Promise<QuotaRow> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS total_bytes
         FROM development_apitester_files
        WHERE user_id = ? AND expires_at > ?`,
    )
    .bind(userId, now)
    .first<QuotaRow>()
  return {
    file_count: Number(row?.file_count ?? 0),
    total_bytes: Number(row?.total_bytes ?? 0),
  }
}

fileRoutes.post('/files', async (c) => {
  const userId = requireUserId(c)
  const bucket = requireBucket(c.env)

  let form: FormData
  try {
    form = await readFormDataWithinLimit(c.req, FILE_UPLOAD_LIMIT)
  } catch (error) {
    if (error instanceof ApiError && error.status === 413) {
      throw new ApiError(413, 'apitester_file_too_large', `Files are limited to ${MAX_FILE_BYTES} bytes`)
    }
    throw error
  }

  const file = form.get('file')
  if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
    throw ApiError.badRequest('The upload must include a file field')
  }
  const kind = form.get('kind')
  if (typeof kind !== 'string' || !FILE_KINDS.includes(kind as FileKind)) {
    throw ApiError.badRequest('The upload kind is not supported')
  }
  const fileKind = kind as FileKind
  const requestedName = form.get('name')
  const name = sanitizeFileName(typeof requestedName === 'string' && requestedName ? requestedName : file.name)
  if (file.size > MAX_FILE_BYTES) {
    throw new ApiError(413, 'apitester_file_too_large', `Files are limited to ${MAX_FILE_BYTES} bytes`)
  }

  await cleanupExpiredFiles(c.env, userId)
  const now = Date.now()
  const quota = await readQuota(c.env.DB, userId, now)
  if (quota.file_count >= MAX_FILES_PER_USER || quota.total_bytes + file.size > MAX_FILE_BYTES_PER_USER) {
    throw new ApiError(409, 'apitester_quota_exceeded', 'The API tester file quota has been reached')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new ApiError(413, 'apitester_file_too_large', `Files are limited to ${MAX_FILE_BYTES} bytes`)
  }

  const id = newApiTesterId()
  const contentType = contentTypeFor(fileKind, file.type)
  const key = fileKey(fileKind, userId, id, contentType)
  const expiresAt = now + FILE_TTL_MS
  await bucket.put(key, bytes, { httpMetadata: { contentType } })
  try {
    await c.env.DB.prepare(
      `INSERT INTO development_apitester_files
         (id, user_id, kind, name, content_type, size, r2_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, userId, fileKind, name, contentType, bytes.byteLength, key, now, expiresAt)
      .run()
  } catch (error) {
    try {
      await bucket.delete(key)
    } catch (cleanupError) {
      console.warn('[inkstone] Removing an unrecorded API tester file failed:', cleanupError)
    }
    console.warn('[inkstone] Recording an API tester file failed:', error)
    throw new ApiError(500, 'internal', 'The uploaded file could not be recorded')
  }

  return c.json(
    toFileView({
      id,
      kind: fileKind,
      name,
      content_type: contentType,
      size: bytes.byteLength,
      r2_key: key,
      created_at: now,
      expires_at: expiresAt,
    }),
  )
})

fileRoutes.get('/files', async (c) => {
  const userId = requireUserId(c)
  requireBucket(c.env)
  const parsed = FileListQuerySchema.safeParse({ kind: c.req.query('kind') || undefined })
  if (!parsed.success) throw ApiError.badRequest('The file kind is not supported')
  const kind = parsed.data.kind

  await cleanupExpiredFiles(c.env, userId)
  const now = Date.now()
  const statement = kind
    ? c.env.DB.prepare(
        `SELECT id, kind, name, content_type, size, r2_key, created_at, expires_at
           FROM development_apitester_files
          WHERE user_id = ? AND kind = ? AND expires_at > ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      ).bind(userId, kind, now, FILE_LIST_LIMIT)
    : c.env.DB.prepare(
        `SELECT id, kind, name, content_type, size, r2_key, created_at, expires_at
           FROM development_apitester_files
          WHERE user_id = ? AND expires_at > ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      ).bind(userId, now, FILE_LIST_LIMIT)
  const { results } = await statement.all<FileRow>()
  return c.json(results.map(toFileView))
})

fileRoutes.get('/files/:id', async (c) => {
  const userId = requireUserId(c)
  const bucket = requireBucket(c.env)
  const row = await findFileRow(c.env.DB, userId, c.req.param('id'))
  if (!row || row.expires_at <= Date.now()) throw ApiError.notFound('File not found')

  const object = await bucket.get(row.r2_key)
  if (!object) throw ApiError.notFound('File data is missing')
  return new Response(object.body as BodyInit, {
    headers: {
      'Content-Type': row.content_type,
      'Content-Disposition': contentDisposition(row.name),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
})

fileRoutes.delete('/files/:id', async (c) => {
  const userId = requireUserId(c)
  requireBucket(c.env)
  const id = c.req.param('id')
  const row = await findFileRow(c.env.DB, userId, id)
  if (!row) throw ApiError.notFound('File not found')

  await c.env.DB.prepare('DELETE FROM development_apitester_files WHERE user_id = ? AND id = ?')
    .bind(userId, id)
    .run()
  try {
    await c.env.FILES?.delete(row.r2_key)
  } catch (error) {
    console.warn('[inkstone] Removing the object of a deleted API tester file failed:', error)
  }
  return c.json({ ok: true })
})

/** The bytes of a file the caller owns, for a relay request body. */
export async function readOwnedFileBytes(env: Env, userId: string, fileId: string): Promise<Uint8Array> {
  const bucket = requireBucket(env)
  const row = await findFileRow(env.DB, userId, fileId)
  if (!row || row.expires_at <= Date.now()) throw ApiError.notFound('File not found')

  const object = await bucket.get(row.r2_key)
  if (!object) throw ApiError.notFound('File data is missing')
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new ApiError(413, 'apitester_file_too_large', `Files are limited to ${MAX_FILE_BYTES} bytes`)
  }
  return bytes
}
