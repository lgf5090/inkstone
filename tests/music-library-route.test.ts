// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { musicRoutes } from '../src/worker/routes/music'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const mocks = vi.hoisted(() => ({ userId: 'user-alice' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
  requireOwner: async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

const track = {
  provider: 'netease',
  providerId: '42',
  kind: 'song',
  title: 'Song',
  artists: [{ id: '1', name: 'Artist' }],
  album: 'Album',
  albumId: '9',
  coverUrl: '',
  durationMs: 1000,
  format: 'mp3',
  bitrate: 320000,
}

let db: D1Database
const app = new Hono<AppBindings>()
app.onError((error, c) => errorResponse(c, error))
app.route('/api/music', musicRoutes)

function env(): AppBindings['Bindings'] {
  return { DB: db } as unknown as AppBindings['Bindings']
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return app.request(`/api/music${path}`, init, env())
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

beforeEach(() => {
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  mocks.userId = ALICE
})

describe('music routes', () => {
  it('returns default settings and saves a normalized patch', async () => {
    const initial = await json<{ settings: { quality: string; downloadConcurrency: number } }>(await send('GET', '/settings'))
    expect(initial.settings.quality).toBe('exhigh')
    expect(initial.settings.downloadConcurrency).toBe(3)

    const saved = await send('PUT', '/settings', { settings: { quality: 'lossless', downloadConcurrency: 99 } })
    expect(saved.status).toBe(200)
    const body = await json<{ settings: { quality: string; downloadConcurrency: number } }>(saved)
    expect(body.settings.quality).toBe('lossless')
    expect(body.settings.downloadConcurrency).toBe(5)
  })

  it('keeps favourites scoped to the session account', async () => {
    const added = await send('POST', '/library/favorites', { track })
    expect(added.status).toBe(200)

    const first = await json<{ items: unknown[] }>(await send('GET', '/library/favorites'))
    expect(first.items).toHaveLength(1)

    mocks.userId = BOB
    const second = await json<{ items: unknown[] }>(await send('GET', '/library/favorites'))
    expect(second.items).toHaveLength(0)
    const denied = await send('DELETE', `/library/favorites/${(first.items[0] as { id: string }).id}`)
    expect(denied.status).toBe(404)
  })

  it('records history and returns the aggregate library', async () => {
    const history = await send('POST', '/library/history', { track, durationPlayed: 900, completed: true })
    expect(history.status).toBe(200)
    const entry = (await json<{ entry: { id: string } }>(history)).entry
    const library = await json<{ history: unknown[]; favorites: unknown[]; tracks: unknown[] }>(await send('GET', '/library'))
    expect(library.history).toHaveLength(1)
    expect(library.tracks).toHaveLength(1)

    const summary = await json<{ totalPlays: number; activeDays: number; latest: { track: { title: string } } }>(
      await send('GET', '/library/history/summary?tzOffset=480'),
    )
    expect(summary.totalPlays).toBe(1)
    expect(summary.activeDays).toBe(1)
    expect(summary.latest.track.title).toBe('Song')

    const removed = await send('DELETE', `/library/history/${entry.id}`)
    expect(removed.status).toBe(200)
    expect((await json<{ totalPlays: number }>(await send('GET', '/library/history/summary'))).totalPlays).toBe(0)

    await send('POST', '/library/history', { track })
    const cleared = await send('DELETE', '/library/history')
    expect(cleared.status).toBe(200)
    expect(await json<{ removed: number }>(cleared)).toEqual({ ok: true, removed: 1 })
  })

  it('does not return a cookie for an unconnected account', async () => {
    const status = await json<{ account: unknown }>(await send('GET', '/account/netease'))
    expect(status.account).toBeNull()
    expect(JSON.stringify(status)).not.toContain('cookie')
  })

  it('serves settings before a playlist id could match the static path', async () => {
    const response = await send('GET', '/settings')
    expect(response.status).toBe(200)
    expect(JSON.stringify(await json<unknown>(response))).toContain('settings')
  })
})
