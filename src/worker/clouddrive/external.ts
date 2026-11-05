/** Read-only browsing and byte reads for the external storage drivers. */
import { AwsClient } from 'aws4fetch'
import { categoryFor, extensionOf, type CloudDriveEntry } from '@shared/clouddrive/model'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { decryptCloudDriveCredentials, encryptCloudDriveCredentials } from '../lib/crypto'
import { checkTarget } from '../lib/outbound'
import type { CloudDriveMountInfo } from './lib'
import { s3RequestUrl } from './storage-urls'
import { createStorageDriver } from './drivers/factory'
import { rethrowDriver } from './drivers/errors'

function driverMountContext(mount: CloudDriveMountInfo): { id: string; mountPath: string; signExpires?: number } {
  return {
    id: mount.id,
    mountPath: mount.mountPath,
    ...(typeof mount.signExpires === 'number' ? { signExpires: mount.signExpires } : {}),
  }
}

interface StorageRow {
  id: string
  user_id: string
  type: string
  config: string
  credentials: string
}

interface DriverEntry {
  name: string
  kind: 'folder' | 'file'
  size: number
  modifiedAt: number
  /** A driver-native item id used to read the entry without resolving its display path again. */
  ref?: string
}

/** One directory's worth of driver entries, plus whether the driver had more than the ceiling allows. */
interface DriverList {
  entries: DriverEntry[]
  truncated: boolean
}

export interface ExternalListing {
  mountId: string
  path: string
  folders: CloudDriveEntry[]
  files: CloudDriveEntry[]
  cursor: null
  total: null
  /** True when the driver had more names than one listing may return. */
  foldersTruncated: boolean
}

const EXTERNAL_PREFIX = 'x'
const MAX_DRIVER_ENTRIES = 5000
/** How many `list-type=2` pages one S3 folder may cost before the listing gives up. */
const S3_LIST_PAGES = 20

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch (error) {
    console.warn('[inkstone] CloudDrive could not cancel an unused response body', error)
  }
}

export function externalEntryId(mountId: string, path: string, ref?: string | null): string {
  const payload = ref ? `${mountId}\0${path}\0${ref}` : `${mountId}\0${path}`
  return `${EXTERNAL_PREFIX}${base64Url(new TextEncoder().encode(payload))}`
}

export function parseExternalEntryId(id: string): { mountId: string; path: string; ref: string | null } | null {
  if (!id.startsWith(EXTERNAL_PREFIX)) return null
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(id.slice(EXTERNAL_PREFIX.length)))
    const [mountId, rawPath, ...rest] = decoded.split('\0')
    const path = rawPath || '/'
    if (!mountId || !safeExternalPath(path)) return null
    return { mountId, path, ref: rest.length > 0 && rest.join('\0') ? rest.join('\0') : null }
  } catch {
    return null
  }
}

function safeSegment(value: string): boolean {
  if (value === '.' || value === '..') return false
  if (value.includes('/') || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return false
  return true
}

function safeExternalPath(path: string): boolean {
  if (!path.startsWith('/')) return false
  for (const raw of path.split('/')) {
    if (!raw) continue
    let segment = raw
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return false
    }
    if (!safeSegment(segment)) return false
  }
  return true
}

/**
 * Per-isolate listing cache and request coalescing.
 *
 * OpenList deduplicates concurrent listings of the same directory so one page view cannot fan out
 * into several upstream requests. The mount's `cache_ttl` turns that into a short-lived cache as
 * well: an external driver is queried again only after the window the reader configured. The cache
 * never crosses isolates, so it is a saving, not a consistency promise; a write clears the mount's
 * entries in the isolate that performed it.
 */
interface CachedListing {
  expires: number
  value: ExternalListing
}

const LISTING_CACHE_MAX = 32
const LISTING_CACHE_MAX_ENTRIES = 2000
const listingCache = new Map<string, CachedListing>()
const listingInflight = new Map<string, Promise<ExternalListing>>()

function listingKey(mount: CloudDriveMountInfo, path: string): string {
  return `${mount.storageId}\0${mount.id}\0${path}`
}

export function invalidateExternalListing(mountId?: string): void {
  if (!mountId) {
    listingCache.clear()
    return
  }
  for (const key of listingCache.keys()) {
    if (key.includes(`\0${mountId}\0`)) listingCache.delete(key)
  }
}

async function loadExternal(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  path: string,
): Promise<ExternalListing> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The mount configuration is missing')
  const listed = await listStorage(env, db, mount, storage, path)
  const entries = listed.entries.filter((entry) => safeSegment(entry.name))
  const folders = entries.filter((entry) => entry.kind === 'folder').map((entry) => toEntry(mount, path, entry))
  const files = entries.filter((entry) => entry.kind === 'file').map((entry) => toEntry(mount, path, entry))
  return { mountId: mount.id, path, folders, files, cursor: null, total: null, foldersTruncated: listed.truncated }
}

export async function listExternal(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  path: string,
): Promise<ExternalListing> {
  const key = listingKey(mount, path)
  const ttl = Math.max(0, mount.cacheTtl ?? 0)
  if (ttl > 0) {
    const cached = listingCache.get(key)
    if (cached && cached.expires > Date.now()) return cached.value
  }
  const running = listingInflight.get(key)
  if (running) return await running

  const pending = loadExternal(env, db, mount, path)
    .then((value) => {
      if (ttl > 0) {
        const entries = value.folders.length + value.files.length
        // A pathologically large listing is served but not kept: one cached page must not hold
        // millions of objects for every reader in this isolate.
        if (entries <= LISTING_CACHE_MAX_ENTRIES) {
          if (listingCache.size >= LISTING_CACHE_MAX) {
            const oldest = listingCache.keys().next().value
            if (oldest !== undefined) listingCache.delete(oldest)
          }
          listingCache.set(key, { expires: Date.now() + ttl * 1000, value })
        }
      }
      return value
    })
    .finally(() => listingInflight.delete(key))
  listingInflight.set(key, pending)
  return await pending
}

export async function readExternal(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  path: string,
  range: string | null,
  ref: string | null = null,
): Promise<Response | null> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The mount configuration is missing')
  return await readStorage(env, db, mount, storage, path, range, ref)
}

export async function externalDirectUrl(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  path: string,
): Promise<string | null> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage) return null
  const driver = await createStorageDriver(env, storage, driverMountContext(mount))
  if (driver) {
    try {
      return driver.directLink ? await driver.directLink(path) : null
    } catch (error) {
      rethrowDriver(error)
    }
  }
  if (storage.type !== 's3') return null
  const config = configOf(storage)
  const key = joinPath(String(config.rootPath ?? ''), path)
  const customHost = stringValue(config.customHost)
  if (customHost) {
    // The browser is told to fetch this address, so it goes through the same guard as a request the
    // worker would make itself: a stored 127.0.0.1 would otherwise turn a share link into a probe.
    const redirect = checkTarget(customHost)
    if (!redirect.url) return null
    const base = `${redirect.url.origin}${redirect.url.pathname.replace(/\/$/, '')}`
    return `${base}/${encodeKey(key)}`
  }
  const target = checkTarget(String(config.endpoint ?? ''))
  if (!target.url) return null
  const credentials = await credentialsOf(env, storage)
  if (!credentials.accessKeyId || !credentials.secretAccessKey) return null
  const aws = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: String(config.region ?? 'auto'),
    service: 's3',
  })
  const url = s3RequestUrl(target.url, config, key)
  const expires = Math.min(86_400, Math.max(60, Math.round(mount.signExpires ?? 300)))
  url.searchParams.set('X-Amz-Expires', String(expires))
  const signed = await aws.sign(url.toString(), { method: 'GET', aws: { signQuery: true } })
  return signed.url
}

export async function externalProxyLocation(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  path: string,
): Promise<string | null> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage) return null
  const config = configOf(storage)
  const proxy = stringValue(config.urlProxy)
  if (!proxy) return null
  const redirect = checkTarget(proxy)
  if (!redirect.url) return null
  const direct = await externalDirectUrl(env, db, mount, path)
  if (direct) return appendProxyTarget(redirect.url.toString(), direct)
  if (storage.type !== 'webdav') return null
  const target = checkTarget(stringValue(config.baseUrl))
  if (!target.url) return null
  const base = `${target.url.origin}${target.url.pathname.replace(/\/$/, '')}`
  const root = String(config.rootPath ?? '').replace(/^\/+|\/+$/g, '')
  const relative = path.replace(/^\/+/, '')
  const source = `${base}/${[root, relative].filter(Boolean).join('/')}`
  return appendProxyTarget(redirect.url.toString(), source)
}

export async function externalCapacityBytes(
  db: D1Database,
  mount: CloudDriveMountInfo,
): Promise<number | null> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage) return null
  const value = configOf(storage).capacityBytes
  return typeof value === 'number' && value > 0 ? value : null
}

export async function externalFolderSize(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  path: string,
): Promise<{ bytes: number; truncated: boolean }> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The mount configuration is missing')
  const driver = await createStorageDriver(env, storage, driverMountContext(mount))
  if (driver) {
    try {
      const queue = [path]
      const visited = new Set<string>()
      let bytes = 0
      let entries = 0
      while (queue.length > 0) {
        const current = queue.shift()!
        if (visited.has(current)) continue
        visited.add(current)
        const listed = await driver.list(current)
        entries += listed.entries.length
        if (entries > MAX_DRIVER_ENTRIES) return { bytes, truncated: true }
        for (const entry of listed.entries) {
          if (entry.kind === 'folder') queue.push(current === '/' ? `/${entry.name}` : `${current}/${entry.name}`)
          else bytes += entry.size
        }
      }
      return { bytes, truncated: false }
    } catch (error) {
      rethrowDriver(error)
    }
  }
  const queue = [path]
  const visited = new Set<string>()
  let bytes = 0
  let entries = 0
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    const listed = await listStorage(env, db, mount, storage, current)
    const found = listed.entries
    entries += found.length
    if (entries > MAX_DRIVER_ENTRIES) return { bytes, truncated: true }
    for (const entry of found) {
      if (!safeSegment(entry.name)) continue
      const child = current === '/' ? `/${entry.name}` : `${current}/${entry.name}`
      if (entry.kind === 'folder') queue.push(child)
      else bytes += entry.size
    }
  }
  return { bytes, truncated: false }
}

function appendProxyTarget(proxy: string, target: string): string {
  const separator = proxy.includes('?') ? '&' : '?'
  return `${proxy}${separator}url=${encodeURIComponent(target)}`
}

async function listStorage(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  storage: StorageRow,
  path: string,
): Promise<DriverList> {
  const driver = await createStorageDriver(env, storage, driverMountContext(mount))
  if (driver) {
    try {
      const result = await driver.list(path)
      return { entries: result.entries, truncated: result.truncated }
    } catch (error) {
      rethrowDriver(error)
    }
  }
  if (storage.type === 's3') return await listS3(env, storage, mount, path)
  if (storage.type === 'webdav') return await listWebdav(env, storage, mount, path)
  // The remaining drivers hand back a whole listing in one answer, so they cannot be truncated.
  if (storage.type === 'github') return { entries: await listGithub(env, storage, path), truncated: false }
  if (storage.type === 'huggingface') return { entries: await listHuggingFace(env, storage, path), truncated: false }
  if (storage.type === 'discord') return { entries: await listDiscord(env, storage), truncated: false }
  if (storage.type === 'onedrive') return { entries: await listOneDrive(env, db, storage, path), truncated: false }
  if (storage.type === 'googledrive') return { entries: await listGoogleDrive(env, db, storage, path), truncated: false }
  if (storage.type === 'telegram') {
    throw new ApiError(502, 'clouddrive_mount_unavailable', 'Telegram bots cannot list chat history; this mount is connection-only')
  }
  throw new ApiError(502, 'clouddrive_mount_unavailable', 'This storage type is not supported yet')
}

async function readStorage(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  storage: StorageRow,
  path: string,
  range: string | null,
  ref: string | null,
): Promise<Response | null> {
  const driver = await createStorageDriver(env, storage, driverMountContext(mount))
  if (driver) {
    try {
      return await driver.read(path, range)
    } catch (error) {
      rethrowDriver(error)
    }
  }
  if (storage.type === 's3') return await readS3(env, storage, mount, path, range)
  if (storage.type === 'webdav') return await readWebdav(env, storage, mount, path, range)
  if (storage.type === 'github') return await readGithub(env, storage, path, range)
  if (storage.type === 'huggingface') return await readHuggingFace(env, storage, path, range)
  if (storage.type === 'discord') return await readDiscord(env, storage, path, ref, range)
  if (storage.type === 'onedrive') return await readOneDrive(env, db, storage, path, ref, range)
  if (storage.type === 'googledrive') return await readGoogleDrive(env, db, storage, path, ref, range)
  throw new ApiError(502, 'clouddrive_mount_unavailable', 'This storage type is not supported yet')
}

function toEntry(mount: CloudDriveMountInfo, parent: string, entry: DriverEntry): CloudDriveEntry {
  const path = parent === '/' ? `/${entry.name}` : `${parent}/${entry.name}`
  return {
    id: externalEntryId(mount.id, path, entry.ref),
    kind: entry.kind,
    name: entry.name,
    path,
    mountId: mount.id,
    mountName: mount.name,
    category: entry.kind === 'folder' ? 'other' : categoryFor(entry.name),
    mime: entry.kind === 'folder' ? 'application/octet-stream' : mimeFor(entry.name),
    size: entry.size,
    uploadedAt: entry.modifiedAt,
    modifiedAt: entry.modifiedAt,
    starredAt: null,
    readOnly: mount.readOnly,
    hasThumbnail: false,
    storage: mount.storageType,
    storageKind: 'external',
    color: null,
    tags: [],
  }
}

function mimeFor(name: string): string {
  const extension = extensionOf(name)
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'svg'].includes(extension)) return `image/${extension === 'jpg' ? 'jpeg' : extension}`
  if (['mp4', 'webm', 'mov'].includes(extension)) return `video/${extension}`
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(extension)) return `audio/${extension}`
  if (extension === 'pdf') return 'application/pdf'
  if (['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yaml', 'yml'].includes(extension)) return 'text/plain'
  return 'application/octet-stream'
}

async function storageFor(db: D1Database, mountId: string, storageId: string): Promise<StorageRow | null> {
  return await db.prepare(
    `SELECT s.id, s.user_id, s.type, s.config, s.credentials, s.updated_at
       FROM CloudDrive_storages s
       JOIN CloudDrive_mounts m ON m.user_id = s.user_id AND m.storage_id = s.id
      WHERE s.id = ?1 AND m.id = ?2 LIMIT 1`,
  ).bind(storageId, mountId).first<StorageRow>()
}

async function credentialsOf(env: Env, storage: StorageRow): Promise<Record<string, string>> {
  const stored = await decryptCloudDriveCredentials(env, storage.id, storage.credentials).catch(() => null)
  if (!stored && storage.credentials) {
    throw new ApiError(502, 'clouddrive_mount_unavailable', 'The stored storage credentials could not be read')
  }
  return Object.fromEntries(Object.entries(stored ?? {}).map(([key, value]) => [key, String(value)]))
}

function configOf(storage: StorageRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(storage.config) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function joinPath(root: string, path: string): string {
  const base = root.replace(/^\/+|\/+$/g, '')
  const tail = path.replace(/^\/+|\/+$/g, '')
  return [base, tail].filter(Boolean).join('/')
}

const XML_PREFIX = '(?:[A-Za-z_][\\w.-]*:)?'
const XML_RESPONSE = new RegExp(`<${XML_PREFIX}response\\b[^>]*>([\\s\\S]*?)</${XML_PREFIX}response>`, 'gi')
const XML_HREF = new RegExp(`<${XML_PREFIX}href\\b[^>]*>([\\s\\S]*?)</${XML_PREFIX}href>`, 'i')
const XML_COLLECTION = new RegExp(`<${XML_PREFIX}collection\\b[^>]*\\/?>`, 'i')
const XML_LENGTH = new RegExp(`<${XML_PREFIX}getcontentlength\\b[^>]*>(\\d+)</${XML_PREFIX}getcontentlength>`, 'i')
const XML_MODIFIED = new RegExp(`<${XML_PREFIX}getlastmodified\\b[^>]*>([^<]+)</${XML_PREFIX}getlastmodified>`, 'i')

function xmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return "'"
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10)
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

interface WebdavChild {
  name: string
}

function webdavChild(href: string, requestUrl: string): WebdavChild | null {
  if (!href) return null
  let url: URL
  let request: URL
  try {
    request = new URL(requestUrl)
    url = new URL(xmlText(href).trim(), request)
  } catch {
    return null
  }
  const requestPath = request.pathname.endsWith('/') ? request.pathname : `${request.pathname}/`
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  if (path === requestPath || !path.startsWith(requestPath)) return null
  const rest = path.slice(requestPath.length).replace(/\/$/, '')
  if (!rest || rest.includes('/')) return null
  const raw = rest
  if (!raw) return null
  let name = raw
  try {
    name = decodeURIComponent(raw)
  } catch {
    name = raw
  }
  return { name }
}

async function listS3(env: Env, storage: StorageRow, _mount: CloudDriveMountInfo, path: string): Promise<DriverList> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const endpointRaw = String(config.endpoint ?? '')
  if (!endpointRaw) throw new ApiError(502, 'clouddrive_mount_unavailable', 'S3 endpoint is missing')
  const target = checkTarget(endpointRaw)
  if (!target.url) throw new ApiError(502, 'clouddrive_mount_unavailable', target.error)
  const aws = new AwsClient({ accessKeyId: credentials.accessKeyId ?? '', secretAccessKey: credentials.secretAccessKey ?? '', region: String(config.region ?? 'auto'), service: 's3', retries: 1 })
  const root = String(config.rootPath ?? '')
  const prefix = joinPath(root, path)
  const requestUrl = s3RequestUrl(target.url, config, null)
  requestUrl.searchParams.set('list-type', '2')
  requestUrl.searchParams.set('delimiter', '/')
  requestUrl.searchParams.set('max-keys', '1000')
  if (prefix) requestUrl.searchParams.set('prefix', `${prefix}/`)

  // `list-type=2` answers one page at a time. Reading only the first page made a bucket with more
  // than a thousand names look like it had lost files, so the token is followed until the listing is
  // complete or the driver's own ceiling is reached — which is then reported instead of hidden.
  const entries: DriverEntry[] = []
  let token: string | null = null
  for (let page = 0; page < S3_LIST_PAGES; page++) {
    const url = new URL(requestUrl.toString())
    if (token) url.searchParams.set('continuation-token', token)
    const response = await aws.fetch(url.toString(), { method: 'GET', redirect: 'manual' })
    const text = await response.text()
    if (!response.ok) throw new ApiError(502, 'clouddrive_mount_unavailable', `S3 list failed (${response.status})`)
    for (const match of text.matchAll(/<CommonPrefixes>[\s\S]*?<Prefix>([^<]+)<\/Prefix>/g)) {
      const name = match[1]!.split('/').filter(Boolean).pop() ?? ''
      if (name) entries.push({ name, kind: 'folder', size: 0, modifiedAt: 0 })
    }
    for (const match of text.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<LastModified>([^<]+)<\/LastModified>[\s\S]*?<Size>(\d+)<\/Size>/g)) {
      const key = match[1]!
      const name = key.split('/').filter(Boolean).pop() ?? ''
      const modified = Date.parse(match[2]!) || 0
      const size = Number(match[3] ?? 0)
      if (name && !key.endsWith('/')) entries.push({ name, kind: 'file', size, modifiedAt: modified })
    }
    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(text)?.[1] ?? null
    if (!token) break
    if (entries.length >= MAX_DRIVER_ENTRIES) break
  }
  // A token still standing means either the entry ceiling or the page ceiling stopped the walk.
  const truncated = token !== null || entries.length > MAX_DRIVER_ENTRIES
  return { entries: entries.slice(0, MAX_DRIVER_ENTRIES), truncated }
}

async function readS3(env: Env, storage: StorageRow, _mount: CloudDriveMountInfo, path: string, range: string | null): Promise<Response | null> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const endpointRaw = String(config.endpoint ?? '')
  const target = checkTarget(endpointRaw)
  if (!target.url) throw new ApiError(502, 'clouddrive_mount_unavailable', target.error)
  const endpoint = target.url
  const key = joinPath(String(config.rootPath ?? ''), path)
  const aws = new AwsClient({ accessKeyId: credentials.accessKeyId ?? '', secretAccessKey: credentials.secretAccessKey ?? '', region: String(config.region ?? 'auto'), service: 's3', retries: 1 })
  const url = s3RequestUrl(endpoint, config, key).toString()
  const headers: Record<string, string> = {}
  if (range) headers.Range = range
  const response = await aws.fetch(url, { method: 'GET', headers, redirect: 'manual' })
  if (response.status === 404) { await discard(response); return null }
  if (!response.ok && response.status !== 206) throw new ApiError(502, 'clouddrive_mount_unavailable', `S3 read failed (${response.status})`)
  return response
}

async function listWebdav(env: Env, storage: StorageRow, _mount: CloudDriveMountInfo, path: string): Promise<DriverList> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const baseRaw = String(config.baseUrl ?? '')
  if (!baseRaw) throw new ApiError(502, 'clouddrive_mount_unavailable', 'WebDAV base URL is missing')
  const target = checkTarget(baseRaw)
  if (!target.url) throw new ApiError(502, 'clouddrive_mount_unavailable', target.error)
  const base = `${target.url.origin}${target.url.pathname.replace(/\/$/, '')}`
  const root = String(config.rootPath ?? '').replace(/^\/+|\/+$/g, '')
  const relative = path === '/' ? '' : path.replace(/^\/+/, '')
  const url = `${base}/${[root, relative].filter(Boolean).join('/')}`.replace(/\/?$/, '/')
  const headers: Record<string, string> = { Depth: '1' }
  if (credentials.username || credentials.password) headers.Authorization = `Basic ${btoa(`${credentials.username ?? ''}:${credentials.password ?? ''}`)}`
  const response = await fetch(url, { method: 'PROPFIND', headers, redirect: 'manual' })
  const xml = await response.text()
  if (!response.ok && response.status !== 207) throw new ApiError(502, 'clouddrive_mount_unavailable', `WebDAV list failed (${response.status})`)
  const entries: DriverEntry[] = []
  const seen = new Set<string>()
  let truncated = false
  for (const block of xml.matchAll(XML_RESPONSE)) {
    const body = block[1]!
    const child = webdavChild(XML_HREF.exec(body)?.[1] ?? '', url)
    if (!child) continue
    const folder = XML_COLLECTION.test(body)
    const key = `${folder ? 'folder' : 'file'}:${child.name}`
    if (seen.has(key)) continue
    // The ceiling is reported, not swallowed: a server with more names than this is telling the
    // reader the folder is only partly shown rather than letting it look like files went missing.
    if (entries.length >= MAX_DRIVER_ENTRIES) {
      truncated = true
      break
    }
    seen.add(key)
    const modifiedText = XML_MODIFIED.exec(body)?.[1]
    entries.push({
      name: child.name,
      kind: folder ? 'folder' : 'file',
      size: folder ? 0 : Number(XML_LENGTH.exec(body)?.[1] ?? 0),
      modifiedAt: modifiedText ? (Date.parse(modifiedText) || 0) : 0,
    })
  }
  return { entries, truncated }
}

async function readWebdav(env: Env, storage: StorageRow, _mount: CloudDriveMountInfo, path: string, range: string | null): Promise<Response | null> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const baseRaw = String(config.baseUrl ?? '')
  const target = checkTarget(baseRaw)
  if (!target.url) throw new ApiError(502, 'clouddrive_mount_unavailable', target.error)
  const base = target.url.origin + target.url.pathname.replace(/\/$/, '')
  const root = String(config.rootPath ?? '').replace(/^\/+|\/+$/g, '')
  const relative = path.replace(/^\/+/, '')
  const url = `${base}/${[root, relative].filter(Boolean).join('/')}`
  const headers: Record<string, string> = {}
  if (credentials.username || credentials.password) headers.Authorization = `Basic ${btoa(`${credentials.username ?? ''}:${credentials.password ?? ''}`)}`
  if (range) headers.Range = range
  const response = await fetch(url, { method: 'GET', headers, redirect: 'manual' })
  if (response.status === 404) { await discard(response); return null }
  if (!response.ok && response.status !== 206) throw new ApiError(502, 'clouddrive_mount_unavailable', `WebDAV read failed (${response.status})`)
  return response
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function requireConfig(config: Record<string, unknown>, key: string, label: string): string {
  const value = stringValue(config[key])
  if (!value) throw new ApiError(502, 'clouddrive_mount_unavailable', `${label} is missing`)
  return value
}

function splitRepo(value: string): { owner: string; repo: string } {
  const parts = value.split('/')
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new ApiError(502, 'clouddrive_mount_unavailable', 'The repository must be owner/name')
  }
  return { owner: parts[0]!, repo: parts[1]! }
}

function githubHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'inkstone-clouddrive',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function listGithub(env: Env, storage: StorageRow, path: string): Promise<DriverEntry[]> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const { owner, repo } = splitRepo(requireConfig(config, 'repo', 'GitHub repository'))
  const branch = stringValue(config.branch)
  const relative = joinPath(stringValue(config.rootPath), path)
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${relative ? `/${encodeKey(relative)}` : ''}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`
  const response = await fetch(url, { headers: githubHeaders(stringValue(credentials.token)), redirect: 'follow' })
  if (response.status === 404) { await discard(response); return [] }
  if (!response.ok) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `GitHub list failed (${response.status})`)
  }
  const payload: unknown = await response.json()
  if (!Array.isArray(payload)) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The GitHub path is not a folder')
  const entries: DriverEntry[] = []
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = stringValue(record.name)
    if (!name) continue
    entries.push({
      name,
      kind: record.type === 'dir' ? 'folder' : 'file',
      size: Number(record.size) || 0,
      modifiedAt: 0,
    })
  }
  return entries
}

async function readGithub(env: Env, storage: StorageRow, path: string, range: string | null): Promise<Response | null> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const { owner, repo } = splitRepo(requireConfig(config, 'repo', 'GitHub repository'))
  const branch = stringValue(config.branch)
  const relative = joinPath(stringValue(config.rootPath), path)
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeKey(relative)}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`
  const headers: Record<string, string> = { ...githubHeaders(stringValue(credentials.token)), Accept: 'application/vnd.github.raw' }
  if (range) headers.Range = range
  const response = await fetch(url, { headers, redirect: 'follow' })
  if (response.status === 404) { await discard(response); return null }
  if (!response.ok) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `GitHub read failed (${response.status})`)
  }
  return response
}

function huggingFaceRepo(config: Record<string, unknown>): { kind: string; repo: string; revision: string } {
  const repo = requireConfig(config, 'repo', 'Hugging Face repository')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new ApiError(502, 'clouddrive_mount_unavailable', 'The repository must be owner/name')
  }
  return {
    kind: config.repoType === 'dataset' ? 'datasets' : 'models',
    repo,
    revision: stringValue(config.revision) || 'main',
  }
}

async function listHuggingFace(env: Env, storage: StorageRow, path: string): Promise<DriverEntry[]> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const { kind, repo, revision } = huggingFaceRepo(config)
  const relative = joinPath(stringValue(config.rootPath), path)
  const url = `https://huggingface.co/api/${kind}/${repo}/tree/${encodeURIComponent(revision)}${relative ? `/${encodeKey(relative)}` : ''}`
  const headers: Record<string, string> = {}
  if (stringValue(credentials.token)) headers.Authorization = `Bearer ${stringValue(credentials.token)}`
  const response = await fetch(url, { headers })
  if (response.status === 404) { await discard(response); return [] }
  if (!response.ok) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `Hugging Face list failed (${response.status})`)
  }
  const payload: unknown = await response.json()
  if (!Array.isArray(payload)) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The Hugging Face path is not a folder')
  const entries: DriverEntry[] = []
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const itemPath = stringValue(record.path)
    const name = itemPath.split('/').filter(Boolean).pop() ?? ''
    if (!name) continue
    entries.push({
      name,
      kind: record.type === 'directory' ? 'folder' : 'file',
      size: Number(record.size) || 0,
      modifiedAt: 0,
      ref: stringValue(record.oid) || undefined,
    })
  }
  return entries
}

async function readHuggingFace(env: Env, storage: StorageRow, path: string, range: string | null): Promise<Response | null> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const { kind, repo, revision } = huggingFaceRepo(config)
  const relative = joinPath(stringValue(config.rootPath), path)
  if (!relative) return null
  const url = `https://huggingface.co/${kind}/${repo}/resolve/${encodeURIComponent(revision)}/${encodeKey(relative)}`
  const headers: Record<string, string> = {}
  if (stringValue(credentials.token)) headers.Authorization = `Bearer ${stringValue(credentials.token)}`
  if (range) headers.Range = range
  const response = await fetch(url, { headers, redirect: 'follow' })
  if (response.status === 404) { await discard(response); return null }
  if (!response.ok && response.status !== 206) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `Hugging Face read failed (${response.status})`)
  }
  return response
}

const DISCORD_API = 'https://discord.com/api/v10'

function discordCredential(config: Record<string, unknown>, credentials: Record<string, string>, key: string): string {
  return stringValue(credentials[key]) || stringValue(config[key])
}

async function listDiscord(env: Env, storage: StorageRow): Promise<DriverEntry[]> {
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const channelId = discordCredential(config, credentials, 'channelId')
  if (!/^\d{5,32}$/.test(channelId)) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The Discord channel id is invalid')
  const token = requireConfig(credentials, 'botToken', 'Discord bot token')
  const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages?limit=100`, {
    headers: { Authorization: `Bot ${token}`, 'User-Agent': 'inkstone-clouddrive' },
  })
  if (!response.ok) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `Discord list failed (${response.status})`)
  }
  const payload: unknown = await response.json()
  if (!Array.isArray(payload)) return []
  const entries: DriverEntry[] = []
  for (const message of payload) {
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    const messageId = stringValue(record.id)
    const attachments = Array.isArray(record.attachments) ? record.attachments : []
    const modifiedAt = Date.parse(stringValue(record.timestamp)) || 0
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== 'object') continue
      const file = attachment as Record<string, unknown>
      const name = stringValue(file.filename)
      const attachmentId = stringValue(file.id)
      if (!name || !messageId || !attachmentId || name.includes('/')) continue
      entries.push({
        name,
        kind: 'file',
        size: Number(file.size) || 0,
        modifiedAt,
        ref: `${channelId}:${messageId}:${attachmentId}`,
      })
    }
  }
  return entries
}

interface DiscordAttachment {
  id: string
  filename: string
  url: string
}

async function discordAttachments(env: Env, storage: StorageRow, channelId: string, messageId: string): Promise<DiscordAttachment[]> {
  const credentials = await credentialsOf(env, storage)
  const token = requireConfig(credentials, 'botToken', 'Discord bot token')
  const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
    headers: { Authorization: `Bot ${token}`, 'User-Agent': 'inkstone-clouddrive' },
  })
  if (!response.ok) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `Discord read failed (${response.status})`)
  }
  const payload = await response.json() as { attachments?: unknown }
  const list = Array.isArray(payload.attachments) ? payload.attachments : []
  return list.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    const id = stringValue(record.id)
    const filename = stringValue(record.filename)
    const url = stringValue(record.url)
    return id && filename && url ? [{ id, filename, url }] : []
  })
}

async function readDiscord(env: Env, storage: StorageRow, path: string, ref: string | null, range: string | null): Promise<Response | null> {
  let channelId = ''
  let messageId = ''
  let attachmentId = ''
  if (ref) [channelId, messageId, attachmentId] = ref.split(':')
  const name = path.split('/').filter(Boolean).pop() ?? ''
  if (!channelId || !messageId) {
    const config = configOf(storage)
    const credentials = await credentialsOf(env, storage)
    channelId = discordCredential(config, credentials, 'channelId')
    const token = requireConfig(credentials, 'botToken', 'Discord bot token')
    const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages?limit=100`, {
      headers: { Authorization: `Bot ${token}`, 'User-Agent': 'inkstone-clouddrive' },
    })
    if (!response.ok) {
      await discard(response)
      throw new ApiError(502, 'clouddrive_mount_unavailable', `Discord read failed (${response.status})`)
    }
    const messages = await response.json() as unknown
    if (!Array.isArray(messages)) return null
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      const record = message as Record<string, unknown>
      const attachments = Array.isArray(record.attachments) ? record.attachments : []
      const found = attachments.find((value) => value && typeof value === 'object' && (value as Record<string, unknown>).filename === name)
      if (found) {
        messageId = stringValue(record.id)
        attachmentId = stringValue((found as Record<string, unknown>).id)
        break
      }
    }
    if (!messageId) return null
  }
  const attachments = await discordAttachments(env, storage, channelId, messageId)
  const attachment = attachments.find((value) => value.id === attachmentId)
    ?? (name ? attachments.find((value) => value.filename === name) : undefined)
  if (!attachment) return null
  const headers: Record<string, string> = {}
  if (range) headers.Range = range
  const response = await fetch(attachment.url, { headers })
  if (!response.ok && response.status !== 206) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `Discord download failed (${response.status})`)
  }
  return response
}

async function oauthAccessToken(
  env: Env,
  db: D1Database,
  storage: StorageRow,
  provider: 'onedrive' | 'googledrive',
): Promise<string> {
  const credentials = await credentialsOf(env, storage)
  const accessToken = stringValue(credentials.accessToken)
  const expiresAt = Number(credentials.expiresAt)
  if (accessToken && (!Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt > Date.now() + 60_000)) {
    return accessToken
  }
  const refreshToken = stringValue(credentials.refreshToken)
  const clientId = stringValue(credentials.clientId)
  const clientSecret = stringValue(credentials.clientSecret)
  if (!refreshToken || !clientId) {
    if (accessToken) return accessToken
    throw new ApiError(502, 'clouddrive_mount_unavailable', 'The access token is missing; reconnect this storage')
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  })
  if (clientSecret) params.set('client_secret', clientSecret)
  const tokenUrl = provider === 'onedrive'
    ? 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
    : 'https://oauth2.googleapis.com/token'
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  const payload = await response.json().catch(() => null) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  } | null
  const refreshed = stringValue(payload?.access_token)
  if (!response.ok || !refreshed) {
    throw new ApiError(502, 'clouddrive_mount_unavailable', `The ${provider === 'onedrive' ? 'OneDrive' : 'Google Drive'} token refresh was refused`)
  }
  const next = {
    ...credentials,
    accessToken: refreshed,
    refreshToken: stringValue(payload?.refresh_token) || refreshToken,
    expiresAt: Date.now() + (Number(payload?.expires_in) || 3600) * 1000,
  }
  await db.prepare(
    `UPDATE CloudDrive_storages SET credentials = ?, updated_at = ? WHERE user_id = ? AND id = ?`,
  ).bind(await encryptCloudDriveCredentials(env, storage.id, next), Date.now(), storage.user_id, storage.id).run()
  return refreshed
}

function oneDriveBase(config: Record<string, unknown>): string {
  const driveId = stringValue(config.driveId)
  return driveId && driveId !== 'me'
    ? `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}`
    : 'https://graph.microsoft.com/v1.0/me/drive'
}

async function listOneDrive(
  env: Env,
  db: D1Database,
  storage: StorageRow,
  path: string,
): Promise<DriverEntry[]> {
  const config = configOf(storage)
  const token = await oauthAccessToken(env, db, storage, 'onedrive')
  const relative = joinPath(stringValue(config.rootPath), path)
  const base = oneDriveBase(config)
  const url = relative
    ? `${base}/root:/${encodeKey(relative)}:/children`
    : `${base}/root/children`
  const search = new URLSearchParams({
    $top: '200',
    $select: 'id,name,size,lastModifiedDateTime,file,folder',
    $orderby: 'name',
  })
  const response = await fetch(`${url}?${search.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  })
  if (response.status === 404) { await discard(response); return [] }
  if (!response.ok) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `OneDrive list failed (${response.status})`)
  }
  const payload = await response.json() as { value?: unknown }
  const rows = Array.isArray(payload.value) ? payload.value : []
  return rows.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    const name = stringValue(record.name)
    const id = stringValue(record.id)
    if (!name || !id) return []
    const folder = record.folder && typeof record.folder === 'object'
    return [{
      name,
      kind: folder ? 'folder' : 'file',
      size: Number(record.size) || 0,
      modifiedAt: Date.parse(stringValue(record.lastModifiedDateTime)) || 0,
      ref: id,
    } satisfies DriverEntry]
  })
}

async function readOneDrive(
  env: Env,
  db: D1Database,
  storage: StorageRow,
  path: string,
  ref: string | null,
  range: string | null,
): Promise<Response | null> {
  const config = configOf(storage)
  const token = await oauthAccessToken(env, db, storage, 'onedrive')
  const base = oneDriveBase(config)
  const relative = ref ? '' : joinPath(stringValue(config.rootPath), path)
  const url = ref
    ? `${base}/items/${encodeURIComponent(ref)}/content`
    : `${base}/root:/${encodeKey(relative)}:/content`
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (range) headers.Range = range
  const response = await fetch(url, { headers, redirect: 'follow' })
  if (response.status === 404) { await discard(response); return null }
  if (!response.ok && response.status !== 206) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `OneDrive read failed (${response.status})`)
  }
  return response
}

const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder'

async function googleChildren(env: Env, db: D1Database, storage: StorageRow, folderId: string): Promise<DriverEntry[]> {
  const token = await oauthAccessToken(env, db, storage, 'googledrive')
  const q = `'${folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents and trashed = false`
  const search = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType,size,modifiedTime)',
    pageSize: '200',
    orderBy: 'name_natural',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?${search.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  })
  if (response.status === 404) { await discard(response); return [] }
  if (!response.ok) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `Google Drive list failed (${response.status})`)
  }
  const payload = await response.json() as { files?: unknown }
  const files = Array.isArray(payload.files) ? payload.files : []
  return files.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    const name = stringValue(record.name)
    const id = stringValue(record.id)
    if (!name || !id) return []
    const folder = record.mimeType === GOOGLE_FOLDER_MIME
    return [{
      name,
      kind: folder ? 'folder' : 'file',
      size: Number(record.size) || 0,
      modifiedAt: Date.parse(stringValue(record.modifiedTime)) || 0,
      ref: id,
    } satisfies DriverEntry]
  })
}

async function googleFolderId(env: Env, db: D1Database, storage: StorageRow, path: string): Promise<string> {
  const config = configOf(storage)
  let current = stringValue(config.folderId) || 'root'
  for (const segment of path.split('/').filter(Boolean)) {
    const entries = await googleChildren(env, db, storage, current)
    const folder = entries.find((entry) => entry.kind === 'folder' && entry.name === segment)
    if (!folder?.ref) throw ApiError.notFound('Folder not found')
    current = folder.ref
  }
  return current
}

async function listGoogleDrive(
  env: Env,
  db: D1Database,
  storage: StorageRow,
  path: string,
): Promise<DriverEntry[]> {
  return await googleChildren(env, db, storage, await googleFolderId(env, db, storage, path))
}

async function readGoogleDrive(
  env: Env,
  db: D1Database,
  storage: StorageRow,
  path: string,
  ref: string | null,
  range: string | null,
): Promise<Response | null> {
  let fileId = ref
  if (!fileId) {
    const parentPath = path.slice(0, path.lastIndexOf('/')) || '/'
    const parentId = await googleFolderId(env, db, storage, parentPath)
    const name = path.split('/').filter(Boolean).pop() ?? ''
    const entries = await googleChildren(env, db, storage, parentId)
    fileId = entries.find((entry) => entry.kind === 'file' && entry.name === name)?.ref ?? null
  }
  if (!fileId) return null
  const token = await oauthAccessToken(env, db, storage, 'googledrive')
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (range) headers.Range = range
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers, redirect: 'follow' },
  )
  if (response.status === 404) { await discard(response); return null }
  if (!response.ok && response.status !== 206) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `Google Drive read failed (${response.status})`)
  }
  return response
}

async function s3ObjectRequest(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  key: string,
): Promise<{ aws: AwsClient; url: string }> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage || storage.type !== 's3') {
    throw new ApiError(502, 'clouddrive_mount_unavailable', 'Only S3 mounts accept distributed parts')
  }
  const config = configOf(storage)
  const credentials = await credentialsOf(env, storage)
  const target = checkTarget(String(config.endpoint ?? ''))
  if (!target.url) throw new ApiError(502, 'clouddrive_mount_unavailable', target.error ?? 'S3 endpoint is missing')
  const bucket = String(config.bucketName ?? '')
  const endpoint = target.url
  const aws = new AwsClient({
    accessKeyId: credentials.accessKeyId ?? '',
    secretAccessKey: credentials.secretAccessKey ?? '',
    region: String(config.region ?? 'auto'),
    service: 's3',
    retries: 1,
  })
  const objectKey = joinPath(String(config.rootPath ?? ''), key)
  const pathStyle = config.pathStyle === true || endpoint.hostname.endsWith('amazonaws.com') === false
  const url = pathStyle
    ? `${endpoint.origin}/${bucket}/${encodeKey(objectKey)}`
    : `${endpoint.protocol}//${bucket}.${endpoint.host}/${encodeKey(objectKey)}`
  return { aws, url }
}

export async function writeExternalObject(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string | null> {
  const { aws, url } = await s3ObjectRequest(env, db, mount, key)
  const response = await aws.fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes.slice().buffer,
  })
  const etag = response.headers.get('etag')
  await discard(response)
  if (!response.ok) throw new ApiError(502, 'clouddrive_mount_unavailable', `S3 part write failed (${response.status})`)
  return etag
}

export async function readExternalObject(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  key: string,
  range: string | null,
): Promise<Response | null> {
  const { aws, url } = await s3ObjectRequest(env, db, mount, key)
  const headers: Record<string, string> = {}
  if (range) headers.Range = range
  const response = await aws.fetch(url, { method: 'GET', headers, redirect: 'manual' })
  if (response.status === 404) { await discard(response); return null }
  if (!response.ok && response.status !== 206) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `S3 part read failed (${response.status})`)
  }
  return response
}

export async function deleteExternalObject(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  key: string,
): Promise<void> {
  const { aws, url } = await s3ObjectRequest(env, db, mount, key)
  const response = await aws.fetch(url, { method: 'DELETE', redirect: 'manual' })
  await discard(response)
  if (!response.ok && response.status !== 404) {
    throw new ApiError(502, 'clouddrive_mount_unavailable', `S3 part delete failed (${response.status})`)
  }
}

function webdavBase(storage: StorageRow): string {
  const config = configOf(storage)
  const target = checkTarget(String(config.baseUrl ?? ''))
  if (!target.url) throw new ApiError(502, 'clouddrive_mount_unavailable', target.error)
  const root = String(config.rootPath ?? '').replace(/^\/+|\/+$/g, '')
  return [target.url.origin + target.url.pathname.replace(/\/$/, ''), root].filter(Boolean).join('/')
}

function webdavUrl(storage: StorageRow, path: string): string {
  const base = webdavBase(storage)
  const relative = path.replace(/^\/+|\/+$/g, '')
  return relative ? `${base}/${encodeKey(relative)}` : `${base}/`
}

async function webdavHeaders(env: Env, storage: StorageRow): Promise<Record<string, string>> {
  const credentials = await credentialsOf(env, storage)
  const headers: Record<string, string> = {}
  if (credentials.username || credentials.password) {
    headers.Authorization = `Basic ${btoa(`${credentials.username ?? ''}:${credentials.password ?? ''}`)}`
  }
  return headers
}

async function webdavWriteRequest(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'manual' })
  if (![301, 302, 303, 307, 308].includes(response.status)) return response
  const location = response.headers.get('location')
  if (!location) return response
  const target = new URL(location, url)
  if (target.origin !== new URL(url).origin) return response
  await discard(response)
  return await fetch(target.toString(), { ...init, redirect: 'manual' })
}

export async function writeExternalFile(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The mount configuration is missing')
  const driver = await createStorageDriver(env, storage, driverMountContext(mount))
  if (driver) {
    try {
      await driver.upload(path, bytes, { size: bytes.byteLength, contentType })
      return
    } catch (error) {
      rethrowDriver(error)
    }
  }
  if (storage.type === 's3') {
    const config = configOf(storage)
    const key = joinPath(String(config.rootPath ?? ''), path)
    await putS3Key(env, db, mount, key, bytes, contentType)
    return
  }
  if (storage.type === 'webdav') {
    const headers = await webdavHeaders(env, storage)
    const response = await webdavWriteRequest(webdavUrl(storage, path), { method: 'PUT', headers: { ...headers, 'Content-Type': contentType }, body: bytes })
    await discard(response)
    if (!response.ok) throw new ApiError(502, 'clouddrive_mount_unavailable', `WebDAV write failed (${response.status})`)
    return
  }
  throw new ApiError(403, 'clouddrive_read_only', 'This storage type does not support writes')
}

export async function mkdirExternal(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  path: string,
): Promise<void> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The mount configuration is missing')
  const driver = await createStorageDriver(env, storage, driverMountContext(mount))
  if (driver) {
    try {
      await driver.mkdir(path)
      return
    } catch (error) {
      rethrowDriver(error)
    }
  }
  if (storage.type === 's3') {
    const config = configOf(storage)
    const key = `${joinPath(String(config.rootPath ?? ''), path)}/`.replace(/^\/+/, '')
    await putS3Key(env, db, mount, key, new Uint8Array(0), 'application/x-directory')
    return
  }
  if (storage.type === 'webdav') {
    const headers = await webdavHeaders(env, storage)
    const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current = `${current}/${segment}`
      const response = await webdavWriteRequest(webdavUrl(storage, current), { method: 'MKCOL', headers })
      await discard(response)
      if (!response.ok && response.status !== 405) {
        throw new ApiError(502, 'clouddrive_mount_unavailable', `WebDAV folder creation failed (${response.status})`)
      }
    }
    return
  }
  throw new ApiError(403, 'clouddrive_read_only', 'This storage type does not support writes')
}

async function listS3Keys(env: Env, storage: StorageRow, prefix: string): Promise<string[]> {
  const config = configOf(storage)
  const target = checkTarget(String(config.endpoint ?? ''))
  if (!target.url) throw new ApiError(502, 'clouddrive_mount_unavailable', target.error)
  const credentials = await credentialsOf(env, storage)
  const aws = new AwsClient({
    accessKeyId: credentials.accessKeyId ?? '', secretAccessKey: credentials.secretAccessKey ?? '',
    region: String(config.region ?? 'auto'), service: 's3', retries: 1,
  })
  const keys: string[] = []
  let token: string | null = null
  do {
    const url = s3RequestUrl(target.url, config, null)
    url.searchParams.set('list-type', '2')
    url.searchParams.set('max-keys', '1000')
    if (prefix) url.searchParams.set('prefix', prefix)
    if (token) url.searchParams.set('continuation-token', token)
    const response = await aws.fetch(url.toString(), { method: 'GET', redirect: 'manual' })
    const xml = await response.text()
    if (!response.ok) throw new ApiError(502, 'clouddrive_mount_unavailable', `S3 list failed (${response.status})`)
    for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(xmlText(match[1]!))
    token = /<IsTruncated>true<\/IsTruncated>/i.test(xml)
      ? xmlText(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/i.exec(xml)?.[1] ?? '') || null
      : null
    if (keys.length > MAX_DRIVER_ENTRIES) throw new ApiError(413, 'clouddrive_folder_too_large', 'The remote folder holds too many objects for this operation')
  } while (token)
  return keys
}

async function copyS3Object(env: Env, db: D1Database, mount: CloudDriveMountInfo, fromKey: string, toKey: string): Promise<void> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage || storage.type !== 's3') throw new ApiError(502, 'clouddrive_mount_unavailable', 'The mount configuration is missing')
  const config = configOf(storage)
  const target = checkTarget(String(config.endpoint ?? ''))
  if (!target.url) throw new ApiError(502, 'clouddrive_mount_unavailable', target.error)
  const credentials = await credentialsOf(env, storage)
  const aws = new AwsClient({
    accessKeyId: credentials.accessKeyId ?? '', secretAccessKey: credentials.secretAccessKey ?? '',
    region: String(config.region ?? 'auto'), service: 's3', retries: 1,
  })
  const url = s3RequestUrl(target.url, config, toKey)
  const source = `/${bucketName(config)}/${encodeKey(fromKey)}`
  const response = await aws.fetch(url.toString(), {
    method: 'PUT', headers: { 'x-amz-copy-source': source }, redirect: 'manual',
  })
  await discard(response)
  if (!response.ok) throw new ApiError(502, 'clouddrive_mount_unavailable', `S3 copy failed (${response.status})`)
}

function bucketName(config: Record<string, unknown>): string {
  return String(config.bucketName ?? '')
}

async function s3AbsoluteClient(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
): Promise<{ aws: AwsClient; config: Record<string, unknown>; endpoint: URL }> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage || storage.type !== 's3') throw new ApiError(502, 'clouddrive_mount_unavailable', 'The mount configuration is missing')
  const config = configOf(storage)
  const target = checkTarget(String(config.endpoint ?? ''))
  if (!target.url) throw new ApiError(502, 'clouddrive_mount_unavailable', target.error)
  const credentials = await credentialsOf(env, storage)
  return {
    config,
    endpoint: target.url,
    aws: new AwsClient({
      accessKeyId: credentials.accessKeyId ?? '', secretAccessKey: credentials.secretAccessKey ?? '',
      region: String(config.region ?? 'auto'), service: 's3', retries: 1,
    }),
  }
}

async function putS3Key(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const { aws, config, endpoint } = await s3AbsoluteClient(env, db, mount)
  const response = await aws.fetch(s3RequestUrl(endpoint, config, key).toString(), {
    method: 'PUT', headers: { 'Content-Type': contentType }, body: bytes.slice().buffer,
  })
  await discard(response)
  if (!response.ok) throw new ApiError(502, 'clouddrive_mount_unavailable', `S3 write failed (${response.status})`)
}

async function deleteS3Key(env: Env, db: D1Database, mount: CloudDriveMountInfo, key: string): Promise<void> {
  const { aws, config, endpoint } = await s3AbsoluteClient(env, db, mount)
  const response = await aws.fetch(s3RequestUrl(endpoint, config, key).toString(), { method: 'DELETE', redirect: 'manual' })
  await discard(response)
  if (!response.ok && response.status !== 404) throw new ApiError(502, 'clouddrive_mount_unavailable', `S3 delete failed (${response.status})`)
}

export async function deleteExternalPath(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  path: string,
): Promise<void> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The mount configuration is missing')
  const driver = await createStorageDriver(env, storage, driverMountContext(mount))
  if (driver) {
    try {
      await driver.remove(path)
      return
    } catch (error) {
      rethrowDriver(error)
    }
  }
  if (storage.type === 's3') {
    const config = configOf(storage)
    const key = joinPath(String(config.rootPath ?? ''), path)
    const children = key ? await listS3Keys(env, storage, `${key}/`) : []
    for (const child of children) await deleteS3Key(env, db, mount, child)
    await deleteS3Key(env, db, mount, key)
    return
  }
  if (storage.type === 'webdav') {
    const headers = await webdavHeaders(env, storage)
    const response = await webdavWriteRequest(webdavUrl(storage, path), { method: 'DELETE', headers })
    await discard(response)
    if (!response.ok && response.status !== 404) {
      throw new ApiError(502, 'clouddrive_mount_unavailable', `WebDAV delete failed (${response.status})`)
    }
    return
  }
  throw new ApiError(403, 'clouddrive_read_only', 'This storage type does not support writes')
}

export async function moveExternalPath(
  env: Env,
  db: D1Database,
  mount: CloudDriveMountInfo,
  from: string,
  to: string,
): Promise<void> {
  const storage = await storageFor(db, mount.id, mount.storageId)
  if (!storage) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The mount configuration is missing')
  const driver = await createStorageDriver(env, storage, driverMountContext(mount))
  if (driver) {
    try {
      await driver.move(from, to)
      return
    } catch (error) {
      rethrowDriver(error)
    }
  }
  if (storage.type === 's3') {
    const config = configOf(storage)
    const root = String(config.rootPath ?? '')
    const fromKey = joinPath(root, from)
    const toKey = joinPath(root, to)
    const children = fromKey ? await listS3Keys(env, storage, `${fromKey}/`) : []
    for (const child of children) {
      const suffix = child.slice(fromKey.length)
      await copyS3Object(env, db, mount, child, `${toKey}${suffix}`)
    }
    await copyS3Object(env, db, mount, fromKey, toKey)
    for (const child of children) await deleteS3Key(env, db, mount, child)
    await deleteS3Key(env, db, mount, fromKey)
    return
  }
  if (storage.type === 'webdav') {
    const headers = await webdavHeaders(env, storage)
    const response = await webdavWriteRequest(webdavUrl(storage, from), { method: 'MOVE', headers: { ...headers, Destination: webdavUrl(storage, to), Overwrite: 'T' } })
    await discard(response)
    if (!response.ok) throw new ApiError(502, 'clouddrive_mount_unavailable', `WebDAV move failed (${response.status})`)
    return
  }
  throw new ApiError(403, 'clouddrive_read_only', 'This storage type does not support writes')
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
