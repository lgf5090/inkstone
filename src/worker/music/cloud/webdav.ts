/**
 * The WebDAV side of the music cloud.
 *
 * The reader's WebDAV target already exists as a backup target, so this module never stores an
 * address or a password of its own: it receives a resolved base, credentials and music directory and
 * works relative to them. Every path is normalised here; a caller can name a directory or a file under
 * the music directory, never an absolute URL, a parent segment or a second origin.
 *
 * Listings are capped twice: the PROPFIND body at half a megabyte and the parsed entries at two
 * thousand. A folder past either bound is answered with a named error that asks for a subfolder,
 * rather than a generic failure or an unbounded parse.
 */
import type { WebdavConfig } from '@shared/types'
import { discardBody } from '../../backup/common'
import {
  authHeader,
  baseUrl,
  childUrl,
  ensureDirs,
  webdavFetch,
  type WebdavSecret,
} from '../../backup/webdav'
import { ApiError } from '../../lib/errors'
import { uploadBodyInit } from './request-body'
import { decodeHrefPath, isMediaEntry, parseMultistatus, type WebdavPropfindEntry } from './webdav-xml'

const PROPFIND_MAX_BYTES = 512 * 1024
const MAX_PATH = 1024
const USER_AGENT = 'Inkstone-Music/1.0'
/** Metadata calls are small; a server that never answers must not hold the request open. */
const METADATA_TIMEOUT_MS = 20_000
/** A 64 MB PUT can legitimately be slow, but not unbounded. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000

export interface MusicWebdavContext {
  /** The backup target this context was resolved from; part of every reference's provider id. */
  targetId: string
  config: WebdavConfig
  secret: WebdavSecret
  dir: string
  base: URL
  auth: string
}

export interface MusicWebdavEntry {
  name: string
  /** Relative to the music directory, never to the server root. */
  path: string
  isDirectory: boolean
  sizeBytes: number
  mime: string | null
  modifiedAt: number | null
  isMedia: boolean
}

export interface MusicWebdavListing {
  entries: MusicWebdavEntry[]
  truncated: boolean
}

export function createMusicWebdavContext(input: {
  targetId: string
  config: WebdavConfig
  secret: WebdavSecret
  dir: string
}): MusicWebdavContext {
  const dir = normalizeCloudPath(input.dir, { allowEmpty: true })
  return {
    targetId: input.targetId,
    config: input.config,
    secret: input.secret,
    dir,
    base: baseUrl(input.config),
    auth: authHeader(input.config, input.secret),
  }
}

/**
 * Normalise a path relative to the music directory.
 *
 * A leading slash is accepted and dropped because listings and hand-written values both use it; the
 * result never starts with one. `..` and `.` are refused rather than collapsed: a value that tried to
 * leave the directory is not the same request as one that named a child.
 */
export function normalizeCloudPath(raw: string, options: { allowEmpty?: boolean } = {}): string {
  const value = raw.trim()
  if (!value) {
    if (options.allowEmpty !== false) return ''
    throw ApiError.badRequest('A path is required.')
  }
  if (value.length > MAX_PATH) throw ApiError.badRequest('That path is too long.')
  if (/[\u0000-\u001f\\]/.test(value)) throw ApiError.badRequest('That path contains a character WebDAV cannot carry.')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw ApiError.badRequest('Use a path relative to the music folder, not an address.')
  const segments = value.split('/').filter(Boolean)
  for (const segment of segments) {
    if (segment === '.' || segment === '..') throw ApiError.badRequest('That path tries to leave the music folder.')
  }
  return segments.join('/')
}

export function joinCloudPath(...parts: string[]): string {
  return parts.map((part) => part.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')
}

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

function directoryUrl(ctx: MusicWebdavContext, path: string): string {
  const url = new URL(childUrl(ctx.base, path))
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

function storageFailure(response: Response, action: string): ApiError {
  if (response.status === 401 || response.status === 403) {
    return new ApiError(502, 'music_storage_unavailable', 'The WebDAV server refused the saved credentials. Update the backup target and try again.')
  }
  if (response.status === 404) {
    return new ApiError(404, 'not_found', 'That file or folder no longer exists on the WebDAV server.')
  }
  if (response.status === 507) {
    return new ApiError(502, 'music_storage_unavailable', 'The WebDAV server is out of storage.')
  }
  return new ApiError(502, 'music_storage_unavailable', `The WebDAV server answered ${response.status} while ${action}.`)
}

/**
 * Turn a transport failure into the same named error a failed status produces.
 *
 * A DNS failure, a TLS refusal or a timeout arrives as a bare `TypeError` from `fetch`; without this
 * seam it would surface as a 500 that blames the worker. An abort is the reader leaving, so it is
 * rethrown untouched and the route's response is dropped with the connection.
 */
async function webdavCall<T>(action: string, work: () => Promise<T>, rethrowAbort = false): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      if (rethrowAbort) throw error
      throw new ApiError(502, 'music_storage_unavailable', `The WebDAV server did not answer in time while ${action}.`)
    }
    console.warn('[inkstone] Music WebDAV request failed:', error instanceof Error ? error.message : error)
    throw new ApiError(502, 'music_storage_unavailable', `The WebDAV server could not be reached while ${action}.`)
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response.body)
    throw new ApiError(502, 'music_storage_unavailable', 'This folder listing is too large to read at once. Open a subfolder instead.')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new ApiError(502, 'music_storage_unavailable', 'This folder listing is too large to read at once. Open a subfolder instead.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function propfind(ctx: MusicWebdavContext, path: string, depth: '0' | '1'): Promise<{ entries: WebdavPropfindEntry[], truncated: boolean }> {
  const target = depth === '0' ? childUrl(ctx.base, path) : directoryUrl(ctx, path)
  const action = depth === '0' ? 'reading that file' : 'listing that folder'
  const response = await webdavCall(action, () => webdavFetch(target, {
    method: 'PROPFIND',
    headers: {
      Authorization: ctx.auth,
      Depth: depth,
      'Content-Type': 'application/xml; charset=utf-8',
      'User-Agent': USER_AGENT,
    },
    body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:resourcetype/><D:getcontentlength/><D:getcontenttype/><D:getlastmodified/></D:prop></D:propfind>',
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  }, ctx.base.origin))
  if (!response.ok) {
    await discardBody(response.body)
    throw storageFailure(response, action)
  }
  const xml = await readLimited(response, PROPFIND_MAX_BYTES)
  return parseMultistatus(xml)
}

function relativeToMusicDir(ctx: MusicWebdavContext, href: string): string | null {
  const decoded = decodeHrefPath(href)
  // The configured base may carry percent-encoded segments (`My%20Music`); hrefs are compared after
  // both sides have been decoded, or every entry would fall outside the configured folder.
  const basePath = decodeHrefPath(ctx.base.pathname.endsWith('/') ? ctx.base.pathname : `${ctx.base.pathname}/`)
  if (!decoded.startsWith(basePath)) return null
  const fromBase = decoded.slice(basePath.length).replace(/\/+$/, '')
  if (!ctx.dir) return fromBase
  if (fromBase === ctx.dir) return ''
  if (!fromBase.startsWith(`${ctx.dir}/`)) return null
  return fromBase.slice(ctx.dir.length + 1).replace(/\/+$/, '')
}

function toEntry(entry: WebdavPropfindEntry, path: string): MusicWebdavEntry {
  const name = path.split('/').filter(Boolean).pop() ?? path
  return {
    name,
    path,
    isDirectory: entry.isCollection,
    sizeBytes: entry.sizeBytes,
    mime: entry.mime,
    modifiedAt: entry.modifiedAt,
    isMedia: isMediaEntry(entry),
  }
}

export async function listMusicDirectory(ctx: MusicWebdavContext, subPath: string): Promise<MusicWebdavListing> {
  const normalized = normalizeCloudPath(subPath, { allowEmpty: true })
  const requestPath = joinCloudPath(ctx.dir, normalized)
  let listing: { entries: WebdavPropfindEntry[], truncated: boolean }
  try {
    listing = await propfind(ctx, requestPath, '1')
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && !normalized) return { entries: [], truncated: false }
    throw error
  }
  const result: MusicWebdavEntry[] = []
  for (const entry of listing.entries) {
    const path = relativeToMusicDir(ctx, entry.href)
    if (path === null || path === '') continue
    if (path === normalized) continue
    // Depth 1 answers with direct children only; a server that ignored Depth is trimmed here.
    const parent = parentOf(path)
    if (parent !== normalized) continue
    result.push(toEntry(entry, path))
  }
  result.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  return { entries: result, truncated: listing.truncated }
}

export async function statMusicObject(ctx: MusicWebdavContext, rawPath: string): Promise<MusicWebdavEntry | null> {
  const path = normalizeCloudPath(rawPath, { allowEmpty: false })
  const requestPath = joinCloudPath(ctx.dir, path)
  try {
    const { entries } = await propfind(ctx, requestPath, '0')
    const found = entries.find((entry) => relativeToMusicDir(ctx, entry.href) === path) ?? entries[0]
    return found ? toEntry(found, path) : null
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export async function putMusicObject(
  ctx: MusicWebdavContext,
  rawPath: string,
  bytes: Uint8Array | Blob | ReadableStream<Uint8Array>,
  mime: string,
  options: { ifNoneMatch?: boolean; contentLength?: number } = {},
): Promise<void> {
  const path = normalizeCloudPath(rawPath, { allowEmpty: false })
  const parent = parentOf(path)
  // MKCOL failures carry the actionable credentials/permission answer; translate them the same way
  // the PUT below is translated instead of letting a plain Error become a 500.
  await webdavCall('creating that folder', () => ensureDirs(
    ctx.base,
    ctx.auth,
    [joinCloudPath(ctx.dir, parent)].filter(Boolean),
    new Set(),
    AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  ))
  const response = await webdavCall('uploading that file', () => webdavFetch(childUrl(ctx.base, joinCloudPath(ctx.dir, path)), {
    method: 'PUT',
    headers: {
      Authorization: ctx.auth,
      'Content-Type': mime,
      'User-Agent': USER_AGENT,
      ...(options.ifNoneMatch ? { 'If-None-Match': '*' } : {}),
      ...(options.contentLength && options.contentLength > 0
        ? { 'Content-Length': String(options.contentLength) }
        : {}),
    },
    ...uploadBodyInit(bytes),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  }, ctx.base.origin))
  await discardBody(response.body)
  if (response.status === 412) {
    throw new ApiError(409, 'conflict', 'A file with that name already exists in this folder.')
  }
  if (!response.ok) throw storageFailure(response, 'uploading that file')
}

export async function deleteMusicObject(ctx: MusicWebdavContext, rawPath: string): Promise<boolean> {
  const path = normalizeCloudPath(rawPath, { allowEmpty: false })
  const response = await webdavCall('deleting that file', () => webdavFetch(childUrl(ctx.base, joinCloudPath(ctx.dir, path)), {
    method: 'DELETE',
    headers: { Authorization: ctx.auth, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  }, ctx.base.origin))
  await discardBody(response.body)
  if (response.status === 404) return false
  if (!response.ok) throw storageFailure(response, 'deleting that file')
  return true
}

/** The upstream GET for the streaming route. Range is forwarded as the reader asked for it. */
export async function fetchMusicObject(
  ctx: MusicWebdavContext,
  rawPath: string,
  range: string | null,
  signal?: AbortSignal,
): Promise<Response> {
  const path = normalizeCloudPath(rawPath, { allowEmpty: false })
  const headers: Record<string, string> = { Authorization: ctx.auth, 'User-Agent': USER_AGENT }
  if (range) headers.Range = range
  const response = await webdavCall('reading that file', () => webdavFetch(childUrl(ctx.base, joinCloudPath(ctx.dir, path)), {
    method: 'GET',
    headers,
    signal,
  }, ctx.base.origin), true)
  if (response.status === 404) {
    await discardBody(response.body)
    throw new ApiError(404, 'not_found', 'That file no longer exists on the WebDAV server.')
  }
  if (response.status !== 200 && response.status !== 206) {
    await discardBody(response.body)
    throw storageFailure(response, 'reading that file')
  }
  return response
}
