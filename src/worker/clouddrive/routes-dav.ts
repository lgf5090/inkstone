/**
 * WebDAV access to the primary mount.
 *
 * The endpoint maps `/clouddrive/dav/<path>` onto the same D1 virtual path the rest of the file API
 * uses, so a DAV client sees exactly the tree the web UI sees. Authentication is either the user's
 * configured WebDAV username/password or `apikey` plus a `cdk_` key; there is no anonymous access.
 * When no account has enabled WebDAV the endpoint answers 503 instead of pretending to be a share.
 *
 * The implementation is deliberately a small, honest DAV server: Depth is limited to 0/1, LOCK is
 * stateless (tokens are handed out but not enforced), and a folder MOVE/COPY either completes or
 * answers a clear error rather than silently copying only part of a subtree.
 */
import { Hono, type Context } from 'hono'
import { categoryFor, filenameOf, foldedName, parentPathOf } from '@shared/clouddrive/model'
import type { CloudDriveSettings } from '@shared/clouddrive/settings'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { fromBase64 } from '../lib/encoding'
import { contentDisposition, parseByteRange } from '../lib/http-range'
import { newId } from '../lib/id'
import { verifyPassword } from '../lib/password'
import {
  assertWritable,
  initialsOf,
  parseName,
  parsePath,
  resolveEntry,
  resolveMount,
  type CloudDriveFileRow,
  type CloudDriveMountInfo,
} from './lib'
import { cloudDriveUsage, ensurePrimaryMount, readCloudDriveSettings } from './store'
import { authenticateApiKey, pathWithinPrefix } from './store-keys'
import { createFolder, trashEntries } from './store-files'

export const clouddriveDavRoutes = new Hono<AppBindings>()

const DAV_PREFIX = '/clouddrive/dav'
const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, LOCK, UNLOCK'
const MAX_COPY_ROWS = 5000
const MAX_PROPFIND_CHILDREN = 5000
const AUTH_REALM = 'Basic realm="CloudDrive"'

interface DavActor {
  userId: string
  pathPrefix: string
  keyId: string | null
}

type DavAuth =
  | { actor: DavActor; settings: CloudDriveSettings }
  | { response: Response }

function unauthorized(message = 'Authorization required'): Response {
  return new Response(message, {
    status: 401,
    headers: { 'WWW-Authenticate': AUTH_REALM, 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

function unavailable(): Response {
  return new Response('WebDAV is not configured', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

function parseBasic(header: string): { username: string; password: string } | null {
  const match = /^Basic\s+(.+)$/i.exec(header)
  if (!match) return null
  try {
    const decoded = new TextDecoder().decode(fromBase64(match[1]!))
    const separator = decoded.indexOf(':')
    if (separator < 0) return null
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
  } catch {
    return null
  }
}

/** Is any account advertising WebDAV? Only used to pick 503 over 401 for an unauthenticated probe. */
async function webdavConfigured(db: D1Database): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS found FROM CloudDrive_settings
      WHERE key = 'webdav.enabled' AND value IN ('true', '1')
      LIMIT 1`,
  ).first<{ found: number }>()
  return Boolean(row?.found)
}

/**
 * Settings are per user and a DAV request only carries a username, so the username lookup is the
 * one pre-authentication query in this module; every query after the owner is known binds `user_id`.
 */
async function usersWithWebdavUsername(db: D1Database, username: string): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT user_id FROM CloudDrive_settings
      WHERE key = 'webdav.username' AND value = ?
      ORDER BY user_id
      LIMIT 20`,
  ).bind(username).all<{ user_id: string }>()
  return (results ?? []).map((row) => row.user_id)
}

async function authenticateDav(c: Context<AppBindings>): Promise<DavAuth> {
  const header = c.req.header('authorization')
  if (!header) {
    if (!await webdavConfigured(c.env.DB)) return { response: unavailable() }
    return { response: unauthorized() }
  }
  const credentials = parseBasic(header)
  if (!credentials) return { response: unauthorized('Malformed authorization') }

  if (credentials.username === 'apikey') {
    const actor = await authenticateApiKey(c.env.DB, credentials.password, 'webdav')
    if (!actor) return { response: unauthorized('Invalid credentials') }
    const settings = await readCloudDriveSettings(c.env.DB, actor.userId)
    if (!settings.webdavEnabled) return { response: unavailable() }
    return {
      actor: { userId: actor.userId, pathPrefix: actor.pathPrefix, keyId: actor.keyId },
      settings,
    }
  }

  for (const userId of await usersWithWebdavUsername(c.env.DB, credentials.username)) {
    const settings = await readCloudDriveSettings(c.env.DB, userId)
    if (!settings.webdavEnabled || !settings.webdavPasswordHash) continue
    if (settings.webdavUsername !== credentials.username) continue
    if (!(await verifyPassword(credentials.password, settings.webdavPasswordHash))) continue
    return {
      actor: { userId, pathPrefix: '/', keyId: null },
      settings,
    }
  }

  // An empty configuration answers 503; a wrong password against a configured account is a 401.
  if (!await webdavConfigured(c.env.DB)) return { response: unavailable() }
  return { response: unauthorized('Invalid credentials') }
}

/** `c.req.path` is still percent-encoded; `parsePath` decodes it exactly once. */
function davPathOf(c: Context<AppBindings>): string {
  const raw = c.req.path
  if (raw === DAV_PREFIX || raw === `${DAV_PREFIX}/`) return '/'
  if (!raw.startsWith(`${DAV_PREFIX}/`)) throw ApiError.notFound('WebDAV path not found')
  return parsePath(raw.slice(DAV_PREFIX.length))
}

function assertPrefix(actor: DavActor, path: string): void {
  if (!pathWithinPrefix(actor.pathPrefix, path)) {
    throw new ApiError(403, 'forbidden', 'This API key is limited to another path')
  }
}

async function davMount(c: Context<AppBindings>, userId: string): Promise<CloudDriveMountInfo> {
  await ensurePrimaryMount(c.env.DB, userId)
  return await resolveMount(c.env.DB, userId, 'primary')
}

function requireBucket(c: Context<AppBindings>): R2Bucket {
  if (!c.env.FILES) {
    throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound on this deployment')
  }
  return c.env.FILES
}

async function optionalEntry(
  db: D1Database,
  userId: string,
  mountId: string,
  path: string,
): Promise<CloudDriveFileRow | null> {
  try {
    return await resolveEntry(db, userId, mountId, path)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** Create every missing folder on the way to `path`, the way a DAV PUT is allowed to. */
async function ensureFolderPath(
  c: Context<AppBindings>,
  userId: string,
  mountId: string,
  path: string,
  now: number,
): Promise<CloudDriveFileRow> {
  const segments = path.split('/').filter(Boolean)
  let parent = await resolveEntry(c.env.DB, userId, mountId, '/')
  for (const segment of segments) {
    const name = parseName(segment)
    const nextPath = parent.path === '/' ? `/${name}` : `${parent.path}/${name}`
    const existing = await optionalEntry(c.env.DB, userId, mountId, nextPath)
    if (existing) {
      if (existing.kind !== 'folder') throw ApiError.conflict('A file is in the way of the folder')
      parent = existing
      continue
    }
    const created = await createFolder(c.env.DB, userId, mountId, parent, name, now)
    if (created.entry) {
      parent = created.entry
      continue
    }
    // Another request may have created the same folder between the lookup and the insert.
    const raced = await resolveEntry(c.env.DB, userId, mountId, nextPath)
    if (raced.kind !== 'folder') throw ApiError.conflict('A file is in the way of the folder')
    parent = raced
  }
  return parent
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function hrefOf(path: string, collection: boolean): string {
  const suffix = path === '/'
    ? ''
    : path.split('/').filter(Boolean).map((segment) => encodeURIComponent(segment)).join('/')
  const href = path === '/' ? `${DAV_PREFIX}/` : `${DAV_PREFIX}/${suffix}`
  return collection && !href.endsWith('/') ? `${href}/` : href
}

function entityTagOf(row: CloudDriveFileRow): string {
  const raw = (row.etag ?? `${row.id}-${row.size}`).replace(/^W\//i, '').replace(/^"|"$/g, '')
  return `"${raw}"`
}

function matchesEntityTag(header: string, etag: string): boolean {
  const target = etag.replace(/^W\//i, '').replace(/^"|"$/g, '')
  return header.split(',').some((item) => {
    const value = item.trim().replace(/^W\//i, '').replace(/^"|"$/g, '')
    return value === '*' || value === target
  })
}

function propertyResponse(row: CloudDriveFileRow, now: number): string {
  const collection = row.kind === 'folder'
  const href = hrefOf(row.path, collection)
  const displayName = row.path === '/' ? '/' : row.name
  const modified = row.path === '/' ? now : row.modified_at || row.updated_at
  const properties = [
    `<D:displayname>${escapeXml(displayName)}</D:displayname>`,
    collection ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>',
    collection ? '' : `<D:getcontentlength>${row.size}</D:getcontentlength>`,
    collection ? '' : `<D:getcontenttype>${escapeXml(row.mime)}</D:getcontenttype>`,
    collection ? '' : `<D:getetag>${escapeXml(entityTagOf(row))}</D:getetag>`,
    `<D:getlastmodified>${new Date(modified).toUTCString()}</D:getlastmodified>`,
    '<D:supportedlock/>',
    '<D:lockdiscovery/>',
  ].join('')
  return `<D:response><D:href>${escapeXml(href)}</D:href><D:propstat><D:prop>${properties}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
}

function xmlResponse(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="utf-8"?>${body}`, {
    status: 207,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function mimeOf(header: string | undefined): string {
  const value = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)
    ? value
    : 'application/octet-stream'
}

async function childRows(
  db: D1Database,
  userId: string,
  mountId: string,
  parentId: string,
): Promise<CloudDriveFileRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM CloudDrive_files
      WHERE user_id = ? AND mount_id = ? AND parent_id = ? AND deleted_at IS NULL
        AND name_folded <> '.keep'
      ORDER BY kind DESC, name_folded, id
      LIMIT ${MAX_PROPFIND_CHILDREN}`,
  ).bind(userId, mountId, parentId).all<CloudDriveFileRow>()
  return results ?? []
}

clouddriveDavRoutes.on(['OPTIONS'], '*', () => new Response(null, {
  status: 200,
  headers: {
    Allow: ALLOW,
    DAV: '1',
    'MS-Author-Via': 'DAV',
    'Accept-Ranges': 'bytes',
    'Content-Length': '0',
  },
}))

clouddriveDavRoutes.on(['PROPFIND'], '*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const path = davPathOf(c)
  assertPrefix(auth.actor, path)
  const depth = (c.req.header('depth') ?? '1').trim().toLowerCase()
  if (depth === 'infinity') {
    return new Response('Depth infinity is not supported', { status: 403 })
  }
  if (depth !== '0' && depth !== '1') {
    return new Response('Depth must be 0 or 1', { status: 400 })
  }

  const mount = await davMount(c, auth.actor.userId)
  const row = await resolveEntry(c.env.DB, auth.actor.userId, mount.id, path)
  const now = Date.now()
  const responses = [propertyResponse(row, now)]
  if (depth === '1' && row.kind === 'folder') {
    const children = await childRows(c.env.DB, auth.actor.userId, mount.id, row.id)
    for (const child of children) responses.push(propertyResponse(child, now))
  }
  return xmlResponse(`<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`)
})

clouddriveDavRoutes.on(['GET', 'HEAD'], '*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const path = davPathOf(c)
  assertPrefix(auth.actor, path)
  const mount = await davMount(c, auth.actor.userId)
  const row = await resolveEntry(c.env.DB, auth.actor.userId, mount.id, path)
  if (row.kind !== 'file') return new Response('A collection cannot be downloaded', { status: 405 })
  if (row.storage_kind !== 'r2' || !row.storage_key) {
    throw new ApiError(503, 'clouddrive_mount_unavailable', 'This file is not on the primary mount')
  }
  const bucket = requireBucket(c)
  const etag = entityTagOf(row)
  const ifNoneMatch = c.req.header('if-none-match')
  if (ifNoneMatch && matchesEntityTag(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, no-store' } })
  }

  const rangeHeader = c.req.header('range')
  const range = rangeHeader ? parseByteRange(rangeHeader, row.size) : null
  const headers = new Headers({
    'Content-Type': row.mime || 'application/octet-stream',
    'Content-Disposition': contentDisposition(row.mime, row.name),
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': new Date(row.modified_at || row.uploaded_at).toUTCString(),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${row.size}`)
    headers.delete('Content-Disposition')
    return new Response(null, { status: 416, headers })
  }

  if (c.req.method === 'HEAD') {
    const object = await bucket.head(row.storage_key)
    if (!object) throw ApiError.notFound('File data is missing')
    if (range) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${row.size}`)
      headers.set('Content-Length', String(range.end - range.start + 1))
      return new Response(null, { status: 206, headers })
    }
    headers.set('Content-Length', String(row.size))
    return new Response(null, { status: 200, headers })
  }

  const object = await bucket.get(
    row.storage_key,
    range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined,
  )
  if (!object) throw ApiError.notFound('File data is missing')
  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${row.size}`)
    headers.set('Content-Length', String(range.end - range.start + 1))
    return new Response(object.body, { status: 206, headers })
  }
  headers.set('Content-Length', String(row.size))
  return new Response(object.body, { status: 200, headers })
})

clouddriveDavRoutes.put('*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const path = davPathOf(c)
  assertPrefix(auth.actor, path)
  if (path === '/') return new Response('A file name is required', { status: 400 })
  const mount = await davMount(c, auth.actor.userId)
  assertWritable(mount)
  const bucket = requireBucket(c)
  const userId = auth.actor.userId

  const name = parseName(filenameOf(path))
  const parentPath = parentPathOf(path)
  const now = Date.now()
  const parent = await ensureFolderPath(c, userId, mount.id, parentPath, now)
  const existing = await optionalEntry(c.env.DB, userId, mount.id, path)
  if (existing?.kind === 'folder') throw ApiError.conflict('A folder with that name already exists')

  const mime = mimeOf(c.req.header('content-type'))
  const category = categoryFor(name, mime)
  const declaredLength = Number(c.req.header('content-length'))
  const maxBytes = auth.settings.uploadMaxFileBytes
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw ApiError.tooLarge('The file exceeds the configured maximum size')
  }
  const quota = auth.settings.quotaDefaultBytes
  if (quota !== null && Number.isFinite(declaredLength)) {
    const usage = await cloudDriveUsage(c.env.DB, userId, c.env)
    if (usage.usedBytes + declaredLength > quota) {
      throw new ApiError(403, 'clouddrive_quota_exceeded', 'The account quota would be exceeded')
    }
  }

  const id = newId()
  const storageKey = `CloudDrive/${category}/${id}`
  const body = c.req.raw.body ?? new Uint8Array(0)
  let object: R2Object
  try {
    object = await bucket.put(storageKey, body, {
      httpMetadata: { contentType: mime },
      customMetadata: { fileId: id, category },
    })
  } catch (error) {
    // The upload never became a row; R2 owns whatever bytes a failed put may have left.
    console.warn('[clouddrive] WebDAV PUT failed before the row was written:', error)
    throw error
  }

  if (object.size > maxBytes) {
    await deleteObjectQuietly(bucket, storageKey)
    throw ApiError.tooLarge('The file exceeds the configured maximum size')
  }
  if (quota !== null) {
    const usage = await cloudDriveUsage(c.env.DB, userId, c.env)
    if (usage.usedBytes + object.size > quota) {
      await deleteObjectQuietly(bucket, storageKey)
      throw new ApiError(403, 'clouddrive_quota_exceeded', 'The account quota would be exceeded')
    }
  }

  const finalName = name
  const statements: D1PreparedStatement[] = []
  if (existing) {
    const batch = newId()
    statements.push(c.env.DB.prepare(
      `UPDATE CloudDrive_files SET deleted_at = ?, trash_batch = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    ).bind(now, batch, now, userId, existing.id))
    statements.push(c.env.DB.prepare(
      `UPDATE CloudDrive_shares SET revoked_at = ?
        WHERE user_id = ? AND file_id = ? AND revoked_at IS NULL`,
    ).bind(now, userId, existing.id))
  }
  statements.push(c.env.DB.prepare(
    `INSERT INTO CloudDrive_files
       (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
        category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
        starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
     VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'r2', ?, '{}', '',
             NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
  ).bind(
    id, userId, mount.id, parent.id, finalName, foldedName(finalName), initialsOf(finalName),
    path, category, mime, object.size, object.etag, storageKey, now, now, now, now,
  ))
  try {
    await c.env.DB.batch(statements)
  } catch (error) {
    // The row is the authority; an object whose row never landed would be an orphan.
    await deleteObjectQuietly(bucket, storageKey)
    throw error
  }

  return new Response(null, { status: existing ? 204 : 201, headers: { ETag: `"${object.etag}"` } })
})

/** Best-effort cleanup where the primary failure is already being reported. */
async function deleteObjectQuietly(bucket: R2Bucket, key: string): Promise<void> {
  try {
    await bucket.delete(key)
  } catch (error) {
    console.warn('[clouddrive] WebDAV cleanup could not delete an object:', key, error)
  }
}

clouddriveDavRoutes.delete('*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const path = davPathOf(c)
  assertPrefix(auth.actor, path)
  if (path === '/') return new Response('The root cannot be deleted', { status: 403 })
  const mount = await davMount(c, auth.actor.userId)
  assertWritable(mount)
  const row = await resolveEntry(c.env.DB, auth.actor.userId, mount.id, path)
  await trashEntries(c.env.DB, auth.actor.userId, mount.id, [row.id], Date.now())
  return new Response(null, { status: 204 })
})

clouddriveDavRoutes.on(['MKCOL'], '*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const path = davPathOf(c)
  assertPrefix(auth.actor, path)
  if (path === '/') return new Response('The root already exists', { status: 405 })
  const mount = await davMount(c, auth.actor.userId)
  assertWritable(mount)
  if (await optionalEntry(c.env.DB, auth.actor.userId, mount.id, path)) {
    return new Response('The collection already exists', { status: 405 })
  }
  const parentPath = parentPathOf(path)
  const parent = await optionalEntry(c.env.DB, auth.actor.userId, mount.id, parentPath)
  if (!parent || parent.kind !== 'folder') {
    return new Response('The parent collection does not exist', { status: 409 })
  }
  const created = await createFolder(
    c.env.DB,
    auth.actor.userId,
    mount.id,
    parent,
    parseName(filenameOf(path)),
    Date.now(),
  )
  if (!created.entry) return new Response('The collection already exists', { status: 405 })
  return new Response(null, { status: 201 })
})

/** Resolve the `Destination` header on the same origin to a virtual path. */
function destinationPath(c: Context<AppBindings>): string {
  const header = c.req.header('destination')
  if (!header) throw ApiError.badRequest('Destination is required')
  let url: URL
  try {
    url = new URL(header, c.req.url)
  } catch {
    throw ApiError.badRequest('Destination is not a valid URL')
  }
  if (url.origin !== new URL(c.req.url).origin) {
    throw new ApiError(502, 'clouddrive_mount_unavailable', 'Cross-origin WebDAV moves are not supported')
  }
  const pathname = url.pathname
  if (pathname !== DAV_PREFIX && !pathname.startsWith(`${DAV_PREFIX}/`)) {
    throw ApiError.badRequest('Destination is outside the WebDAV endpoint')
  }
  return pathname === DAV_PREFIX || pathname === `${DAV_PREFIX}/`
    ? '/'
    : parsePath(pathname.slice(DAV_PREFIX.length))
}

function overwriteRequested(c: Context<AppBindings>): boolean {
  const value = (c.req.header('overwrite') ?? 'T').trim().toUpperCase()
  if (value !== 'T' && value !== 'F') throw ApiError.badRequest('Overwrite must be T or F')
  return value === 'T'
}

function assertTransferable(source: CloudDriveFileRow, destination: string): void {
  if (destination === source.path) return
  if (source.kind === 'folder'
    && (destination === source.path || destination.startsWith(`${source.path}/`))) {
    throw ApiError.conflict('A folder cannot be moved or copied into itself')
  }
}

clouddriveDavRoutes.on(['MOVE'], '*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const sourcePath = davPathOf(c)
  const destination = destinationPath(c)
  assertPrefix(auth.actor, sourcePath)
  assertPrefix(auth.actor, destination)
  if (sourcePath === '/' || destination === '/') {
    return new Response('The root cannot be moved', { status: 403 })
  }
  const mount = await davMount(c, auth.actor.userId)
  assertWritable(mount)
  const userId = auth.actor.userId
  const source = await resolveEntry(c.env.DB, userId, mount.id, sourcePath)
  if (destination === sourcePath) return new Response(null, { status: 204 })
  assertTransferable(source, destination)

  const existing = await optionalEntry(c.env.DB, userId, mount.id, destination)
  if (existing && !overwriteRequested(c)) return new Response(null, { status: 412 })
  if (existing && existing.id === source.id) return new Response(null, { status: 204 })
  if (existing?.kind === 'folder' && sourcePath.startsWith(`${destination}/`)) {
    return new Response('The destination contains the source', { status: 409 })
  }

  const parentPath = parentPathOf(destination)
  const parent = await optionalEntry(c.env.DB, userId, mount.id, parentPath)
  if (!parent || parent.kind !== 'folder') {
    return new Response('The destination collection does not exist', { status: 409 })
  }
  const name = parseName(filenameOf(destination))
  const now = Date.now()
  const statements: D1PreparedStatement[] = []
  if (existing) {
    const batch = newId()
    statements.push(c.env.DB.prepare(
      `UPDATE CloudDrive_files SET deleted_at = ?, trash_batch = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    ).bind(now, batch, now, userId, existing.id))
    statements.push(c.env.DB.prepare(
      `UPDATE CloudDrive_shares SET revoked_at = ?
        WHERE user_id = ? AND file_id = ? AND revoked_at IS NULL`,
    ).bind(now, userId, existing.id))
  }
  if (source.kind === 'folder') {
    // `substr`, not `LIKE`: a folder named `100%` must not rewrite `100x`.
    statements.push(c.env.DB.prepare(
      `UPDATE CloudDrive_files
          SET path = ? || substr(path, length(?) + 1), updated_at = ?
        WHERE user_id = ? AND mount_id = ?
          AND substr(path, 1, length(?) + 1) = ? || '/'`,
    ).bind(destination, source.path, now, userId, mount.id, source.path, source.path))
  }
  statements.push(c.env.DB.prepare(
    `UPDATE CloudDrive_files
        SET parent_id = ?, name = ?, name_folded = ?, name_initials = ?, path = ?, updated_at = ?
      WHERE user_id = ? AND mount_id = ? AND id = ?`,
  ).bind(parent.id, name, foldedName(name), initialsOf(name), destination, now, userId, mount.id, source.id))
  await c.env.DB.batch(statements)
  return new Response(null, { status: existing ? 204 : 201 })
})

clouddriveDavRoutes.on(['COPY'], '*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const sourcePath = davPathOf(c)
  const destination = destinationPath(c)
  assertPrefix(auth.actor, sourcePath)
  assertPrefix(auth.actor, destination)
  if (sourcePath === '/' || destination === '/') {
    return new Response('The root cannot be copied', { status: 403 })
  }
  const mount = await davMount(c, auth.actor.userId)
  assertWritable(mount)
  const userId = auth.actor.userId
  const source = await resolveEntry(c.env.DB, userId, mount.id, sourcePath)
  assertTransferable(source, destination)

  const existing = await optionalEntry(c.env.DB, userId, mount.id, destination)
  if (existing && !overwriteRequested(c)) return new Response(null, { status: 412 })
  if (existing?.id === source.id) return new Response(null, { status: 204 })
  const parentPath = parentPathOf(destination)
  const parent = await optionalEntry(c.env.DB, userId, mount.id, parentPath)
  if (!parent || parent.kind !== 'folder') {
    return new Response('The destination collection does not exist', { status: 409 })
  }
  const name = parseName(filenameOf(destination))
  const now = Date.now()

  const sources: CloudDriveFileRow[] = [source]
  if (source.kind === 'folder') {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL
          AND substr(path, 1, length(?) + 1) = ? || '/'
        ORDER BY length(path), path, id`,
    ).bind(userId, mount.id, source.path, source.path).all<CloudDriveFileRow>()
    sources.push(...(results ?? []))
  }
  if (sources.length > MAX_COPY_ROWS) {
    throw ApiError.tooLarge(`A synchronous WebDAV copy is limited to ${MAX_COPY_ROWS} entries`)
  }

  const idMap = new Map<string, string>([[source.id, newId()]])
  const statements: D1PreparedStatement[] = []
  if (existing) {
    const batch = newId()
    statements.push(c.env.DB.prepare(
      `UPDATE CloudDrive_files SET deleted_at = ?, trash_batch = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    ).bind(now, batch, now, userId, existing.id))
    statements.push(c.env.DB.prepare(
      `UPDATE CloudDrive_shares SET revoked_at = ?
        WHERE user_id = ? AND file_id = ? AND revoked_at IS NULL`,
    ).bind(now, userId, existing.id))
  }
  statements.push(copyStatement(c.env.DB, source, idMap.get(source.id)!, parent.id, name, destination, now))
  for (const child of sources.slice(1)) {
    const childId = newId()
    idMap.set(child.id, childId)
    const childPath = `${destination}${child.path.slice(source.path.length)}`
    statements.push(copyStatement(
      c.env.DB,
      child,
      childId,
      idMap.get(child.parent_id) ?? parent.id,
      child.name,
      childPath,
      now,
    ))
  }
  // D1 refuses batches above about a hundred statements; a big copy may leave earlier chunks behind
  // if a later one fails, which is reported as a 500 rather than as a successful copy.
  for (let offset = 0; offset < statements.length; offset += 90) {
    await c.env.DB.batch(statements.slice(offset, offset + 90))
  }
  return new Response(null, { status: existing ? 204 : 201 })
})

function copyStatement(
  db: D1Database,
  source: CloudDriveFileRow,
  id: string,
  parentId: string,
  name: string,
  path: string,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO CloudDrive_files
       (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
        category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
        starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
  ).bind(
    id, source.user_id, source.mount_id, parentId, source.kind, name, foldedName(name),
    initialsOf(name), path, source.category, source.mime, source.size, source.etag, source.checksum,
    source.storage_kind,
    // A copy shares the immutable object with its source; only the last row may delete it.
    source.storage_key, source.metadata, source.color, now, now, now, source.modified_at,
  )
}

/**
 * The stateless lock Windows and macOS probe for. No token is enforced: this server has no
 * multi-writer guarantee to protect, and pretending otherwise would be worse than saying so here.
 */
clouddriveDavRoutes.on(['LOCK'], '*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const token = `opaquelocktoken:${crypto.randomUUID()}`
  const body = `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Lock-Token': `<${token}>`,
    },
  })
})

clouddriveDavRoutes.on(['UNLOCK'], '*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  return new Response(null, { status: 204 })
})

clouddriveDavRoutes.all('*', () => new Response('Method not allowed', {
  status: 405,
  headers: { Allow: ALLOW, 'Content-Type': 'text/plain; charset=utf-8' },
}))
