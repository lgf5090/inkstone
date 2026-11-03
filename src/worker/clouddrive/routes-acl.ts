import { Hono, type Context } from 'hono'
import { autoSuffixName, childPath, foldedName, parentPathOf } from '@shared/clouddrive/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { readJson } from '../lib/request'
import {
  assertWritable,
  buildEntry,
  chunkedBatch,
  initialsOf,
  parseFolderMeta,
  parsePath,
  resolveEntry,
  resolveMount,
  type CloudDriveFileRow,
} from './lib'
import { distributedStream, fileParts } from './distributed'
import { effectiveMeta, hiddenByPatterns } from './meta'
import { cloudDriveUsage } from './store'
import { planContentResponse, headResponse } from './content-response'
import { assertMetaAccess } from './routes-meta'

export const clouddriveAclRoutes = new Hono<AppBindings>()

clouddriveAclRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

const BODY_LIMIT = 16 * 1024

interface AclFileRow {
  id: string
  user_id: string
  mount_id: string
  parent_id: string
  path: string
  kind: string
  name: string
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

async function subtreeOf(c: Context<AppBindings>, ownerId: string, root: AclFileRow): Promise<AclFileRow[]> {
  const rows: AclFileRow[] = []
  let frontier = [root.id]
  while (frontier.length > 0) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, user_id, mount_id, parent_id, path, kind, name, category, mime, size, etag, storage_kind, storage_key, metadata,
              uploaded_at, modified_at
         FROM CloudDrive_files WHERE user_id = ? AND deleted_at IS NULL AND parent_id IN (${frontier.map(() => '?').join(',')})
        ORDER BY kind DESC, name_folded LIMIT ?`,
    ).bind(ownerId, ...frontier, MAX_SAVE_ROWS + 1).all<AclFileRow>()
    const children = results ?? []
    if (rows.length + children.length > MAX_SAVE_ROWS) {
      throw ApiError.tooLarge(`A saved folder holds at most ${MAX_SAVE_ROWS} items`)
    }
    rows.push(...children)
    frontier = children.filter((row) => row.kind === 'folder').map((row) => row.id)
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
        AND f.deleted_at IS NULL
        AND (f.id = ?3 OR (f.kind = 'folder' AND (f.path = ?4 OR substr(?4, 1, length(f.path) + 1) = f.path || '/')))
      LIMIT 1`,
  ).bind(ownerId, granteeId, fileId, target.path).first<{ hit: number }>()
  return grant ? target : null
}

clouddriveAclRoutes.get('/acl/grants', async (c) => {
  const fileId = c.req.query('fileId') ?? ''
  const file = await ownerFile(c, fileId)
  const { results } = await c.env.DB.prepare(
    `SELECT a.grantee_id, a.created_at, u.username, u.name
       FROM CloudDrive_acl a
       JOIN users u ON u.id = a.grantee_id
      WHERE a.owner_id = ? AND a.file_id = ? AND a.revoked_at IS NULL
      ORDER BY a.created_at`,
  ).bind(userIdOf(c), file.id).all<{ grantee_id: string; created_at: number; username: string; name: string }>()
  return c.json({
    grants: (results ?? []).map((row) => ({
      granteeId: row.grantee_id,
      username: row.username,
      name: row.name,
      createdAt: row.created_at,
    })),
  })
})

clouddriveAclRoutes.post('/acl/grants', async (c) => {
  const ownerId = userIdOf(c)
  const body = await readJson<{ fileId?: unknown; username?: unknown }>(c, BODY_LIMIT)
  if (typeof body.fileId !== 'string') throw ApiError.badRequest('fileId is required')
  const file = await ownerFile(c, body.fileId)
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  if (!username) throw ApiError.badRequest('A username is required')
  const grantee = await c.env.DB.prepare(
    `SELECT id, username, name FROM users WHERE lower(username) = lower(?) LIMIT 1`,
  ).bind(username).first<{ id: string; username: string; name: string }>()
  if (!grantee) throw ApiError.notFound('No account uses that username')
  if (grantee.id === ownerId) throw ApiError.badRequest('You already own this item')
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_acl (owner_id, file_id, grantee_id, created_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, NULL)
     ON CONFLICT(owner_id, file_id, grantee_id) DO UPDATE SET created_at = excluded.created_at, revoked_at = NULL`,
  ).bind(ownerId, file.id, grantee.id, now).run()
  return c.json({
    grant: { granteeId: grantee.id, username: grantee.username, name: grantee.name, createdAt: now },
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
  const { results } = await c.env.DB.prepare(
    `SELECT a.owner_id, a.file_id, a.created_at, f.name, f.path, f.kind, f.size, f.mime,
            f.modified_at, u.username AS owner_username, u.name AS owner_name
       FROM CloudDrive_acl a
       JOIN CloudDrive_files f ON f.user_id = a.owner_id AND f.id = a.file_id AND f.deleted_at IS NULL
       JOIN users u ON u.id = a.owner_id
      WHERE a.grantee_id = ? AND a.revoked_at IS NULL
      ORDER BY a.created_at DESC`,
  ).bind(userIdOf(c)).all<{
    owner_id: string
    file_id: string
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
  return c.json({
    shared: (results ?? []).map((row) => ({
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
      sharedAt: row.created_at,
    })),
  })
})

clouddriveAclRoutes.get('/acl/shared/:ownerId/:fileId/list', async (c) => {
  const ownerId = c.req.param('ownerId')
  const fileId = c.req.param('fileId')
  const target = await aclAllows(c, ownerId, fileId, userIdOf(c))
  if (!target) throw ApiError.notFound('File not found')
  if (target.kind !== 'folder') throw ApiError.badRequest('This item is not a folder')
  const requested = parsePath(c.req.query('path') ?? target.path)
  if (requested !== target.path && !requested.startsWith(`${target.path}/`)) {
    throw ApiError.forbidden('The path is outside the shared folder')
  }
  const folder = requested === target.path
    ? target
    : await c.env.DB.prepare(
      `SELECT * FROM CloudDrive_files WHERE user_id = ? AND path = ? AND kind = 'folder' AND deleted_at IS NULL`,
    ).bind(ownerId, requested).first<CloudDriveFileRow>()
  if (!folder) throw ApiError.notFound('Folder not found')
  // The drive's folder password is an access boundary here too: a grantee who was handed a folder
  // cannot list what the owner later locked, and the same `hidePatterns` rule the owner's own
  // listing applies decides which names the directory shows.
  await assertMetaAccess(c, ownerId, folder.mount_id, requested)
  const meta = await effectiveMeta(c.env.DB, ownerId, folder.mount_id, requested)
  const folderMeta = parseFolderMeta(folder.metadata)
  const { results } = await c.env.DB.prepare(
    `SELECT id, user_id, path, kind, name, mime, size, etag, storage_kind, storage_key, metadata,
            uploaded_at, modified_at
       FROM CloudDrive_files WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL
       ORDER BY kind DESC, name_folded LIMIT 500`,
  ).bind(ownerId, folder.id).all<AclFileRow>()
  return c.json({
    ownerId,
    path: requested,
    entries: (results ?? [])
      .filter((row) => !hiddenByPatterns(row.name, [...meta.hidePatterns, ...folderMeta.hiddenPatterns]))
      .map((row) => ({
        ownerId,
        fileId: row.id,
        name: row.name,
        path: row.path,
        kind: row.kind,
        size: row.size,
        mime: row.mime,
        modifiedAt: row.modified_at,
      })),
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
