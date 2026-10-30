import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { contentDisposition, parseByteRange } from '../lib/http-range'
import { readJson } from '../lib/request'
import { parseFolderMeta, parsePath, type CloudDriveFileRow } from './lib'
import { distributedStream, fileParts } from './distributed'

export const clouddriveAclRoutes = new Hono<AppBindings>()

clouddriveAclRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

const BODY_LIMIT = 16 * 1024

interface AclFileRow {
  id: string
  user_id: string
  path: string
  kind: string
  name: string
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
    `SELECT id, user_id, path, kind, name, mime, size, etag, storage_kind, storage_key, metadata,
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

function hiddenBy(patterns: readonly string[], name: string): boolean {
  const folded = name.normalize('NFC').toLocaleLowerCase()
  return patterns.some((pattern) => {
    const foldedPattern = pattern.normalize('NFC').toLocaleLowerCase()
    const regex = new RegExp(`^${foldedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
    return regex.test(folded)
  })
}

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
  const meta = parseFolderMeta(folder.metadata)
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
      .filter((row) => !hiddenBy(meta.hiddenPatterns, row.name))
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
  const rangeHeader = c.req.header('range') ?? null
  const range = rangeHeader ? parseByteRange(rangeHeader, file.size) : null
  if (range === 'invalid') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } })
  const download = c.req.query('download') === '1'
  const headers = new Headers({
    'Content-Type': file.mime || 'application/octet-stream',
    'ETag': `"${file.etag ?? `${file.id}-${file.size}`}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': contentDisposition(file.mime, file.name),
  })
  if (download) headers.set('Content-Disposition', headers.get('Content-Disposition')!.replace(/^inline/, 'attachment'))
  const start = range ? range.start : 0
  const length = range ? range.end - range.start + 1 : file.size
  headers.set('Content-Length', String(length))
  if (range) headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${file.size}`)
  if (c.req.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers })
  if (file.storage_kind === 'distributed') {
    const parts = await fileParts(c.env.DB, ownerId, file.id)
    const total = parts.reduce((sum, part) => sum + part.size, 0)
    if (parts.length === 0 || total !== file.size) throw ApiError.notFound('File not found')
    const body = await distributedStream(c.env, c.env.DB, ownerId, parts, start, length)
    return new Response(body, { status: range ? 206 : 200, headers })
  }
  if (!file.storage_key || !c.env.FILES) throw ApiError.notFound('File not found')
  const object = range
    ? await c.env.FILES.get(file.storage_key, { range: { offset: range.start, length } })
    : await c.env.FILES.get(file.storage_key)
  if (!object) throw ApiError.notFound('File not found')
  return new Response(object.body, { status: range ? 206 : 200, headers })
})
