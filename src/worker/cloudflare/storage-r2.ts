/**
 * R2 buckets and objects.
 *
 * Uploads and downloads bypass `cfFetchRaw`'s JSON body handling: an object is bytes, not a value to
 * stringify, so those two calls are made here against the same origin with the account's own headers.
 * Keys are validated before any path is built, because a key is the one part of an R2 URL a reader
 * controls.
 */
import type { CloudflareAuth } from './cf-api'
import {
  authHeaders,
  cfFetch,
  cfFetchRaw,
  CF_API_BASE,
  CloudflareApiError,
  upstreamApiError,
} from './cf-api'
import { ApiError } from '../lib/errors'

export const R2_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
export const R2_DELETE_CONCURRENCY = 5
const R2_KEY_MAX_LENGTH = 1024
const R2_LIST_LIMIT = 100
const R2_TRANSFER_TIMEOUT_MS = 300_000

export interface R2Bucket {
  name: string
  creation_date?: string
  location?: string
}

export interface R2ObjectInfo {
  key: string
  size: number
  etag: string
  last_modified: string
  content_type: string
}

export interface R2ListPage {
  objects: R2ObjectInfo[]
  delimited_prefixes: string[]
  cursor: string | null
}

interface CfBucket {
  name?: unknown
  creation_date?: unknown
  location?: unknown
}

interface CfObject {
  key?: unknown
  size?: unknown
  etag?: unknown
  last_modified?: unknown
  http_metadata?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toBucket(row: CfBucket): R2Bucket | null {
  const name = text(row.name)
  if (!name) return null
  const bucket: R2Bucket = { name }
  const creation = text(row.creation_date)
  const location = text(row.location)
  if (creation) bucket.creation_date = creation
  if (location) bucket.location = location
  return bucket
}

function toObject(row: CfObject): R2ObjectInfo | null {
  const key = text(row.key)
  if (!key) return null
  let contentType = ''
  if (row.http_metadata && typeof row.http_metadata === 'object') {
    const metadata = row.http_metadata as Record<string, unknown>
    contentType = text(metadata.contentType) || text(metadata.content_type)
  }
  return {
    key,
    size: typeof row.size === 'number' ? row.size : 0,
    etag: text(row.etag),
    last_modified: text(row.last_modified),
    content_type: contentType,
  }
}

export function assertValidBucketName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
    throw ApiError.badRequest('An R2 bucket name must be 3-63 lowercase letters, numbers or hyphens')
  }
}

export function assertValidR2Key(key: string, label = 'object key'): void {
  if (!key) throw ApiError.badRequest(`A ${label} is required`)
  if (key.length > R2_KEY_MAX_LENGTH) {
    throw ApiError.badRequest(`A ${label} may be at most ${R2_KEY_MAX_LENGTH} characters`)
  }
  if (key.startsWith('/')) throw ApiError.badRequest(`A ${label} cannot start with a slash`)
  if (key.includes('..')) throw ApiError.badRequest(`A ${label} cannot contain ".."`)
  if (/[\u0000-\u001f\u007f\\]/.test(key)) {
    throw ApiError.badRequest(`A ${label} contains a forbidden character`)
  }
}

function bucketPath(cfAccountId: string, bucket: string): string {
  return `/accounts/${encodeURIComponent(cfAccountId)}/r2/buckets/${encodeURIComponent(bucket)}`
}

function objectPath(cfAccountId: string, bucket: string, key: string): string {
  return `${bucketPath(cfAccountId, bucket)}/objects/${encodeURIComponent(key)}`
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  const body = await response.text()
  throw upstreamApiError(new CloudflareApiError({ status: response.status, body }))
}

export async function listR2Buckets(
  auth: CloudflareAuth,
  cfAccountId: string,
): Promise<R2Bucket[]> {
  const body = await cfFetch<{ result?: CfBucket[] | { buckets?: CfBucket[] } | null }>(
    auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/r2/buckets`,
  )
  const rows = Array.isArray(body.result) ? body.result : body.result?.buckets ?? []
  return rows.map(toBucket).filter((row): row is R2Bucket => row !== null)
}

export async function createR2Bucket(
  auth: CloudflareAuth,
  cfAccountId: string,
  name: string,
): Promise<R2Bucket> {
  assertValidBucketName(name)
  const body = await cfFetch<{ result?: CfBucket | null }>(
    auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/r2/buckets`,
    { method: 'POST', body: { name } },
  )
  return (body.result ? toBucket(body.result) : null) ?? { name }
}

export async function deleteR2Bucket(
  auth: CloudflareAuth,
  cfAccountId: string,
  bucket: string,
): Promise<void> {
  assertValidBucketName(bucket)
  await cfFetch(auth, bucketPath(cfAccountId, bucket), { method: 'DELETE' })
}

export interface R2ListOptions {
  prefix?: string
  delimiter?: string
  cursor?: string
  limit?: number
}

export async function listR2Objects(
  auth: CloudflareAuth,
  cfAccountId: string,
  bucket: string,
  options: R2ListOptions = {},
): Promise<R2ListPage> {
  assertValidBucketName(bucket)
  const prefix = options.prefix ?? ''
  if (prefix) assertValidR2Key(prefix, 'prefix')
  const delimiter = options.delimiter ?? '/'
  if (delimiter !== '' && delimiter !== '/') throw ApiError.badRequest('The delimiter must be empty or "/"')
  const limit = Math.min(Math.max(options.limit ?? R2_LIST_LIMIT, 1), 1000)
  const query = new URLSearchParams()
  if (prefix) query.set('prefix', prefix)
  if (delimiter) query.set('delimiter', delimiter)
  if (options.cursor) query.set('cursor', options.cursor)
  query.set('per_page', String(limit))
  const body = await cfFetch<{
    result?: CfObject[] | { objects?: CfObject[] } | null
    result_info?: { delimited?: unknown; cursor?: unknown }
  }>(auth, `${bucketPath(cfAccountId, bucket)}/objects?${query.toString()}`)
  const rows = Array.isArray(body.result) ? body.result : body.result?.objects ?? []
  const delimited = Array.isArray(body.result_info?.delimited)
    ? body.result_info.delimited.filter((entry): entry is string => typeof entry === 'string')
    : []
  const cursor = text(body.result_info?.cursor)
  return {
    objects: rows.map(toObject).filter((row): row is R2ObjectInfo => row !== null),
    delimited_prefixes: delimited,
    cursor: cursor || null,
  }
}

export async function fetchR2Object(
  auth: CloudflareAuth,
  cfAccountId: string,
  bucket: string,
  key: string,
): Promise<Response> {
  assertValidBucketName(bucket)
  assertValidR2Key(key)
  const response = await cfFetchRaw(auth, objectPath(cfAccountId, bucket, key), {
    timeoutMs: R2_TRANSFER_TIMEOUT_MS,
  })
  await ensureOk(response)
  return response
}

export async function uploadR2Object(
  auth: CloudflareAuth,
  cfAccountId: string,
  bucket: string,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  assertValidBucketName(bucket)
  assertValidR2Key(key)
  if (bytes.byteLength > R2_UPLOAD_MAX_BYTES) {
    throw ApiError.tooLarge(`An R2 object may be at most ${R2_UPLOAD_MAX_BYTES / (1024 * 1024)} MB`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), R2_TRANSFER_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${CF_API_BASE}${objectPath(cfAccountId, bucket, key)}`, {
      method: 'PUT',
      headers: {
        ...authHeaders(auth),
        'Content-Type': contentType || 'application/octet-stream',
      },
      body: bytes,
      signal: controller.signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not accept the upload in time')
    }
    throw new ApiError(
      502,
      'cloudflare_upstream',
      `Cloudflare could not be reached: ${(error as Error)?.message ?? 'network error'}`,
    )
  } finally {
    clearTimeout(timer)
  }
  await ensureOk(response)
}

export async function deleteR2Object(
  auth: CloudflareAuth,
  cfAccountId: string,
  bucket: string,
  key: string,
): Promise<void> {
  assertValidBucketName(bucket)
  assertValidR2Key(key)
  await cfFetch(auth, objectPath(cfAccountId, bucket, key), { method: 'DELETE' })
}

export interface R2CorsRule {
  id?: string
  allowed?: { methods?: string[]; origins?: string[]; headers?: string[]; [key: string]: unknown }
  exposeHeaders?: string[]
  maxAgeSeconds?: number
  [key: string]: unknown
}

export interface R2ManagedDomain {
  domain: string
  enabled: boolean
}

export interface R2CustomDomain {
  domain: string
  enabled: boolean
  status: { ownership: string; ssl: string }
  zoneId?: string
  zoneName?: string
  minTLS?: string
}

export interface R2LifecycleCondition {
  type: string
  maxAge?: number
  date?: string
}

export interface R2LifecycleRule {
  id?: string
  enabled: boolean
  conditions?: { prefix?: string }
  abortMultipartUploadsTransition?: { condition?: R2LifecycleCondition }
  deleteObjectsTransition?: { condition?: R2LifecycleCondition }
  storageClassTransitions?: Array<{ condition?: R2LifecycleCondition; storageClass?: string }>
  [key: string]: unknown
}

export interface R2BucketSettings {
  cors: R2CorsRule[]
  managed_domain: R2ManagedDomain
  custom_domains: R2CustomDomain[]
  lifecycle: R2LifecycleRule[]
}

const CORS_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'HEAD']
const TLS_VERSIONS = ['1.0', '1.1', '1.2', '1.3']

function settingsPath(cfAccountId: string, bucket: string, section: string): string {
  return `${bucketPath(cfAccountId, bucket)}/${section}`
}

function corsPath(cfAccountId: string, bucket: string): string {
  return settingsPath(cfAccountId, bucket, 'cors')
}

function lifecyclePath(cfAccountId: string, bucket: string): string {
  return settingsPath(cfAccountId, bucket, 'lifecycle')
}

function managedDomainPath(cfAccountId: string, bucket: string): string {
  return settingsPath(cfAccountId, bucket, 'domains/managed')
}

function customDomainsPath(cfAccountId: string, bucket: string, domain?: string): string {
  const base = settingsPath(cfAccountId, bucket, 'domains/custom')
  return domain ? `${base}/${encodeURIComponent(domain)}` : base
}

/** Cloudflare answers 404 for a bucket that has no policy at all; that is an empty setting, not a failure. */
async function getOptional<T>(auth: CloudflareAuth, path: string): Promise<T | null> {
  try {
    return await cfFetch<T>(auth, path)
  } catch (error) {
    if (error instanceof ApiError) {
      const upstream = (error.details as { upstream_status?: unknown } | undefined)?.upstream_status
      if (upstream === 404) return null
    }
    throw error
  }
}

function stringEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function corsRulesFrom(value: unknown): R2CorsRule[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is R2CorsRule => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
  )
}

function lifecycleRulesFrom(value: unknown): R2LifecycleRule[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is R2LifecycleRule => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
  )
}

function toManagedDomain(value: unknown): R2ManagedDomain {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return { domain: text(record.domain), enabled: record.enabled === true }
}

function toCustomDomain(value: unknown): R2CustomDomain | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const domain = text(record.domain)
  if (!domain) return null
  const status = record.status && typeof record.status === 'object' && !Array.isArray(record.status)
    ? record.status as Record<string, unknown>
    : {}
  return {
    domain,
    enabled: record.enabled === true,
    status: { ownership: text(status.ownership), ssl: text(status.ssl) },
    ...(text(record.zoneId) ? { zoneId: text(record.zoneId) } : {}),
    ...(text(record.zoneName) ? { zoneName: text(record.zoneName) } : {}),
    ...(text(record.minTLS) ? { minTLS: text(record.minTLS) } : {}),
  }
}

/**
 * Every bucket setting the screen shows, read in one round of parallel calls.
 *
 * A section Cloudflare answers 404 for comes back empty: a bucket with no CORS or lifecycle policy is
 * a normal configuration, not a failure. Any other error is passed through so the screen can name it.
 */
export async function readR2BucketSettings(
  auth: CloudflareAuth,
  cfAccountId: string,
  bucket: string,
): Promise<R2BucketSettings> {
  assertValidBucketName(bucket)
  const [cors, managed, custom, lifecycle] = await Promise.all([
    getOptional<{ result?: { rules?: unknown[] } | R2CorsRule[] | null }>(auth, corsPath(cfAccountId, bucket)),
    getOptional<{ result?: unknown }>(auth, managedDomainPath(cfAccountId, bucket)),
    getOptional<{ result?: { domains?: unknown[] } | null }>(auth, customDomainsPath(cfAccountId, bucket)),
    getOptional<{ result?: { rules?: unknown[] } | null }>(auth, lifecyclePath(cfAccountId, bucket)),
  ])
  const corsResult = cors?.result
  const corsRules = Array.isArray(corsResult) ? corsResult : corsResult?.rules
  const customResult = custom?.result
  const domains = (Array.isArray(customResult) ? customResult : customResult?.domains) ?? []
  return {
    cors: corsRulesFrom(corsRules),
    managed_domain: toManagedDomain(managed?.result),
    custom_domains: domains
      .map(toCustomDomain)
      .filter((domain): domain is R2CustomDomain => domain !== null),
    lifecycle: lifecycleRulesFrom(lifecycle?.result?.rules),
  }
}

function assertCorsRules(value: unknown): R2CorsRule[] {
  if (!Array.isArray(value)) throw ApiError.badRequest('CORS rules must be an array')
  if (value.length > 100) throw ApiError.badRequest('At most 100 CORS rules may be saved at once')
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw ApiError.badRequest(`CORS rule ${index + 1} is not an object`)
    }
    const rule = entry as Record<string, unknown>
    const allowed = rule.allowed
    if (!allowed || typeof allowed !== 'object' || Array.isArray(allowed)) {
      throw ApiError.badRequest(`CORS rule ${index + 1} has no allowed block`)
    }
    const allowedRecord = allowed as Record<string, unknown>
    const origins = stringEntries(allowedRecord.origins)
    const methods = stringEntries(allowedRecord.methods)
    if (origins.length === 0) throw ApiError.badRequest(`CORS rule ${index + 1} needs at least one origin`)
    if (methods.length === 0) throw ApiError.badRequest(`CORS rule ${index + 1} needs at least one method`)
    for (const method of methods) {
      if (!CORS_METHODS.includes(method)) {
        throw ApiError.badRequest(`CORS rule ${index + 1} has an unsupported method: ${method}`)
      }
    }
    const headers = allowedRecord.headers
    if (headers !== undefined && (!Array.isArray(headers) || headers.some((header) => typeof header !== 'string'))) {
      throw ApiError.badRequest(`CORS rule ${index + 1} has an invalid headers list`)
    }
    const maxAge = rule.maxAgeSeconds
    if (maxAge !== undefined && (
      typeof maxAge !== 'number' || !Number.isInteger(maxAge) || maxAge < 0 || maxAge > 604_800
    )) {
      throw ApiError.badRequest(`CORS rule ${index + 1} has an invalid max age`)
    }
    return rule as R2CorsRule
  })
}

/** Replaces the bucket's whole CORS policy; an empty list removes it with the API's own DELETE. */
export async function writeR2CorsPolicy(
  auth: CloudflareAuth,
  cfAccountId: string,
  bucket: string,
  rules: unknown,
): Promise<void> {
  assertValidBucketName(bucket)
  const validated = assertCorsRules(rules)
  if (validated.length === 0) {
    await cfFetch(auth, corsPath(cfAccountId, bucket), { method: 'DELETE' })
    return
  }
  await cfFetch(auth, corsPath(cfAccountId, bucket), { method: 'PUT', body: { rules: validated } })
}

function assertLifecycleCondition(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest(`${label} has no condition`)
  }
  const condition = value as Record<string, unknown>
  if (condition.type === 'Age') {
    if (typeof condition.maxAge !== 'number' || !Number.isInteger(condition.maxAge) || condition.maxAge < 1) {
      throw ApiError.badRequest(`${label} needs a whole number of seconds`)
    }
    return
  }
  if (condition.type === 'Date') {
    if (typeof condition.date !== 'string' || Number.isNaN(Date.parse(condition.date))) {
      throw ApiError.badRequest(`${label} needs a valid date`)
    }
    return
  }
  throw ApiError.badRequest(`${label} has an unsupported condition type`)
}

function assertLifecycleRules(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw ApiError.badRequest('Lifecycle rules must be an array')
  if (value.length > 100) throw ApiError.badRequest('At most 100 lifecycle rules may be saved at once')
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw ApiError.badRequest(`Lifecycle rule ${index + 1} is not an object`)
    }
    const rule = entry as Record<string, unknown>
    if (typeof rule.enabled !== 'boolean') {
      throw ApiError.badRequest(`Lifecycle rule ${index + 1} needs an enabled flag`)
    }
    const conditions = rule.conditions
    if (conditions !== undefined) {
      if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) {
        throw ApiError.badRequest(`Lifecycle rule ${index + 1} has invalid conditions`)
      }
      const prefix = (conditions as Record<string, unknown>).prefix
      if (prefix !== undefined && (typeof prefix !== 'string' || prefix.length > 1024)) {
        throw ApiError.badRequest(`Lifecycle rule ${index + 1} has an invalid prefix`)
      }
    }
    const transitions = [rule.abortMultipartUploadsTransition, rule.deleteObjectsTransition]
    transitions.forEach((transition, transitionIndex) => {
      if (transition === undefined) return
      if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
        throw ApiError.badRequest(`Lifecycle rule ${index + 1} has an invalid transition`)
      }
      assertLifecycleCondition(
        (transition as Record<string, unknown>).condition,
        `Lifecycle rule ${index + 1} transition ${transitionIndex + 1}`,
      )
    })
    const storageClasses = rule.storageClassTransitions
    if (storageClasses !== undefined) {
      if (!Array.isArray(storageClasses)) {
        throw ApiError.badRequest(`Lifecycle rule ${index + 1} has an invalid storage-class list`)
      }
      for (const transition of storageClasses) {
        if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
          throw ApiError.badRequest(`Lifecycle rule ${index + 1} has an invalid storage-class transition`)
        }
        assertLifecycleCondition(
          (transition as Record<string, unknown>).condition,
          `Lifecycle rule ${index + 1} storage-class transition`,
        )
      }
    }
    return rule
  })
}

/** Replaces the whole lifecycle policy; an empty list removes it with the API's own DELETE. */
export async function writeR2LifecycleRules(
  auth: CloudflareAuth,
  cfAccountId: string,
  bucket: string,
  rules: unknown,
): Promise<void> {
  assertValidBucketName(bucket)
  const validated = assertLifecycleRules(rules)
  if (validated.length === 0) {
    await cfFetch(auth, lifecyclePath(cfAccountId, bucket), { method: 'DELETE' })
    return
  }
  await cfFetch(auth, lifecyclePath(cfAccountId, bucket), { method: 'PUT', body: { rules: validated } })
}

export async function setR2ManagedDomainEnabled(
  auth: CloudflareAuth,
  cfAccountId: string,
  bucket: string,
  enabled: boolean,
): Promise<void> {
  assertValidBucketName(bucket)
  await cfFetch(auth, managedDomainPath(cfAccountId, bucket), { method: 'PUT', body: { enabled } })
}

const CUSTOM_DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/

export async function attachR2CustomDomain(
  auth: CloudflareAuth,
  cfAccountId: string,
  bucket: string,
  input: { domain: string; zoneId: string; minTLS?: string },
): Promise<void> {
  assertValidBucketName(bucket)
  const domain = input.domain.trim().toLowerCase()
  if (domain.length > 253 || !CUSTOM_DOMAIN.test(domain)) {
    throw ApiError.badRequest('A custom domain must be a plain lowercase hostname')
  }
  if (!/^[A-Za-z0-9]{1,64}$/.test(input.zoneId)) throw ApiError.badRequest('A zone id is required')
  if (input.minTLS !== undefined && !TLS_VERSIONS.includes(input.minTLS)) {
    throw ApiError.badRequest('The minimum TLS version must be 1.0, 1.1, 1.2 or 1.3')
  }
  await cfFetch(auth, customDomainsPath(cfAccountId, bucket), {
    method: 'POST',
    body: { domain, zoneId: input.zoneId, enabled: true, ...(input.minTLS ? { minTLS: input.minTLS } : {}) },
  })
}

export async function detachR2CustomDomain(
  auth: CloudflareAuth,
  cfAccountId: string,
  bucket: string,
  domain: string,
): Promise<void> {
  assertValidBucketName(bucket)
  const normalized = domain.trim().toLowerCase()
  if (normalized.length > 253 || !CUSTOM_DOMAIN.test(normalized)) {
    throw ApiError.badRequest('A custom domain must be a plain lowercase hostname')
  }
  await cfFetch(auth, customDomainsPath(cfAccountId, bucket, normalized), { method: 'DELETE' })
}

/** R2 has no bulk-delete endpoint, so keys go in bounded concurrent batches. */
export async function bulkDeleteR2Objects(
  auth: CloudflareAuth,
  cfAccountId: string,
  bucket: string,
  keys: readonly string[],
): Promise<number> {
  if (keys.length === 0) throw ApiError.badRequest('At least one object key is required')
  for (const key of keys) assertValidR2Key(key)
  let deleted = 0
  for (let start = 0; start < keys.length; start += R2_DELETE_CONCURRENCY) {
    const chunk = keys.slice(start, start + R2_DELETE_CONCURRENCY)
    await Promise.all(chunk.map((key) => deleteR2Object(auth, cfAccountId, bucket, key)))
    deleted += chunk.length
  }
  return deleted
}
