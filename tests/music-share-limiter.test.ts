// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/worker/env'
import { MusicShareLimiter } from '../src/worker/music/share-limiter'

function fakeState(): DurableObjectState {
  const values = new Map<string, unknown>()
  return {
    storage: {
      async get(key: string) { return values.get(key) },
      async put(key: string, value: unknown) { values.set(key, value) },
    },
    async blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T> { return await run() },
  } as unknown as DurableObjectState
}

function request(body: unknown, path = '/meter'): Request {
  return new Request(`https://music-share-limit.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('music share limiter', () => {
  it('counts one key across requests and reports the retry window', async () => {
    const limiter = new MusicShareLimiter(fakeState(), {} as Env)
    expect((await limiter.fetch(request({ key: 'ip:slug', limit: 2, windowMs: 60_000 }))).status).toBe(204)
    expect((await limiter.fetch(request({ key: 'ip:slug', limit: 2, windowMs: 60_000 }))).status).toBe(204)
    const blocked = await limiter.fetch(request({ key: 'ip:slug', limit: 2, windowMs: 60_000 }))
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await blocked.json()).toMatchObject({ allowed: false })
    // Another slug is a different bucket.
    expect((await limiter.fetch(request({ key: 'ip:other', limit: 2, windowMs: 60_000 }))).status).toBe(204)
  })

  it('refuses malformed keys, bodies and paths without touching the counter', async () => {
    const limiter = new MusicShareLimiter(fakeState(), {} as Env)
    expect((await limiter.fetch(request({ key: '', limit: 2, windowMs: 60_000 }))).status).toBe(400)
    expect((await limiter.fetch(request({ key: 'x'.repeat(257), limit: 2, windowMs: 60_000 }))).status).toBe(400)
    expect((await limiter.fetch(new Request('https://music-share-limit.internal/meter', { method: 'POST', body: '{' }))).status).toBe(400)
    expect((await limiter.fetch(request({ key: 'ip:slug' }, '/other'))).status).toBe(404)
  })
})
