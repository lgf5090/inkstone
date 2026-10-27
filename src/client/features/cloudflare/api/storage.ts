/**
 * The storage screen's calls.
 *
 * Every path segment a reader can name — an account, a namespace, a key, a bucket — is encoded here,
 * so a key full of slashes stays one segment. Downloads go through `cfDownload`, which keeps the bytes
 * and the filename the route chose.
 */
import { cfDownload, cfRequest, type CloudflareDownload } from './client'

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

export interface D1Database {
  id: string
  name: string
  created_at?: string
}

export interface D1Table {
  name: string
  rows: number
}

export interface D1Column {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

export interface D1QueryMeta {
  duration: number
  rows_read?: number
  rows_written?: number
  changes?: number
}

export interface D1QueryResult {
  results: Record<string, unknown>[]
  meta: D1QueryMeta
}

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

interface DeletedResponse {
  deleted: number | true
}

const segment = encodeURIComponent

function queryString(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

function accountPath(accountId: string): string {
  return `/storage/${segment(accountId)}`
}

function kvPath(accountId: string, namespaceId?: string): string {
  return `${accountPath(accountId)}/kv${namespaceId ? `/${segment(namespaceId)}` : ''}`
}

function d1Path(accountId: string, databaseId?: string): string {
  return `${accountPath(accountId)}/d1${databaseId ? `/${segment(databaseId)}` : ''}`
}

function r2Path(accountId: string, bucket?: string): string {
  return `${accountPath(accountId)}/r2${bucket ? `/${segment(bucket)}` : ''}`
}

export const storageApi = {
  listKvNamespaces: (accountId: string) =>
    cfRequest<{ namespaces: KvNamespace[] }>(kvPath(accountId)),

  createKvNamespace: (accountId: string, title: string) =>
    cfRequest<KvNamespace>(kvPath(accountId), { method: 'POST', body: { title } }),

  deleteKvNamespace: (accountId: string, namespaceId: string) =>
    cfRequest<DeletedResponse>(kvPath(accountId, namespaceId), { method: 'DELETE' }),

  listKvKeys: (
    accountId: string,
    namespaceId: string,
    params: { prefix?: string; cursor?: string; limit?: number } = {},
  ) => cfRequest<KvKeysPage>(`${kvPath(accountId, namespaceId)}/keys${queryString(params)}`),

  getKvValue: (accountId: string, namespaceId: string, key: string) =>
    cfRequest<{ value: string }>(
      `${kvPath(accountId, namespaceId)}/values/${segment(key)}`,
    ),

  putKvValue: (
    accountId: string,
    namespaceId: string,
    key: string,
    value: string,
    options: { expiration?: number; expiration_ttl?: number } = {},
  ) => cfRequest<{ saved: boolean }>(
    `${kvPath(accountId, namespaceId)}/values/${segment(key)}`,
    { method: 'PUT', body: { value, ...options }, timeoutMs: 60_000 },
  ),

  deleteKvKey: (accountId: string, namespaceId: string, key: string) =>
    cfRequest<DeletedResponse>(
      `${kvPath(accountId, namespaceId)}/values/${segment(key)}`,
      { method: 'DELETE' },
    ),

  bulkDeleteKvKeys: (accountId: string, namespaceId: string, keys: string[]) =>
    cfRequest<DeletedResponse>(`${kvPath(accountId, namespaceId)}/bulk-delete`, {
      method: 'POST',
      body: { keys },
    }),

  listD1Databases: (accountId: string) =>
    cfRequest<{ databases: D1Database[] }>(d1Path(accountId)),

  createD1Database: (accountId: string, name: string) =>
    cfRequest<D1Database>(d1Path(accountId), { method: 'POST', body: { name } }),

  deleteD1Database: (accountId: string, databaseId: string) =>
    cfRequest<DeletedResponse>(d1Path(accountId, databaseId), { method: 'DELETE' }),

  listD1Tables: (accountId: string, databaseId: string) =>
    cfRequest<{ tables: D1Table[] }>(`${d1Path(accountId, databaseId)}/tables`),

  getD1TableSchema: (accountId: string, databaseId: string, tableName: string) =>
    cfRequest<{ schema: D1Column[] }>(
      `${d1Path(accountId, databaseId)}/tables/${segment(tableName)}/schema`,
    ),

  executeD1Query: (accountId: string, databaseId: string, sql: string, allowWrite = false) =>
    cfRequest<D1QueryResult>(`${d1Path(accountId, databaseId)}/query`, {
      method: 'POST',
      body: { sql, allowWrite },
      timeoutMs: 60_000,
    }),

  listR2Buckets: (accountId: string) =>
    cfRequest<{ buckets: R2Bucket[] }>(r2Path(accountId)),

  createR2Bucket: (accountId: string, name: string) =>
    cfRequest<R2Bucket>(r2Path(accountId), { method: 'POST', body: { name } }),

  deleteR2Bucket: (accountId: string, bucket: string) =>
    cfRequest<DeletedResponse>(r2Path(accountId, bucket), { method: 'DELETE' }),

  listR2Objects: (
    accountId: string,
    bucket: string,
    params: { prefix?: string; delimiter?: string; cursor?: string; limit?: number } = {},
  ) => cfRequest<R2ListPage>(
    `${r2Path(accountId, bucket)}/objects${queryString(params)}`,
  ),

  downloadR2Object: async (accountId: string, bucket: string, key: string): Promise<CloudflareDownload> => {
    const download = await cfDownload(
      `${r2Path(accountId, bucket)}/download?key=${segment(key)}`,
      key.split('/').pop() || 'download',
    )
    // The route's ASCII fallback is for HTTP clients; the object's own name is the useful one here.
    return { ...download, filename: key.split('/').pop() || download.filename }
  },

  uploadR2Object: (accountId: string, bucket: string, key: string, file: File) => {
    const form = new FormData()
    form.append('key', key)
    form.append('file', file)
    return cfRequest<{ uploaded: boolean; key: string; size: number }>(
      `${r2Path(accountId, bucket)}/upload`,
      { method: 'PUT', formData: form, timeoutMs: 120_000 },
    )
  },

  deleteR2Object: (accountId: string, bucket: string, key: string) =>
    cfRequest<DeletedResponse>(
      `${r2Path(accountId, bucket)}/objects?key=${segment(key)}`,
      { method: 'DELETE' },
    ),

  bulkDeleteR2Objects: (accountId: string, bucket: string, keys: string[]) =>
    cfRequest<DeletedResponse>(`${r2Path(accountId, bucket)}/bulk-delete`, {
      method: 'POST',
      body: { keys },
    }),
}
