/**
 * KV namespaces, keys and values through the Cloudflare REST API.
 *
 * The service speaks only to Cloudflare; account ownership and demo protection belong to the route.
 * Values are written as raw text with the TTL in the query string, which avoids multipart on a PUT
 * that only carries one field.
 */
import type { CloudflareAuth } from './cf-api'
import {
  cfFetch,
  cfFetchAll,
  cfFetchRaw,
  CloudflareApiError,
  upstreamApiError,
} from './cf-api'
import { ApiError } from '../lib/errors'

export const KV_BULK_CHUNK = 1_000
const KV_PAGE_LIMIT = 100
const KV_KEY_MAX_BYTES = 512
const KV_VALUE_MAX_BYTES = 25 * 1024 * 1024

export interface KvNamespace {
  id: string
  title: string
}

export interface KvKey {
  name: string
  expiration?: number
  metadata?: unknown
}

export interface KvKeysPage {
  keys: KvKey[]
  cursor: string | null
}

interface CfNamespace {
  id?: unknown
  title?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toNamespace(row: CfNamespace): KvNamespace | null {
  const id = text(row.id)
  if (!id) return null
  return { id, title: text(row.title) || id }
}

function toKey(row: unknown): KvKey | null {
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const name = text(record.name)
  if (!name) return null
  const key: KvKey = { name }
  if (typeof record.expiration === 'number') key.expiration = record.expiration
  if (record.metadata !== undefined) key.metadata = record.metadata
  return key
}

function assertKvKey(key: string): void {
  if (!key) throw ApiError.badRequest('A KV key is required')
  if (new TextEncoder().encode(key).byteLength > KV_KEY_MAX_BYTES) {
    throw ApiError.badRequest(`A KV key may be at most ${KV_KEY_MAX_BYTES} bytes`)
  }
}

function assertKvValue(value: string): void {
  if (new TextEncoder().encode(value).byteLength > KV_VALUE_MAX_BYTES) {
    throw ApiError.tooLarge(`A KV value may be at most ${KV_VALUE_MAX_BYTES / (1024 * 1024)} MB`)
  }
}

function namespacePath(cfAccountId: string, namespaceId: string): string {
  return `/accounts/${encodeURIComponent(cfAccountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}`
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  const body = await response.text()
  throw upstreamApiError(new CloudflareApiError({ status: response.status, body }))
}

export async function listKvNamespaces(
  auth: CloudflareAuth,
  cfAccountId: string,
): Promise<KvNamespace[]> {
  const rows = await cfFetchAll<CfNamespace>(auth, `/accounts/${encodeURIComponent(cfAccountId)}/storage/kv/namespaces`, KV_PAGE_LIMIT)
  return rows.map(toNamespace).filter((row): row is KvNamespace => row !== null)
}

export async function createKvNamespace(
  auth: CloudflareAuth,
  cfAccountId: string,
  title: string,
): Promise<KvNamespace> {
  const body = await cfFetch<{ result?: CfNamespace }>(
    auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/storage/kv/namespaces`,
    { method: 'POST', body: { title } },
  )
  const created = body.result ? toNamespace(body.result) : null
  if (!created) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a namespace without answering with it')
  return created
}

export async function deleteKvNamespace(
  auth: CloudflareAuth,
  cfAccountId: string,
  namespaceId: string,
): Promise<void> {
  await cfFetch(auth, namespacePath(cfAccountId, namespaceId), { method: 'DELETE' })
}

export interface KvKeyListOptions {
  prefix?: string
  cursor?: string
  limit?: number
}

export async function listKvKeys(
  auth: CloudflareAuth,
  cfAccountId: string,
  namespaceId: string,
  options: KvKeyListOptions = {},
): Promise<KvKeysPage> {
  const query = new URLSearchParams()
  if (options.prefix) query.set('prefix', options.prefix)
  if (options.cursor) query.set('cursor', options.cursor)
  query.set('limit', String(options.limit ?? KV_PAGE_LIMIT))
  const body = await cfFetch<{
    result?: unknown[] | null
    result_info?: { cursor?: unknown }
  }>(auth, `${namespacePath(cfAccountId, namespaceId)}/keys?${query.toString()}`)
  const keys = (body.result ?? []).map(toKey).filter((row): row is KvKey => row !== null)
  const cursor = text(body.result_info?.cursor)
  return { keys, cursor: cursor || null }
}

export async function getKvValue(
  auth: CloudflareAuth,
  cfAccountId: string,
  namespaceId: string,
  key: string,
): Promise<string> {
  assertKvKey(key)
  const response = await cfFetchRaw(
    auth,
    `${namespacePath(cfAccountId, namespaceId)}/values/${encodeURIComponent(key)}`,
  )
  await ensureOk(response)
  return await response.text()
}

export interface KvValueWriteOptions {
  expiration?: number
  expirationTtl?: number
}

export async function putKvValue(
  auth: CloudflareAuth,
  cfAccountId: string,
  namespaceId: string,
  key: string,
  value: string,
  options: KvValueWriteOptions = {},
): Promise<void> {
  assertKvKey(key)
  assertKvValue(value)
  if (options.expiration !== undefined && options.expirationTtl !== undefined) {
    throw ApiError.badRequest('Set either expiration or expiration_ttl, not both')
  }
  const query = new URLSearchParams()
  if (options.expiration !== undefined) query.set('expiration', String(options.expiration))
  if (options.expirationTtl !== undefined) query.set('expiration_ttl', String(options.expirationTtl))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  const response = await cfFetchRaw(
    auth,
    `${namespacePath(cfAccountId, namespaceId)}/values/${encodeURIComponent(key)}${suffix}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: value,
    },
  )
  await ensureOk(response)
}

export async function deleteKvKey(
  auth: CloudflareAuth,
  cfAccountId: string,
  namespaceId: string,
  key: string,
): Promise<void> {
  assertKvKey(key)
  await cfFetch(
    auth,
    `${namespacePath(cfAccountId, namespaceId)}/values/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  )
}

/** Deletes in chunks: the bulk endpoint has a per-request key ceiling. */
export async function bulkDeleteKvKeys(
  auth: CloudflareAuth,
  cfAccountId: string,
  namespaceId: string,
  keys: readonly string[],
): Promise<number> {
  if (keys.length === 0) throw ApiError.badRequest('At least one key is required')
  for (const key of keys) assertKvKey(key)
  let deleted = 0
  for (let start = 0; start < keys.length; start += KV_BULK_CHUNK) {
    const chunk = keys.slice(start, start + KV_BULK_CHUNK)
    await cfFetch(auth, `${namespacePath(cfAccountId, namespaceId)}/bulk`, {
      method: 'DELETE',
      body: chunk,
    })
    deleted += chunk.length
  }
  return deleted
}
