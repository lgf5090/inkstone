/**
 * The template catalogue: where it is fetched from, how it is validated, and what a reader sees
 * after several sources are merged.
 *
 * A catalogue is public data on someone else's static host, so nothing here trusts it: URLs must be
 * HTTPS (localhost is the one debugging exception), responses are size-capped, and a body without a
 * `templates` array is a bad request rather than an empty store. The rows remember the fetch outcome
 * and the ETag; the parsed documents live in a five-minute in-memory cache in front of a copy in the
 * bucket, so a cold isolate still has something to show when the host answers 304.
 */
import type { Env } from '../env'
import { newId } from '../lib/id'
import { ApiError } from '../lib/errors'

export type CatalogTemplateType = 'worker' | 'pages' | 'hybrid'

export interface CatalogSourceRef {
  kind?: string
  url?: string
  [key: string]: unknown
}

export interface CatalogBinding {
  type: string
  name: string
  title?: string
  secret?: boolean
  required?: boolean
  action?: string
  [key: string]: unknown
}

export interface CatalogTemplate {
  id: string
  name: string
  type?: CatalogTemplateType
  version?: string
  description?: string
  source?: CatalogSourceRef
  sources?: {
    worker?: CatalogSourceRef
    pages?: CatalogSourceRef
    [key: string]: CatalogSourceRef | undefined
  }
  bindings?: CatalogBinding[]
  env?: Record<string, string>
  compatibility_date?: string
  compatibility_flags?: string[]
  [key: string]: unknown
}

export interface Catalog {
  name?: string
  templates: CatalogTemplate[]
  [key: string]: unknown
}

export interface CatalogSourceRow {
  id: string
  user_id: string
  url: string
  name: string
  is_default: number
  enabled: number
  last_synced: number | null
  last_status: string
  last_error: string | null
  etag: string | null
  created_at: number
}

export interface CatalogSourceView extends CatalogSourceRow {
  template_count?: number
}

export interface TemplateItem {
  template: CatalogTemplate
  sourceId: string
  sourceName: string
  sourceCount: number
}

export interface CatalogueResult {
  templates: TemplateItem[]
  sources: CatalogSourceView[]
}

export interface TemplateMatch {
  template: CatalogTemplate
  source: CatalogSourceRow
}

export interface TemplateSources {
  worker?: string
  pages?: string
}

/** The catalogue a reader starts with; three addresses of the same public store. */
export const DEFAULT_CATALOG_SOURCES: ReadonlyArray<{ url: string; name: string; is_default: number }> = [
  { url: 'https://cf-store.surge.sh/catalog.json', name: 'Official catalog', is_default: 1 },
  { url: 'https://cdn.jsdelivr.net/gh/hefy2027/cf-store@main/catalog.json', name: 'Official mirror (jsDelivr)', is_default: 0 },
  { url: 'https://raw.githubusercontent.com/hefy2027/cf-store/main/catalog.json', name: 'Official mirror (GitHub)', is_default: 0 },
]

const MAX_CATALOG_BYTES = 5 * 1024 * 1024
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024
const CATALOG_CACHE_TTL_MS = 5 * 60_000
const CATALOG_TIMEOUT_MS = 15_000
const TEMPLATE_TIMEOUT_MS = 30_000
const MAX_SOURCE_NAME_CHARS = 120
const MAX_ERROR_CHARS = 300

const SOURCE_COLUMNS = `id, user_id, url, name, is_default, enabled, last_synced, last_status,
  last_error, etag, created_at`

interface CachedCatalog {
  catalog: Catalog
  etag: string | null
  fetchedAt: number
}

const catalogCache = new Map<string, CachedCatalog>()

/**
 * Where the documents outlive the isolate.
 *
 * The memory cache answers in one read; the bucket answers after a cold start, which is the case it
 * exists for: without a stored document a 304 has nothing behind it and the whole file is downloaded
 * again. Keys are the source URL, so two readers on the same mirror share one object.
 */
const CATALOG_DOCUMENT_PREFIX = 'cloudflare/json/catalogs/'

function catalogDocumentKey(url: string): string {
  return `${CATALOG_DOCUMENT_PREFIX}${encodeURIComponent(url)}.json`
}

async function readStoredCatalog(env: Env, url: string): Promise<{ catalog: Catalog; etag: string | null } | null> {
  if (!env.FILES) return null
  try {
    const object = await env.FILES.get(catalogDocumentKey(url))
    if (!object) return null
    const parsed = JSON.parse(await object.text()) as { etag?: unknown; catalog?: unknown } | null
    if (!parsed || typeof parsed !== 'object' || !parsed.catalog || typeof parsed.catalog !== 'object') return null
    return { catalog: parsed.catalog as Catalog, etag: typeof parsed.etag === 'string' ? parsed.etag : null }
  } catch (error) {
    console.warn('[inkstone] Stored catalog could not be read:', errorMessage(error))
    return null
  }
}

async function storeCatalog(env: Env, url: string, catalog: Catalog, etag: string | null): Promise<void> {
  if (!env.FILES) return
  try {
    await env.FILES.put(catalogDocumentKey(url), JSON.stringify({ etag, catalog }), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    })
  } catch (error) {
    // Best-effort: the reader already has the document, and the next fetch will try again.
    console.warn('[inkstone] Stored catalog could not be written:', errorMessage(error))
  }
}

/** Tests start from an empty cache; production never needs to. */
export function resetCatalogCache(): void {
  catalogCache.clear()
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`
}

function isLocalDebugHost(url: URL): boolean {
  // The loopback allowance is a local-development convenience only: in a deployed Worker the same
  // exception would let a catalogue point this fetch at the notebook's own API.
  if (import.meta.env?.DEV !== true) return false
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}

/** A catalogue address: HTTPS everywhere, plain HTTP only for a loopback debug host. */
export function assertCatalogUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw ApiError.badRequest('The catalog URL is not a valid URL')
  }
  if (url.protocol !== 'https:' && !isLocalDebugHost(url)) {
    throw ApiError.badRequest('Catalog URLs must use HTTPS (http://localhost is allowed for debugging)')
  }
  return url
}

/** A template source is code or an archive that will be deployed: HTTPS, no exception. */
export function assertTemplateUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw ApiError.badRequest('The template source URL is not a valid URL')
  }
  if (url.protocol !== 'https:') throw ApiError.badRequest('Template sources must use HTTPS')
  return url
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { redirect: 'follow', ...init, signal: controller.signal })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new ApiError(502, 'cloudflare_upstream', `${what} did not answer in time`)
    }
    throw new ApiError(
      502,
      'cloudflare_upstream',
      `${what} could not be reached: ${errorMessage(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Reads a response with a hard ceiling, cancelling the stream as soon as it is crossed. */
async function readCapped(response: Response, cap: number, what: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > cap) {
    throw ApiError.badRequest(`${what} is larger than ${formatBytes(cap)}`)
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > cap) throw ApiError.badRequest(`${what} is larger than ${formatBytes(cap)}`)
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) {
        throw ApiError.badRequest(`${what} is larger than ${formatBytes(cap)}`)
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export interface FetchCatalogResult {
  catalog: Catalog | null
  etag: string | null
  notModified: boolean
}

/**
 * One conditional request. A 304 is an answer, not an empty catalog: the caller owns the cached
 * document and decides what to reuse.
 */
export async function fetchCatalog(rawUrl: string, etag?: string | null): Promise<FetchCatalogResult> {
  const url = assertCatalogUrl(rawUrl)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (etag) headers['If-None-Match'] = etag
  const response = await fetchGuarded(url.toString(), { headers }, assertCatalogUrl, CATALOG_TIMEOUT_MS, 'The catalog host')
  const responseEtag = response.headers.get('etag')
  if (response.status === 304) {
    return { catalog: null, etag: responseEtag ?? etag ?? null, notModified: true }
  }
  if (!response.ok) {
    throw new ApiError(502, 'cloudflare_upstream', `The catalog URL answered HTTP ${response.status}`)
  }
  const bytes = await readCapped(response, MAX_CATALOG_BYTES, 'The catalog')
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw ApiError.badRequest('The catalog is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ApiError.badRequest('The catalog must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const rawTemplates = record.templates
  if (!Array.isArray(rawTemplates)) {
    throw ApiError.badRequest('The catalog has no templates array')
  }
  const templates: CatalogTemplate[] = []
  for (const entry of rawTemplates) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw ApiError.badRequest('The catalog contains a template that is not an object')
    }
    const item = entry as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id.trim()) {
      throw ApiError.badRequest('The catalog contains a template without an id')
    }
    const id = item.id.trim()
    templates.push({
      ...item,
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : id,
    } as CatalogTemplate)
  }
  return {
    catalog: { ...record, templates } as Catalog,
    etag: responseEtag,
    notModified: false,
  }
}

/**
 * The cached document for one URL, refreshed at most every five minutes.
 *
 * `force` is used by `/refresh`, which must ask the host even when the cache is warm. A conditional
 * request whose 304 has no cached document behind it (a different isolate answered the earlier
 * request) is retried unconditionally, because a 304 alone cannot rebuild a catalogue.
 */
export async function loadCatalog(
  env: Env,
  url: string,
  options: { etag?: string | null; force?: boolean } = {},
): Promise<{ catalog: Catalog; etag: string | null }> {
  const cached = catalogCache.get(url)
  if (!options.force && cached && Date.now() - cached.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return { catalog: cached.catalog, etag: cached.etag }
  }

  const stored = cached ? null : await readStoredCatalog(env, url)
  const knownEtag = cached?.etag ?? stored?.etag ?? options.etag ?? null
  let result = await fetchCatalog(url, knownEtag)
  if (result.notModified) {
    const behind = cached ?? stored
    if (behind) {
      const etag = result.etag ?? behind.etag
      catalogCache.set(url, { catalog: behind.catalog, etag, fetchedAt: Date.now() })
      return { catalog: behind.catalog, etag }
    }
    result = await fetchCatalog(url, null)
    if (result.notModified) {
      throw new ApiError(502, 'cloudflare_upstream', 'The catalog answered 304 without a cached copy')
    }
  }
  if (!result.catalog) {
    throw new ApiError(502, 'cloudflare_upstream', 'The catalog answered without a document')
  }
  catalogCache.set(url, { catalog: result.catalog, etag: result.etag, fetchedAt: Date.now() })
  await storeCatalog(env, url, result.catalog, result.etag)
  return { catalog: result.catalog, etag: result.etag }
}

/** The template source bytes, capped at 2 MB so a hostile URL cannot exhaust the isolate. */
/** Hosts a worker must never be talked into reaching: loopback, private, link-local, CGNAT. */
function isPrivateHost(host: string): boolean {
  const name = host.toLowerCase()
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1' || name === '[::1]') return true
  if (name === '0.0.0.0' || name === '[::]' || name === '169.254.169.254') return true
  if (name.startsWith('fc') || name.startsWith('fd') || name.startsWith('fe80:')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
    const [a, b] = name.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 100 && b >= 64 && b <= 127) return true
  }
  return false
}

/** A README, an image or a template package is someone else's text: it may not name our own network. */
function assertPublicHttps(rawUrl: string): URL {
  const url = assertTemplateUrl(rawUrl)
  if (isPrivateHost(url.hostname)) throw ApiError.badRequest('That address is not a public host')
  return url
}

const MAX_REDIRECT_HOPS = 3

/**
 * Fetch with the URL guard applied to every hop, not just the first one.
 *
 * Following redirects automatically hands the choice of destination to the remote server, which is
 * exactly the decision the guard exists to make: a public README can answer 302 with a link-local
 * metadata address and have this worker read it on the caller's behalf.
 */
async function fetchGuarded(
  rawUrl: string,
  init: Omit<RequestInit, 'redirect'>,
  guard: (url: string) => URL,
  timeoutMs: number,
  what: string,
): Promise<Response> {
  let url = guard(rawUrl)
  for (let hop = 0; ; hop += 1) {
    const response = await fetchWithTimeout(url.toString(), { ...init, redirect: 'manual' }, timeoutMs, what)
    const redirects = new Set([301, 302, 303, 307, 308])
    if (!redirects.has(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    await response.body?.cancel().catch(() => undefined)
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new ApiError(502, 'cloudflare_upstream', `${what} redirected too many times`)
    }
    url = guard(new URL(location, url).toString())
  }
}

const MAX_README_BYTES = 512 * 1024

/** The template's README, read by the worker because the reader's CSP does not allow the catalog host. */
export async function downloadReadme(rawUrl: string): Promise<string> {
  const response = await fetchGuarded(
    rawUrl,
    { headers: { Accept: 'text/plain, text/markdown, */*' } },
    assertPublicHttps,
    TEMPLATE_TIMEOUT_MS,
    'The template readme',
  )
  if (!response.ok) {
    throw new ApiError(502, 'cloudflare_upstream', `The readme answered HTTP ${response.status}`)
  }
  const bytes = await readCapped(response, MAX_README_BYTES, 'The template readme')
  return new TextDecoder().decode(bytes)
}

const MAX_README_IMAGE_BYTES = 2 * 1024 * 1024

/**
 * A picture a README refers to, read by the worker for the same reason as the README itself: the
 * reader's `img-src` does not allow the documentation host.
 */
export async function downloadReadmeImage(rawUrl: string): Promise<{ bytes: Uint8Array; type: string }> {
  const response = await fetchGuarded(
    rawUrl,
    { headers: { Accept: 'image/*' } },
    assertPublicHttps,
    TEMPLATE_TIMEOUT_MS,
    'The readme image',
  )
  if (!response.ok) {
    throw new ApiError(502, 'cloudflare_upstream', `The readme image answered HTTP ${response.status}`)
  }
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
  if (!type.startsWith('image/')) {
    throw new ApiError(502, 'cloudflare_upstream', 'That readme address is not a picture')
  }
  const bytes = await readCapped(response, MAX_README_IMAGE_BYTES, 'The readme image')
  return { bytes, type }
}

export async function downloadTemplateBytes(rawUrl: string): Promise<Uint8Array> {
  const response = await fetchGuarded(
    rawUrl,
    { headers: { Accept: '*/*' } },
    assertTemplateUrl,
    TEMPLATE_TIMEOUT_MS,
    'The template source',
  )
  if (!response.ok) {
    throw new ApiError(502, 'cloudflare_upstream', `The template source answered HTTP ${response.status}`)
  }
  return await readCapped(response, MAX_TEMPLATE_BYTES, 'The template source')
}

/**
 * The downloadable halves a template declares.
 *
 * A single `source` is a script for a worker template and a zip for a pages template; a hybrid
 * template names both halves under `sources`. A hybrid that only ships a script therefore has a
 * Worker half and no Pages half, which is what lets deploy refuse a half deploy instead of
 * uploading one half and failing the other.
 */
export function templateSources(template: CatalogTemplate): TemplateSources {
  const single = typeof template.source?.url === 'string' ? template.source.url : undefined
  const workerUrl = typeof template.sources?.worker?.url === 'string' ? template.sources.worker.url : single
  const pagesUrl = typeof template.sources?.pages?.url === 'string'
    ? template.sources.pages.url
    : template.type === 'pages'
      ? single
      : undefined
  return { worker: workerUrl, pages: pagesUrl }
}

export function templateType(template: CatalogTemplate): CatalogTemplateType {
  return template.type === 'pages' || template.type === 'hybrid' ? template.type : 'worker'
}

export async function listSources(env: Env, userId: string): Promise<CatalogSourceView[]> {
  const rows = await env.DB.prepare(
    `SELECT ${SOURCE_COLUMNS} FROM cloudflare_catalog_source
      WHERE user_id = ? ORDER BY is_default DESC, created_at ASC, id ASC`,
  )
    .bind(userId)
    .all<CatalogSourceRow>()
  return (rows.results ?? []).map((row) => {
    const cached = catalogCache.get(row.url)
    return cached ? { ...row, template_count: cached.catalog.templates.length } : { ...row }
  })
}

export async function getSourceRow(env: Env, userId: string, id: string): Promise<CatalogSourceRow | null> {
  return await env.DB.prepare(
    `SELECT ${SOURCE_COLUMNS} FROM cloudflare_catalog_source WHERE user_id = ? AND id = ?`,
  )
    .bind(userId, id)
    .first<CatalogSourceRow>()
}

async function listEnabledSources(env: Env, userId: string): Promise<CatalogSourceRow[]> {
  const rows = await env.DB.prepare(
    `SELECT ${SOURCE_COLUMNS} FROM cloudflare_catalog_source
      WHERE user_id = ? AND enabled = 1 ORDER BY is_default DESC, created_at ASC, id ASC`,
  )
    .bind(userId)
    .all<CatalogSourceRow>()
  return rows.results ?? []
}

export async function addSource(
  env: Env,
  userId: string,
  rawUrl: string,
  rawName: string,
): Promise<CatalogSourceView> {
  const name = rawName.trim()
  if (!name) throw ApiError.badRequest('A source name is required')
  if (name.length > MAX_SOURCE_NAME_CHARS) {
    throw ApiError.badRequest(`The source name is longer than ${MAX_SOURCE_NAME_CHARS} characters`)
  }
  const url = assertCatalogUrl(rawUrl).toString()
  const existing = await env.DB.prepare(
    'SELECT id FROM cloudflare_catalog_source WHERE user_id = ? AND url = ?',
  )
    .bind(userId, url)
    .first<{ id: string }>()
  if (existing) throw ApiError.conflict('That catalog source is already added')

  const { catalog, etag } = await fetchCatalog(url)
  if (!catalog) throw ApiError.badRequest('The catalog could not be read')
  const id = newId()
  const now = Date.now()
  try {
    await env.DB.prepare(
      `INSERT INTO cloudflare_catalog_source
        (id, user_id, url, name, is_default, enabled, last_synced, last_status, last_error, etag, created_at)
       VALUES (?, ?, ?, ?, 0, 1, ?, 'success', NULL, ?, ?)`,
    )
      .bind(id, userId, url, name, now, etag, now)
      .run()
  } catch (error) {
    if (/UNIQUE/i.test(errorMessage(error))) {
      throw ApiError.conflict('That catalog source is already added')
    }
    throw error
  }
  catalogCache.set(url, { catalog, etag, fetchedAt: now })
  await storeCatalog(env, url, catalog, etag)
  const row = await getSourceRow(env, userId, id)
  if (!row) throw new ApiError(500, 'internal', 'The catalog source was written but cannot be read back')
  return { ...row, template_count: catalog.templates.length }
}

export async function updateSource(
  env: Env,
  userId: string,
  id: string,
  patch: { name?: string; enabled?: boolean },
): Promise<CatalogSourceRow> {
  const row = await getSourceRow(env, userId, id)
  if (!row) throw ApiError.notFound('That catalog source does not exist')
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw ApiError.badRequest('A source name is required')
    if (name.length > MAX_SOURCE_NAME_CHARS) {
      throw ApiError.badRequest(`The source name is longer than ${MAX_SOURCE_NAME_CHARS} characters`)
    }
    sets.push('name = ?')
    values.push(name)
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?')
    values.push(patch.enabled ? 1 : 0)
  }
  if (sets.length === 0) throw ApiError.badRequest('No fields to update')
  await env.DB.prepare(
    `UPDATE cloudflare_catalog_source SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`,
  )
    .bind(...values, userId, id)
    .run()
  const fresh = await getSourceRow(env, userId, id)
  if (!fresh) throw ApiError.notFound('That catalog source does not exist')
  return fresh
}

export async function deleteSource(env: Env, userId: string, id: string): Promise<void> {
  const result = await env.DB.prepare(
    'DELETE FROM cloudflare_catalog_source WHERE user_id = ? AND id = ?',
  )
    .bind(userId, id)
    .run()
  if ((result.meta?.changes ?? 0) === 0) throw ApiError.notFound('That catalog source does not exist')
}

/**
 * The three official sources, seeded exactly once per reader.
 *
 * "Once" is decided by the reader having no rows at all: re-seeding whenever a default is missing
 * would resurrect a source the reader deleted every time the store screen opened.
 */
export async function seedDefaultSources(env: Env, userId: string): Promise<number> {
  const count = await env.DB.prepare(
    'SELECT count(*) AS n FROM cloudflare_catalog_source WHERE user_id = ?',
  )
    .bind(userId)
    .first<{ n: number }>()
  if ((count?.n ?? 0) > 0) return 0

  const now = Date.now()
  const statements = DEFAULT_CATALOG_SOURCES.map((source) => env.DB.prepare(
    `INSERT OR IGNORE INTO cloudflare_catalog_source
      (id, user_id, url, name, is_default, enabled, last_synced, last_status, last_error, etag, created_at)
     VALUES (?, ?, ?, ?, ?, 1, NULL, 'pending', NULL, NULL, ?)`,
  ).bind(newId(), userId, source.url, source.name, source.is_default, now))
  await env.DB.batch(statements)
  return statements.length
}

/**
 * Merge every enabled source, first source wins, and count how many sources carry each template.
 *
 * A failing source never removes another source's templates. On `/refresh` the failure is written
 * to the row; on a plain read it only shapes this response. A stale cached document still
 * contributes, because hiding a whole catalogue over one unreachable mirror is worse than showing
 * yesterday's list beside an error row.
 */
export async function collectCatalogue(
  env: Env,
  userId: string,
  options: { refresh: boolean },
): Promise<CatalogueResult> {
  const rows = await listEnabledSources(env, userId)
  // The three mirrors are independent hosts; asking them one after another made a first visit wait
  // for the sum of their latencies. `Promise.all` keeps the row order (first source still wins) while
  // the network waits overlap.
  const loaded = await Promise.all(rows.map(async (row): Promise<{ row: CatalogSourceRow; catalog: Catalog | null }> => {
    try {
      const { catalog, etag } = await loadCatalog(env, row.url, { etag: row.etag, force: options.refresh })
      const synced = options.refresh ? Date.now() : row.last_synced
      if (options.refresh) {
        await env.DB.prepare(
          `UPDATE cloudflare_catalog_source
              SET last_synced = ?, last_status = 'success', last_error = NULL, etag = ?
            WHERE user_id = ? AND id = ?`,
        )
          .bind(synced, etag, userId, row.id)
          .run()
      }
      return {
        row: { ...row, last_synced: synced, last_status: 'success', last_error: null, etag: etag ?? row.etag },
        catalog,
      }
    } catch (error) {
      const message = errorMessage(error).slice(0, MAX_ERROR_CHARS)
      console.warn(`[inkstone] Catalog source "${row.name}" failed: ${message}`)
      const synced = options.refresh ? Date.now() : row.last_synced
      if (options.refresh) {
        await env.DB.prepare(
          `UPDATE cloudflare_catalog_source
              SET last_synced = ?, last_status = 'error', last_error = ?
            WHERE user_id = ? AND id = ?`,
        )
          .bind(synced, message, userId, row.id)
          .run()
      }
      return {
        row: { ...row, last_synced: synced, last_status: 'error', last_error: message },
        catalog: catalogCache.get(row.url)?.catalog ?? null,
      }
    }
  }))

  const providers = new Map<string, number>()
  const seen = new Set<string>()
  const templates: TemplateItem[] = []
  for (const { row, catalog } of loaded) {
    if (!catalog) continue
    const ids = new Set(catalog.templates.map((template) => template.id))
    for (const id of ids) providers.set(id, (providers.get(id) ?? 0) + 1)
    for (const template of catalog.templates) {
      if (seen.has(template.id)) continue
      seen.add(template.id)
      templates.push({ template, sourceId: row.id, sourceName: row.name, sourceCount: 0 })
    }
  }
  for (const item of templates) item.sourceCount = providers.get(item.template.id) ?? 1

  return {
    templates,
    sources: loaded.map(({ row, catalog }) => ({
      ...row,
      ...(catalog ? { template_count: catalog.templates.length } : {}),
    })),
  }
}

/** The first enabled source that carries this template, in the same order the store lists them. */
export async function findTemplate(
  env: Env,
  userId: string,
  templateId: string,
): Promise<TemplateMatch | null> {
  const sources = await listEnabledSources(env, userId)
  for (const source of sources) {
    try {
      const { catalog } = await loadCatalog(env, source.url, { etag: source.etag })
      const template = catalog.templates.find((item) => item.id === templateId)
      if (template) return { template, source }
    } catch (error) {
      console.warn(`[inkstone] Catalog source "${source.name}" failed: ${errorMessage(error)}`)
    }
  }
  return null
}

export function templateHasPagesSource(template: CatalogTemplate): boolean {
  return Boolean(templateSources(template).pages)
}
