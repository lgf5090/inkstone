import { beforeEach, describe, expect, it } from 'vitest'
import { checkRateLimit, clearRateLimit } from '../src/worker/imgbed/rate-limit'

describe('imgbed rate limit', () => {
  beforeEach(() => clearRateLimit())

  it('allows the budget and rejects the next request until the window moves', () => {
    const start = 1_000_000
    expect(checkRateLimit('ip:1', 2, 60_000, start).ok).toBe(true)
    expect(checkRateLimit('ip:1', 2, 60_000, start + 1).ok).toBe(true)
    const blocked = checkRateLimit('ip:1', 2, 60_000, start + 2)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterSec).toBe(60)
    expect(checkRateLimit('ip:1', 2, 60_000, start + 60_000).ok).toBe(true)
  })

  it('keeps keys independent', () => {
    expect(checkRateLimit('a', 1, 1_000, 1).ok).toBe(true)
    expect(checkRateLimit('b', 1, 1_000, 1).ok).toBe(true)
    expect(checkRateLimit('a', 1, 1_000, 2).ok).toBe(false)
    expect(checkRateLimit('b', 1, 1_000, 2).ok).toBe(false)
  })
})
