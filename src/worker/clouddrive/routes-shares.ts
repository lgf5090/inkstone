import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { sharePasscodeProblem } from '@shared/share-passcode'
import { autoSuffixName, childPath, foldedName, normalizeCloudDrivePath, parentPathOf } from '@shared/clouddrive/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { sha256Hex } from '../lib/encoding'
import { hashPassword, verifyPassword } from '../lib/password'
import { requestClientIp } from '../lib/request'
import { newId, newSlug } from '../lib/id'
import { contentDisposition, isBrowserRenderable, parseByteRange } from '../lib/http-range'
import { distributedStream, fileParts } from './distributed'
import { readExternalObject } from './external'
import { readCloudDriveSettings } from './store'
import {
  assertMemberAllowed,
  assertPasscodeAttemptsLeft,
  assertWritable,
  buildEntry,
  chunkedBatch,
  initialsOf,
  notePasscodeFailure,
  notePasscodeSuccess,
  passcodeThrottleKey,
  parsePath,
  resolveEntry,
  resolveMount,
  decodeCursor,
  encodeCursor,
  type CloudDriveFileRow,
} from './lib'
import { folderHiddenPatterns } from './store-files'
import { effectiveMeta, effectiveMetas, hiddenByPatterns } from './meta'
import { assertMetaAccess } from './routes-meta'
import { cloudDriveUsage } from './store'
import { buildFolderZip, zipDisposition } from './zip'

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
  storage_kind: string
  modified_at: number
  kind: string
}

const SESSION_MS = 2 * 60 * 60 * 1000
const DAY_MS = 86_400_000

interface ShareExpiryPolicy {
  shareDefaultExpiryDays: number
  shareMaxExpiryDays: number
}

function shareExpiry(value: unknown, policy: ShareExpiryPolicy, now: number): number | null {
  if (value === undefined || value === null) {
    const days = Math.min(policy.shareDefaultExpiryDays, policy.shareMaxExpiryDays)
    return days > 0 ? now + days * DAY_MS : null
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw ApiError.badRequest('expiresAt must be a timestamp')
  if (value <= now) throw ApiError.badRequest('The expiry is in the past')
  if (value > now + policy.shareMaxExpiryDays * DAY_MS) throw ApiError.badRequest('The expiry exceeds the maximum allowed')
  return value
}

async function shareCookieName(slug: string): Promise<string> {
  return `clouddrive_share_${(await sha256Hex(`clouddrive-share-cookie:${slug}`)).slice(0, 16)}`
}

export const clouddriveShareRoutes = new Hono<AppBindings>()
export const clouddrivePublicShareRoutes = new Hono<AppBindings>()
export const clouddriveRawRoutes = new Hono<AppBindings>()

clouddriveShareRoutes.get('/shares', async (c) => {
  const userId = c.get('userId')
  const clauses = ['user_id = ?1']
  const params: unknown[] = [userId]
  const cursor = c.req.query('cursor')
  if (cursor) {
    const decoded = decodeCursor(cursor, 'uploaded')
    if (typeof decoded.v !== 'number') throw ApiError.badRequest('The cursor is invalid')
    clauses.push('(created_at < ?2 OR (created_at = ?3 AND slug < ?4))')
    params.push(decoded.v, decoded.v, decoded.id)
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_shares WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, slug DESC LIMIT ?${params.length + 1}`,
  ).bind(...params, SHARE_PAGE_SIZE + 1).all<ShareRow>()
  const rows = results ?? []
  const page = rows.slice(0, SHARE_PAGE_SIZE)
  const last = page[page.length - 1]
  return c.json({
    shares: page.map(toShareView),
    cursor: rows.length > SHARE_PAGE_SIZE && last
      ? encodeCursor('uploaded', last.created_at, last.slug)
      : null,
  })
})

clouddriveShareRoutes.post('/shares', async (c) => {
  const userId = c.get('userId')
  await assertMemberAllowed(c.env.DB, userId, c.get('user')?.role, 'shareAllowMemberShares')
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
      `SELECT id, name, path, category, mime, size, storage_key, storage_kind, modified_at, kind
         FROM CloudDrive_files WHERE user_id = ?1 AND id = ?2 AND mount_id = ?3 AND deleted_at IS NULL`,
    ).bind(userId, fileId, mountId).first<FileRow>()
    : await c.env.DB.prepare(
      `SELECT id, name, path, category, mime, size, storage_key, storage_kind, modified_at, kind
         FROM CloudDrive_files WHERE user_id = ?1 AND mount_id = ?2 AND path = ?3 AND deleted_at IS NULL`,
    ).bind(userId, mountId, path).first<FileRow>()
  if (!file) throw ApiError.notFound('The share target does not exist')
  if (targetKind === 'file' && file.kind !== 'file') throw ApiError.badRequest('A file share needs a file')
  if (targetKind === 'folder' && file.kind !== 'folder') throw ApiError.badRequest('A folder share needs a folder')
  await assertMetaAccess(c, userId, mountId, file.kind === 'folder' ? file.path : parentPathOf(file.path))
  const passwordProblem = sharePasscodeProblem(body.password)
  if (passwordProblem) throw ApiError.badRequest(passwordProblem)
  const passwordHash = typeof body.password === 'string' && body.password ? await hashPassword(body.password) : null
  const now = Date.now()
  const policy = await readCloudDriveSettings(c.env.DB, userId)
  const expiresAt = shareExpiry(body.expiresAt, policy, now)
  const maxViews = positiveIntOrNull(body.maxViews)
  const maxDownloads = positiveIntOrNull(body.maxDownloads)
  const slug = newSlug()
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_shares
       (slug, user_id, target_kind, file_id, mount_id, path, name, size, mime, password_hash,
        expires_at, max_views, views, max_downloads, downloads, allow_download, allow_list,
        is_enabled, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,?13,0,?14,?15,1,?16)`,
  ).bind(
    slug, userId, targetKind, file.id, mountId, file.path, file.name, file.size, file.mime,
    passwordHash, expiresAt, maxViews, maxDownloads, body.allowDownload === false ? 0 : 1,
    body.allowList === false ? 0 : 1, now,
  ).run()
  const row = await shareBySlug(c, slug)
  if (!row) throw new ApiError(500, 'internal', 'The share could not be read back')
  return c.json({ share: toShareView(row) })
})

const MAX_SHARE_SAVE_ROWS = 500

async function freeShareName(db: D1Database, userId: string, mountId: string, parentId: string, name: string): Promise<string> {
  let candidate = name
  for (let attempt = 0; attempt <= 100; attempt++) {
    const clash = await db.prepare(
      `SELECT 1 AS hit FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND parent_id = ? AND name_folded = ? AND deleted_at IS NULL`,
    ).bind(userId, mountId, parentId, foldedName(candidate)).first<{ hit: number }>()
    if (!clash) return candidate
    candidate = autoSuffixName(name, attempt + 1)
  }
  throw ApiError.conflict('A destination name could not be found')
}

async function visibleShareSubtree(c: Context<AppBindings>, ownerId: string, root: CloudDriveFileRow): Promise<CloudDriveFileRow[]> {
  if (root.kind === 'file') return [root]
  const rows: CloudDriveFileRow[] = []
  let frontier = [root]
  while (frontier.length > 0) {
    const [metas, folderRules] = await Promise.all([
      effectiveMetas(c.env.DB, ownerId, root.mount_id, frontier.map((row) => row.path)),
      folderHiddenPatterns(c.env.DB, ownerId, root.mount_id, frontier.map((row) => row.path)),
    ])
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL
          AND parent_id IN (${frontier.map(() => '?').join(',')})
        ORDER BY kind DESC, name_folded LIMIT ?`,
    ).bind(ownerId, root.mount_id, ...frontier.map((row) => row.id), MAX_SHARE_SAVE_ROWS + 1).all<CloudDriveFileRow>()
    const visible: CloudDriveFileRow[] = []
    for (const child of results ?? []) {
      const patterns = [
        ...(metas.get(parentPathOf(child.path))?.hidePatterns ?? []),
        ...(folderRules.get(parentPathOf(child.path)) ?? []),
      ]
      if (hiddenByPatterns(child.name, patterns)) continue
      if (child.kind === 'folder') await assertMetaAccess(c, ownerId, child.mount_id, child.path)
      visible.push(child)
    }
    if (rows.length + visible.length > MAX_SHARE_SAVE_ROWS) {
      throw ApiError.tooLarge(`A saved folder holds at most ${MAX_SHARE_SAVE_ROWS} items`)
    }
    rows.push(...visible)
    frontier = visible.filter((row) => row.kind === 'folder')
  }
  return rows
}

clouddriveShareRoutes.post('/shares/:slug/save', async (c) => {
  const userId = c.get('userId')
  const share = await loadPublicShare(c, c.req.param('slug'))
  if (share.password_hash && !(await shareUnlocked(c, share))) throw new ApiError(401, 'clouddrive_share_locked', 'A password is required')
  if (share.allow_download !== 1) throw ApiError.forbidden('Downloads are disabled for this link')
  if (!share.file_id) throw ApiError.notFound('File not found')
  const body = await readJson(c)
  const root = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_files WHERE user_id = ? AND mount_id = ? AND id = ? AND deleted_at IS NULL`,
  ).bind(share.user_id, share.mount_id, share.file_id).first<CloudDriveFileRow>()
  if (!root || root.kind !== share.target_kind) throw ApiError.notFound('File not found')
  const sourceMount = await resolveMount(c.env.DB, share.user_id, root.mount_id)
  if (sourceMount.storageId !== 'primary') throw ApiError.badRequest('Only primary R2 shares can be saved')
  await assertMetaAccess(c, share.user_id, root.mount_id, root.kind === 'folder' ? root.path : parentPathOf(root.path))
  const parentPatterns = await sourceParentPatternsForShare(c, share.user_id, root.mount_id, parentPathOf(root.path))
  if (hiddenByPatterns(root.name, parentPatterns)) throw ApiError.notFound('File not found')
  const subtree = root.kind === 'folder' ? await visibleShareSubtree(c, share.user_id, root) : []
  const sources = [root, ...subtree]
  if (sources.some((row) => row.storage_kind !== 'r2' || (row.kind === 'file' && !row.storage_key))) {
    throw ApiError.badRequest('This share contains content that is not stored on the primary mount')
  }
  const bytes = sources.reduce((sum, row) => sum + (row.kind === 'file' ? row.size : 0), 0)
  const usage = await cloudDriveUsage(c.env.DB, userId, c.env)
  if (usage.quotaBytes !== null && usage.usedBytes + bytes > usage.quotaBytes) {
    throw new ApiError(403, 'clouddrive_quota_exceeded', 'Saving this item would exceed your quota')
  }

  const mount = await resolveMount(c.env.DB, userId, 'primary')
  assertWritable(mount)
  const toPath = parsePath(body.toPath ?? '/')
  await assertMetaAccess(c, userId, mount.id, toPath)
  const parent = await resolveEntry(c.env.DB, userId, mount.id, toPath)
  if (parent.kind !== 'folder') throw ApiError.badRequest('The destination is not a folder')
  const now = Date.now()
  const rootName = await freeShareName(c.env.DB, userId, mount.id, parent.id, root.name)
  const bySource = new Map<string, { id: string; path: string }>()
  const inserted: string[] = []
  const statements: D1PreparedStatement[] = []
  const insert = (row: CloudDriveFileRow, id: string, path: string, parentId: string, name: string) => {
    bySource.set(row.id, { id, path })
    inserted.push(id)
    statements.push(c.env.DB.prepare(
      `INSERT INTO CloudDrive_files
         (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path, category,
          mime, size, etag, checksum, storage_kind, storage_key, metadata, color, starred_at,
          last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'r2', ?, '{}', '',
               NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    ).bind(
      id, userId, mount.id, parentId, row.kind, name, foldedName(name), initialsOf(name), path,
      row.category, row.mime, row.size, row.etag, row.checksum, row.storage_key, now, now, row.uploaded_at, row.modified_at,
    ))
  }
  insert(root, newId(), childPath(toPath, rootName), parent.id, rootName)
  for (const row of subtree) {
    const above = bySource.get(row.parent_id)
    if (!above) continue
    const name = await freeShareName(c.env.DB, userId, mount.id, above.id, row.name)
    insert(row, newId(), childPath(above.path, name), above.id, name)
  }
  try {
    await chunkedBatch(c.env.DB, statements)
    await countDownload(c, share, '/', bytes)
  } catch (error) {
    // A spent copy that cannot be charged must not remain in the recipient's drive. The owner's rows
    // still reference every object, so removing these new rows cannot delete shared bytes.
    for (let offset = 0; offset < inserted.length; offset += 90) {
      const chunk = inserted.slice(offset, offset + 90)
      await c.env.DB.prepare(`DELETE FROM CloudDrive_files WHERE user_id = ? AND id IN (${chunk.map(() => '?').join(',')})`)
        .bind(userId, ...chunk).run()
    }
    throw error
  }
  const saved = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_files WHERE user_id = ? AND mount_id = ? AND id = ?`,
  ).bind(userId, mount.id, inserted[0]).first<CloudDriveFileRow>()
  if (!saved) throw new ApiError(500, 'internal', 'The saved share has no row')
  return c.json({ saved: inserted.length, entry: buildEntry(saved, mount, []) }, 201)
})

async function sourceParentPatternsForShare(c: Context<AppBindings>, ownerId: string, mountId: string, path: string): Promise<string[]> {
  const [metas, folderRules] = await Promise.all([
    effectiveMetas(c.env.DB, ownerId, mountId, [path]),
    folderHiddenPatterns(c.env.DB, ownerId, mountId, [path]),
  ])
  return [...(metas.get(path)?.hidePatterns ?? []), ...(folderRules.get(path) ?? [])]
}

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
  if (body.expiresAt !== undefined) {
    const policy = await readCloudDriveSettings(c.env.DB, userId)
    bind('expires_at = ?', shareExpiry(body.expiresAt, policy, Date.now()))
  }
  if (body.maxViews !== undefined) bind('max_views = ?', positiveIntOrNull(body.maxViews))
  if (body.maxDownloads !== undefined) bind('max_downloads = ?', positiveIntOrNull(body.maxDownloads))
  if (body.allowDownload !== undefined) bind('allow_download = ?', body.allowDownload ? 1 : 0)
  if (body.allowList !== undefined) bind('allow_list = ?', body.allowList ? 1 : 0)
  if (body.isEnabled !== undefined) bind('is_enabled = ?', body.isEnabled ? 1 : 0)
  if (!sets.length) return c.json({ share: toShareView(row) })
  values.push(userId, row.slug)
  await c.env.DB.prepare(
    `UPDATE CloudDrive_shares SET ${sets.join(', ')} WHERE user_id = ? AND slug = ?`,
  ).bind(...values).run()
  const updated = await shareBySlug(c, row.slug)
  return c.json({ share: toShareView(updated!) })
})

clouddriveShareRoutes.get('/shares/:slug/stats', async (c) => {
  const userId = c.get('userId')
  const slug = c.req.param('slug')
  const owned = await c.env.DB.prepare(
    `SELECT 1 AS hit FROM CloudDrive_shares WHERE user_id = ?1 AND slug = ?2`,
  ).bind(userId, slug).first<{ hit: number }>()
  if (!owned) throw ApiError.notFound('Share not found')
  const [days, visitors] = await Promise.all([
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day,
              SUM(CASE WHEN kind = 'view' THEN 1 ELSE 0 END) AS views,
              SUM(CASE WHEN kind = 'download' THEN 1 ELSE 0 END) AS downloads,
              COALESCE(SUM(CASE WHEN kind = 'download' THEN bytes ELSE 0 END), 0) AS bytes
         FROM CloudDrive_share_visits
        WHERE user_id = ?1 AND slug = ?2
        GROUP BY day ORDER BY day DESC LIMIT 90`,
    ).bind(userId, slug).all<{ day: string; views: number; downloads: number; bytes: number }>(),
    // A salted per-visitor digest, never an address: the count answers "how many people", the row
    // cannot be reversed and the details themselves age out with the purge job.
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT ip_hash) AS count FROM CloudDrive_share_visits WHERE user_id = ?1 AND slug = ?2 AND ip_hash IS NOT NULL`,
    ).bind(userId, slug).first<{ count: number }>(),
  ])
  return c.json({
    days: (days.results ?? []).map((row) => ({
      date: row.day,
      views: row.views ?? 0,
      downloads: row.downloads ?? 0,
      bytes: row.bytes ?? 0,
    })),
    visitors: visitors?.count ?? 0,
  })
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
  const unlocked = await shareUnlocked(c, share)
  // A locked link is a name, a path and a size the owner never agreed to hand to whoever holds the URL,
  // and counting the visit would let an anonymous visitor spend the link's `maxViews` for them.
  if (share.password_hash && !unlocked) {
    return c.json({
      name: '',
      path: '',
      targetKind: share.target_kind,
      size: null,
      mime: null,
      locked: true,
      hasPassword: true,
      expiresAt: share.expires_at,
      allowDownload: share.allow_download === 1,
      disabled: false,
    })
  }
  const target = await shareRoot(c, share)
  await assertSharePathAccess(c, share, target.path, target.kind === 'folder' ? 'folder' : 'file')
  await recordView(c, share)
  return c.json({
    name: target.name,
    // The owner's absolute path is only ever needed to address the share root, and the browse/list
    // endpoints already resolve it server-side; the recipient sees the share's own name instead.
    path: '/',
    targetKind: share.target_kind,
    size: target.size,
    mime: target.mime,
    locked: false,
    hasPassword: Boolean(share.password_hash),
    expiresAt: share.expires_at,
    allowDownload: share.allow_download === 1,
    disabled: false,
  })
})

clouddrivePublicShareRoutes.post('/shares/:slug/verify', async (c) => {
  const slug = c.req.param('slug')
  const share = await loadPublicShare(c, slug)
  if (!share.password_hash) return c.json({ ok: true })
  const throttleKey = passcodeThrottleKey('share', slug, c.req.raw)
  await assertPasscodeAttemptsLeft(c.env.DB, throttleKey)
  const body = await readJson(c)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!(await verifyPassword(password, share.password_hash))) {
    await notePasscodeFailure(c.env.DB, throttleKey)
    throw new ApiError(401, 'clouddrive_share_locked', 'A password is required')
  }
  await notePasscodeSuccess(c.env.DB, throttleKey)
  const id = newId()
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_share_sessions (id, user_id, slug, password_hash, expires_at, created_at)
     VALUES (?1,?2,?3,?4,?5,?6)`,
  ).bind(id, share.user_id, share.slug, share.password_hash, now + SESSION_MS, now).run()
  setCookie(c, await shareCookieName(share.slug), id, { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: SESSION_MS / 1000, secure: new URL(c.req.url).protocol === 'https:' })
  return c.json({ ok: true })
})

clouddrivePublicShareRoutes.get('/shares/:slug/list', async (c) => {
  const share = await requireAccess(c, c.req.param('slug'))
  if (share.target_kind !== 'folder' || share.allow_list !== 1) throw ApiError.forbidden('Browsing is disabled for this link')
  const requested = resolveSharePath(share, c.req.query('path'))
  const folder = requested === share.path
    ? await shareRoot(c, share)
    : await c.env.DB.prepare(
      `SELECT id, name, path, category, mime, size, storage_key, storage_kind, modified_at, kind
         FROM CloudDrive_files WHERE user_id = ?1 AND mount_id = ?2 AND path = ?3 AND kind = 'folder' AND deleted_at IS NULL`,
    ).bind(share.user_id, share.mount_id, requested).first<FileRow>()
  if (!folder || folder.kind !== 'folder') throw ApiError.notFound('Folder not found')
  await assertSharePathAccess(c, share, folder.path, 'folder')
  const directory = await shareDirectoryState(c, share.user_id, share.mount_id, folder.path)
  // A public folder pages by the same composite key it orders on. An offset cursor repeats or skips
  // entries when the owner creates a file between two requests; the opaque keyset cursor does not.
  const limit = SHARE_LIST_PAGE
  const clauses = ['user_id = ?', 'mount_id = ?', 'parent_id = ?', 'deleted_at IS NULL']
  const params: unknown[] = [share.user_id, share.mount_id, folder.id]
  const cursor = c.req.query('cursor')
  if (cursor) {
    const decoded = decodeCursor(cursor, 'name')
    if (typeof decoded.v !== 'string') throw ApiError.badRequest('The cursor is invalid')
    const separator = decoded.v.indexOf('\u0000')
    const kind = decoded.v.slice(0, separator)
    const name = decoded.v.slice(separator + 1)
    if (separator < 0 || !['folder', 'file'].includes(kind)) throw ApiError.badRequest('The cursor is invalid')
    clauses.push('(kind < ? OR (kind = ? AND (name_folded > ? OR (name_folded = ? AND id > ?))))')
    params.push(kind, kind, name, name, decoded.id)
  }
  const hiddenSql = directory.patterns.map(() => "name_folded NOT LIKE ? ESCAPE '\\'").join(' AND ')
  if (hiddenSql) clauses.push(hiddenSql)
  params.push(...directory.patterns.map(hiddenPatternToLike))
  const [{ results }, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, name, name_folded, path, category, mime, size, storage_key, storage_kind, modified_at, kind
         FROM CloudDrive_files WHERE ${clauses.join(' AND ')}
         ORDER BY kind DESC, name_folded, id LIMIT ?`,
    ).bind(...params, limit).all<FileRow & { name_folded: string }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND parent_id = ? AND deleted_at IS NULL
          ${hiddenSql ? `AND ${hiddenSql}` : ''}`,
    ).bind(share.user_id, share.mount_id, folder.id, ...directory.patterns.map(hiddenPatternToLike)).first<{ count: number }>(),
  ])
  const rows = results ?? []
  const last = rows[rows.length - 1]
  return c.json({
    path: shareRelativePath(share, requested),
    entries: rows.map((row) => ({
      name: row.name,
      path: shareRelativePath(share, row.path),
      kind: row.kind,
      size: row.size,
      mime: row.mime,
      modifiedAt: row.modified_at,
    })),
    total: total?.count ?? rows.length,
    cursor: last && rows.length === limit
      ? encodeCursor('name', `${last.kind}\u0000${last.name_folded}`, last.id)
      : null,
  })
})

clouddrivePublicShareRoutes.get('/shares/:slug/content', async (c) => {
  const share = await requireAccess(c, c.req.param('slug'))
  return serveShareContent(c, share, c.req.query('path'), c.req.query('download') === '1')
})

clouddrivePublicShareRoutes.get('/shares/:slug/download', async (c) => {
  const share = await requireAccess(c, c.req.param('slug'))
  if (share.allow_download !== 1) throw ApiError.forbidden('Downloads are disabled for this link')
  return serveShareContent(c, share, c.req.query('path'), true)
})

clouddrivePublicShareRoutes.on(['GET', 'HEAD'], '/shares/:slug/zip', async (c) => {
  const share = await requireAccess(c, c.req.param('slug'))
  if (share.target_kind !== 'folder') throw ApiError.badRequest('Only folder shares can be archived')
  if (share.allow_download !== 1) throw ApiError.forbidden('Downloads are disabled for this link')
  const root = await shareRoot(c, share)
  const mount = await resolveMount(c.env.DB, share.user_id, share.mount_id)
  if (mount.storageId !== 'primary') throw ApiError.badRequest('Only primary R2 folders can be archived')
  const directoryCache = new Map<string, Promise<{ patterns: string[]; locked: boolean }>>()
  const directoryState = (path: string) => {
    const cached = directoryCache.get(path)
    if (cached) return cached
    const pending = shareDirectoryState(c, share.user_id, mount.id, path)
    directoryCache.set(path, pending)
    return pending
  }
  const visiblePaths = new Set<string>([root.path])
  const archive = await buildFolderZip(c.env, c.env.DB, share.user_id, mount, root.path, async (row) => {
    if (row.id === root.id) return false
    const parent = parentPathOf(row.path)
    // Rows are ordered by path, so a hidden or locked folder is omitted before any descendant is
    // visited. Checking only the immediate parent would still archive children of a hidden folder.
    if (parent !== root.path && !visiblePaths.has(parent)) return true
    const state = await directoryState(parent)
    const visible = !state.locked && !hiddenByPatterns(row.name, state.patterns)
    if (visible) visiblePaths.add(row.path)
    return !visible
  })
  if (c.req.method !== 'HEAD') await countDownload(c, share, '/', archive.bytes)
  const headers = new Headers({
    'Content-Type': 'application/zip',
    'Content-Disposition': zipDisposition(archive.filename),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-CloudDrive-Zip-Items': String(archive.items),
  })
  return new Response(c.req.method === 'HEAD' ? null : archive.stream, { status: 200, headers })
})

clouddriveRawRoutes.on(['GET', 'HEAD'], '/:slug/raw', async (c) => {
  const share = await requireAccess(c, c.req.param('slug'))
  if (share.allow_download !== 1) throw ApiError.forbidden('Downloads are disabled for this link')
  return serveShareContent(c, share, c.req.query('path'), true)
})

/** The immutable target id, not its former path, is the public link's root. */
async function shareRoot(c: Context<AppBindings>, share: ShareRow): Promise<FileRow> {
  if (!share.file_id) throw ApiError.notFound('File not found')
  const target = await c.env.DB.prepare(
    `SELECT id, name, path, category, mime, size, storage_key, storage_kind, modified_at, kind
       FROM CloudDrive_files
      WHERE user_id = ?1 AND mount_id = ?2 AND id = ?3 AND deleted_at IS NULL`,
  ).bind(share.user_id, share.mount_id, share.file_id).first<FileRow>()
  if (!target || target.kind !== share.target_kind) throw ApiError.notFound('File not found')
  return target
}

function atShareRoot(share: ShareRow, target: FileRow): ShareRow {
  return { ...share, path: target.path, name: target.name, size: target.size, mime: target.mime }
}

/**
 * The share's own address space: a recipient names a file relative to the link, never by the path it
 * happens to occupy inside the owner's drive.
 */
function resolveSharePath(share: ShareRow, requested: string | undefined): string {
  const relative = requested === undefined || requested === '' ? '/' : safePath(requested)
  if (relative === '/') return assertWithinShare(share, share.path)
  const root = share.path === '/' ? '' : share.path
  let absolute: string
  try {
    absolute = normalizeCloudDrivePath(`${root}${relative}`)
  } catch {
    throw new ApiError(400, 'clouddrive_path_invalid', 'Invalid path')
  }
  return assertWithinShare(share, absolute)
}

function shareRelativePath(share: ShareRow, absolute: string): string {
  if (share.path === '/') return absolute
  const rest = absolute.slice(share.path.length)
  return rest === '' ? '/' : rest
}

function assertWithinShare(share: ShareRow, path: string): string {
  const root = share.path
  if (path !== root && root !== '/' && !path.startsWith(`${root}/`)) throw ApiError.badRequest('Path is outside the share')
  return path
}

function safePath(value: string): string {
  try {
    return normalizeCloudDrivePath(value)
  } catch {
    throw new ApiError(400, 'clouddrive_path_invalid', 'Invalid path')
  }
}

function hiddenPatternToLike(pattern: string): string {
  let out = ''
  for (const char of foldedName(pattern)) {
    if (char === '*') out += '%'
    else if (char === '?') out += '_'
    else if (char === '\\' || char === '%' || char === '_') out += `\\${char}`
    else out += char
  }
  return out
}

async function shareDirectoryState(
  c: Context<AppBindings>,
  ownerId: string,
  mountId: string,
  path: string,
): Promise<{ patterns: string[]; locked: boolean }> {
  const [meta, folderRules] = await Promise.all([
    effectiveMeta(c.env.DB, ownerId, mountId, path),
    folderHiddenPatterns(c.env.DB, ownerId, mountId, [path]),
  ])
  return {
    patterns: [...meta.hidePatterns, ...(folderRules.get(path) ?? [])],
    locked: Boolean(meta.passwordHash || meta.vaultPath),
  }
}

/** Check every directory between the share root and the requested entry, not only its immediate parent. */
async function assertSharePathAccess(
  c: Context<AppBindings>,
  share: ShareRow,
  path: string,
  kind: 'file' | 'folder',
): Promise<void> {
  const root = share.target_kind === 'folder' ? share.path : parentPathOf(share.path)
  const directories: string[] = []
  let current = kind === 'folder' ? path : parentPathOf(path)
  for (;;) {
    directories.unshift(current)
    if (current === root || current === '/') break
    current = parentPathOf(current)
  }
  for (const directory of directories) {
    await assertMetaAccess(c, share.user_id, share.mount_id, directory)
    if (directory === root) continue
    const parent = parentPathOf(directory)
    const state = await shareDirectoryState(c, share.user_id, share.mount_id, parent)
    if (hiddenByPatterns(directory.slice(directory.lastIndexOf('/') + 1), state.patterns)) {
      throw ApiError.notFound('File not found')
    }
  }
  if (path !== root) {
    const state = await shareDirectoryState(c, share.user_id, share.mount_id, parentPathOf(path))
    if (hiddenByPatterns(path.slice(path.lastIndexOf('/') + 1), state.patterns)) throw ApiError.notFound('File not found')
  }
}

/**
 * The share route's own answer to "may a visitor's browser draw this".
 *
 * The app-wide list keeps `application/pdf` on the download side because a stored attachment should
 * not render inside the product's origin; a link the owner opened precisely for previewing is where
 * the browser's built-in viewer is the point, so this route adds that one type and nothing else.
 */
function shareRenderable(mime: string): boolean {
  return isBrowserRenderable(mime) || mime === 'application/pdf'
}

function shareDisposition(mime: string, name: string, forceDownload: boolean): string {
  const base = contentDisposition(mime, name)
  if (forceDownload) return base.replace(/^inline/, 'attachment')
  // Only a type this route is willing to draw may switch to inline; `text/html` in particular keeps
  // the attachment disposition the app-wide rule gave it.
  return shareRenderable(mime) ? base.replace(/^attachment(?=;)/, 'inline') : base
}

/** A distributed row is only a manifest; verify the objects this response will actually read before spending its budget. */
async function assertSharePartsPresent(
  c: Context<AppBindings>,
  share: ShareRow,
  parts: readonly { mount_id: string; storage_key: string; size: number }[],
  start: number,
  length: number,
): Promise<void> {
  const end = start + length
  let offset = 0
  for (const part of parts) {
    const partStart = offset
    offset += part.size
    if (offset <= start || partStart >= end) continue
    if (part.mount_id === 'primary') {
      if (!c.env.FILES || !await c.env.FILES.head(part.storage_key)) throw ApiError.notFound('File not found')
      continue
    }
    const mount = await resolveMount(c.env.DB, share.user_id, part.mount_id)
    const probe = await readExternalObject(c.env, c.env.DB, mount, part.storage_key, 'bytes=0-0')
    if (!probe) throw ApiError.notFound('File not found')
    try {
      await probe.body?.cancel()
    } catch (error) {
      console.warn('[inkstone] CloudDrive could not cancel a distributed share probe:', error)
    }
  }
}

async function serveShareContent(c: Context<AppBindings>, share: ShareRow, requestedRaw: string | undefined, forceDownload: boolean): Promise<Response> {
  const requested = resolveSharePath(share, requestedRaw)
  const file = share.target_kind === 'file'
    ? await shareRoot(c, share)
    : await c.env.DB.prepare(
      `SELECT id, name, path, category, mime, size, storage_key, storage_kind, modified_at, kind
         FROM CloudDrive_files WHERE user_id = ?1 AND mount_id = ?2 AND path = ?3 AND kind = 'file' AND deleted_at IS NULL`,
    ).bind(share.user_id, share.mount_id, requested).first<FileRow>()
  if (!file || file.kind !== 'file') throw ApiError.notFound('File not found')
  await assertSharePathAccess(c, share, file.path, 'file')
  // "No download" has to mean something: a link that forbids downloading still renders the types a
  // browser can draw in place, and refuses to hand over the bytes of anything else.
  if (!forceDownload && share.allow_download !== 1 && !shareRenderable(file.mime || 'application/octet-stream')) {
    throw ApiError.forbidden('Downloads are disabled for this link')
  }
  if (file.storage_kind !== 'distributed' && !file.storage_key) throw ApiError.notFound('File not found')
  if (file.storage_kind !== 'distributed' && !c.env.FILES) {
    throw new ApiError(503, 'storage_unavailable', 'R2 is not configured')
  }
  const rangeHeader = c.req.header('range') ?? null
  const parsed = rangeHeader ? parseByteRange(rangeHeader, file.size) : null
  if (parsed === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } })
  }
  // A download is a request, not a header shape: `/content`, `/download`, `/raw` and Range all hand
  // over the same bytes. HEAD and preview-only rendering stay free; a missing object is never charged.
  const chargeDownload = async () => {
    if (c.req.method !== 'HEAD' && (forceDownload || share.allow_download === 1)) {
      await countDownload(c, share, shareRelativePath(share, requested), file.size)
    }
  }
  if (file.storage_kind === 'distributed') {
    const parts = await fileParts(c.env.DB, share.user_id, file.id)
    const total = parts.reduce((sum, part) => sum + part.size, 0)
    if (parts.length === 0 || total !== file.size) throw ApiError.notFound('File not found')
    const start = parsed ? parsed.start : 0
    const length = parsed ? parsed.end - parsed.start + 1 : file.size
    const headers = new Headers({
      'Content-Type': file.mime || 'application/octet-stream',
      'ETag': `"${file.id}-${file.size}"`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
    })
    headers.set('Content-Disposition', shareDisposition(file.mime, file.name, forceDownload))
    headers.set('Content-Length', String(length))
    if (parsed) headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${file.size}`)
    if (c.req.method === 'HEAD') return new Response(null, { status: parsed ? 206 : 200, headers })
    if (forceDownload || share.allow_download === 1) await assertSharePartsPresent(c, share, parts, start, length)
    await chargeDownload()
    const body = await distributedStream(c.env, c.env.DB, share.user_id, parts, start, length)
    return new Response(body, { status: parsed ? 206 : 200, headers })
  }
  const storageKey = file.storage_key
  if (!storageKey || !c.env.FILES) throw ApiError.notFound('File not found')
  const object = parsed
    ? await c.env.FILES.get(storageKey, { range: { offset: parsed.start, length: parsed.end - parsed.start + 1 } })
    : await c.env.FILES.get(storageKey)
  if (!object) throw ApiError.notFound('File not found')
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Content-Type', file.mime || 'application/octet-stream')
  headers.set('ETag', object.httpEtag)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Cache-Control', 'private, no-store')
  headers.set('Content-Disposition', shareDisposition(file.mime, file.name, forceDownload))
  const ranged = parsed && 'range' in object && object.range && 'offset' in object.range
  if (ranged) {
    const offset = object.range.offset ?? parsed.start
    const length = object.range.length ?? parsed.end - parsed.start + 1
    headers.set('Content-Length', String(length))
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${file.size}`)
  } else {
    headers.set('Content-Length', String(object.size))
  }
  if (c.req.method === 'HEAD') return new Response(null, { status: ranged ? 206 : 200, headers })
  try {
    await chargeDownload()
  } catch (error) {
    await object.body.cancel().catch((cancelError: unknown) => console.warn('[inkstone] CloudDrive could not cancel an uncharged share response:', cancelError))
    throw error
  }
  return new Response(object.body, { status: ranged ? 206 : 200, headers })
}

async function requireAccess(c: Context<AppBindings>, slug: string): Promise<ShareRow> {
  const share = await loadPublicShare(c, slug)
  if (share.password_hash && !(await shareUnlocked(c, share))) throw new ApiError(401, 'clouddrive_share_locked', 'A password is required')
  const resolved = atShareRoot(share, await shareRoot(c, share))
  await assertSharePathAccess(c, resolved, resolved.path, resolved.target_kind)
  // Listing and content are views too. Charging them here closes the alternate endpoints that used
  // to skip `max_views`; the per-visitor dedupe still makes metadata + list + preview one visit.
  await recordView(c, resolved)
  return resolved
}

async function loadPublicShare(c: Context<AppBindings>, slug: string): Promise<ShareRow> {
  const now = Date.now()
  const row = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_shares WHERE slug = ?1`,
  ).bind(slug).first<ShareRow>()
  if (!row || row.revoked_at || row.is_enabled !== 1 || (row.expires_at !== null && row.expires_at <= now)) {
    throw ApiError.notFound('Share not found')
  }
  if (row.file_id) {
    const target = await c.env.DB.prepare(
      `SELECT kind, path, name FROM CloudDrive_files WHERE user_id = ? AND id = ?`,
    ).bind(row.user_id, row.file_id).first<{ kind: string; path: string; name: string }>()
    const meta = target ? await effectiveMeta(c.env.DB, row.user_id, row.mount_id,
      target.kind === 'folder' ? target.path : parentPathOf(target.path)) : null
    if (meta?.vaultPath) throw ApiError.notFound('Share not found')
    if (target) {
      const parent = parentPathOf(target.path)
      const state = await shareDirectoryState(c, row.user_id, row.mount_id, parent)
      if (hiddenByPatterns(target.name, state.patterns)) throw ApiError.notFound('Share not found')
    }
  }
  return row
}

/** The same visitor is counted once an hour per link; the row exists to make that judgement cheap. */
const VISIT_DEDUPE_MS = 60 * 60 * 1000
const SHARE_LIST_PAGE = 200
const SHARE_PAGE_SIZE = 100

/**
 * A visitor, not an address. The salt is per link, so two shares of the same file cannot be joined by
 * their hashes and the raw IP never reaches the row.
 */
async function visitHash(c: Context<AppBindings>, slug: string): Promise<string> {
  const digest = await sha256Hex(`${requestClientIp(c.req.raw)}|${slug}|clouddrive-share-visit`)
  return digest.slice(0, 32)
}

async function recordView(c: Context<AppBindings>, share: ShareRow): Promise<void> {
  const now = Date.now()
  const ipHash = await visitHash(c, share.slug)
  const seen = await c.env.DB.prepare(
    `SELECT 1 AS hit FROM CloudDrive_share_visits
      WHERE user_id = ?1 AND slug = ?2 AND kind = 'view' AND ip_hash = ?3 AND at > ?4`,
  ).bind(share.user_id, share.slug, ipHash, now - VISIT_DEDUPE_MS).first<{ hit: number }>()
  if (seen) {
    // The budget was already spent by this visitor's counted view; a link that has since run out must
    // still refuse them, and the row this caller handed over already says whether it has.
    if (share.max_views !== null && share.views >= share.max_views) {
      throw new ApiError(403, 'clouddrive_share_expired', 'This link has reached its limit')
    }
    return
  }
  const result = await c.env.DB.prepare(
    `UPDATE CloudDrive_shares SET views = views + 1, last_accessed_at = ?1
      WHERE slug = ?2 AND (max_views IS NULL OR views < max_views)`,
  ).bind(now, share.slug).run()
  if (!result.meta.changes) throw new ApiError(403, 'clouddrive_share_expired', 'This link has reached its limit')
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_share_visits (id, user_id, slug, kind, path, bytes, ip_hash, at)
     VALUES (?1,?2,?3,'view',NULL,NULL,?4,?5)`,
  ).bind(newId(), share.user_id, share.slug, ipHash, now).run()
}

async function shareUnlocked(c: Context<AppBindings>, share: ShareRow): Promise<boolean> {
  if (!share.password_hash) return true
  const sessionId = getCookie(c, await shareCookieName(share.slug))
  if (!sessionId) return false
  const session = await c.env.DB.prepare(
    `SELECT password_hash FROM CloudDrive_share_sessions WHERE id = ?1 AND slug = ?2 AND user_id = ?3 AND expires_at > ?4`,
  ).bind(sessionId, share.slug, share.user_id, Date.now()).first<{ password_hash: string }>()
  return Boolean(session && session.password_hash === share.password_hash)
}

async function countDownload(c: Context<AppBindings>, share: ShareRow, path: string, bytes: number): Promise<void> {
  const now = Date.now()
  const ipHash = await visitHash(c, share.slug)
  // A browser asks for the same object again when a preview reloads or a range request follows the
  // first one. Charge one visitor/file/window, not one HTTP request; another file in a folder link is
  // still a separate download. The marker insert and counter update share one transaction, so two
  // simultaneous requests cannot both pass a read-then-write dedupe check.
  const visitId = newId()
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO CloudDrive_share_visits (id, user_id, slug, kind, path, bytes, ip_hash, at)
       SELECT ?1, ?2, ?3, 'download', ?4, ?5, ?6, ?7
        WHERE NOT EXISTS (
          SELECT 1 FROM CloudDrive_share_visits
           WHERE user_id = ?2 AND slug = ?3 AND kind = 'download'
             AND path = ?4 AND ip_hash = ?6 AND at > ?8
        )
        AND EXISTS (
          SELECT 1 FROM CloudDrive_shares
           WHERE user_id = ?2 AND slug = ?3
             AND (max_downloads IS NULL OR downloads < max_downloads)
        )`,
    ).bind(visitId, share.user_id, share.slug, path, bytes, ipHash, now, now - VISIT_DEDUPE_MS),
    c.env.DB.prepare(
      `UPDATE CloudDrive_shares SET downloads = downloads + 1
        WHERE user_id = ?1 AND slug = ?2
          AND EXISTS (SELECT 1 FROM CloudDrive_share_visits WHERE user_id = ?1 AND id = ?3)`,
    ).bind(share.user_id, share.slug, visitId),
  ])
  if (Number(results[1]?.meta.changes ?? 0) > 0) return

  const [seen, current] = await Promise.all([
    c.env.DB.prepare(
      `SELECT 1 AS hit FROM CloudDrive_share_visits
        WHERE user_id = ?1 AND slug = ?2 AND kind = 'download' AND path = ?3 AND ip_hash = ?4 AND at > ?5`,
    ).bind(share.user_id, share.slug, path, ipHash, now - VISIT_DEDUPE_MS).first<{ hit: number }>(),
    c.env.DB.prepare(
      `SELECT max_downloads, downloads FROM CloudDrive_shares WHERE user_id = ?1 AND slug = ?2`,
    ).bind(share.user_id, share.slug).first<{ max_downloads: number | null; downloads: number }>(),
  ])
  if (seen) {
    if (current && current.max_downloads !== null && current.downloads >= current.max_downloads) {
      throw new ApiError(403, 'clouddrive_share_expired', 'This link has reached its download limit')
    }
    return
  }
  if (!current) throw ApiError.notFound('Share not found')
  throw new ApiError(403, 'clouddrive_share_expired', 'This link has reached its download limit')
}

async function shareBySlug(c: Context<AppBindings>, slug: string): Promise<ShareRow | null> {
  return await c.env.DB.prepare(`SELECT * FROM CloudDrive_shares WHERE slug = ?1`).bind(slug).first<ShareRow>()
}

function toShareView(row: ShareRow) {
  return {
    slug: row.slug,
    url: `/d/${row.slug}`,
    targetKind: row.target_kind,
    fileId: row.file_id,
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
    allowList: row.allow_list === 1,
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
