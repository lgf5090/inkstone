/**
 * The persisted index cache. Everything read back from IndexedDB is validated before it is handed to
 * MiniSearch, because a record written by an older build — or a half-written one after the tab was
 * killed — must degrade into a rebuild rather than a wrong result set or a throw.
 */
import { localDb } from '../../lib/db'
import type { CachePayload } from './engine'

export const OMNISEARCH_CACHE_VERSION = 1

export interface OmnisearchCacheRecord {
  version: number
  fingerprint: string
  savedAt: number
  bodyBytes: number
  payload: CachePayload
}

function isNumberPair(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'string' && typeof value[1] === 'number' && Number.isFinite(value[1])
}

function isBoolPair(value: unknown): value is [string, boolean] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'boolean'
}

function isEmbedPair(value: unknown): value is [string, string[]] {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'string'
    && Array.isArray(value[1])
    && value[1].every((item) => typeof item === 'string')
}

export function isCacheRecord(value: unknown): value is OmnisearchCacheRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<OmnisearchCacheRecord>
  if (record.version !== OMNISEARCH_CACHE_VERSION) return false
  if (typeof record.fingerprint !== 'string') return false
  if (typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt)) return false
  if (typeof record.bodyBytes !== 'number' || !Number.isFinite(record.bodyBytes) || record.bodyBytes < 0) return false
  const payload = record.payload
  if (!payload || typeof payload !== 'object') return false
  if (typeof payload.index !== 'string' || !payload.index) return false
  if (!Array.isArray(payload.refs) || !payload.refs.every(isNumberPair)) return false
  if (!Array.isArray(payload.hasBody) || !payload.hasBody.every(isBoolPair)) return false
  if (!Array.isArray(payload.embeds) || !payload.embeds.every(isEmbedPair)) return false
  return true
}

export async function readCache(fingerprint: string): Promise<OmnisearchCacheRecord | null> {
  const value = await localDb.loadOmnisearchCache()
  if (!isCacheRecord(value)) return null
  // The reference plugin only checks a MiniSearch internal version and otherwise trusts the cache; a
  // fold or tokenizer change then silently answers from tokens the reader no longer types. MiniSearch
  // itself still refuses to load a foreign serialization, and that throw becomes a rebuild too.
  return value.fingerprint === fingerprint ? value : null
}

/** Returns false when the write was refused, which is what the quota-exceeded hint keys on. */
export async function writeCache(record: OmnisearchCacheRecord): Promise<boolean> {
  try {
    await localDb.saveOmnisearchCache(record)
    return true
  } catch {
    return false
  }
}

export async function eraseCache(bodyIds: readonly string[] = []): Promise<void> {
  await localDb.clearOmnisearchCache()
  await localDb.dropOmnisearchBodies(bodyIds)
}
