interface Bucket { start: number; count: number }

const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 5000

export interface RateLimitResult {
  ok: boolean
  retryAfterSec: number
}

export function checkRateLimit(key: string, max: number, windowMs: number, now = Date.now()): RateLimitResult {
  if (buckets.size > MAX_BUCKETS) {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.start >= windowMs) buckets.delete(bucketKey)
    }
  }
  const current = buckets.get(key)
  if (!current || now - current.start >= windowMs) {
    buckets.set(key, { start: now, count: 1 })
    return { ok: true, retryAfterSec: 0 }
  }
  current.count += 1
  if (current.count > max) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((current.start + windowMs - now) / 1000)) }
  }
  return { ok: true, retryAfterSec: 0 }
}

export function clearRateLimit(): void {
  buckets.clear()
}
