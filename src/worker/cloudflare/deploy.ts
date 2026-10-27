/**
 * Uploading Workers and Pages, and the two batch operations that surround them.
 *
 * A Worker deployment is the same multipart PUT wrangler performs: one metadata JSON part and one
 * part per module. A Pages deployment is a direct upload: a manifest naming each file by the hash it
 * is stored under. Both live here rather than in the router so the store slice and this one have one
 * place to agree with Cloudflare.
 */
import { ApiError } from '../lib/errors'
import type { LoadedAccount } from './accounts'
import {
  CF_API_BASE,
  CloudflareApiError,
  authHeaders,
  cfFetch,
  cfFetchAll,
  cfFetchRaw,
  upstreamApiError,
  type CloudflareAuth,
} from './cf-api'
import {
  assertBindingName,
  assertSecretName,
  assertWorkerName,
  errorText,
  parseMultipart,
  pickEntryModule,
} from './workers'
import { extractPagesArchive } from './store-deploy'

const DEFAULT_COMPATIBILITY_DATE = '2024-11-01'
const DEPLOY_TIMEOUT_MS = 120_000
const MAX_SCRIPT_BYTES = 10 * 1024 * 1024
const MAX_BATCH_TARGETS = 50
const MAX_BINDINGS = 100
const MAX_SECRET_CHARS = 16_384
const MAX_PAGES_FILES = 500
const MAX_PAGES_FILE_BYTES = 5 * 1024 * 1024
const MAX_PAGES_TOTAL_BYTES = 20 * 1024 * 1024
const RESOURCE_VALUE_RE = /^[\w.@-]{1,200}$/
const COMPATIBILITY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ENVIRONMENT_RE = /^[A-Za-z0-9_-]{1,64}$/

export type DeployBindingType = 'kv' | 'd1' | 'r2' | 'ai' | 'durable_object' | 'service' | 'queue'

export interface DeployVar {
  name: string
  value?: string
  secret?: boolean
  keep?: boolean
}

export interface DeployBinding {
  type: DeployBindingType
  name: string
  resourceName?: string
  mode?: 'auto' | 'existing'
  existingId?: string
  className?: string
  scriptName?: string
  service?: string
  environment?: string
  queueName?: string
}

export interface DeployTarget {
  accountId: string
  workerName: string
}

export interface WorkerDeployInput {
  account: LoadedAccount
  name: string
  script?: Uint8Array
  zip?: Uint8Array
  mainModule?: string
  vars: DeployVar[]
  bindings: DeployBinding[]
  compatibilityDate?: string
  isRedeploy: boolean
}

export interface WorkerDeployOutcome {
  url?: string
}

export interface PagesDeployInput {
  account: LoadedAccount
  name: string
  zip: Uint8Array
  vars: DeployVar[]
  bindings: DeployBinding[]
}

export interface WorkerEnv {
  vars: Array<{ name: string; value: string }>
  secrets: string[]
}

export interface EnvSyncSource {
  accountId: string
  workerName: string
}

export interface EnvSyncTargetPreview {
  accountId: string
  workerName: string
  missing: Array<{ name: string; type: 'plain_text' | 'secret_text' }>
  changed: Array<{ name: string; source: string; target: string }>
  error?: string
}

export interface EnvSyncPreview {
  source: WorkerEnv
  previews: EnvSyncTargetPreview[]
}

export interface EnvSyncResult {
  accountId: string
  workerName: string
  success: boolean
  applied: string[]
  error?: string
}

interface MetadataBinding {
  type: string
  name: string
  [key: string]: unknown
}

interface ScriptModule {
  name: string
  bytes: Uint8Array
  contentType: string
}

interface ExistingScript {
  modules: ScriptModule[]
  mainModule: string
  settings: Record<string, unknown>
}

function requireCfAccountId(account: LoadedAccount): string {
  const id = account.row.cf_account_id?.trim()
  if (!id) throw ApiError.badRequest('The account is not bound to a Cloudflare account id')
  return id
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function assertResourceValue(value: string, label: string): string {
  if (!RESOURCE_VALUE_RE.test(value)) throw ApiError.badRequest(`Invalid ${label} value`)
  return value
}

function assertCompatibilityDate(value: string): string {
  if (!COMPATIBILITY_DATE_RE.test(value)) throw ApiError.badRequest('Invalid compatibility date')
  return value
}

/** A JSON body from the client may be absent; anything present must match the deploy contract. */
export function parseDeployVars(value: unknown): DeployVar[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw ApiError.badRequest('vars must be an array')
  if (value.length > MAX_BINDINGS) throw ApiError.badRequest(`At most ${MAX_BINDINGS} variables can be sent`)
  return value.map((item) => {
    const row = asRecord(item)
    const name = assertBindingName(textOf(row.name).trim())
    const text = typeof row.value === 'string' ? row.value : ''
    if (text.length > MAX_SECRET_CHARS) {
      throw ApiError.badRequest(`Variable ${name} is larger than ${MAX_SECRET_CHARS} characters`)
    }
    return {
      name,
      value: text,
      secret: row.secret === true,
      keep: row.keep === true,
    }
  })
}

export function parseDeployBindings(value: unknown): DeployBinding[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw ApiError.badRequest('bindings must be an array')
  if (value.length > MAX_BINDINGS) throw ApiError.badRequest(`At most ${MAX_BINDINGS} bindings can be sent`)
  return value.map((item) => {
    const row = asRecord(item)
    const type = textOf(row.type)
    if (!['kv', 'd1', 'r2', 'ai', 'durable_object', 'service', 'queue'].includes(type)) {
      throw ApiError.badRequest(`Unknown binding type: ${type || '(empty)'}`)
    }
    const name = assertBindingName(textOf(row.name).trim())
    const mode = row.mode === 'existing' ? 'existing' : row.mode === 'auto' ? 'auto' : undefined
    return {
      type: type as DeployBindingType,
      name,
      ...(typeof row.resourceName === 'string' ? { resourceName: row.resourceName } : {}),
      ...(mode ? { mode } : {}),
      ...(typeof row.existingId === 'string' ? { existingId: row.existingId } : {}),
      ...(typeof row.className === 'string' ? { className: row.className } : {}),
      ...(typeof row.scriptName === 'string' ? { scriptName: row.scriptName } : {}),
      ...(typeof row.service === 'string' ? { service: row.service } : {}),
      ...(typeof row.environment === 'string' ? { environment: row.environment } : {}),
      ...(typeof row.queueName === 'string' ? { queueName: row.queueName } : {}),
    }
  })
}

export function parseDeployTargets(value: unknown): DeployTarget[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.badRequest('targets is required')
  }
  if (value.length > MAX_BATCH_TARGETS) {
    throw ApiError.badRequest(`At most ${MAX_BATCH_TARGETS} targets can be sent`)
  }
  return value.map((item) => {
    const row = asRecord(item)
    const accountId = textOf(row.accountId).trim()
    const workerName = assertWorkerName(textOf(row.workerName).trim())
    if (!accountId) throw ApiError.badRequest('Every target needs an accountId')
    return { accountId, workerName }
  })
}

/** A script URL is fetched by the server, so its destination is checked before the request exists. */
export async function fetchScriptFromUrl(raw: string): Promise<Uint8Array> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw ApiError.badRequest('The script URL is not a valid URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw ApiError.badRequest('The script URL must be an https URL without credentials')
  }
  const host = url.hostname.toLowerCase()
  if (
    host === 'localhost'
    || host === '[::1]'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || !host.includes('.')
    || isPrivateIpv4(host)
    || /^\[(?:fc|fd|fe80)/.test(host)
  ) {
    throw ApiError.badRequest('The script URL must point at a public host')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let response: Response
  try {
    response = await fetch(url.toString(), { redirect: 'error', signal: controller.signal })
  } catch (error) {
    throw ApiError.badRequest(`The script URL could not be fetched: ${errorText(error)}`)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) throw ApiError.badRequest(`The script URL answered HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_SCRIPT_BYTES) throw ApiError.tooLarge('The script is larger than 10 MB')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_SCRIPT_BYTES) throw ApiError.tooLarge('The script is larger than 10 MB')
  return bytes
}

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const [a, b] = [Number(match[1]), Number(match[2])]
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0
}

async function sendMultipart(
  auth: CloudflareAuth,
  path: string,
  method: 'POST' | 'PUT' | 'PATCH',
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
      `Cloudflare could not be reached: ${errorText(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  if (!response.ok) throw upstreamApiError(new CloudflareApiError({ status: response.status, body: text }))
  if (!text.trim()) return { status: response.status, body: {} }
  try {
    return { status: response.status, body: JSON.parse(text) as unknown }
  } catch {
    return { status: response.status, body: text }
  }
}

async function readWorkerSettings(
  auth: CloudflareAuth,
  cfAccountId: string,
  name: string,
): Promise<Record<string, unknown>> {
  try {
    const body = await cfFetch<{ result?: Record<string, unknown> }>(
      auth,
      `/accounts/${encodeURIComponent(cfAccountId)}/workers/scripts/${encodeURIComponent(name)}/settings`,
    )
    return asRecord(body.result)
  } catch (error) {
    console.warn('[inkstone] Worker settings could not be read before a redeploy:', errorText(error))
    return {}
  }
}

function existingMetadataBindings(settings: Record<string, unknown>): MetadataBinding[] {
  const out: MetadataBinding[] = []
  for (const item of asArray(settings.bindings)) {
    const binding = asRecord(item)
    if (typeof binding.type !== 'string' || typeof binding.name !== 'string') continue
    out.push({ ...binding, type: binding.type, name: binding.name })
  }
  return out
}

function metadataFromExisting(settings: Record<string, unknown>): MetadataBinding[] {
  return existingMetadataBindings(settings).filter((binding) => (
    binding.type !== 'plain_text' && binding.type !== 'secret_text'
  ))
}

async function downloadWorkerScript(
  auth: CloudflareAuth,
  cfAccountId: string,
  name: string,
): Promise<ExistingScript> {
  const path = `/accounts/${encodeURIComponent(cfAccountId)}/workers/scripts/${encodeURIComponent(name)}`
  const response = await cfFetchRaw(auth, path, { headers: { Accept: '*/*' } })
  if (!response.ok) {
    throw upstreamApiError(new CloudflareApiError({ status: response.status, body: await response.text() }))
  }
  const contentType = response.headers.get('content-type') ?? ''
  const buffer = await response.arrayBuffer()
  const settings = await readWorkerSettings(auth, cfAccountId, name)
  const parts = parseMultipart(buffer, contentType)
  if (!parts) {
    const mainModule = 'worker.js'
    return {
      modules: [{
        name: mainModule,
        bytes: new Uint8Array(buffer),
        contentType: 'application/javascript+module',
      }],
      mainModule,
      settings,
    }
  }
  const modules = parts
    .filter((part) => /\.(?:m?js|wasm)$/i.test(part.name))
    .map((part) => ({
      name: part.name,
      bytes: part.bytes,
      contentType: part.contentType || (part.name.endsWith('.wasm') ? 'application/wasm' : 'application/javascript+module'),
    }))
  if (modules.length === 0) {
    throw ApiError.badRequest('The deployed Worker has no JavaScript module to redeploy')
  }
  const preferred = response.headers.get('cf-entrypoint') ?? undefined
  const entry = pickEntryModule(
    modules.map((module) => ({ name: module.name, contentType: module.contentType, bytes: module.bytes })),
    preferred,
  )
  return {
    modules,
    mainModule: entry?.name ?? modules[0]!.name,
    settings,
  }
}

function modulesFromZip(entries: Array<{ path: string; bytes: Uint8Array }>, preferred?: string): {
  modules: ScriptModule[]
  mainModule: string
} {
  const modules = entries
    .filter((entry) => /\.(?:m?js|wasm)$/i.test(entry.path))
    .map((entry) => ({
      name: entry.path,
      bytes: entry.bytes,
      contentType: entry.path.endsWith('.wasm') ? 'application/wasm' : 'application/javascript+module',
    }))
  if (modules.length === 0) {
    throw ApiError.badRequest('The archive has no JavaScript module to deploy')
  }
  const entry = pickEntryModule(
    modules.map((module) => ({ name: module.name, contentType: module.contentType, bytes: module.bytes })),
    preferred,
  )
  if (!entry) throw ApiError.badRequest('The archive has no entry module')
  return { modules, mainModule: entry.name }
}

async function ensureKvNamespace(auth: CloudflareAuth, cfAccountId: string, title: string): Promise<string> {
  const namespaces = await cfFetchAll<{ id?: string; title?: string }>(
    auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/storage/kv/namespaces`,
    100,
  )
  const existing = namespaces.find((namespace) => namespace.title === title)
  if (existing?.id) return existing.id
  const created = await cfFetch<{ result?: { id?: string } }>(
    auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/storage/kv/namespaces`,
    { method: 'POST', body: { title } },
  )
  const id = created.result?.id
  if (!id) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not return the created KV namespace')
  return id
}

async function ensureD1Database(auth: CloudflareAuth, cfAccountId: string, name: string): Promise<string> {
  const databases = await cfFetchAll<{ uuid?: string; name?: string }>(
    auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/d1/database`,
    100,
  )
  const existing = databases.find((database) => database.name === name)
  if (existing?.uuid) return existing.uuid
  const created = await cfFetch<{ result?: { uuid?: string } }>(
    auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/d1/database`,
    { method: 'POST', body: { name } },
  )
  const id = created.result?.uuid
  if (!id) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not return the created D1 database')
  return id
}

async function ensureR2Bucket(auth: CloudflareAuth, cfAccountId: string, name: string): Promise<string> {
  let buckets: Array<{ name?: string }> = []
  try {
    const body = await cfFetch<{ result?: { buckets?: Array<{ name?: string }> } }>(
      auth,
      `/accounts/${encodeURIComponent(cfAccountId)}/r2/buckets`,
    )
    buckets = body.result?.buckets ?? []
  } catch (error) {
    const message = errorText(error)
    if (/10042|enable R2|Please enable R2/i.test(message)) {
      throw ApiError.badRequest('R2 is not enabled for this account')
    }
    throw error
  }
  if (buckets.some((bucket) => bucket.name === name)) return name
  try {
    await cfFetch(auth, `/accounts/${encodeURIComponent(cfAccountId)}/r2/buckets`, {
      method: 'POST',
      body: { name },
    })
  } catch (error) {
    if (/10042|enable R2|Please enable R2/i.test(errorText(error))) {
      throw ApiError.badRequest('R2 is not enabled for this account')
    }
    throw error
  }
  return name
}

async function bindingMetadata(
  auth: CloudflareAuth,
  cfAccountId: string,
  binding: DeployBinding,
): Promise<MetadataBinding> {
  const name = assertBindingName(binding.name)
  if (binding.type === 'ai') return { type: 'ai', name }
  if (binding.type === 'durable_object') {
    const className = binding.className?.trim()
    if (!className) throw ApiError.badRequest(`Durable Object binding ${name} needs a class name`)
    return {
      type: 'durable_object_namespace',
      name,
      class_name: className,
      ...(binding.scriptName?.trim() ? { script_name: binding.scriptName.trim() } : {}),
    }
  }
  if (binding.type === 'service') {
    const service = binding.service?.trim() || name
    const environment = binding.environment?.trim()
    if (environment && !ENVIRONMENT_RE.test(environment)) throw ApiError.badRequest('Invalid service environment')
    return {
      type: 'service',
      name,
      service,
      ...(environment ? { environment } : {}),
    }
  }
  if (binding.type === 'queue') {
    return { type: 'queue', name, queue_name: binding.queueName?.trim() || name }
  }

  const resourceName = assertResourceValue(binding.resourceName?.trim() || name, `${binding.type} resource`)
  if (binding.mode === 'existing') {
    const existingId = binding.existingId?.trim()
    if (!existingId || !RESOURCE_VALUE_RE.test(existingId)) {
      throw ApiError.badRequest(`Binding ${name} needs an existing resource id`)
    }
    if (binding.type === 'kv') return { type: 'kv_namespace', name, namespace_id: existingId }
    if (binding.type === 'd1') return { type: 'd1', name, id: existingId }
    return { type: 'r2_bucket', name, bucket_name: existingId }
  }

  if (binding.type === 'kv') {
    return { type: 'kv_namespace', name, namespace_id: await ensureKvNamespace(auth, cfAccountId, resourceName) }
  }
  if (binding.type === 'd1') {
    return { type: 'd1', name, id: await ensureD1Database(auth, cfAccountId, resourceName) }
  }
  return { type: 'r2_bucket', name, bucket_name: await ensureR2Bucket(auth, cfAccountId, resourceName) }
}

async function workerUrl(auth: CloudflareAuth, cfAccountId: string, name: string): Promise<string | undefined> {
  try {
    const body = await cfFetch<{ result?: { subdomain?: string } }>(
      auth,
      `/accounts/${encodeURIComponent(cfAccountId)}/workers/subdomain`,
    )
    const subdomain = body.result?.subdomain
    return subdomain ? `https://${name}.${subdomain}.workers.dev` : undefined
  } catch (error) {
    console.warn('[inkstone] Workers subdomain lookup failed:', errorText(error))
    return undefined
  }
}

/**
 * Deploy one module Worker.
 *
 * A redeploy without a new script downloads the current modules and uploads them again with the new
 * bindings, which is the only way the API can change bindings while keeping the code.
 */
export async function deployWorkerScript(input: WorkerDeployInput): Promise<WorkerDeployOutcome> {
  const cfAccountId = requireCfAccountId(input.account)
  const name = assertWorkerName(input.name)
  if (!input.script && !input.zip && !input.isRedeploy) {
    throw ApiError.badRequest('A script file, a zip archive or a script URL is required')
  }

  let existing: ExistingScript | null = null
  if (!input.script && !input.zip) {
    existing = await downloadWorkerScript(input.account.auth, cfAccountId, name)
  }
  const settings = existing?.settings ?? (input.isRedeploy
    ? await readWorkerSettings(input.account.auth, cfAccountId, name)
    : {})

  let modules: ScriptModule[]
  let mainModule: string
  if (input.zip) {
    const entries = await extractPagesArchive(input.zip)
    const parsed = modulesFromZip(entries, input.mainModule)
    modules = parsed.modules
    mainModule = parsed.mainModule
  } else if (input.script) {
    mainModule = input.mainModule?.trim() || 'worker.js'
    modules = [{
      name: mainModule,
      bytes: input.script,
      contentType: 'application/javascript+module',
    }]
  } else {
    modules = existing!.modules
    mainModule = input.mainModule?.trim() || existing!.mainModule
  }
  if (!modules.some((module) => module.name === mainModule)) {
    throw ApiError.badRequest(`The entry module ${mainModule} is not part of the upload`)
  }

  const bindings = input.isRedeploy ? metadataFromExisting(settings) : []
  const byName = new Map(bindings.map((binding) => [binding.name, binding]))
  for (const binding of input.bindings) {
    const metadata = await bindingMetadata(input.account.auth, cfAccountId, binding)
    byName.set(metadata.name, metadata)
  }
  for (const variable of input.vars) {
    const variableName = assertBindingName(variable.name)
    if (variable.secret) {
      if (variable.keep || !variable.value) {
        if (!input.isRedeploy) throw ApiError.badRequest(`Secret ${variableName} needs a value`)
        // An omitted secret is preserved by Cloudflare; re-sending it without text would blank it.
        continue
      }
      byName.set(variableName, { type: 'secret_text', name: variableName, text: variable.value })
    } else {
      byName.set(variableName, { type: 'plain_text', name: variableName, text: variable.value ?? '' })
    }
  }

  const compatibilityDate = input.compatibilityDate
    ? assertCompatibilityDate(input.compatibilityDate)
    : textOf(settings.compatibility_date) || DEFAULT_COMPATIBILITY_DATE
  const metadata: Record<string, unknown> = {
    main_module: mainModule,
    compatibility_date: compatibilityDate,
  }
  if (byName.size > 0) metadata.bindings = [...byName.values()]
  if (Array.isArray(settings.compatibility_flags)) {
    const flags = settings.compatibility_flags.filter((flag): flag is string => typeof flag === 'string' && Boolean(flag))
    if (flags.length > 0) metadata.compatibility_flags = flags
  }

  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  for (const module of modules) {
    form.append(module.name, new Blob([module.bytes], { type: module.contentType }), module.name)
  }
  await sendMultipart(
    input.account.auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/workers/scripts/${encodeURIComponent(name)}`,
    'PUT',
    form,
  )
  return { url: await workerUrl(input.account.auth, cfAccountId, name) }
}

function pagesConfigSection(value: unknown): Record<string, unknown> {
  return asRecord(value)
}

function buildPagesConfig(
  project: Record<string, unknown>,
  vars: DeployVar[],
  bindings: DeployBinding[],
): Record<string, unknown> | null {
  const configs = asRecord(project.deployment_configs)
  const production = pagesConfigSection(configs.production)
  const preview = pagesConfigSection(configs.preview)
  const nextProduction: Record<string, unknown> = { ...production }
  const nextPreview: Record<string, unknown> = { ...preview }
  let changed = false

  const envVars: Record<string, unknown> = {}
  for (const variable of vars) {
    const name = assertBindingName(variable.name)
    // Pages never returns secret plaintext, so an untouched secret row means "keep the deployed one".
    if (variable.secret && variable.keep && !variable.value) continue
    envVars[name] = {
      type: variable.secret ? 'secret_text' : 'plain_text',
      value: variable.value ?? '',
    }
  }
  if (Object.keys(envVars).length > 0) {
    nextProduction.env_vars = { ...pagesConfigSection(production.env_vars), ...envVars }
    nextPreview.env_vars = { ...pagesConfigSection(preview.env_vars), ...envVars }
    changed = true
  }

  for (const binding of bindings) {
    const name = assertBindingName(binding.name)
    const value = binding.mode === 'existing'
      ? binding.existingId?.trim()
      : binding.resourceName?.trim() || name
    if (!value) throw ApiError.badRequest(`Binding ${name} needs a resource`)
    if (binding.type === 'kv') {
      nextProduction.kv_namespaces = { ...pagesConfigSection(production.kv_namespaces), [name]: { namespace_id: value } }
      nextPreview.kv_namespaces = { ...pagesConfigSection(preview.kv_namespaces), [name]: { namespace_id: value } }
    } else if (binding.type === 'd1') {
      nextProduction.d1_databases = { ...pagesConfigSection(production.d1_databases), [name]: { id: value } }
      nextPreview.d1_databases = { ...pagesConfigSection(preview.d1_databases), [name]: { id: value } }
    } else if (binding.type === 'r2') {
      nextProduction.r2_buckets = { ...pagesConfigSection(production.r2_buckets), [name]: { name: value } }
      nextPreview.r2_buckets = { ...pagesConfigSection(preview.r2_buckets), [name]: { name: value } }
    } else if (binding.type === 'ai') {
      nextProduction.ai = { ...pagesConfigSection(production.ai), [name]: {} }
      nextPreview.ai = { ...pagesConfigSection(preview.ai), [name]: {} }
    } else {
      throw ApiError.badRequest('Pages supports only KV, D1, R2 and AI bindings')
    }
    changed = true
  }

  if (!changed) return null
  return { production: nextProduction, preview: nextPreview }
}

async function readPagesProject(
  auth: CloudflareAuth,
  cfAccountId: string,
  name: string,
): Promise<Record<string, unknown> | null> {
  const response = await cfFetchRaw(
    auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/pages/projects/${encodeURIComponent(name)}`,
  )
  if (response.status === 404) return null
  const body = await response.text()
  if (!response.ok) throw upstreamApiError(new CloudflareApiError({ status: response.status, body }))
  if (!body.trim()) return {}
  try {
    return asRecord((JSON.parse(body) as { result?: unknown }).result)
  } catch {
    throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare answered with something that is not JSON')
  }
}

async function ensurePagesProject(
  auth: CloudflareAuth,
  cfAccountId: string,
  name: string,
): Promise<Record<string, unknown>> {
  const existing = await readPagesProject(auth, cfAccountId, name)
  if (existing) return existing
  const created = await cfFetch<{ result?: Record<string, unknown> }>(
    auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/pages/projects`,
    { method: 'POST', body: { name, production_branch: 'main' } },
  )
  return asRecord(created.result)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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

/** A Pages direct upload: the manifest names each content hash for the path it serves. */
export async function deployPagesProject(input: PagesDeployInput): Promise<{ url?: string }> {
  const cfAccountId = requireCfAccountId(input.account)
  const name = assertWorkerName(input.name)
  const entries = await extractPagesArchive(input.zip)
  if (entries.length > MAX_PAGES_FILES) throw ApiError.badRequest('The archive has too many files')

  const project = await ensurePagesProject(input.account.auth, cfAccountId, name)
  const configs = buildPagesConfig(project, input.vars, input.bindings)
  if (configs) {
    await cfFetch(input.account.auth, `/accounts/${encodeURIComponent(cfAccountId)}/pages/projects/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: { deployment_configs: configs },
    })
  }

  const form = new FormData()
  const manifest: Record<string, string> = {}
  let total = 0
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    if (entry.bytes.byteLength > MAX_PAGES_FILE_BYTES) {
      throw ApiError.tooLarge(`The archive contains a file larger than 5 MB: ${entry.path}`)
    }
    total += entry.bytes.byteLength
    if (total > MAX_PAGES_TOTAL_BYTES) throw ApiError.tooLarge('The archive expands to more than 20 MB')
    const hash = (await sha256Hex(entry.bytes)).slice(0, 32)
    if (manifest[hash]) continue
    manifest[hash] = `/${entry.path}`
    form.append(hash, new Blob([entry.bytes], { type: contentTypeFor(entry.path) }), hash)
  }
  form.append('manifest', new Blob([JSON.stringify(manifest)], { type: 'application/json' }))

  const response = await sendMultipart(
    input.account.auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/pages/projects/${encodeURIComponent(name)}/deployments`,
    'POST',
    form,
  )
  const body = asRecord(response.body)
  const url = textOf(asRecord(body.result).url) || undefined
  return { url }
}

export async function readWorkerEnv(account: LoadedAccount, name: string): Promise<WorkerEnv> {
  const cfAccountId = requireCfAccountId(account)
  const base = `/accounts/${encodeURIComponent(cfAccountId)}/workers/scripts/${encodeURIComponent(name)}`
  const [settings, secrets] = await Promise.all([
    cfFetch<{ result?: Record<string, unknown> }>(account.auth, `${base}/settings`),
    cfFetch<{ result?: Array<{ name?: string }> }>(account.auth, `${base}/secrets`),
  ])
  const vars: Array<{ name: string; value: string }> = []
  const secretNames = new Set<string>()
  for (const item of asArray(settings.result?.bindings)) {
    const binding = asRecord(item)
    if (typeof binding.name !== 'string') continue
    if (binding.type === 'plain_text') vars.push({ name: binding.name, value: textOf(binding.text) })
    if (binding.type === 'secret_text') secretNames.add(binding.name)
  }
  for (const item of asArray(secrets.result)) {
    const secret = asRecord(item)
    if (typeof secret.name === 'string') secretNames.add(secret.name)
  }
  return { vars, secrets: [...secretNames].sort() }
}

/** Names present in the source and absent or different in a target. */
export async function previewEnvSync(
  source: LoadedAccount,
  sourceName: string,
  targets: Array<{ account: LoadedAccount; workerName: string }>,
): Promise<EnvSyncPreview> {
  const sourceEnv = await readWorkerEnv(source, sourceName)
  const previews: EnvSyncTargetPreview[] = []
  for (const target of targets) {
    try {
      const targetEnv = await readWorkerEnv(target.account, target.workerName)
      const targetVars = new Map(targetEnv.vars.map((variable) => [variable.name, variable.value]))
      const targetSecrets = new Set(targetEnv.secrets)
      const missing: EnvSyncTargetPreview['missing'] = []
      const changed: EnvSyncTargetPreview['changed'] = []
      for (const variable of sourceEnv.vars) {
        const current = targetVars.get(variable.name)
        if (current === undefined) missing.push({ name: variable.name, type: 'plain_text' })
        else if (current !== variable.value) {
          changed.push({ name: variable.name, source: variable.value, target: current })
        }
      }
      for (const secret of sourceEnv.secrets) {
        if (!targetSecrets.has(secret)) missing.push({ name: secret, type: 'secret_text' })
      }
      previews.push({
        accountId: target.account.row.id,
        workerName: target.workerName,
        missing,
        changed,
      })
    } catch (error) {
      previews.push({
        accountId: target.account.row.id,
        workerName: target.workerName,
        missing: [],
        changed: [],
        error: errorText(error),
      })
    }
  }
  return { source: sourceEnv, previews }
}

/**
 * Apply selected environment keys to targets.
 *
 * A secret is written through the secrets endpoint. A plain variable can only change with a deploy,
 * so the target's current modules are uploaded again with the merged variable set.
 */
export async function executeEnvSync(
  source: LoadedAccount,
  sourceName: string,
  targets: Array<{ account: LoadedAccount; workerName: string }>,
  keys: string[] | undefined,
  secretValues: Record<string, string>,
): Promise<EnvSyncResult[]> {
  const sourceEnv = await readWorkerEnv(source, sourceName)
  const sourceVars = new Map(sourceEnv.vars.map((variable) => [variable.name, variable.value]))
  const sourceSecrets = new Set(sourceEnv.secrets)
  const requested = keys && keys.length > 0
    ? keys
    : [...sourceVars.keys(), ...sourceSecrets]
  for (const key of requested) {
    if (!sourceVars.has(key) && !sourceSecrets.has(key)) {
      throw ApiError.badRequest(`Unknown environment key: ${key}`)
    }
  }

  const results: EnvSyncResult[] = []
  for (const target of targets) {
    const applied: string[] = []
    try {
      const cfAccountId = requireCfAccountId(target.account)
      const base = `/accounts/${encodeURIComponent(cfAccountId)}/workers/scripts/${encodeURIComponent(target.workerName)}`
      const secretKeys = requested.filter((key) => sourceSecrets.has(key))
      for (const key of secretKeys) {
        const value = secretValues[key]
        if (!value) throw ApiError.badRequest(`Secret ${key} needs a value before it can be synced`)
        assertSecretName(key)
        await cfFetch(target.account.auth, `${base}/secrets`, {
          method: 'PUT',
          body: { name: key, type: 'secret_text', text: value },
        })
        applied.push(key)
      }

      const plainKeys = requested.filter((key) => sourceVars.has(key))
      if (plainKeys.length > 0) {
        const targetEnv = await readWorkerEnv(target.account, target.workerName)
        const merged = new Map(targetEnv.vars.map((variable) => [variable.name, variable.value]))
        for (const key of plainKeys) merged.set(key, sourceVars.get(key) ?? '')
        await deployWorkerScript({
          account: target.account,
          name: target.workerName,
          vars: [...merged].map(([varName, value]) => ({ name: varName, value, secret: false })),
          bindings: [],
          isRedeploy: true,
        })
        applied.push(...plainKeys)
      }
      results.push({
        accountId: target.account.row.id,
        workerName: target.workerName,
        success: true,
        applied,
      })
    } catch (error) {
      results.push({
        accountId: target.account.row.id,
        workerName: target.workerName,
        success: false,
        applied,
        error: errorText(error),
      })
    }
  }
  return results
}
