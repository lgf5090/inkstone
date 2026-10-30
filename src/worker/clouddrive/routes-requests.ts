import { Hono, type Context } from 'hono'
import { sharePasscodeProblem } from '@shared/share-passcode'
import {
  autoSuffixName,
  categoryFor,
  childPath,
  foldedName,
} from '@shared/clouddrive/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId, newSlug } from '../lib/id'
import { hashPassword, verifyPassword } from '../lib/password'
import { readJson } from '../lib/request'
import {
  initialsOf,
  parseName,
  parsePath,
  resolveEntry,
  resolveMount,
} from './lib'
import { cloudDriveUsage } from './store'

export const clouddriveRequestRoutes = new Hono<AppBindings>()
export const clouddrivePublicRequestRoutes = new Hono<AppBindings>()

clouddriveRequestRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

const BODY_LIMIT = 16 * 1024
const DEFAULT_MAX_FILES = 20
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024
const BLOCKED_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
])

interface RequestRow {
  slug: string
  user_id: string
  target_mount: string
  target_path: string
  name: string
  password_hash: string | null
  expires_at: number | null
  max_files: number
  max_bytes: number
  max_file_bytes: number
  received_files: number
  received_bytes: number
  is_enabled: number
  created_at: number
  last_upload_at: number | null
  revoked_at: number | null
}

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

function toView(row: RequestRow) {
  return {
    slug: row.slug,
    url: `/r/${row.slug}`,
    name: row.name,
    targetPath: row.target_path,
    hasPassword: Boolean(row.password_hash),
    expiresAt: row.expires_at,
    maxFiles: row.max_files,
    maxBytes: row.max_bytes,
    maxFileBytes: row.max_file_bytes,
    receivedFiles: row.received_files,
    receivedBytes: row.received_bytes,
    isEnabled: row.is_enabled === 1,
    createdAt: row.created_at,
    lastUploadAt: row.last_upload_at,
    revokedAt: row.revoked_at,
  }
}

async function ownerRequest(c: Context<AppBindings>, slug: string): Promise<RequestRow> {
  const row = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_file_requests WHERE user_id = ? AND slug = ?`,
  ).bind(userIdOf(c), slug).first<RequestRow>()
  if (!row) throw ApiError.notFound('Request not found')
  return row
}

async function publicRequest(c: Context<AppBindings>, slug: string): Promise<RequestRow> {
  const row = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_file_requests WHERE slug = ?`,
  ).bind(slug).first<RequestRow>()
  const now = Date.now()
  if (!row || row.revoked_at !== null || row.is_enabled !== 1 || (row.expires_at !== null && row.expires_at <= now)) {
    throw ApiError.notFound('This upload link is no longer available')
  }
  return row
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback
}

clouddriveRequestRoutes.get('/requests', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_file_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`,
  ).bind(userIdOf(c)).all<RequestRow>()
  return c.json({ requests: (results ?? []).map(toView) })
})

clouddriveRequestRoutes.post('/requests', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : ''
  if (!name) throw ApiError.badRequest('A request name is required')
  const targetPath = parsePath(body.targetPath ?? '/')
  const mount = await resolveMount(c.env.DB, userId, 'primary')
  const target = await resolveEntry(c.env.DB, userId, mount.id, targetPath)
  if (target.kind !== 'folder') throw ApiError.badRequest('The target path is not a folder')
  const passwordProblem = sharePasscodeProblem(body.password)
  if (passwordProblem) throw ApiError.badRequest(passwordProblem)
  const passwordHash = typeof body.password === 'string' && body.password ? await hashPassword(body.password) : null
  const expiresAt = typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt) ? body.expiresAt : null
  if (expiresAt !== null && expiresAt <= Date.now()) throw ApiError.badRequest('The expiry is in the past')
  const maxFiles = clampInt(body.maxFiles, 1, 1000, DEFAULT_MAX_FILES)
  const maxBytes = clampInt(body.maxBytes, 1, 10 * 1024 * 1024 * 1024, DEFAULT_MAX_BYTES)
  const maxFileBytes = clampInt(body.maxFileBytes, 1, Math.min(maxBytes, 1024 * 1024 * 1024), DEFAULT_MAX_FILE_BYTES)
  const slug = newSlug()
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_file_requests
       (slug, user_id, target_mount, target_path, name, password_hash, expires_at, max_files,
        max_bytes, max_file_bytes, received_files, received_bytes, is_enabled, created_at, last_upload_at, revoked_at)
     VALUES (?, ?, 'primary', ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, NULL, NULL)`,
  ).bind(slug, userId, targetPath, name, passwordHash, expiresAt, maxFiles, maxBytes, maxFileBytes, now).run()
  const row = await ownerRequest(c, slug)
  return c.json({ request: toView(row) }, 201)
})

clouddriveRequestRoutes.patch('/requests/:slug', async (c) => {
  const row = await ownerRequest(c, c.req.param('slug'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const sets: string[] = []
  const values: unknown[] = []
  const put = (sql: string, value: unknown) => { sets.push(sql); values.push(value) }
  if (body.password !== undefined) {
    const problem = sharePasscodeProblem(body.password)
    if (problem) throw ApiError.badRequest(problem)
    put('password_hash = ?', typeof body.password === 'string' && body.password ? await hashPassword(body.password) : null)
  }
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null) put('expires_at = NULL', null)
    else if (typeof body.expiresAt === 'number' && body.expiresAt > Date.now()) put('expires_at = ?', body.expiresAt)
    else throw ApiError.badRequest('expiresAt must be a future timestamp or null')
  }
  if (body.isEnabled !== undefined) put('is_enabled = ?', body.isEnabled ? 1 : 0)
  if (sets.length === 0) return c.json({ request: toView(row) })
  values.push(userIdOf(c), row.slug)
  await c.env.DB.prepare(
    `UPDATE CloudDrive_file_requests SET ${sets.join(', ')} WHERE user_id = ? AND slug = ?`,
  ).bind(...values).run()
  return c.json({ request: toView(await ownerRequest(c, row.slug)) })
})

clouddriveRequestRoutes.delete('/requests/:slug', async (c) => {
  const row = await ownerRequest(c, c.req.param('slug'))
  await c.env.DB.prepare(
    `UPDATE CloudDrive_file_requests SET revoked_at = ?, is_enabled = 0 WHERE user_id = ? AND slug = ?`,
  ).bind(Date.now(), userIdOf(c), row.slug).run()
  return c.json({ ok: true })
})

clouddrivePublicRequestRoutes.get('/requests/:slug', async (c) => {
  const row = await publicRequest(c, c.req.param('slug'))
  return c.json({
    name: row.name,
    hasPassword: Boolean(row.password_hash),
    expiresAt: row.expires_at,
    maxFiles: row.max_files,
    maxBytes: row.max_bytes,
    maxFileBytes: row.max_file_bytes,
    receivedFiles: row.received_files,
    receivedBytes: row.received_bytes,
  })
})

async function availableRequestName(
  db: D1Database,
  userId: string,
  mountId: string,
  parentId: string,
  name: string,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = autoSuffixName(name, attempt)
    const row = await db.prepare(
      `SELECT 1 AS hit FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND parent_id = ? AND name_folded = ? AND deleted_at IS NULL`,
    ).bind(userId, mountId, parentId, foldedName(candidate)).first<{ hit: number }>()
    if (!row) return candidate
  }
  throw ApiError.conflict('Too many files share this name')
}

clouddrivePublicRequestRoutes.post('/requests/:slug/verify', async (c) => {
  const row = await publicRequest(c, c.req.param('slug'))
  if (!row.password_hash) return c.json({ ok: true })
  const body = await readJson<{ password?: unknown }>(c, BODY_LIMIT)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!(await verifyPassword(password, row.password_hash))) {
    throw new ApiError(401, 'clouddrive_share_locked', 'This upload link needs a password')
  }
  return c.json({ ok: true })
})

clouddrivePublicRequestRoutes.post('/requests/:slug/upload', async (c) => {
  const request = await publicRequest(c, c.req.param('slug'))
  if (request.password_hash) {
    const password = c.req.header('x-clouddrive-request-password') ?? ''
    if (!(await verifyPassword(password, request.password_hash))) {
      throw new ApiError(401, 'clouddrive_share_locked', 'This upload link needs a password')
    }
  }
  const name = parseName(c.req.query('name') ?? '')
  const mimeRaw = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase() || 'application/octet-stream'
  if (mimeRaw.length > 255) throw ApiError.badRequest('The content type is invalid')
  if (BLOCKED_TYPES.has(mimeRaw)) throw ApiError.badRequest('This file type is not accepted')
  const declared = Number(c.req.header('content-length'))
  if (Number.isFinite(declared) && declared > request.max_file_bytes) throw ApiError.tooLarge('The file is larger than this request allows')
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.byteLength > request.max_file_bytes) throw ApiError.tooLarge('The file is larger than this request allows')
  if (request.received_files + 1 > request.max_files) throw ApiError.badRequest('This request has received all its files')
  if (request.received_bytes + bytes.byteLength > request.max_bytes) throw ApiError.badRequest('This request has received all its bytes')
  const target = await resolveEntry(c.env.DB, request.user_id, request.target_mount, request.target_path)
  if (target.kind !== 'folder') throw ApiError.conflict('The destination folder no longer exists')
  const usage = await cloudDriveUsage(c.env.DB, request.user_id, c.env)
  if (usage.quotaBytes && usage.usedBytes + bytes.byteLength > usage.quotaBytes) {
    throw new ApiError(403, 'clouddrive_quota_exceeded', 'The drive does not have room for this upload')
  }
  if (!c.env.FILES) throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound')

  const now = Date.now()
  const reserved = await c.env.DB.prepare(
    `UPDATE CloudDrive_file_requests
        SET received_files = received_files + 1, received_bytes = received_bytes + ?2,
            last_upload_at = ?3
      WHERE slug = ?1 AND is_enabled = 1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?3)
        AND received_files + 1 <= max_files
        AND received_bytes + ?2 <= max_bytes`,
  ).bind(request.slug, bytes.byteLength, now).run()
  if ((reserved.meta.changes ?? 0) === 0) throw ApiError.conflict('This request is no longer accepting uploads')

  const finalName = await availableRequestName(c.env.DB, request.user_id, request.target_mount, target.id, name)
  const fileId = newId()
  const category = categoryFor(finalName)
  const key = `CloudDrive/${category}/${fileId}`
  let inserted = false
  try {
    const object = await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: mimeRaw } })
    const path = childPath(target.path, finalName)
    await c.env.DB.prepare(
      `INSERT INTO CloudDrive_files
         (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
          category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
          starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
       VALUES (?1, ?2, ?3, ?4, 'file', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, 'r2', ?13, '{}', '',
               NULL, NULL, NULL, NULL, ?14, ?14, ?14, ?14)`,
    ).bind(
      fileId, request.user_id, request.target_mount, target.id, finalName, foldedName(finalName),
      initialsOf(finalName), path, category, mimeRaw, bytes.byteLength, object.etag, key, now,
    ).run()
    inserted = true
  } finally {
    if (!inserted) {
      await c.env.DB.prepare(
        `UPDATE CloudDrive_file_requests
            SET received_files = MAX(0, received_files - 1), received_bytes = MAX(0, received_bytes - ?2)
          WHERE slug = ?1`,
      ).bind(request.slug, bytes.byteLength).run().catch((error) => {
        console.warn('[clouddrive] rolling back a public upload reservation failed', error)
      })
      try {
        await c.env.FILES.delete(key)
      } catch (error) {
        console.warn('[clouddrive] removing a failed public upload object failed', key, error)
      }
    }
  }
  return c.json({ ok: true, name: finalName, size: bytes.byteLength })
})
