import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { sharePasscodeProblem } from '@shared/share-passcode'
import { normalizeCloudDrivePath } from '@shared/clouddrive/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { hashPassword, verifyPassword } from '../lib/password'
import { newId, newSlug } from '../lib/id'
import { contentDisposition, parseByteRange } from '../lib/http-range'

interface ShareRow {
  slug: string
  user_id: string
  target_kind: 'file' | 'folder'
  file_id: string | null
  mount_id: string
  path: string
  name: string
  size: number | null
  mime: string | null
  password_hash: string | null
  expires_at: number | null
  max_views: number | null
  views: number
  max_downloads: number | null
  downloads: number
  allow_download: number
  allow_list: number
  is_enabled: number
  created_at: number
  last_accessed_at: number | null
  revoked_at: number | null
}

interface FileRow {
  id: string
  name: string
  path: string
  category: string
  mime: string
  size: number
  storage_key: string | null
  modified_at: number
  kind: string
}

const SHARE_COOKIE = 'clouddrive_share'
const SESSION_MS = 2 * 60 * 60 * 1000

export const clouddriveShareRoutes = new Hono<AppBindings>()
export const clouddrivePublicShareRoutes = new Hono<AppBindings>()
export const clouddriveRawRoutes = new Hono<AppBindings>()

clouddriveShareRoutes.get('/shares', async (c) => {
  const userId = c.get('userId')
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_shares WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 500`,
  ).bind(userId).all<ShareRow>()
  return c.json({ shares: (results ?? []).map(toShareView) })
})

clouddriveShareRoutes.post('/shares', async (c) => {
  const userId = c.get('userId')
  const body = await readJson(c)
  const targetKind = body.targetKind === 'folder' ? 'folder' : body.targetKind === 'file' ? 'file' : null
  if (!targetKind) throw ApiError.badRequest('Invalid share target')
  const fileId = typeof body.fileId === 'string' ? body.fileId : null
  const mountId = typeof body.mountId === 'string' && body.mountId ? body.mountId : 'primary'
  let path: string
  try {
    path = normalizeCloudDrivePath(String(body.path ?? '/'))
  } catch {
    throw new ApiError(400, 'clouddrive_path_invalid', 'Invalid path')
  }
  const file = fileId
    ? await c.env.DB.prepare(
      `SELECT id, name, path, category, mime, size, storage_key, modified_at, kind
         FROM CloudDrive_files WHERE user_id = ?1 AND id = ?2 AND mount_id = ?3 AND deleted_at IS NULL`,
    ).bind(userId, fileId, mountId).first<FileRow>()
    : await c.env.DB.prepare(
      `SELECT id, name, path, category, mime, size, storage_key, modified_at, kind
         FROM CloudDrive_files WHERE user_id = ?1 AND mount_id = ?2 AND path = ?3 AND deleted_at IS NULL`,
    ).bind(userId, mountId, path).first<FileRow>()
  if (!file) throw ApiError.notFound('The share target does not exist')
  if (targetKind === 'file' && file.kind !== 'file') throw ApiError.badRequest('A file share needs a file')
  if (targetKind === 'folder' && file.kind !== 'folder') throw ApiError.badRequest('A folder share needs a folder')
  const passwordProblem = sharePasscodeProblem(body.password)
  if (passwordProblem) throw ApiError.badRequest(passwordProblem)
  const passwordHash = typeof body.password === 'string' && body.password ? await hashPassword(body.password) : null
  const expiresAt = typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt) ? body.expiresAt : null
  if (expiresAt !== null && expiresAt <= Date.now()) throw ApiError.badRequest('The expiry is in the past')
  const maxViews = positiveIntOrNull(body.maxViews)
  const maxDownloads = positiveIntOrNull(body.maxDownloads)
  const slug = newSlug()
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_shares
       (slug, user_id, target_kind, file_id, mount_id, path, name, size, mime, password_hash,
        expires_at, max_views, views, max_downloads, downloads, allow_download, allow_list,
        is_enabled, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,?13,0,?14,1,1,?15)`,
  ).bind(
    slug, userId, targetKind, file.id, mountId, file.path, file.name, file.size, file.mime,
    passwordHash, expiresAt, maxViews, maxDownloads, body.allowDownload === false ? 0 : 1, now,
  ).run()
  const row = await shareBySlug(c, slug)
  if (!row) throw new ApiError(500, 'internal', 'The share could not be read back')
  return c.json({ share: toShareView(row) })
})

clouddriveShareRoutes.patch('/shares/:slug', async (c) => {
  const userId = c.get('userId')
  const row = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_shares WHERE user_id = ?1 AND slug = ?2`,
  ).bind(userId, c.req.param('slug')).first<ShareRow>()
  if (!row) throw ApiError.notFound('Share not found')
  const body = await readJson(c)
  const sets: string[] = []
  const values: unknown[] = []
  const bind = (sql: string, value: unknown) => { sets.push(sql); values.push(value) }
  if (body.password !== undefined) {
    const problem = sharePasscodeProblem(body.password)
    if (problem) throw ApiError.badRequest(problem)
    bind('password_hash = ?', typeof body.password === 'string' && body.password ? await hashPassword(body.password) : null)
  }
  if (body.expiresAt !== undefined) bind('expires_at = ?', typeof body.expiresAt === 'number' && body.expiresAt > Date.now() ? body.expiresAt : null)
  if (body.maxViews !== undefined) bind('max_views = ?', positiveIntOrNull(body.maxViews))
  if (body.maxDownloads !== undefined) bind('max_downloads = ?', positiveIntOrNull(body.maxDownloads))
  if (body.allowDownload !== undefined) bind('allow_download = ?', body.allowDownload ? 1 : 0)
  if (body.isEnabled !== undefined) bind('is_enabled = ?', body.isEnabled ? 1 : 0)
  if (!sets.length) return c.json({ share: toShareView(row) })
  values.push(userId, row.slug)
  await c.env.DB.prepare(
    `UPDATE CloudDrive_shares SET ${sets.join(', ')} WHERE user_id = ? AND slug = ?`,
  ).bind(...values).run()
  const updated = await shareBySlug(c, row.slug)
  return c.json({ share: toShareView(updated!) })
})

clouddriveShareRoutes.delete('/shares/:slug', async (c) => {
  const userId = c.get('userId')
  const result = await c.env.DB.prepare(
    `UPDATE CloudDrive_shares SET revoked_at = ?1, is_enabled = 0 WHERE user_id = ?2 AND slug = ?3 AND revoked_at IS NULL`,
  ).bind(Date.now(), userId, c.req.param('slug')).run()
  if (!result.meta.changes) throw ApiError.notFound('Share not found')
  return c.json({ ok: true })
})

clouddrivePublicShareRoutes.get('/shares/:slug', async (c) => {
  const share = await loadPublicShare(c, c.req.param('slug'))
  await recordView(c, share)
  const unlocked = await shareUnlocked(c, share)
  return c.json({
    name: share.name,
    targetKind: share.target_kind,
    size: share.size,
    mime: share.mime,
    locked: Boolean(share.password_hash) && !unlocked,
    hasPassword: Boolean(share.password_hash),
    expiresAt: share.expires_at,
    allowDownload: share.allow_download === 1,
    disabled: false,
  })
})

clouddrivePublicShareRoutes.post('/shares/:slug/verify', async (c) => {
  const share = await loadPublicShare(c, c.req.param('slug'))
  if (!share.password_hash) return c.json({ ok: true })
  const body = await readJson(c)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!(await verifyPassword(password, share.password_hash))) throw new ApiError(401, 'clouddrive_share_locked', 'A password is required')
  const id = newId()
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_share_sessions (id, user_id, slug, password_hash, expires_at, created_at)
     VALUES (?1,?2,?3,?4,?5,?6)`,
  ).bind(id, share.user_id, share.slug, share.password_hash, now + SESSION_MS, now).run()
  setCookie(c, SHARE_COOKIE, id, { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: SESSION_MS / 1000, secure: new URL(c.req.url).protocol === 'https:' })
  return c.json({ ok: true })
})

clouddrivePublicShareRoutes.get('/shares/:slug/list', async (c) => {
  const share = await requireAccess(c, c.req.param('slug'))
  if (share.target_kind !== 'folder' || share.allow_list !== 1) throw ApiError.forbidden('Browsing is disabled for this link')
  const requested = safePath(c.req.query('path') ?? share.path)
  assertWithinShare(share, requested)
  const folder = await c.env.DB.prepare(
    `SELECT id, name, path, category, mime, size, storage_key, modified_at, kind
       FROM CloudDrive_files WHERE user_id = ?1 AND mount_id = ?2 AND path = ?3 AND kind = 'folder' AND deleted_at IS NULL`,
  ).bind(share.user_id, share.mount_id, requested).first<FileRow>()
  if (!folder) throw ApiError.notFound('Folder not found')
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, path, category, mime, size, storage_key, modified_at, kind
       FROM CloudDrive_files WHERE user_id = ?1 AND mount_id = ?2 AND parent_id = ?3 AND deleted_at IS NULL
       ORDER BY kind DESC, name_folded LIMIT 500`,
  ).bind(share.user_id, share.mount_id, folder.id).all<FileRow>()
  return c.json({ path: requested, entries: (results ?? []).map((row) => ({ name: row.name, path: row.path, kind: row.kind, size: row.size, mime: row.mime, modifiedAt: row.modified_at })) })
})

clouddrivePublicShareRoutes.get('/shares/:slug/content', async (c) => {
  const share = await requireAccess(c, c.req.param('slug'))
  return serveShareContent(c, share, c.req.query('path') ?? share.path, c.req.query('download') === '1')
})

clouddrivePublicShareRoutes.get('/shares/:slug/download', async (c) => {
  const share = await requireAccess(c, c.req.param('slug'))
  if (share.allow_download !== 1) throw ApiError.forbidden('Downloads are disabled for this link')
  return serveShareContent(c, share, c.req.query('path') ?? share.path, true)
})

clouddriveRawRoutes.on(['GET', 'HEAD'], '/:slug/raw', async (c) => {
  const share = await requireAccess(c, c.req.param('slug'))
  if (share.allow_download !== 1) throw ApiError.forbidden('Downloads are disabled for this link')
  return serveShareContent(c, share, c.req.query('path') ?? share.path, true)
})

async function serveShareContent(c: Context<AppBindings>, share: ShareRow, requestedRaw: string, forceDownload: boolean): Promise<Response> {
  const requested = safePath(requestedRaw)
  assertWithinShare(share, requested)
  const file = await c.env.DB.prepare(
    `SELECT id, name, path, category, mime, size, storage_key, modified_at, kind
       FROM CloudDrive_files WHERE user_id = ?1 AND mount_id = ?2 AND path = ?3 AND kind = 'file' AND deleted_at IS NULL`,
  ).bind(share.user_id, share.mount_id, requested).first<FileRow>()
  if (!file?.storage_key) throw ApiError.notFound('File not found')
  if (!c.env.FILES) throw new ApiError(503, 'storage_unavailable', 'R2 is not configured')
  const rangeHeader = c.req.header('range') ?? null
  const parsed = rangeHeader ? parseByteRange(rangeHeader, file.size) : null
  if (parsed === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } })
  }
  if (forceDownload && (!rangeHeader || rangeHeader.startsWith('bytes=0-'))) {
    await countDownload(c, share, requested)
  }
  const object = parsed
    ? await c.env.FILES.get(file.storage_key, { range: { offset: parsed.start, length: parsed.end - parsed.start + 1 } })
    : await c.env.FILES.get(file.storage_key)
  if (!object) throw ApiError.notFound('File not found')
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Content-Type', file.mime || 'application/octet-stream')
  headers.set('ETag', object.httpEtag)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Cache-Control', 'private, no-store')
  const disposition = contentDisposition(file.mime, file.name)
  headers.set('Content-Disposition', forceDownload ? disposition.replace(/^inline/, 'attachment') : disposition)
  if (parsed && 'range' in object && object.range && 'offset' in object.range) {
    const offset = object.range.offset ?? parsed.start
    const length = object.range.length ?? parsed.end - parsed.start + 1
    headers.set('Content-Length', String(length))
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${file.size}`)
    return new Response(c.req.method === 'HEAD' ? null : object.body, { status: 206, headers })
  }
  headers.set('Content-Length', String(object.size))
  return new Response(c.req.method === 'HEAD' ? null : object.body, { status: 200, headers })
}

async function requireAccess(c: Context<AppBindings>, slug: string): Promise<ShareRow> {
  const share = await loadPublicShare(c, slug)
  if (share.password_hash && !(await shareUnlocked(c, share))) throw new ApiError(401, 'clouddrive_share_locked', 'A password is required')
  return share
}

async function loadPublicShare(c: Context<AppBindings>, slug: string): Promise<ShareRow> {
  const now = Date.now()
  const row = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_shares WHERE slug = ?1`,
  ).bind(slug).first<ShareRow>()
  if (!row || row.revoked_at || row.is_enabled !== 1 || (row.expires_at !== null && row.expires_at <= now)) {
    throw ApiError.notFound('Share not found')
  }
  return row
}

async function recordView(c: Context<AppBindings>, share: ShareRow): Promise<void> {
  const now = Date.now()
  const result = await c.env.DB.prepare(
    `UPDATE CloudDrive_shares SET views = views + 1, last_accessed_at = ?1
      WHERE slug = ?2 AND (max_views IS NULL OR views < max_views)`,
  ).bind(now, share.slug).run()
  if (!result.meta.changes) throw new ApiError(403, 'clouddrive_share_expired', 'This link has reached its limit')
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_share_visits (id, user_id, slug, kind, path, bytes, ip_hash, at)
     VALUES (?1,?2,?3,'view',NULL,NULL,NULL,?4)`,
  ).bind(newId(), share.user_id, share.slug, now).run()
}

async function shareUnlocked(c: Context<AppBindings>, share: ShareRow): Promise<boolean> {
  if (!share.password_hash) return true
  const sessionId = getCookie(c, SHARE_COOKIE)
  if (!sessionId) return false
  const session = await c.env.DB.prepare(
    `SELECT password_hash FROM CloudDrive_share_sessions WHERE id = ?1 AND slug = ?2 AND user_id = ?3 AND expires_at > ?4`,
  ).bind(sessionId, share.slug, share.user_id, Date.now()).first<{ password_hash: string }>()
  return Boolean(session && session.password_hash === share.password_hash)
}

async function countDownload(c: Context<AppBindings>, share: ShareRow, path: string): Promise<void> {
  const now = Date.now()
  const result = await c.env.DB.prepare(
    `UPDATE CloudDrive_shares SET downloads = downloads + 1
      WHERE slug = ?1 AND (max_downloads IS NULL OR downloads < max_downloads)`,
  ).bind(share.slug).run()
  if (!result.meta.changes) throw new ApiError(403, 'clouddrive_share_expired', 'This link has reached its download limit')
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_share_visits (id, user_id, slug, kind, path, bytes, ip_hash, at)
     VALUES (?1,?2,?3,'download',?4,?5,?6,?7)`,
  ).bind(newId(), share.user_id, share.slug, path, 0, null, now).run()
}

function assertWithinShare(share: ShareRow, path: string): void {
  const root = share.target_kind === 'folder' ? share.path : share.path
  if (path !== root && !path.startsWith(`${root}/`)) throw ApiError.badRequest('Path is outside the share')
}

function safePath(value: string): string {
  try {
    return normalizeCloudDrivePath(value)
  } catch {
    throw new ApiError(400, 'clouddrive_path_invalid', 'Invalid path')
  }
}

async function shareBySlug(c: Context<AppBindings>, slug: string): Promise<ShareRow | null> {
  return await c.env.DB.prepare(`SELECT * FROM CloudDrive_shares WHERE slug = ?1`).bind(slug).first<ShareRow>()
}

function toShareView(row: ShareRow) {
  return {
    slug: row.slug,
    url: `/d/${row.slug}`,
    targetKind: row.target_kind,
    name: row.name,
    size: row.size,
    mime: row.mime,
    hasPassword: Boolean(row.password_hash),
    expiresAt: row.expires_at,
    views: row.views,
    maxViews: row.max_views,
    downloads: row.downloads,
    maxDownloads: row.max_downloads,
    allowDownload: row.allow_download === 1,
    isEnabled: row.is_enabled === 1,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    revokedAt: row.revoked_at,
  }
}

function positiveIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

async function readJson(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw ApiError.badRequest('A JSON object is required')
  return body as Record<string, unknown>
}
