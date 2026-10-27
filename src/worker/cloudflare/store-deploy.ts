/**
 * Deploying a catalogue template: one Worker half, one Pages half, and the rule that neither half
 * starts until both have been validated.
 *
 * The Worker endpoint is the same multipart upload wrangler performs. The Pages endpoint is a direct
 * upload: a project is created when missing, the template's zip is read in memory, and every asset is
 * sent once under the hash the manifest names it by. Multipart bodies bypass `cfFetch` because that
 * helper always serialises JSON; the auth headers are still the shared ones.
 */
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import {
  CF_API_BASE,
  CloudflareApiError,
  authHeaders,
  cfFetch,
  cfFetchRaw,
  upstreamApiError,
  type CloudflareAuth,
} from './cf-api'
import type { LoadedAccount } from './accounts'
import {
  downloadTemplateBytes,
  errorMessage,
  templateSources,
  templateType,
  type CatalogTemplate,
  type TemplateSources,
} from './catalog'

export type DeployType = 'worker' | 'pages' | 'both'

const DEFAULT_COMPATIBILITY_DATE = '2024-11-01'
const DEPLOY_TIMEOUT_MS = 120_000
const MAX_BINDING_ENTRIES = 100
const MAX_SECRET_CHARS = 16_384
const MAX_PAGES_FILES = 500
const MAX_PAGES_FILE_BYTES = 5 * 1024 * 1024
const MAX_PAGES_TOTAL_BYTES = 20 * 1024 * 1024

const IDENTIFIER_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const BINDING_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const RESOURCE_VALUE_RE = /^[\w.@-]{1,200}$/
const COMPATIBILITY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface DeployInput {
  account: LoadedAccount
  template: CatalogTemplate
  name: string
  deployType: DeployType
  bindingSelections: Record<string, string>
  secretValues: Record<string, string>
}

export interface DeployOutcome {
  ok: boolean
  url?: string
  error?: string
}

/** Worker and Pages names share one alphabet, and the name ends up in a URL path. */
export function assertDeployName(name: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw ApiError.badRequest(
      'The deployment name must be 1-63 lowercase letters, digits or hyphens, and cannot start or end with a hyphen',
    )
  }
}

/** The template's own type unless the caller chose a hybrid half; a fixed template refuses others. */
export function resolveDeployType(template: CatalogTemplate, requested?: string): DeployType {
  const type = templateType(template)
  const native: DeployType = type === 'pages' ? 'pages' : type === 'hybrid' ? 'both' : 'worker'
  if (requested === undefined) return native
  if (requested !== 'worker' && requested !== 'pages' && requested !== 'both') {
    throw ApiError.badRequest('deployType must be worker, pages or both')
  }
  if (type !== 'hybrid' && requested !== native) {
    throw ApiError.badRequest(`This ${type} template can only be deployed as ${native}`)
  }
  return requested
}

function requireCfAccountId(account: LoadedAccount): string {
  const id = account.row.cf_account_id?.trim()
  if (!id) throw ApiError.badRequest('The account is not bound to a Cloudflare account id')
  return id
}

function assertBindingName(name: string): void {
  if (!BINDING_NAME_RE.test(name)) {
    throw ApiError.badRequest(`Invalid binding name: ${name}`)
  }
}

function assertResourceValue(value: string, label: string): void {
  if (!RESOURCE_VALUE_RE.test(value)) {
    throw ApiError.badRequest(`Invalid ${label} value`)
  }
}

interface MetadataBinding {
  type: string
  name: string
  [key: string]: unknown
}

/**
 * Bindings from the three inputs, in order of authority: a secret overrides a resource selection,
 * which overrides the template's plain environment. Duplicate names are a client mistake.
 */
export function buildWorkerBindings(
  template: CatalogTemplate,
  selections: Record<string, string>,
  secrets: Record<string, string>,
): MetadataBinding[] {
  if (Object.keys(selections).length > MAX_BINDING_ENTRIES) {
    throw ApiError.badRequest(`At most ${MAX_BINDING_ENTRIES} bindings can be sent`)
  }
  if (Object.keys(secrets).length > MAX_BINDING_ENTRIES) {
    throw ApiError.badRequest(`At most ${MAX_BINDING_ENTRIES} secrets can be sent`)
  }

  const bindings = new Map<string, MetadataBinding>()
  for (const [rawName, rawValue] of Object.entries(selections)) {
    const name = rawName.trim()
    assertBindingName(name)
    const value = rawValue.trim()
    if (!value || value === 'none') continue
    const separator = value.indexOf(':')
    if (separator <= 0) throw ApiError.badRequest(`Invalid binding selection for ${name}`)
    const kind = value.slice(0, separator)
    const resource = value.slice(separator + 1)
    if (!resource) throw ApiError.badRequest(`Invalid binding selection for ${name}`)
    if (kind === 'kv') {
      assertResourceValue(resource, 'KV namespace')
      bindings.set(name, { type: 'kv_namespace', name, namespace_id: resource })
    } else if (kind === 'd1') {
      assertResourceValue(resource, 'D1 database')
      bindings.set(name, { type: 'd1', name, id: resource })
    } else if (kind === 'r2') {
      assertResourceValue(resource, 'R2 bucket')
      bindings.set(name, { type: 'r2_bucket', name, bucket_name: resource })
    } else if (kind === 'ai') {
      assertResourceValue(resource, 'AI binding')
      bindings.set(name, { type: 'ai', name })
    } else {
      throw ApiError.badRequest(`Unknown binding kind for ${name}: ${kind}`)
    }
  }

  for (const [rawName, rawValue] of Object.entries(secrets)) {
    const name = rawName.trim()
    assertBindingName(name)
    if (typeof rawValue !== 'string') throw ApiError.badRequest(`Secret ${name} must be a string`)
    if (rawValue.length > MAX_SECRET_CHARS) {
      throw ApiError.badRequest(`Secret ${name} is larger than ${MAX_SECRET_CHARS} characters`)
    }
    bindings.set(name, { type: 'secret_text', name, text: rawValue })
  }

  const env = template.env
  if (env && typeof env === 'object') {
    for (const [rawName, value] of Object.entries(env)) {
      const name = rawName.trim()
      if (bindings.has(name)) continue
      assertBindingName(name)
      if (typeof value !== 'string') {
        throw ApiError.badRequest(`Template env ${name} must be a string`)
      }
      bindings.set(name, { type: 'plain_text', name, text: value })
    }
  }

  return [...bindings.values()]
}

function buildWorkerMetadata(template: CatalogTemplate, bindings: MetadataBinding[]): Record<string, unknown> {
  const date = typeof template.compatibility_date === 'string'
    && COMPATIBILITY_DATE_RE.test(template.compatibility_date)
    ? template.compatibility_date
    : DEFAULT_COMPATIBILITY_DATE
  const metadata: Record<string, unknown> = {
    main_module: 'worker.js',
    compatibility_date: date,
  }
  if (bindings.length > 0) metadata.bindings = bindings
  if (Array.isArray(template.compatibility_flags)) {
    const flags = template.compatibility_flags.filter((flag): flag is string => typeof flag === 'string' && Boolean(flag))
    if (flags.length > 0) metadata.compatibility_flags = flags
  }
  return metadata
}

/** A multipart call: `fetch` must set the boundary itself, so the shared JSON helper cannot be used. */
async function sendMultipart(
  auth: CloudflareAuth,
  path: string,
  method: 'POST' | 'PUT',
  form: FormData,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEPLOY_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${CF_API_BASE}${path}`, {
      method,
      headers: authHeaders(auth),
      body: form,
      signal: controller.signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not answer the deployment in time')
    }
    throw new ApiError(
      502,
      'cloudflare_upstream',
      `Cloudflare could not be reached: ${errorMessage(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  if (!response.ok) {
    throw upstreamApiError(new CloudflareApiError({ status: response.status, body: text }))
  }
  if (!text.trim()) return { status: response.status, body: {} }
  try {
    return { status: response.status, body: JSON.parse(text) as unknown }
  } catch {
    return { status: response.status, body: text }
  }
}

async function deployWorkerScript(
  auth: CloudflareAuth,
  cfAccountId: string,
  name: string,
  script: Uint8Array,
  metadata: Record<string, unknown>,
): Promise<void> {
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('worker.js', new Blob([script], { type: 'application/javascript+module' }), 'worker.js')
  await sendMultipart(
    auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/workers/scripts/${encodeURIComponent(name)}`,
    'PUT',
    form,
  )
}

/** Best-effort: a deployed worker without a known subdomain is still deployed. */
async function workerSubdomain(auth: CloudflareAuth, cfAccountId: string): Promise<string | null> {
  try {
    const body = await cfFetch<{ result?: { subdomain?: string } }>(
      auth,
      `/accounts/${encodeURIComponent(cfAccountId)}/workers/subdomain`,
    )
    const subdomain = body.result?.subdomain
    return typeof subdomain === 'string' && subdomain ? subdomain : null
  } catch (error) {
    console.warn('[inkstone] Cloudflare workers subdomain lookup failed:', errorMessage(error))
    return null
  }
}

interface PagesEntry {
  path: string
  bytes: Uint8Array
}

/**
 * Ensure the project exists before uploading assets into it.
 *
 * The lookup uses the raw response so a 404 stays a 404; `cfFetch` maps every upstream failure to a
 * 502 and would make "missing" indistinguishable from "refused".
 */
async function ensurePagesProject(auth: CloudflareAuth, cfAccountId: string, name: string): Promise<void> {
  const base = `/accounts/${encodeURIComponent(cfAccountId)}/pages/projects`
  const response = await cfFetchRaw(auth, `${base}/${encodeURIComponent(name)}`)
  if (response.ok) return
  const body = await response.text()
  if (response.status !== 404) {
    throw upstreamApiError(new CloudflareApiError({ status: response.status, body }))
  }
  await cfFetch(auth, base, {
    method: 'POST',
    body: { name, production_branch: 'main' },
  })
}

function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json',
    txt: 'text/plain; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    wasm: 'application/wasm',
  }
  return types[extension] ?? 'application/octet-stream'
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A Pages deployment is a manifest plus the files it names. The manifest maps each content hash to
 * the path it is served at, and each file part is named by that hash.
 */
async function deployPagesProject(
  auth: CloudflareAuth,
  cfAccountId: string,
  name: string,
  entries: readonly PagesEntry[],
): Promise<string | undefined> {
  await ensurePagesProject(auth, cfAccountId, name)

  const form = new FormData()
  const manifest: Record<string, string> = {}
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const hash = (await sha256Hex(entry.bytes)).slice(0, 32)
    if (manifest[hash]) continue
    manifest[hash] = `/${entry.path}`
    form.append(hash, new Blob([entry.bytes], { type: contentTypeFor(entry.path) }), hash)
  }
  form.append('manifest', new Blob([JSON.stringify(manifest)], { type: 'application/json' }))

  const { body } = await sendMultipart(
    auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/pages/projects/${encodeURIComponent(name)}/deployments`,
    'POST',
    form,
  )
  if (body && typeof body === 'object') {
    const result = (body as { result?: { url?: unknown } }).result
    if (typeof result?.url === 'string' && result.url) return result.url
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Zip reading — a template Pages half is an archive, and the runtime has no unzip helper.
// ---------------------------------------------------------------------------------------------

function findEndOfCentralDirectory(view: DataView, length: number): number {
  const earliest = Math.max(0, length - 0xffff - 22)
  for (let offset = length - 22; offset >= earliest; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  }
  throw ApiError.badRequest('The Pages source is not a valid zip archive')
}

/** Keeps a zip's own paths from escaping the asset root. */
function sanitizeZipPath(raw: string): string {
  const parts: string[] = []
  for (const part of raw.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') throw ApiError.badRequest('The Pages source contains a path traversal entry')
    parts.push(part)
  }
  return parts.join('/')
}

/** A repo archive wraps everything in one folder; Pages expects the files at the root. */
function stripSingleRoot(entries: PagesEntry[]): PagesEntry[] {
  if (entries.length === 0) return entries
  const root = entries[0]!.path.split('/')[0]
  if (!root || !entries.every((entry) => entry.path.startsWith(`${root}/`))) return entries
  return entries.map((entry) => ({ ...entry, path: entry.path.slice(root.length + 1) }))
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_PAGES_FILE_BYTES) {
        throw ApiError.badRequest('The Pages source contains a file larger than 5 MB')
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

/** Reads the files of a stored or deflated zip, with per-file and total ceilings. */
export async function extractPagesArchive(bytes: Uint8Array): Promise<PagesEntry[]> {
  if (bytes.byteLength < 22) throw ApiError.badRequest('The Pages source is not a valid zip archive')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(view, bytes.byteLength)
  const entryCount = view.getUint16(eocd + 10, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  if (entryCount > MAX_PAGES_FILES) {
    throw ApiError.badRequest(`The Pages source has more than ${MAX_PAGES_FILES} files`)
  }

  const entries: PagesEntry[] = []
  let total = 0
  let cursor = directoryOffset
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
      throw ApiError.badRequest('The Pages source has a corrupt zip directory')
    }
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const nameStart = cursor + 46
    const rawName = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength))
    cursor = nameStart + nameLength + extraLength + commentLength

    if (flags & 0x0001) throw ApiError.badRequest('The Pages source is encrypted and cannot be read')
    const path = sanitizeZipPath(rawName)
    if (!path || rawName.endsWith('/') || path.startsWith('__MACOSX/') || path.endsWith('/.DS_Store')) {
      continue
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw ApiError.badRequest('Zip64 archives are not supported')
    }
    if (uncompressedSize > MAX_PAGES_FILE_BYTES) {
      throw ApiError.badRequest(`The Pages source contains a file larger than 5 MB: ${path}`)
    }
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw ApiError.badRequest('The Pages source has a corrupt zip entry')
    }
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > bytes.byteLength) throw ApiError.badRequest('The Pages source has a truncated zip entry')

    let content: Uint8Array
    if (method === 0) {
      content = bytes.slice(dataStart, dataEnd)
    } else if (method === 8) {
      content = await inflateRaw(bytes.subarray(dataStart, dataEnd))
    } else {
      throw ApiError.badRequest(`The Pages source uses unsupported compression (${method})`)
    }
    if (content.byteLength > MAX_PAGES_FILE_BYTES) {
      throw ApiError.badRequest(`The Pages source contains a file larger than 5 MB: ${path}`)
    }
    total += content.byteLength
    if (total > MAX_PAGES_TOTAL_BYTES) {
      throw ApiError.badRequest('The Pages source expands to more than 20 MB')
    }
    entries.push({ path, bytes: content })
  }

  if (entries.length === 0) throw ApiError.badRequest('The Pages source has no files')
  return stripSingleRoot(entries)
}

/** Downloads and reads a Pages archive before anything is deployed. */
export async function loadPagesEntries(url: string): Promise<PagesEntry[]> {
  return await extractPagesArchive(await downloadTemplateBytes(url))
}

function missingSourceMessage(label: 'Worker' | 'Pages', template: CatalogTemplate): string {
  if (label === 'Pages') {
    return `This template (${template.type ?? 'worker'}) ships no Pages source, so it cannot be deployed as Pages`
  }
  return 'This template has no Worker source and cannot be deployed as a Worker'
}

function requiredSources(template: CatalogTemplate, deployType: DeployType): TemplateSources {
  const sources = templateSources(template)
  if (deployType === 'worker' && !sources.worker) {
    throw ApiError.badRequest(missingSourceMessage('Worker', template))
  }
  if (deployType === 'pages' && !sources.pages) {
    throw ApiError.badRequest(missingSourceMessage('Pages', template))
  }
  if (deployType === 'both' && (!sources.worker || !sources.pages)) {
    throw ApiError.badRequest(
      'This template needs both a Worker and a Pages source for a combined deployment',
    )
  }
  return sources
}

/**
 * Deploy one template to one account.
 *
 * Everything needed by either half — downloads, archive parsing, binding validation — happens before
 * the first upstream write. A `both` deployment then runs each half and reports the failure of one
 * beside the success of the other instead of pretending the pair succeeded or failed as a unit.
 */
export async function deployTemplate(_env: Env, input: DeployInput): Promise<DeployOutcome> {
  assertDeployName(input.name)
  const sources = requiredSources(input.template, input.deployType)
  const cfAccountId = requireCfAccountId(input.account)
  const bindings = buildWorkerBindings(input.template, input.bindingSelections, input.secretValues)

  let workerScript: Uint8Array | undefined
  let pagesEntries: PagesEntry[] | undefined
  if (input.deployType === 'worker' || input.deployType === 'both') {
    workerScript = await downloadTemplateBytes(sources.worker!)
  }
  if (input.deployType === 'pages' || input.deployType === 'both') {
    pagesEntries = await loadPagesEntries(sources.pages!)
  }

  const auth = input.account.auth
  const metadata = buildWorkerMetadata(input.template, bindings)

  if (input.deployType === 'worker') {
    await deployWorkerScript(auth, cfAccountId, input.name, workerScript!, metadata)
    const subdomain = await workerSubdomain(auth, cfAccountId)
    return {
      ok: true,
      ...(subdomain ? { url: `https://${input.name}.${subdomain}.workers.dev` } : {}),
    }
  }

  if (input.deployType === 'pages') {
    const url = await deployPagesProject(auth, cfAccountId, input.name, pagesEntries!)
    return { ok: true, ...(url ? { url } : {}) }
  }

  let workerError: string | undefined
  let pagesError: string | undefined
  let workerUrl: string | undefined
  let pagesUrl: string | undefined

  try {
    await deployWorkerScript(auth, cfAccountId, input.name, workerScript!, metadata)
    const subdomain = await workerSubdomain(auth, cfAccountId)
    if (subdomain) workerUrl = `https://${input.name}.${subdomain}.workers.dev`
  } catch (error) {
    workerError = errorMessage(error)
  }

  try {
    pagesUrl = await deployPagesProject(auth, cfAccountId, input.name, pagesEntries!)
  } catch (error) {
    pagesError = errorMessage(error)
  }

  const failures: string[] = []
  if (workerError) failures.push(`Worker half failed: ${workerError}`)
  if (pagesError) failures.push(`Pages half failed: ${pagesError}`)
  return {
    ok: failures.length === 0,
    ...(pagesUrl ?? workerUrl ? { url: pagesUrl ?? workerUrl } : {}),
    ...(failures.length > 0 ? { error: failures.join('; ') } : {}),
  }
}
