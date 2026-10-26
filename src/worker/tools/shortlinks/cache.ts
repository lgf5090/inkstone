/**
 * Edge KV Cache for short link redirection.
 * Gracefully falls through when KV is not bound.
 */

export interface CachedSlugEntry {
  url: string
  link_id: number
  user_id: string
  disabled_at: number | null
  expires_at: number | null
  password_hash: string | null
}

const KV_PREFIX = 'slug:'

export async function getCachedSlug(
  kv: KVNamespace | undefined,
  slug: string,
): Promise<CachedSlugEntry | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(`${KV_PREFIX}${slug}`, 'json')
    return (raw as CachedSlugEntry) ?? null
  } catch {
    return null
  }
}

export async function putCachedSlug(
  kv: KVNamespace | undefined,
  slug: string,
  entry: CachedSlugEntry,
  ttlSeconds = 86400,
): Promise<void> {
  if (!kv) return
  try {
    await kv.put(`${KV_PREFIX}${slug}`, JSON.stringify(entry), {
      expirationTtl: Math.max(60, ttlSeconds),
    })
  } catch {
    // Non-fatal
  }
}

export async function deleteCachedSlug(
  kv: KVNamespace | undefined,
  slug: string,
): Promise<void> {
  if (!kv) return
  try {
    await kv.delete(`${KV_PREFIX}${slug}`)
  } catch {
    // Non-fatal
  }
}
