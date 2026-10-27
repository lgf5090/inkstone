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
