// @vitest-environment node
/**
 * Online playback through the worker: one provider lookup serves repeated Range requests, and the
 * playback path does not spend the discovery/provider budget.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicProvider, MusicStreamSource } from '../src/worker/music/providers/types'
import { MUSIC_SCHEMA_STATEMENTS } from '../src/worker/music/schema'
import { MusicStore } from '../src/worker/music/store'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { musicRoutes } from '../src/worker/routes/music'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = '0123456789abcdefghjkmnpqrs'
const SOURCE_URL = 'https://m1.music.126.net/track.mp3'
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 1, 2, 3, 4, 5])

const providerMock = vi.hoisted(() => ({
  provider: null as unknown,
  options: null as unknown,
}))

vi.mock('../src/worker/music/providers/account', () => ({
  musicProviderFor: async (_env: unknown, _userId: string, options?: unknown) => {
    providerMock.options = options
    return providerMock.provider
  },
}))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', USER)
    await next()
  },
  requireOwner: async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let app: Hono<AppBindings>

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of MUSIC_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  env = testBindings(db)
  app = new Hono<AppBindings>()
  app.onError((error, c) => errorResponse(c, error))
  app.route('/api/music', musicRoutes)
  providerMock.provider = null
  providerMock.options = null
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

describe('online music stream', () => {
  it('serves repeated ranges from one provider lookup and does not spend the provider budget', async () => {
    const source: MusicStreamSource = {
      url: SOURCE_URL,
      expiresAt: Date.now() + 10 * 60_000,
      format: 'mp3',
      bitrate: 320_000,
      size: AUDIO.byteLength,
      quality: 'exhigh',
      freeTrial: false,
    }
    const stream = vi.fn(async () => source)
    providerMock.provider = { id: 'netease', stream } as unknown as MusicProvider

    const track = await new MusicStore(db, USER).upsertTrack({
      provider: 'netease',
      providerId: '42',
      title: 'Online',
      format: 'mp3',
      size: AUDIO.byteLength,
    })

    const ranges: Array<string | null> = []
    vi.stubGlobal('fetch', async (_input: URL | string, init: RequestInit = {}) => {
      const range = new Headers(init.headers).get('range')
      ranges.push(range)
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')
      const start = Number(match?.[1] ?? 0)
      const end = Math.min(Number(match?.[2] ?? AUDIO.byteLength - 1), AUDIO.byteLength - 1)
      const body = AUDIO.slice(start, end + 1)
      return new Response(body, {
        status: 206,
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': String(body.byteLength),
          'content-range': `bytes ${start}-${end}/${AUDIO.byteLength}`,
        },
      })
    })

    const first = await app.fetch(new Request(
      `http://localhost/api/music/media/stream/${track.id}`,
      { headers: { range: 'bytes=0-3' } },
    ), env)
    expect(first.status).toBe(206)
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(AUDIO.slice(0, 4))

    const second = await app.fetch(new Request(
      `http://localhost/api/music/media/stream/${track.id}`,
      { headers: { range: 'bytes=4-9' } },
    ), env)
    expect(second.status).toBe(206)
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(AUDIO.slice(4))
    expect(stream).toHaveBeenCalledTimes(1)
    expect(ranges).toEqual(['bytes=0-3', 'bytes=4-9'])
    expect(providerMock.options).toEqual({ spendBudget: false })
  })
})
