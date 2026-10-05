import { expect, it } from 'vitest'
import { shareVerifyThrottleTargets, shouldPersistShareView } from '../src/worker/routes/share'

it('locks share passcode guessing per client IP only', () => {
  const targets = shareVerifyThrottleTargets('abc2d3ef4g', '203.0.113.7')
  expect(targets.lockTargets).toEqual([
    expect.stringContaining(':ip:203.0.113.7'),
  ])
  for (const target of [...targets.lockTargets, ...targets.workTargets.map((t) => t.key)]) {
    const raw = typeof target === 'string' ? target : target
    expect(raw).not.toContain('share-slug:')
  }
})

it('keeps a global slug work budget with a short fixed lock', () => {
  const global = shareVerifyThrottleTargets('abc2d3ef4g', '203.0.113.7')
    .workTargets.find((t) => t.key === 'share-work:abc2d3ef4g')
  expect(global).toMatchObject({ maxAttempts: 60, windowMs: 600_000, lockMs: 60_000 })
})

it('caps persisted share views per window and resets on rollover', () => {
  const t0 = 1_000_000
  let state = { count: 0, windowStart: 0 }
  for (let index = 0; index < 60; index++) {
    const hit = shouldPersistShareView(state, t0 + index)
    expect(hit.persist).toBe(true)
    state = hit.state
  }
  expect(shouldPersistShareView(state, t0 + 30).persist).toBe(false)
  const rolled = shouldPersistShareView(state, t0 + 61_000)
  expect(rolled.persist).toBe(true)
  expect(rolled.state).toEqual({ count: 1, windowStart: t0 + 61_000 })
})
