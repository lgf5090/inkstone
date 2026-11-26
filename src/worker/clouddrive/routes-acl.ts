import { Hono, type Context } from 'hono'
import { autoSuffixName, categoryFor, childPath, foldedName, parentPathOf } from '@shared/clouddrive/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { readJson } from '../lib/request'
import {
  assertPasscodeAttemptsLeft,
  assertWritable,
  buildEntry,
  chunkedBatch,
  deleteObjectQuietly,
  initialsOf,
  notePasscodeFailure,
  parseFolderMeta,
  passcodeThrottleKey,
  parsePath,
  parseName,
  requireBucket,
  resolveEntry,
  resolveMount,
  type CloudDriveFileRow,
  decodeCursor,
  encodeCursor,
} from './lib'
import { distributedStream, fileParts } from './distributed'
import { createFile, createFolder, folderHiddenPatterns, renameEntry, setEntryFlags } from './store-files'
import { hiddenPatternToLike } from './store-files-list'
import { effectiveMeta, effectiveMetas, hiddenByPatterns, normalizeMetaPatterns } from './meta'
import { cloudDriveUsage } from './store'
import { planContentResponse, headResponse } from './content-response'
import { assertMetaAccess } from './routes-meta'
import { aclFileForRole, parseAclExpiry, parseAclRole } from './acl-access'

export const clouddriveAclRoutes = new Hono<AppBindings>()

clouddriveAclRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

const BODY_LIMIT = 16 * 1024
const ACL_PAGE_SIZE = 100

interface AclFileRow {
  id: string
  user_id: string
  mount_id: string
  parent_id: string
  path: string
  kind: string
  name: string
  name_folded: string
  category: string
  mime: string
  size: number
  etag: string | null
  storage_kind: string
  storage_key: string | null
  metadata: string
  uploaded_at: number
  modified_at: number
}

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

/**
 * The rows a single save may copy. A shared tree deep enough to exceed this is refused rather than
 * half-copied, because a partial folder in the reader's drive is worse than an error they can retry.
 */
const MAX_SAVE_ROWS = 500

async function sourceParentPatterns(
  c: Context<AppBindings>,
  ownerId: string,
  mountId: string,
  paths: readonly string[],
): Promise<Map<string, string[]>> {
  const [metas, folderRules] = await Promise.all([
    effectiveMetas(c.env.DB, ownerId, mountId, paths),
    folderHiddenPatterns(c.env.DB, ownerId, mountId, paths),
  ])
  return new Map(paths.map((path) => [path, [...(metas.get(path)?.hidePatterns ?? []), ...(folderRules.get(path) ?? [])]]))
}

async function assertSaveRootVisible(c: Context<AppBindings>, ownerId: string, root: AclFileRow): Promise<void> {
  const parent = parentPathOf(root.path)
  const patterns = await sourceParentPatterns(c, ownerId, root.mount_id, [parent])
  if (hiddenByPatterns(root.name, patterns.get(parent) ?? [])) throw ApiError.notFound('File not found')
  await assertMetaAccess(c, ownerId, root.mount_id, root.kind === 'folder' ? root.path : parent)
}

async function subtreeOf(c: Context<AppBindings>, ownerId: string, root: AclFileRow): Promise<AclFileRow[]> {
  const rows: AclFileRow[] = []
  let frontier = [root]
  while (frontier.length > 0) {
    const patterns = await sourceParentPatterns(c, ownerId, root.mount_id, frontier.map((row) => row.path))
    const { results } = await c.env.DB.prepare(
      `SELECT id, user_id, mount_id, parent_id, path, kind, name, category, mime, size, etag, storage_kind, storage_key, metadata,
              uploaded_at, modified_at
         FROM CloudDrive_files WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL
           AND parent_id IN (${frontier.map(() => '?').join(',')})
        ORDER BY kind DESC, name_folded LIMIT ?`,
    ).bind(ownerId, root.mount_id, ...frontier.map((row) => row.id), MAX_SAVE_ROWS + 1).all<AclFileRow>()
    const visible: AclFileRow[] = []
    for (const child of results ?? []) {
      if (hiddenByPatterns(child.name, patterns.get(parentPathOf(child.path)) ?? [])) continue
      if (child.kind === 'folder') await assertMetaAccess(c, ownerId, child.mount_id, child.path)
      visible.push(child)
    }
    if (rows.length + visible.length > MAX_SAVE_ROWS) {
      throw ApiError.tooLarge(`A saved folder holds at most ${MAX_SAVE_ROWS} items`)
    }
    rows.push(...visible)
    frontier = visible.filter((row) => row.kind === 'folder')
  }
  return rows
}

clouddriveAclRoutes.post('/acl/save', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ ownerId?: unknown; fileId?: unknown; toPath?: unknown }>(c, BODY_LIMIT)
  const ownerId = typeof body.ownerId === 'string' && isValidId(body.ownerId) ? body.ownerId : ''
  const fileId = typeof body.fileId === 'string' && isValidId(body.fileId) ? body.fileId : ''
  if (!ownerId || !fileId) throw ApiError.badRequest('A saved item names its owner and its file')
  const target = await aclAllows(c, ownerId, fileId, userId)
  if (!target) throw ApiError.notFound('File not found')
  await assertSaveRootVisible(c, ownerId, target)

  const mount = await resolveMount(c.env.DB, userId, 'primary')
  assertWritable(mount)
  const toPath = parsePath(body.toPath ?? '/')
  await assertMetaAccess(c, userId, mount.id, toPath)
  const parent = await resolveEntry(c.env.DB, userId, mount.id, toPath)
  if (parent.kind !== 'folder') throw ApiError.badRequest('The destination is not a folder')

  const rows = target.kind === 'folder' ? await subtreeOf(c, ownerId, target) : []
  const sources = [target, ...rows]
  // Only objects this deployment holds in its own bucket can be pointed at twice; a distributed or
  // external row lives on a mount the reader has no claim to.
  if (sources.some((row) => row.storage_kind !== 'r2')) {
    throw ApiError.badRequest('This item is not stored on the primary mount and cannot be saved')
  }
  const bytes = sources.reduce((sum, row) => sum + (row.kind === 'file' ? row.size : 0), 0)
  const usage = await cloudDriveUsage(c.env.DB, userId, c.env)
  if (usage.quotaBytes !== null && usage.usedBytes + bytes > usage.quotaBytes) {
    throw new ApiError(403, 'clouddrive_quota_exceeded', 'Saving this item would exceed your quota')
  }
  const rootName = await freeName(c.env.DB, userId, mount.id, parent.id, target.name)
  const rootPath = childPath(toPath, rootName)

  const now = Date.now()
  const bySource = new Map<string, { id: string; path: string; parentId: string }>()
  const statements: D1PreparedStatement[] = []
  const insert = (row: AclFileRow, id: string, path: string, parentId: string, name: string) => {
    bySource.set(row.id, { id, path, parentId })
    statements.push(c.env.DB.prepare(
      `INSERT INTO CloudDrive_files
         (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path, category,
          mime, size, etag, checksum, storage_kind, storage_key, metadata, color, starred_at,
          last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'r2', ?, '{}', '',
               NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    ).bind(
      id, userId, mount.id, parentId, row.kind, name, foldedName(name), initialsOf(name), path,
      row.category, row.mime, row.size, row.etag, row.storage_key, now, now, row.uploaded_at, row.modified_at,
    ))
  }
  const rootId = newId()
  insert(target, rootId, rootPath, parent.id, rootName)
  // Children keep the owner's folder shape; a name the destination already holds gets a suffix
  // rather than silently replacing the reader's own file.
  for (const row of rows) {
    const above = bySource.get(row.parent_id)
    if (!above) continue
    const name = await freeName(c.env.DB, userId, mount.id, above.id, row.name)
    insert(row, newId(), childPath(above.path, name), above.id, name)
  }
  await chunkedBatch(c.env.DB, statements)
  const saved = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_files WHERE user_id = ? AND mount_id = ? AND id = ?`,
  ).bind(userId, mount.id, rootId).first<CloudDriveFileRow>()
  if (!saved) throw new ApiError(500, 'internal', 'The saved item has no row')
  return c.json({ saved: statements.length, entry: buildEntry(saved, mount, []) }, 201)
})

/** A name the destination folder does not already hold, using the same suffix rule as an upload. */
async function freeName(db: D1Database, userId: string, mountId: string, parentId: string, name: string): Promise<string> {
  let candidate = name
  for (let attempt = 0; attempt <= 100; attempt++) {
    const clash = await db.prepare(
      `SELECT 1 AS hit FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND parent_id = ? AND name_folded = ? AND deleted_at IS NULL`,
    ).bind(userId, mountId, parentId, foldedName(candidate)).first<{ hit: number }>()
    if (!clash) return candidate
    candidate = autoSuffixName(name, attempt + 1)
  }
  return candidate
}

async function ownerFile(c: Context<AppBindings>, fileId: string): Promise<CloudDriveFileRow> {
  if (!isValidId(fileId)) throw ApiError.notFound('File not found')
  const row = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_files WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
  ).bind(userIdOf(c), fileId).first<CloudDriveFileRow>()
  if (!row) throw ApiError.notFound('File not found')
  return row
}

async function aclAllows(
  c: Context<AppBindings>,
  ownerId: string,
  fileId: string,
  granteeId: string,
): Promise<AclFileRow | null> {
  if (!isValidId(fileId)) return null
  const target = await c.env.DB.prepare(
    `SELECT id, user_id, mount_id, parent_id, path, kind, name, category, mime, size, etag, storage_kind, storage_key, metadata,
            uploaded_at, modified_at
       FROM CloudDrive_files WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
  ).bind(ownerId, fileId).first<AclFileRow>()
  if (!target) return null
  const grant = await c.env.DB.prepare(
    `SELECT 1 AS hit FROM CloudDrive_acl a
       JOIN CloudDrive_files f ON f.user_id = a.owner_id AND f.id = a.file_id
      WHERE a.owner_id = ?1 AND a.grantee_id = ?2 AND a.revoked_at IS NULL
        AND (a.expires_at IS NULL OR a.expires_at > ?6)
        AND f.deleted_at IS NULL AND f.mount_id = ?5
        AND (f.id = ?3 OR (f.kind = 'folder'
          AND (f.path = ?4 OR (f.path <> '/' AND substr(?4, 1, length(f.path) + 1) = f.path || '/'))))
      LIMIT 1`,
  ).bind(ownerId, granteeId, fileId, target.path, target.mount_id, Date.now()).first<{ hit: number }>()
  return grant ? target : null
}

clouddriveAclRoutes.get('/acl/grants', async (c) => {
  const fileId = c.req.query('fileId') ?? ''
  const file = await ownerFile(c, fileId)
  const clauses = ['a.owner_id = ?1', 'a.file_id = ?2', 'a.revoked_at IS NULL']
  const params: unknown[] = [userIdOf(c), file.id]
  const cursor = c.req.query('cursor')
  if (cursor) {
    const decoded = decodeCursor(cursor, 'uploaded')
    if (typeof decoded.v !== 'number') throw ApiError.badRequest('The cursor is invalid')
    clauses.push('(a.created_at > ?3 OR (a.created_at = ?4 AND a.grantee_id > ?5))')
    params.push(decoded.v, decoded.v, decoded.id)
  }
  const { results } = await c.env.DB.prepare(
    `SELECT a.grantee_id, a.role, a.expires_at, a.created_at, u.username, u.name
       FROM CloudDrive_acl a
       JOIN users u ON u.id = a.grantee_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.created_at, a.grantee_id LIMIT ?${params.length + 1}`,
  ).bind(...params, ACL_PAGE_SIZE + 1).all<{ grantee_id: string; role: string; expires_at: number | null; created_at: number; username: string; name: string }>()
  const rows = results ?? []
  const page = rows.slice(0, ACL_PAGE_SIZE)
  const last = page[page.length - 1]
  return c.json({
    grants: page.map((row) => ({
      granteeId: row.grantee_id,
      username: row.username,
      name: row.name,
      role: parseAclRole(row.role),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })),
    cursor: rows.length > ACL_PAGE_SIZE && last
      ? encodeCursor('uploaded', last.created_at, last.grantee_id)
      : null,
  })
})

clouddriveAclRoutes.post('/acl/grants', async (c) => {
  const ownerId = userIdOf(c)
  const body = await readJson<{ fileId?: unknown; username?: unknown; role?: unknown; expiresAt?: unknown }>(c, BODY_LIMIT)
  if (typeof body.fileId !== 'string') throw ApiError.badRequest('fileId is required')
  const file = await ownerFile(c, body.fileId)
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  if (!username) throw ApiError.badRequest('A username is required')
  // A username lookup is an enumeration oracle. Budget all misses for this owner/client together so
  // changing the guessed name cannot reset the lock; valid lookups neither spend nor clear it.
  const throttleKey = passcodeThrottleKey('acl-user', ownerId, c.req.raw)
  await assertPasscodeAttemptsLeft(c.env.DB, throttleKey)
  const grantee = await c.env.DB.prepare(
    `SELECT id, username, name FROM users WHERE lower(username) = lower(?) LIMIT 1`,
  ).bind(username).first<{ id: string; username: string; name: string }>()
  if (!grantee) {
    await notePasscodeFailure(c.env.DB, throttleKey)
    throw ApiError.notFound('No account uses that username')
  }
  if (grantee.id === ownerId) throw ApiError.badRequest('You already own this item')
  const now = Date.now()
  const role = body.role === undefined ? 'viewer' : parseAclRole(body.role)
  const expiresAt = parseAclExpiry(body.expiresAt, now)
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_acl (owner_id, file_id, grantee_id, role, expires_at, created_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)
     ON CONFLICT(owner_id, file_id, grantee_id) DO UPDATE SET
       role = excluded.role, expires_at = excluded.expires_at, created_at = excluded.created_at, revoked_at = NULL`,
  ).bind(ownerId, file.id, grantee.id, role, expiresAt, now).run()
  return c.json({
    grant: { granteeId: grantee.id, username: grantee.username, name: grantee.name, role, expiresAt, createdAt: now },
  })
})

clouddriveAclRoutes.patch('/acl/grants', async (c) => {
  const ownerId = userIdOf(c)
  const body = await readJson<{ fileId?: unknown; granteeId?: unknown; role?: unknown; expiresAt?: unknown }>(c, BODY_LIMIT)
  if (typeof body.fileId !== 'string' || typeof body.granteeId !== 'string' || !isValidId(body.granteeId)) {
    throw ApiError.badRequest('fileId and granteeId are required')
  }
  await ownerFile(c, body.fileId)
  const sets: string[] = []
  const values: unknown[] = []
  if (body.role !== undefined) {
    sets.push('role = ?')
    values.push(parseAclRole(body.role))
  }
  if (body.expiresAt !== undefined) {
    sets.push('expires_at = ?')
    values.push(parseAclExpiry(body.expiresAt))
  }
  if (sets.length === 0) throw ApiError.badRequest('role or expiresAt is required')
  values.push(ownerId, body.fileId, body.granteeId)
  const updated = await c.env.DB.prepare(
    `UPDATE CloudDrive_acl SET ${sets.join(', ')}
      WHERE owner_id = ? AND file_id = ? AND grantee_id = ? AND revoked_at IS NULL`,
  ).bind(...values).run()
  if (!updated.meta.changes) throw ApiError.notFound('Grant not found')
  const grant = await c.env.DB.prepare(
    `SELECT a.grantee_id, a.role, a.expires_at, a.created_at, u.username, u.name
       FROM CloudDrive_acl a JOIN users u ON u.id = a.grantee_id
      WHERE a.owner_id = ? AND a.file_id = ? AND a.grantee_id = ? AND a.revoked_at IS NULL`,
  ).bind(ownerId, body.fileId, body.granteeId).first<{
    grantee_id: string; role: string; expires_at: number | null; created_at: number; username: string; name: string
  }>()
  if (!grant) throw ApiError.notFound('Grant not found')
  return c.json({
    grant: {
      granteeId: grant.grantee_id,
      username: grant.username,
      name: grant.name,
      role: parseAclRole(grant.role),
      expiresAt: grant.expires_at,
      createdAt: grant.created_at,
    },
  })
})

clouddriveAclRoutes.delete('/acl/grants', async (c) => {
  const ownerId = userIdOf(c)
  const body = await readJson<{ fileId?: unknown; granteeId?: unknown }>(c, BODY_LIMIT)
  if (typeof body.fileId !== 'string' || typeof body.granteeId !== 'string' || !isValidId(body.granteeId)) {
    throw ApiError.badRequest('fileId and granteeId are required')
  }
  await ownerFile(c, body.fileId)
  await c.env.DB.prepare(
    `UPDATE CloudDrive_acl SET revoked_at = ?
      WHERE owner_id = ? AND file_id = ? AND grantee_id = ? AND revoked_at IS NULL`,
  ).bind(Date.now(), ownerId, body.fileId, body.granteeId).run()
  return c.json({ ok: true })
})

clouddriveAclRoutes.get('/acl/shared', async (c) => {
  const clauses = ['a.grantee_id = ?1', 'a.revoked_at IS NULL', '(a.expires_at IS NULL OR a.expires_at > ?2)']
  const params: unknown[] = [userIdOf(c), Date.now()]
  const cursor = c.req.query('cursor')
  if (cursor) {
    const decoded = decodeCursor(cursor, 'uploaded')
    if (typeof decoded.v !== 'number') throw ApiError.badRequest('The cursor is invalid')
    const separator = decoded.id.indexOf('\u0000')
    const ownerId = decoded.id.slice(0, separator)
    const fileId = decoded.id.slice(separator + 1)
    if (separator < 0 || !ownerId || !fileId) throw ApiError.badRequest('The cursor is invalid')
    clauses.push('(a.created_at < ?3 OR (a.created_at = ?4 AND (a.owner_id < ?5 OR (a.owner_id = ?6 AND a.file_id < ?7))))')
    params.push(decoded.v, decoded.v, ownerId, ownerId, fileId)
  }
  const { results } = await c.env.DB.prepare(
    `SELECT a.owner_id, a.file_id, a.role, a.expires_at, a.created_at, f.name, f.path, f.kind, f.size, f.mime,
            f.modified_at, u.username AS owner_username, u.name AS owner_name
       FROM CloudDrive_acl a
       JOIN CloudDrive_files f ON f.user_id = a.owner_id AND f.id = a.file_id AND f.deleted_at IS NULL
       JOIN users u ON u.id = a.owner_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.created_at DESC, a.owner_id DESC, a.file_id DESC LIMIT ?${params.length + 1}`,
  ).bind(...params, ACL_PAGE_SIZE + 1).all<{
    owner_id: string
    file_id: string
    role: string
    expires_at: number | null
    created_at: number
    name: string
    path: string
    kind: string
    size: number
    mime: string
    modified_at: number
    owner_username: string
    owner_name: string
  }>()
  const rows = results ?? []
  const page = rows.slice(0, ACL_PAGE_SIZE)
  const last = page[page.length - 1]
  return c.json({
    shared: page.map((row) => ({
      ownerId: row.owner_id,
      ownerUsername: row.owner_username,
      ownerName: row.owner_name,
      fileId: row.file_id,
      name: row.name,
      path: row.path,
      kind: row.kind,
      size: row.size,
      mime: row.mime,
      modifiedAt: row.modified_at,
      role: parseAclRole(row.role),
      expiresAt: row.expires_at,
      sharedAt: row.created_at,
    })),
    cursor: rows.length > ACL_PAGE_SIZE && last
      ? encodeCursor('uploaded', last.created_at, `${last.owner_id}\u0000${last.file_id}`)
      : null,
  })
})

clouddriveAclRoutes.get('/acl/shared/:ownerId/:fileId/list', async (c) => {
  const ownerId = c.req.param('ownerId')
  const fileId = c.req.param('fileId')
  const target = await aclAllows(c, ownerId, fileId, userIdOf(c))
  if (!target) throw ApiError.notFound('File not found')
  if (target.kind !== 'folder') throw ApiError.badRequest('This item is not a folder')
  const requested = parsePath(c.req.query('path') ?? target.path)
  if (requested !== target.path && target.path !== '/' && !requested.startsWith(`${target.path}/`)) {
    throw ApiError.forbidden('The path is outside the shared folder')
  }
  const folder = requested === target.path
    ? target
    : await c.env.DB.prepare(
      `SELECT * FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND path = ? AND kind = 'folder' AND deleted_at IS NULL`,
    ).bind(ownerId, target.mount_id, requested).first<CloudDriveFileRow>()
  if (!folder) throw ApiError.notFound('Folder not found')
  // The drive's folder password is an access boundary here too: a grantee who was handed a folder
  // cannot list what the owner later locked, and the same `hidePatterns` rule the owner's own
  // listing applies decides which names the directory shows.
  await assertMetaAccess(c, ownerId, folder.mount_id, requested)
  const meta = await effectiveMeta(c.env.DB, ownerId, folder.mount_id, requested)
  const folderMeta = parseFolderMeta(folder.metadata)
  const clauses = ['user_id = ?', 'mount_id = ?', 'parent_id = ?', 'deleted_at IS NULL']
  const params: unknown[] = [ownerId, folder.mount_id, folder.id]
  const hidden = [...meta.hidePatterns, ...folderMeta.hiddenPatterns]
  if (hidden.length > 0) {
    clauses.push(`(${hidden.map(() => "name_folded NOT LIKE ? ESCAPE '\\'").join(' AND ')})`)
    params.push(...hidden.map(hiddenPatternToLike))
  }
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
  const { results } = await c.env.DB.prepare(
    `SELECT id, user_id, path, kind, name, name_folded, mime, size, etag, storage_kind, storage_key, metadata,
            uploaded_at, modified_at
       FROM CloudDrive_files WHERE ${clauses.join(' AND ')}
       ORDER BY kind DESC, name_folded, id LIMIT ?`,
  ).bind(...params, ACL_PAGE_SIZE + 1).all<AclFileRow>()
  const rows = results ?? []
  const page = rows.slice(0, ACL_PAGE_SIZE)
  const last = page[page.length - 1]
  return c.json({
    ownerId,
    path: requested,
    entries: page.map((row) => ({
      ownerId,
      fileId: row.id,
      name: row.name,
      path: row.path,
      kind: row.kind,
      size: row.size,
      mime: row.mime,
      modifiedAt: row.modified_at,
    })),
    cursor: rows.length > ACL_PAGE_SIZE && last
      ? encodeCursor('name', `${last.kind}\u0000${last.name_folded}`, last.id)
      : null,
  })
})

clouddriveAclRoutes.on(['GET', 'HEAD'], '/acl/shared/:ownerId/:fileId/content', async (c) => {
  const ownerId = c.req.param('ownerId')
  const fileId = c.req.param('fileId')
  const file = await aclAllows(c, ownerId, fileId, userIdOf(c))
  if (!file || file.kind !== 'file') throw ApiError.notFound('File not found')
  // A grant to a file under a password folder follows the folder's lock, exactly as the owner's own
  // file route does (it checks the containing directory, not the file path).
  await assertMetaAccess(c, ownerId, file.mount_id, parentPathOf(file.path))
  const planned = planContentResponse({
    method: c.req.method,
    rangeHeader: c.req.header('range'),
    ifNoneMatch: c.req.header('if-none-match'),
    download: c.req.query('download') === '1',
    file: {
      id: file.id,
      size: file.size,
      mime: file.mime,
      name: file.name,
      etag: file.etag,
      lastModified: file.modified_at,
    },
  })
  if (planned.kind === 'respond') return planned.response
  if (planned.kind === 'head') return headResponse(planned)
  if (file.storage_kind === 'distributed') {
    const parts = await fileParts(c.env.DB, ownerId, file.id)
    const total = parts.reduce((sum, part) => sum + part.size, 0)
    if (parts.length === 0 || total !== file.size) throw ApiError.notFound('File not found')
    const body = await distributedStream(c.env, c.env.DB, ownerId, parts, planned.offset, planned.length)
    return new Response(body, { status: planned.status, headers: planned.headers })
  }
  if (!file.storage_key || !c.env.FILES) throw ApiError.notFound('File not found')
  const object = await c.env.FILES.get(
    file.storage_key,
    planned.status === 206 ? { range: { offset: planned.offset, length: planned.length } } : undefined,
  )
  if (!object) throw ApiError.notFound('File not found')
  return new Response(object.body, { status: planned.status, headers: planned.headers })
})

async function editableSharedFolder(c: Context<AppBindings>, ownerId: string, folderId: string) {
  const { file } = await aclFileForRole(c, ownerId, folderId, userIdOf(c), 'editor')
  if (file.kind !== 'folder') throw ApiError.badRequest('This item is not a folder')
  const mount = await resolveMount(c.env.DB, ownerId, file.mount_id)
  assertWritable(mount)
  await assertMetaAccess(c, ownerId, mount.id, file.path)
  return { file, mount }
}

clouddriveAclRoutes.post('/acl/shared/:ownerId/:folderId/folders', async (c) => {
  const ownerId = c.req.param('ownerId')
  const { file, mount } = await editableSharedFolder(c, ownerId, c.req.param('folderId'))
  const body = await readJson<{ name?: unknown }>(c, BODY_LIMIT)
  const created = await createFolder(c.env.DB, ownerId, mount.id, file, parseName(body.name), Date.now())
  if (!created.entry) throw ApiError.conflict('A file with this name already exists', { suggestedName: created.conflict })
  return c.json({ entry: buildEntry(created.entry, mount, []) }, 201)
})

clouddriveAclRoutes.post('/acl/shared/:ownerId/:folderId/files', async (c) => {
  const ownerId = c.req.param('ownerId')
  const { file, mount } = await editableSharedFolder(c, ownerId, c.req.param('folderId'))
  const body = await readJson<{ name?: unknown }>(c, BODY_LIMIT)
  const name = parseName(body.name)
  const category = categoryFor(name)
  const mime = category === 'txt' || category === 'code' ? 'text/plain' : 'application/octet-stream'
  const bucket = await requireBucket(c)
  const id = newId()
  const storageKey = `CloudDrive/${category}/${id}`
  const object = await bucket.put(storageKey, new Uint8Array(0), {
    httpMetadata: { contentType: mime },
    customMetadata: { fileId: id, category },
  })
  const created = await createFile(c.env.DB, ownerId, mount.id, file, name, {
    id, category, mime, storageKey, etag: object.etag,
  }, Date.now())
  if (!created.entry) {
    await deleteObjectQuietly(bucket, storageKey)
    throw ApiError.conflict('A file with this name already exists', { suggestedName: created.conflict })
  }
  return c.json({ entry: buildEntry(created.entry, mount, []) }, 201)
})

clouddriveAclRoutes.patch('/acl/shared/:ownerId/:fileId', async (c) => {
  const ownerId = c.req.param('ownerId')
  const { file } = await aclFileForRole(c, ownerId, c.req.param('fileId'), userIdOf(c), 'editor')
  const mount = await resolveMount(c.env.DB, ownerId, file.mount_id)
  assertWritable(mount)
  await assertMetaAccess(c, ownerId, mount.id, file.kind === 'folder' ? file.path : parentPathOf(file.path))
  const body = await readJson<{ name?: unknown; note?: unknown; hidePatterns?: unknown }>(c, BODY_LIMIT)
  let current = file
  if (body.name !== undefined) {
    const renamed = await renameEntry(c.env.DB, ownerId, mount.id, current, parseName(body.name), Date.now())
    if (renamed.tooLarge) throw ApiError.tooLarge('The folder is too large to rename synchronously')
    if (!renamed.entry) throw ApiError.conflict('A file with this name already exists', { suggestedName: renamed.conflict })
    current = renamed.entry
  }
  if (body.note !== undefined || body.hidePatterns !== undefined) {
    if (current.kind !== 'folder') throw ApiError.badRequest('Only folders can have a note or hidden patterns')
    let metadata: Record<string, unknown>
    try {
      const parsed = JSON.parse(current.metadata) as unknown
      metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      metadata = {}
    }
    if (body.note !== undefined) {
      if (typeof body.note !== 'string' || body.note.length > 4000) throw ApiError.badRequest('note must be a string of at most 4000 characters')
      const note = body.note.trim()
      if (note) metadata.note = note
      else delete metadata.note
    }
    if (body.hidePatterns !== undefined) {
      try {
        metadata.hidePatterns = normalizeMetaPatterns(body.hidePatterns)
      } catch (error) {
        throw ApiError.badRequest(error instanceof Error ? error.message : 'hidePatterns holds * and ? wildcards')
      }
    }
    current = await setEntryFlags(c.env.DB, ownerId, mount.id, current, { metadata }, Date.now())
  }
  return c.json({ entry: buildEntry(current, mount, []) })
})
