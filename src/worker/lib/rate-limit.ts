import { ApiError } from './errors'

/** Per-isolate ceiling on tracked callers; a busy minute of distinct users resets the table rather than growing without bound. */
const BUCKET_CAP = 512
const WINDOW_MS = 60_000

/**
 * Builds a per-caller, per-minute budget held in the isolate's memory.
 *
 * This is a brake on a runaway client, not a quota: it lives and dies with the isolate and every
 * deployment sees its own. Each caller gets `limit` spends per wall-clock minute; the next spend over
 * the limit answers `429` with `message`.
 */
export function createMinuteBudget(limit: number, message: string): (userId: string) => void {
  const buckets = new Map<string, { window: number; used: number }>()
  return (userId: string): void => {
    const windowStart = Math.floor(Date.now() / WINDOW_MS)
    const current = buckets.get(userId)
    if (!current || current.window !== windowStart) {
      if (buckets.size > BUCKET_CAP) buckets.clear()
      buckets.set(userId, { window: windowStart, used: 1 })
      return
    }
    current.used += 1
    if (current.used > limit) {
      throw new ApiError(429, 'too_many_attempts', message)
    }
  }
}

interface FixedBucket {
  start: number
  count: number
}

const fixedBuckets = new Map<string, FixedBucket>()
const MAX_FIXED_BUCKETS = 5000

export interface RateLimitResult {
  ok: boolean
  retryAfterSec: number
  firstBlock: boolean
}

export function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  if (fixedBuckets.size > MAX_FIXED_BUCKETS) {
    for (const [bucketKey, bucket] of fixedBuckets) {
      if (now - bucket.start >= windowMs) fixedBuckets.delete(bucketKey)
    }
  }
  const current = fixedBuckets.get(key)
  if (!current || now - current.start >= windowMs) {
    fixedBuckets.set(key, { start: now, count: 1 })
    return { ok: true, retryAfterSec: 0, firstBlock: false }
  }
  current.count += 1
  if (current.count > max) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((current.start + windowMs - now) / 1000)),
      firstBlock: current.count === max + 1,
    }
  }
  return { ok: true, retryAfterSec: 0, firstBlock: false }
}

export function clearRateLimit(): void {
  fixedBuckets.clear()
}
