/**
 * Alist as a music drive: a registered server, a folder under it, and the JSON API its own client
 * uses. The token never leaves the worker and never appears in a listing; only the four browser
 * calls this page needs are exposed (list, search, mount management).
 *
 * The address rules are the same trust boundary as every other outbound reader: HTTPS, no credentials
 * in the URL, no loopback or private literal, and no redirects. Alist may return media entries from
 * any folder, so the path is normalised and re-anchored to the configured root before it is shown.
 */
import { decryptMusicMountToken } from '../../lib/crypto'
import { ApiError } from '../../lib/errors'
import type { Env } from '../../env'
import { MusicStore } from '../store'
import type { MusicMount } from '@shared/music/model'

const MAX_PATH = 1_024
const MAX_NAME = 120
const MAX_TOKEN = 4_096
const MAX_URL = 2_048
const LIST_PAGE_SIZE = 200
const SEARCH_PAGE_SIZE = 100
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024
const REQUEST_DEADLINE_MS = 10_000
const MEDIA_RE = /\.(?:mp3|m4a|mp4|flac|wav|wave|ogg|oga|opus|aac|webm|mov|m4v)$/i
const PRIVATE_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|0(?:\.\d{1,3}){3}|\[?::1\]?)$/i

export interface MusicAlistEntry {
  name: string
  /** Relative to the mount's root path. */
  path: string
  isDirectory: boolean
  sizeBytes: number
  modifiedAt: number | null
  isMedia: boolean
}

export interface MusicAlistListing {
  path: string
  entries: MusicAlistEntry[]
  truncated: boolean
}

export interface MusicAlistMountInput {
  name: string
  baseUrl: string
  rootPath?: string
  token: string
}

export interface MusicAlistMountPatch {
  name?: string
  baseUrl?: string
  rootPath?: string
  /** Absent keeps the saved token; an empty string clears it. */
  token?: string
}

interface AlistContext {
  mount: MusicMount
  base: URL
  root: string
  token: string
}

interface AlistResponse<T> {
  code?: number
  message?: string
  data?: T
}

function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw ApiError.badRequest(`${label} must be text.`)
  const trimmed = value.trim()
  if (!trimmed) throw ApiError.badRequest(`${label} is required.`)
  if (trimmed.length > max) throw ApiError.badRequest(`${label} is too long.`)
  return trimmed
}

function optionalText(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw ApiError.badRequest(`${label} must be text.`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw ApiError.badRequest(`${label} is too long.`)
  return trimmed
}

/** A folder or file path relative to the mount root; parent segments are refused, not collapsed. */
export function normalizeAlistPath(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (value.length > MAX_PATH) throw ApiError.badRequest('That path is too long.')
  if (/[\u0000-\u001f\\]/.test(value)) throw ApiError.badRequest('That path contains a character Alist cannot carry.')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw ApiError.badRequest('Use a path relative to the mount, not an address.')
  const segments = value.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw ApiError.badRequest('That path tries to leave the mount.')
  }
  return segments.join('/')
}

export function normalizeAlistBaseUrl(raw: string): string {
  const value = text(raw, MAX_URL, 'Alist address')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw ApiError.badRequest('The Alist address is not a valid URL.')
  }
  if (url.protocol !== 'https:') throw ApiError.badRequest('The Alist address must use HTTPS.')
  if (url.username || url.password) throw ApiError.badRequest('The Alist address may not carry credentials.')
  if (url.search || url.hash) throw ApiError.badRequest('The Alist address may not carry a query or fragment.')
  if (isPrivateHostname(url.hostname)) {
    throw ApiError.badRequest('The Alist address must be a public host, not this machine or a private network.')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url.toString()
}

export function normalizeAlistRoot(raw: string | undefined): string {
  if (raw === undefined) return '/'
  const path = normalizeAlistPath(raw)
  return path ? `/${path}` : '/'
}

export function joinAlistPath(root: string, path: string): string {
  const base = root === '/' ? '' : root.replace(/\/+$/, '')
  const child = path.replace(/^\/+|\/+$/g, '')
  return child ? `${base}/${child}` : base || '/'
}

export function relativeAlistPath(root: string, absolute: string): string | null {
  const value = absolute.startsWith('/') ? absolute : `/${absolute}`
  const base = root === '/' ? '' : root.replace(/\/+$/, '')
  if (base) {
    if (value === base) return ''
    if (!value.startsWith(`${base}/`)) return null
    return value.slice(base.length + 1)
  }
  return value.replace(/^\/+/, '')
}

function isMediaName(name: string): boolean {
  return MEDIA_RE.test(name)
}

function isPrivateHostname(hostname: string): boolean {
  return PRIVATE_HOST_RE.test(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')
}

async function readJsonLimited(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > RESPONSE_MAX_BYTES) {
    throw new ApiError(502, 'music_storage_unavailable', 'The Alist response is too large to read.')
  }
  const body = await response.text()
  if (body.length > RESPONSE_MAX_BYTES) {
    throw new ApiError(502, 'music_storage_unavailable', 'The Alist response is too large to read.')
  }
  if (!body.trim()) return null
  try {
    return JSON.parse(body)
  } catch {
    throw new ApiError(502, 'music_storage_unavailable', 'The Alist server answered with something that is not JSON.')
  }
}

async function alistRequest<T>(ctx: AlistContext, endpoint: string, body: Record<string, unknown>): Promise<T> {
  const url = new URL(endpoint.replace(/^\/+/, ''), ctx.base)
  if (url.origin !== ctx.base.origin || isPrivateHostname(url.hostname)) {
    throw new ApiError(502, 'music_storage_unavailable', 'The Alist server asked for an address this app will not call.')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      // The edge runtime implements only follow/manual; a redirect is refused below, not followed.
      redirect: 'manual',
      headers: {
        Authorization: ctx.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError(502, 'music_storage_unavailable', 'The Alist server did not answer in time.')
    }
    console.warn('[inkstone] Alist request failed:', error)
    throw new ApiError(502, 'music_storage_unavailable', 'The Alist server could not be reached.')
  } finally {
    clearTimeout(timer)
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined)
    throw new ApiError(502, 'music_storage_unavailable', 'The Alist server redirected this request. Enter the final HTTPS address instead.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(502, 'music_storage_unavailable', 'The Alist server refused the saved token. Edit the mount and try again.')
    }
    throw new ApiError(502, 'music_storage_unavailable', `The Alist server answered ${response.status}.`)
  }
  const parsed = await readJsonLimited(response) as AlistResponse<T> | null
  if (!parsed || (parsed.code !== undefined && parsed.code !== 200)) {
    throw new ApiError(502, 'music_storage_unavailable', parsed?.message?.slice(0, 200) || 'The Alist server refused the request.')
  }
  return parsed.data as T
}

export async function resolveAlistMount(env: Env, store: MusicStore, id: string): Promise<AlistContext> {
  const mount = await store.getMount(id)
  if (!mount) throw ApiError.notFound('That Alist mount does not exist.')
  if (mount.kind !== 'alist') throw ApiError.badRequest('That mount is not an Alist mount.')
  const secret = await store.getMountSecret(id)
  if (!secret) {
    throw new ApiError(503, 'music_storage_unavailable', 'This Alist mount has no saved token. Edit it and try again.')
  }
  const token = await decryptMusicMountToken(env, id, secret)
  if (!token) {
    throw new ApiError(503, 'music_storage_unavailable', 'The Alist token could not be read. Edit the mount and enter it again.')
  }
  return {
    mount,
    base: new URL(mount.baseUrl.endsWith('/') ? mount.baseUrl : `${mount.baseUrl}/`),
    root: normalizeAlistRoot(mount.rootPath),
    token,
  }
}

interface AlistRawEntry {
  name?: unknown
  parent?: unknown
  is_dir?: unknown
  size?: unknown
  modified?: unknown
}

function toEntry(raw: AlistRawEntry, root: string, expectedParent: string): MusicAlistEntry | null {
  if (typeof raw.name !== 'string' || !raw.name) return null
  const parent = typeof raw.parent === 'string' ? raw.parent : expectedParent
  const absolute = parent.endsWith('/') ? `${parent}${raw.name}` : `${parent}/${raw.name}`
  const path = relativeAlistPath(root, absolute)
  if (path === null) return null
  const isDirectory = raw.is_dir === true
  return {
    name: raw.name,
    path,
    isDirectory,
    sizeBytes: typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0 ? Math.trunc(raw.size) : 0,
    modifiedAt: typeof raw.modified === 'string' && Number.isFinite(Date.parse(raw.modified)) ? Date.parse(raw.modified) : null,
    isMedia: isDirectory || isMediaName(raw.name),
  }
}

function sortEntries(entries: MusicAlistEntry[]): MusicAlistEntry[] {
  return entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

export async function listAlistDirectory(ctx: AlistContext, rawPath: string): Promise<MusicAlistListing> {
  const path = normalizeAlistPath(rawPath)
  const data = await alistRequest<{ content?: AlistRawEntry[] | null }>(ctx, '/api/fs/list', {
    path: joinAlistPath(ctx.root, path),
    page: 1,
    per_page: LIST_PAGE_SIZE,
    refresh: false,
  })
  const expectedParent = joinAlistPath(ctx.root, path)
  const entries: MusicAlistEntry[] = []
  for (const raw of data?.content ?? []) {
    const entry = toEntry(raw, ctx.root, expectedParent)
    if (entry) entries.push(entry)
  }
  return { path, entries: sortEntries(entries), truncated: (data?.content?.length ?? 0) >= LIST_PAGE_SIZE }
}

export async function searchAlist(ctx: AlistContext, rawKeywords: string): Promise<MusicAlistEntry[]> {
  const keywords = text(rawKeywords, 200, 'Search keywords')
  const data = await alistRequest<{ content?: AlistRawEntry[] | null }>(ctx, '/api/fs/search', {
    parent: ctx.root,
    keywords,
    page: 1,
    per_page: SEARCH_PAGE_SIZE,
    scope: 0,
  })
  const entries: MusicAlistEntry[] = []
  for (const raw of data?.content ?? []) {
    const entry = toEntry(raw, ctx.root, ctx.root)
    if (entry && !entry.isDirectory && entry.isMedia) entries.push(entry)
  }
  return sortEntries(entries)
}

export interface AlistFileInfo {
  name: string
  sizeBytes: number
  isDirectory: boolean
  rawUrl: string
}

interface AlistRawFile {
  name?: unknown
  size?: unknown
  is_dir?: unknown
  raw_url?: unknown
}

function mediaUrl(ctx: AlistContext, raw: string): URL {
  let url: URL
  try {
    url = new URL(raw, ctx.base)
  } catch {
    throw new ApiError(502, 'music_storage_unavailable', 'The Alist file address is not valid.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || isPrivateHostname(url.hostname)) {
    throw new ApiError(502, 'music_storage_unavailable', 'The Alist file address is not allowed.')
  }
  return url
}

/** Metadata for one file; the caller imports only files that report a size and a media name. */
export async function statAlistFile(ctx: AlistContext, rawPath: string): Promise<AlistFileInfo> {
  const path = normalizeAlistPath(rawPath)
  const data = await alistRequest<AlistRawFile>(ctx, '/api/fs/get', {
    path: joinAlistPath(ctx.root, path),
  })
  const name = typeof data?.name === 'string' && data.name ? data.name : path.split('/').pop() ?? path
  return {
    name,
    sizeBytes: typeof data?.size === 'number' && Number.isFinite(data.size) && data.size >= 0 ? Math.trunc(data.size) : 0,
    isDirectory: data?.is_dir === true,
    rawUrl: typeof data?.raw_url === 'string' ? data.raw_url : '',
  }
}

/**
 * Fetch the bytes through the mount's download address. A redirect is followed only when the next
 * hop is another public HTTPS address; the token is never sent to the file host.
 */
export async function fetchAlistStream(
  ctx: AlistContext,
  path: string,
  range: string | null,
  signal: AbortSignal,
): Promise<Response> {
  const info = await statAlistFile(ctx, path)
  if (info.isDirectory || !info.rawUrl) {
    throw new ApiError(502, 'music_source_unavailable', 'The Alist file has no playable download address.')
  }
  let url = mediaUrl(ctx, info.rawUrl)
  for (let redirects = 0; ; redirects += 1) {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: range ? { Range: range } : undefined,
        signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new ApiError(502, 'music_source_unavailable', 'The Alist file host could not be reached.')
    }
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!location) throw new ApiError(502, 'music_source_unavailable', 'The Alist file host redirected without a location.')
    if (redirects >= 3) throw new ApiError(502, 'music_source_unavailable', 'The Alist file host redirected too many times.')
    try {
      url = mediaUrl(ctx, new URL(location, url).toString())
    } catch {
      throw new ApiError(502, 'music_source_unavailable', 'The Alist file host redirected to an address this app will not follow.')
    }
  }
}

export async function testAlistMount(ctx: AlistContext): Promise<void> {
  await listAlistDirectory(ctx, '')
}

export const ALIST_LIMITS = {
  name: MAX_NAME,
  token: MAX_TOKEN,
  url: MAX_URL,
} as const

export function alistMountName(value: unknown): string {
  return text(value, MAX_NAME, 'Mount name')
}

export function alistMountBaseUrl(value: unknown): string {
  return normalizeAlistBaseUrl(text(value, MAX_URL, 'Alist address'))
}

export function alistMountRoot(value: unknown): string {
  return normalizeAlistRoot(optionalText(value, MAX_PATH, 'Root path'))
}

export function alistMountToken(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined
  return text(value, MAX_TOKEN, 'Alist token')
}
