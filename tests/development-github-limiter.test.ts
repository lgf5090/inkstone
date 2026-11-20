// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/worker/env'
import { createGithubBudget } from '../src/worker/development/github/rate-limit'
import { testDurableObjectNamespace } from './doubles/bindings'
import { testGithubLimiter } from './doubles/github-limiter'

function envWith(namespace: DurableObjectNamespace): Env {
  return { GITHUB_LIMITER: namespace } as Env
}

afterEach(() => vi.restoreAllMocks())

describe('GitHub cross-isolate budget', () => {
  it('counts per caller across the shared object and reports the retry delay', async () => {
    const budget = createGithubBudget(2, 'contract', 'Too many requests.')
    const env = envWith(testGithubLimiter())
    await budget.spend(env, 'caller-a')
    await budget.spend(env, 'caller-a')
    await expect(budget.spend(env, 'caller-a')).rejects.toMatchObject({
      status: 429,
      code: 'too_many_attempts',
      details: { retryAfterSeconds: expect.any(Number) },
    })
    await budget.spend(env, 'caller-b')
  })

  it('keeps separate budgets for separate resource names', async () => {
    const env = envWith(testGithubLimiter())
    const search = createGithubBudget(1, 'search-contract', 'search')
    const write = createGithubBudget(1, 'write-contract', 'write')
    await search.spend(env, 'caller-c')
    await expect(search.spend(env, 'caller-c')).rejects.toMatchObject({ status: 429 })
    await write.spend(env, 'caller-c')
  })

  it('falls back to the isolate budget when no object is bound', async () => {
    const budget = createGithubBudget(2, 'fallback-contract', 'Too many requests.')
    const env = {} as Env
    await budget.spend(env, 'isolate-only-a')
    await budget.spend(env, 'isolate-only-a')
    await expect(budget.spend(env, 'isolate-only-a')).rejects.toMatchObject({ status: 429 })
  })

  it('falls back to the isolate budget when the object answers unexpectedly', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken = testDurableObjectNamespace(() => new Response('nope', { status: 500 }))
    const budget = createGithubBudget(2, 'broken-contract', 'Too many requests.')
    const env = envWith(broken)
    await budget.spend(env, 'isolate-only-b')
    await budget.spend(env, 'isolate-only-b')
    await expect(budget.spend(env, 'isolate-only-b')).rejects.toMatchObject({ status: 429 })
  })
})
