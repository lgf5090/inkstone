/**
 * WebDAV access to the primary mount.
 *
 * The endpoint maps `/clouddrive/dav/<path>` onto the same D1 virtual path the rest of the file API
 * uses, so a DAV client sees exactly the tree the web UI sees. Authentication is either the user's
 * configured WebDAV username/password or `apikey` plus a `cdk_` key; there is no anonymous access.
 * When no account has enabled WebDAV the endpoint answers 503 instead of pretending to be a share.
 *
 * The implementation is deliberately a small, honest DAV server: Depth is limited to 0/1, LOCK is a
 * class-2 write lock kept in `CloudDrive_dav_locks` and enforced by every mutating method until it
 * expires, and a folder MOVE/COPY either completes or answers a clear error rather than silently
 * copying only part of a subtree.
 */
import { Hono, type Context } from 'hono'
import { categoryFor, filenameOf, foldedName, parentPathOf } from '@shared/clouddrive/model'
import type { CloudDriveSettings } from '@shared/clouddrive/settings'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { fromBase64 } from '../lib/encoding'
import { contentDisposition } from '../lib/http-range'
import { newId } from '../lib/id'
import { verifyPassword } from '../lib/password'
import {
  assertWritable,
  deleteObjectQuietly,
  initialsOf,
  parseName,
  parsePath,
  resolveEntry,
  resolveMount,
  assertPasscodeAttemptsLeft,
  notePasscodeFailure,
  notePasscodeSuccess,
  passcodeThrottleKey,
  type CloudDriveFileRow,
  type CloudDriveMountInfo,
} from './lib'
import { cloudDriveUsage, ensurePrimaryMount, readCloudDriveSettings } from './store'
import { entityTagOf, headResponse, planContentResponse } from './content-response'
import { assertUnlockedMeta } from './routes-meta'
import { effectiveMeta, hiddenByPatterns, type EffectiveCloudDriveMeta } from './meta'
import { authenticateApiKey, pathWithinPrefix } from './store-keys'
import { createFolder, trashEntries } from './store-files'
import {
  activeLocks,
  blockingLock,
  createLock,
  isLockRequest,
  parseLockDepth,
  parseLockOwner,
  parseLockScope,
  parseLockTimeoutSeconds,
  presentedLockTokens,
  refreshLock,
  releaseLock,
  sweepExpiredLocks,
  lockCovers,
  type DavLock,
} from './dav-locks'
import {
  deleteExternalPath,
  externalCapacityBytes,
  externalDirectUrl,
  externalProxyLocation,
  listExternal,
  mkdirExternal,
  moveExternalPath,
  readExternal,
  writeExternalFile,
} from './external'

export const clouddriveDavRoutes = new Hono<AppBindings>()

const DAV_PREFIX = '/clouddrive/dav'
const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, LOCK, UNLOCK'
const MAX_COPY_ROWS = 5000
const MAX_PROPFIND_CHILDREN = 5000
const MAX_BUFFERED_EXTERNAL_WRITE = 64 * 1024 * 1024
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

  // Every branch below can spend a scrypt derivation, so one client gets one attempt budget for this
  // endpoint; a successful check clears it, and the lock answers 429 the way the rest of the app does.
  const throttleKey = passcodeThrottleKey('dav', credentials.username, c.req.raw)
  try {
    await assertPasscodeAttemptsLeft(c.env.DB, throttleKey)
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      const retryAfter = (error.details as { retryAfter?: number } | undefined)?.retryAfter ?? 60
      return { response: new Response('Too many attempts', {
        status: 429,
        headers: { 'Retry-After': String(retryAfter), 'Content-Type': 'text/plain; charset=utf-8' },
      }) }
    }
    throw error
  }
  let verified = false
  try {
    const answer = await davCredentials(c, credentials, throttleKey)
    verified = !('response' in answer)
    return answer
  } finally {
    if (!verified) await notePasscodeFailure(c.env.DB, throttleKey)
  }
}

async function davCredentials(
  c: Context<AppBindings>,
  credentials: { username: string; password: string },
  throttleKey: string,
): Promise<DavAuth> {
  if (credentials.username === 'apikey') {
    const actor = await authenticateApiKey(c.env.DB, credentials.password, 'webdav')
    if (!actor) return { response: unauthorized('Invalid credentials') }
    const settings = await readCloudDriveSettings(c.env.DB, actor.userId)
    if (!settings.webdavEnabled) return { response: unavailable() }
    await notePasscodeSuccess(c.env.DB, throttleKey)
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
    await notePasscodeSuccess(c.env.DB, throttleKey)
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

interface DavExternalMount {
  id: string
  name: string
  mountPath: string
  readOnly: boolean
  storageType: string
  apiKeyVisible: boolean
}

async function davExternalMounts(db: D1Database, userId: string): Promise<DavExternalMount[]> {
  const { results } = await db.prepare(
    `SELECT m.id, m.name, m.mount_path, m.read_only, s.type AS storage_type, s.api_key_visible
       FROM CloudDrive_mounts m
       JOIN CloudDrive_storages s ON s.user_id = m.user_id AND s.id = m.storage_id
      WHERE m.user_id = ?1 AND m.enabled = 1 AND m.storage_id != 'primary' AND s.status = 'enabled'
      ORDER BY m.sort_order, m.created_at, m.id`,
  ).bind(userId).all<{
    id: string
    name: string
    mount_path: string
    read_only: number
    storage_type: string
    api_key_visible: number
  }>()
  return (results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    mountPath: row.mount_path,
    readOnly: row.read_only === 1,
    storageType: row.storage_type,
    apiKeyVisible: row.api_key_visible === 1,
  }))
}

interface DavTarget {
  mount: CloudDriveMountInfo
  path: string
  external: boolean
}

async function davTarget(c: Context<AppBindings>, actor: DavActor, path: string): Promise<DavTarget> {
  await ensurePrimaryMount(c.env.DB, actor.userId)
  const first = path.split('/').filter(Boolean)[0]
  if (first) {
    const mounts = await davExternalMounts(c.env.DB, actor.userId)
    const hit = mounts.find((mount) => mount.mountPath === `/${first}`)
    if (hit) {
      if (actor.keyId && !hit.apiKeyVisible) throw ApiError.notFound('Mount not found')
      const mount = await resolveMount(c.env.DB, actor.userId, hit.id)
      const subPath = path === hit.mountPath ? '/' : path.slice(hit.mountPath.length)
      return { mount, path: subPath || '/', external: true }
    }
  }
  const mount = await resolveMount(c.env.DB, actor.userId, 'primary')
  return { mount, path, external: false }
}

function virtualPath(mount: CloudDriveMountInfo, path: string): string {
  if (mount.storageId === 'primary') return path
  return path === '/' ? mount.mountPath : `${mount.mountPath}${path}`
}

function requireBucket(c: Context<AppBindings>): R2Bucket {
  if (!c.env.FILES) {
    throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound on this deployment')
  }
  return c.env.FILES
}

/**
 * The folder lock and the hidden rules are one control, not a browser-only one: a directory the web
 * declines to list must not stay readable to a DAV client, and a name hidden from it must not
 * reappear here. The caller passes the directory that governs the path — the folder itself when a
 * collection is addressed, its parent when a file is.
 */
async function davFolderMeta(
  c: Context<AppBindings>,
  userId: string,
  mountId: string,
  path: string,
  cached?: Map<string, EffectiveCloudDriveMeta>,
): Promise<EffectiveCloudDriveMeta> {
  const found = cached?.get(path)
  if (found) {
    await assertUnlockedMeta(c, userId, mountId, found)
    return found
  }
  const meta = await effectiveMeta(c.env.DB, userId, mountId, path)
  await assertUnlockedMeta(c, userId, mountId, meta)
  cached?.set(path, meta)
  return meta
}

/**
 * One scan of the mount's metadata rows for the whole request. `effectiveMeta` reads every rule of
 * that mount to resolve a single path, so a PROPFIND that governs the addressed directory and its
 * children would otherwise pay for the same table twice or three times.
 */
function metaCache(): Map<string, EffectiveCloudDriveMeta> {
  return new Map()
}

/** Where a path lives, which is whose rules hide and lock it. */
function davContainer(path: string): string {
  return parentPathOf(path)
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

/**
 * The locks a client can see on one resource. Answering with an empty element while a write is
 * being held elsewhere is what made the old stateless LOCK a lie, so the rows are reported here.
 */
function lockDiscoveryXml(locks: DavLock[], path: string, now: number): string {
  const held = locks.filter((lock) => lockCovers(lock, path))
  if (held.length === 0) return '<D:lockdiscovery/>'
  const items = held.map((lock) => {
    const seconds = Math.max(0, Math.round((lock.expiresAt - now) / 1000))
    return [
      '<D:activelock>',
      '<D:locktype><D:write/></D:locktype>',
      `<D:lockscope><D:${lock.scope}/></D:lockscope>`,
      `<D:depth>${lock.depth}</D:depth>`,
      lock.owner ? `<D:owner>${escapeXml(lock.owner)}</D:owner>` : '',
      `<D:timeout>Second-${seconds}</D:timeout>`,
      `<D:locktoken><D:href>${escapeXml(lock.token)}</D:href></D:locktoken>`,
      `<D:lockroot><D:href>${escapeXml(hrefOf(lock.root, false))}</D:href></D:lockroot>`,
      '</D:activelock>',
    ].join('')
  }).join('')
  return `<D:lockdiscovery>${items}</D:lockdiscovery>`
}

function propertyResponse(row: CloudDriveFileRow, now: number, locks: DavLock[]): string {
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
    lockDiscoveryXml(locks, row.path, now),
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

/** A DAV error body, because a client parses this XML rather than reading the status alone. */
function davError(status: number, inner: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:">${inner}</D:error>`,
    {
      status,
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    },
  )
}

/** The `LOCK` answer: the lock in the body, and the token header the client has to keep. */
function lockResponse(lock: DavLock, issued: boolean): Response {
  const body = `<D:prop xmlns:D="DAV:">${lockDiscoveryXml([lock], lock.root, Date.now())}</D:prop>`
  const headers = new Headers({
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  // A refresh hands back the lock the caller already named, so it gets no new token.
  if (issued) headers.set('Lock-Token', `<${lock.token}>`)
  return new Response(`<?xml version="1.0" encoding="utf-8"?>${body}`, { status: 200, headers })
}

/** Tokens the client says it holds, from `If` and `Lock-Token`. */
function davTokens(c: Context<AppBindings>): string[] {
  return presentedLockTokens(c.req.header('if'), c.req.header('lock-token'))
}

/**
 * The 423 a mutating method must answer with when a lock covers the path, or null to let it run.
 * Checked on both ends of a MOVE and at the destination of a COPY, which is where a lock earns it.
 */
async function davLockBlocked(c: Context<AppBindings>, userId: string, mountId: string, path: string): Promise<Response | null> {
  const blocked = await blockingLock({
    db: c.env.DB,
    userId,
    mountId,
    path,
    tokens: davTokens(c),
    now: Date.now(),
  })
  return blocked ? davError(423, '<D:locked/>') : null
}

function externalProperty(
  path: string,
  name: string,
  kind: 'file' | 'folder',
  size: number,
  mime: string,
  modifiedAt: number,
  locks: DavLock[],
  lockPath: string,
): string {
  const collection = kind === 'folder'
  const href = hrefOf(path, collection)
  const properties = [
    `<D:displayname>${escapeXml(name)}</D:displayname>`,
    collection ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>',
    collection ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`,
    collection ? '' : `<D:getcontenttype>${escapeXml(mime || 'application/octet-stream')}</D:getcontenttype>`,
    collection ? '' : `<D:getetag>${escapeXml(`"${size}-${modifiedAt}"`)}</D:getetag>`,
    `<D:getlastmodified>${new Date(modifiedAt || Date.now()).toUTCString()}</D:getlastmodified>`,
    '<D:supportedlock/>',
    // A PROPFIND reports the virtual path, while locks are claimed inside the mount that owns them.
    lockDiscoveryXml(locks, lockPath, Date.now()),
  ].join('')
  return `<D:response><D:href>${escapeXml(href)}</D:href><D:propstat><D:prop>${properties}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
}

function externalMountProperty(mount: CloudDriveMountInfo, locks: DavLock[]): string {
  return externalProperty(mount.mountPath, mount.name, 'folder', 0, '', Date.now(), locks, '/')
}

async function externalEntry(
  c: Context<AppBindings>,
  mount: CloudDriveMountInfo,
  path: string,
): Promise<{ name: string; kind: 'file' | 'folder'; size: number; mime: string; modifiedAt: number } | null> {
  if (path === '/') return { name: mount.name, kind: 'folder', size: 0, mime: '', modifiedAt: Date.now() }
  const listing = await listExternal(c.env, c.env.DB, mount, parentPathOf(path))
  const name = filenameOf(path)
  return [...listing.folders, ...listing.files].find((entry) => entry.name === name) ?? null
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
    // Class 2 because a write lock is now real: it is stored, honoured, and reported.
    DAV: '1, 2',
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

  const target = await davTarget(c, auth.actor, path)
  const metas = metaCache()
  const now = Date.now()
  // One read of the lock table per mount touched by this listing, not one per row.
  const lockCache = new Map<string, DavLock[]>()
  const locksOf = async (mountId: string): Promise<DavLock[]> => {
    const hit = lockCache.get(mountId)
    if (hit) return hit
    const loaded = await activeLocks(c.env.DB, auth.actor.userId, mountId, now)
    lockCache.set(mountId, loaded)
    return loaded
  }
  if (target.external) {
    const entry = target.path === '/' ? null : await externalEntry(c, target.mount, target.path)
    if (target.path !== '/' && !entry) throw ApiError.notFound('File not found')
    const addressed = entry === null || entry.kind === 'folder' ? target.path : davContainer(target.path)
    const meta = await davFolderMeta(c, auth.actor.userId, target.mount.id, addressed, metas)
    if (entry && entry.kind === 'file' && hiddenByPatterns(filenameOf(target.path), meta.hidePatterns)) {
      throw ApiError.notFound('File not found')
    }
    const locks = await locksOf(target.mount.id)
    const responses = [target.path === '/'
      ? externalMountProperty(target.mount, locks)
      : externalProperty(
        virtualPath(target.mount, target.path),
        filenameOf(target.path),
        entry!.kind,
        entry!.size,
        entry!.mime,
        entry!.modifiedAt,
        locks,
        target.path,
      )]
    if (depth === '1') {
      const listing = await listExternal(c.env, c.env.DB, target.mount, target.path)
      for (const listed of [...listing.folders, ...listing.files]) {
        if (hiddenByPatterns(listed.name, meta.hidePatterns)) continue
        responses.push(externalProperty(
          virtualPath(target.mount, listed.path),
          listed.name,
          listed.kind,
          listed.size,
          listed.mime,
          listed.modifiedAt,
          locks,
          listed.path,
        ))
      }
    }
    return xmlResponse(`<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`)
  }

  const row = await resolveEntry(c.env.DB, auth.actor.userId, target.mount.id, target.path)
  const meta = await davFolderMeta(
    c, auth.actor.userId, target.mount.id, row.kind === 'folder' ? row.path : davContainer(row.path), metas,
  )
  if (row.kind === 'file' && hiddenByPatterns(row.name, meta.hidePatterns)) {
    throw ApiError.notFound('File not found')
  }
  const locks = await locksOf(target.mount.id)
  const responses = [propertyResponse(row, now, locks)]
  if (depth === '1' && row.kind === 'folder') {
    const children = (await childRows(c.env.DB, auth.actor.userId, target.mount.id, row.id))
      .filter((child) => !hiddenByPatterns(child.name, meta.hidePatterns))
    const mounts = target.path === '/'
      ? (await davExternalMounts(c.env.DB, auth.actor.userId)).filter((mount) => !auth.actor.keyId || mount.apiKeyVisible)
      : []
    const mountPaths = new Set(mounts.map((mount) => mount.mountPath))
    for (const child of children) {
      if (!mountPaths.has(child.path)) responses.push(propertyResponse(child, now, locks))
    }
    for (const mount of mounts) {
      responses.push(externalProperty(mount.mountPath, mount.name, 'folder', 0, '', now, await locksOf(mount.id), '/'))
    }
  }
  return xmlResponse(`<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`)
})

clouddriveDavRoutes.on(['GET', 'HEAD'], '*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const path = davPathOf(c)
  assertPrefix(auth.actor, path)
  const target = await davTarget(c, auth.actor, path)
  await davFolderMeta(c, auth.actor.userId, target.mount.id, davContainer(target.path))
  if (target.external) {
    if (target.path === '/') return new Response('A collection cannot be downloaded', { status: 405 })
    if (!target.mount.webProxy) {
      const location = target.mount.webdavPolicy === '302_redirect'
        ? await externalDirectUrl(c.env, c.env.DB, target.mount, target.path)
        : target.mount.webdavPolicy === 'use_proxy_url'
          ? await externalProxyLocation(c.env, c.env.DB, target.mount, target.path)
          : null
      if (location) return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } })
    }
    const response = await readExternal(c.env, c.env.DB, target.mount, target.path, c.req.header('range') ?? null)
    if (!response) throw ApiError.notFound('File not found')
    const headers = new Headers({
      'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
      'Content-Disposition': contentDisposition(response.headers.get('content-type') ?? 'application/octet-stream', filenameOf(target.path)),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = response.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (c.req.method === 'HEAD') {
      await response.body?.cancel()
      return new Response(null, { status: response.status, headers })
    }
    return new Response(response.body, { status: response.status, headers })
  }
  const row = await resolveEntry(c.env.DB, auth.actor.userId, target.mount.id, target.path)
  if (row.kind !== 'file') return new Response('A collection cannot be downloaded', { status: 405 })
  if (row.storage_kind !== 'r2' || !row.storage_key) {
    throw new ApiError(503, 'clouddrive_mount_unavailable', 'This file is not on the primary mount')
  }
  const bucket = requireBucket(c)
  const planned = planContentResponse({
    method: c.req.method,
    rangeHeader: c.req.header('range'),
    ifNoneMatch: c.req.header('if-none-match'),
    download: false,
    file: {
      id: row.id,
      size: row.size,
      mime: row.mime,
      name: row.name,
      etag: row.etag,
      lastModified: row.modified_at || row.uploaded_at,
    },
  })
  if (planned.kind === 'respond') return planned.response
  if (planned.kind === 'head') {
    if (!await bucket.head(row.storage_key)) throw ApiError.notFound('File data is missing')
    return headResponse(planned)
  }
  const object = await bucket.get(
    row.storage_key,
    planned.status === 206 ? { range: { offset: planned.offset, length: planned.length } } : undefined,
  )
  if (!object) throw ApiError.notFound('File data is missing')
  return new Response(object.body, { status: planned.status, headers: planned.headers })
})

clouddriveDavRoutes.put('*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const path = davPathOf(c)
  assertPrefix(auth.actor, path)
  if (path === '/') return new Response('A file name is required', { status: 400 })
  const target = await davTarget(c, auth.actor, path)
  const blocked = await davLockBlocked(c, auth.actor.userId, target.mount.id, target.path)
  if (blocked) return blocked
  await davFolderMeta(c, auth.actor.userId, target.mount.id, davContainer(target.path))
  if (target.external) {
    if (target.path === '/') return new Response('A file name is required', { status: 400 })
    if (target.mount.readOnly) throw new ApiError(403, 'clouddrive_read_only', 'This mount is read-only')
    const declared = Number(c.req.header('content-length'))
    // A write to an external driver is buffered whole: the S3 signature and the WebDAV PUT both need
    // the body in hand, so it is the isolate's memory that bounds this path, not the owner's upload
    // ceiling. Anything larger belongs to the chunked upload session, which streams part by part.
    const buffered = Math.max(0, Math.min(auth.settings.uploadMaxFileBytes, MAX_BUFFERED_EXTERNAL_WRITE))
    if (Number.isFinite(declared) && declared > buffered) {
      throw ApiError.tooLarge(`A WebDAV write to an external mount holds at most ${buffered} bytes`)
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength > buffered) throw ApiError.tooLarge(`A WebDAV write to an external mount holds at most ${buffered} bytes`)
    const capacity = await externalCapacityBytes(c.env.DB, target.mount)
    // Same rule as the web upload: the whole-mount walk happens in the folder-size view and the
    // background job, not in front of every write.
    if (capacity !== null && bytes.byteLength > capacity) {
      throw new ApiError(403, 'clouddrive_quota_exceeded', 'This file is larger than the storage capacity limit')
    }
    const parent = parentPathOf(target.path)
    if (parent !== '/') await mkdirExternal(c.env, c.env.DB, target.mount, parent)
    await writeExternalFile(c.env, c.env.DB, target.mount, target.path, bytes, mimeOf(c.req.header('content-type')))
    return new Response(null, { status: 201 })
  }
  const mount = target.mount
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

clouddriveDavRoutes.delete('*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const path = davPathOf(c)
  assertPrefix(auth.actor, path)
  if (path === '/') return new Response('The root cannot be deleted', { status: 403 })
  const target = await davTarget(c, auth.actor, path)
  const blocked = await davLockBlocked(c, auth.actor.userId, target.mount.id, target.path)
  if (blocked) return blocked
  await davFolderMeta(c, auth.actor.userId, target.mount.id, davContainer(target.path))
  if (target.external) {
    if (target.path === '/') return new Response('A mount cannot be deleted', { status: 403 })
    if (target.mount.readOnly) throw new ApiError(403, 'clouddrive_read_only', 'This mount is read-only')
    await deleteExternalPath(c.env, c.env.DB, target.mount, target.path)
    return new Response(null, { status: 204 })
  }
  assertWritable(target.mount)
  const row = await resolveEntry(c.env.DB, auth.actor.userId, target.mount.id, target.path)
  await trashEntries(c.env.DB, auth.actor.userId, target.mount.id, [row.id], Date.now())
  return new Response(null, { status: 204 })
})

clouddriveDavRoutes.on(['MKCOL'], '*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const path = davPathOf(c)
  assertPrefix(auth.actor, path)
  if (path === '/') return new Response('The root already exists', { status: 405 })
  const target = await davTarget(c, auth.actor, path)
  const blocked = await davLockBlocked(c, auth.actor.userId, target.mount.id, target.path)
  if (blocked) return blocked
  await davFolderMeta(c, auth.actor.userId, target.mount.id, davContainer(target.path))
  if (target.external) {
    if (target.path === '/') return new Response('The mount already exists', { status: 405 })
    if (target.mount.readOnly) throw new ApiError(403, 'clouddrive_read_only', 'This mount is read-only')
    if (await externalEntry(c, target.mount, target.path)) return new Response('The collection already exists', { status: 405 })
    await mkdirExternal(c.env, c.env.DB, target.mount, target.path)
    return new Response(null, { status: 201 })
  }
  const mount = target.mount
  assertWritable(mount)
  if (await optionalEntry(c.env.DB, auth.actor.userId, mount.id, target.path)) {
    return new Response('The collection already exists', { status: 405 })
  }
  const parentPath = parentPathOf(target.path)
  const parent = await optionalEntry(c.env.DB, auth.actor.userId, mount.id, parentPath)
  if (!parent || parent.kind !== 'folder') {
    return new Response('The parent collection does not exist', { status: 409 })
  }
  const created = await createFolder(
    c.env.DB,
    auth.actor.userId,
    mount.id,
    parent,
    parseName(filenameOf(target.path)),
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
  const sourceTarget = await davTarget(c, auth.actor, sourcePath)
  const destinationTarget = await davTarget(c, auth.actor, destination)
  const blocked = await davLockBlocked(c, auth.actor.userId, sourceTarget.mount.id, sourceTarget.path)
    ?? await davLockBlocked(c, auth.actor.userId, destinationTarget.mount.id, destinationTarget.path)
  if (blocked) return blocked
  await davFolderMeta(c, auth.actor.userId, sourceTarget.mount.id, davContainer(sourceTarget.path))
  await davFolderMeta(c, auth.actor.userId, destinationTarget.mount.id, davContainer(destinationTarget.path))
  if (sourceTarget.external || destinationTarget.external) {
    if (!sourceTarget.external || !destinationTarget.external || sourceTarget.mount.id !== destinationTarget.mount.id) {
      return new Response('Cross-mount WebDAV moves are not supported', { status: 502 })
    }
    if (sourceTarget.path === '/' || destinationTarget.path === '/') {
      return new Response('A mount cannot be moved', { status: 403 })
    }
    if (sourceTarget.mount.readOnly) throw new ApiError(403, 'clouddrive_read_only', 'This mount is read-only')
    const existing = await externalEntry(c, sourceTarget.mount, destinationTarget.path)
    if (existing && !overwriteRequested(c)) return new Response(null, { status: 412 })
    await moveExternalPath(c.env, c.env.DB, sourceTarget.mount, sourceTarget.path, destinationTarget.path)
    return new Response(null, { status: existing ? 204 : 201 })
  }
  const mount = sourceTarget.mount
  assertWritable(mount)
  const userId = auth.actor.userId
  const source = await resolveEntry(c.env.DB, userId, mount.id, sourceTarget.path)
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
  const sourceTarget = await davTarget(c, auth.actor, sourcePath)
  const destinationTarget = await davTarget(c, auth.actor, destination)
  const blocked = await davLockBlocked(c, auth.actor.userId, destinationTarget.mount.id, destinationTarget.path)
  if (blocked) return blocked
  await davFolderMeta(c, auth.actor.userId, sourceTarget.mount.id, davContainer(sourceTarget.path))
  await davFolderMeta(c, auth.actor.userId, destinationTarget.mount.id, davContainer(destinationTarget.path))
  if (sourceTarget.external || destinationTarget.external) {
    return new Response('COPY on external mounts is not supported', { status: 501 })
  }
  const mount = sourceTarget.mount
  assertWritable(mount)
  const userId = auth.actor.userId
  const source = await resolveEntry(c.env.DB, userId, mount.id, sourceTarget.path)
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
 * Write locks: stored, enforced by every mutating method until they expire, and reported by
 * PROPFIND. A body carrying `<D:lockinfo>` takes a lock; an empty body refreshes one the caller
 * already holds. `Depth: 0` locks a single resource, anything else the whole subtree under it.
 */
clouddriveDavRoutes.on(['LOCK'], '*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const path = davPathOf(c)
  assertPrefix(auth.actor, path)
  const target = await davTarget(c, auth.actor, path)
  if (target.mount.readOnly) throw new ApiError(403, 'clouddrive_read_only', 'This mount is read-only')
  const now = Date.now()
  const tokens = davTokens(c)
  const xml = await c.req.text()
  const seconds = parseLockTimeoutSeconds(c.req.header('timeout'))
  await sweepExpiredLocks(c.env.DB, auth.actor.userId, target.mount.id, now)

  if (!isLockRequest(xml)) {
    const refreshed = await refreshLock({
      db: c.env.DB,
      userId: auth.actor.userId,
      mountId: target.mount.id,
      root: target.path,
      token: tokens[0] ?? '',
      seconds,
      now,
    })
    return refreshed ? lockResponse(refreshed, false) : davError(423, '<D:no-lock/>')
  }

  const outcome = await createLock({
    db: c.env.DB,
    userId: auth.actor.userId,
    mountId: target.mount.id,
    root: target.path,
    scope: parseLockScope(xml),
    depth: parseLockDepth(c.req.header('depth')),
    owner: parseLockOwner(xml),
    seconds,
    now,
    tokens,
  })
  if (outcome.status === 'conflict') return davError(423, '<D:no-lock/>')
  if (outcome.status === 'limit') {
    return davError(429, '<error>This mount already holds as many locks as it allows.</error>')
  }
  return lockResponse(outcome.lock, true)
})

clouddriveDavRoutes.on(['UNLOCK'], '*', async (c) => {
  const auth = await authenticateDav(c)
  if ('response' in auth) return auth.response
  const path = davPathOf(c)
  assertPrefix(auth.actor, path)
  const target = await davTarget(c, auth.actor, path)
  const tokens = davTokens(c)
  const released = tokens.length > 0 && await releaseLock({
    db: c.env.DB,
    userId: auth.actor.userId,
    mountId: target.mount.id,
    root: target.path,
    token: tokens[0],
    now: Date.now(),
  })
  // A token that names no lock on this resource is a conflict, not a success that changed nothing.
  return released ? new Response(null, { status: 204 }) : davError(409, '<D:no-lock/>')
})

clouddriveDavRoutes.all('*', () => new Response('Method not allowed', {
  status: 405,
  headers: { Allow: ALLOW, 'Content-Type': 'text/plain; charset=utf-8' },
}))
