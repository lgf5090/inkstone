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
