// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicCommentPage } from '../src/shared/music/comments'
import type { MusicProvider } from '../src/worker/music/providers/types'
import { MUSIC_SCHEMA_STATEMENTS } from '../src/worker/music/schema'
import { MusicStore } from '../src/worker/music/store'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { createMusicCommentsRoutes } from '../src/worker/routes/music-comments'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-comments'

const page: MusicCommentPage = {
  hot: [{ id: '1', userId: 'u', nickname: 'N', avatarUrl: '', content: 'hot', createdAt: 1, likedCount: 2, liked: false, ipLocation: '' }],
  latest: [{ id: '2', userId: 'u', nickname: 'N', avatarUrl: '', content: 'latest', createdAt: 2, likedCount: 0, liked: false, ipLocation: '' }],
  total: 2,
  hasMore: false,
}

let sqlite: DatabaseSync
let store: MusicStore
let env: Env
let provider: Pick<MusicProvider, 'comments' | 'likeComment'>
let app: Hono<AppBindings>

function testApp(): Hono<AppBindings> {
  const hono = new Hono<AppBindings>()
  hono.onError((error, c) => errorResponse(c, error))
  hono.use('/api/music/*', async (c, next) => {
    c.set('userId', USER)
    c.set('user', { id: USER, username: USER, login: USER, name: USER, avatarUrl: '', role: 'member', createdAt: 0, settingsRaw: '{}' })
    await next()
  })
  hono.route('/api/music', createMusicCommentsRoutes({
    provider: async () => provider as MusicProvider,
    translate: (error) => error,
  }))
  return hono
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'x-test-user': USER }
  if (method !== 'GET' && method !== 'HEAD') headers['X-Inkstone-Client'] = '1'
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of MUSIC_SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite))
  store = new MusicStore(env.DB, USER)
  provider = {
    comments: vi.fn(async () => page),
    likeComment: vi.fn(async () => undefined),
  }
  app = testApp()
})

afterEach(() => {
  sqlite.close()
})

describe('music comments route', () => {
  it('reads a song thread from the stored provider identity', async () => {
    const track = await store.upsertTrack({ provider: 'netease', providerId: '42', title: 'Song' })
    const response = await call('GET', `/api/music/comments/${track.id}?offset=0&limit=30`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ total: 2 })
    expect(provider.comments).toHaveBeenCalledWith({ thread: 'R_SO_4_42', offset: 0, limit: 30 })
  })

  it('uses the programme thread for an episode and refuses one without its id', async () => {
    const episode = await store.upsertTrack({
      provider: 'netease',
      providerId: '900',
      kind: 'podcast',
      title: 'Episode',
      programId: '77',
    })
    await call('GET', `/api/music/comments/${episode.id}`)
    expect(provider.comments).toHaveBeenCalledWith({ thread: 'A_DJ_1_77', offset: 0, limit: 30 })

    const old = await store.upsertTrack({ provider: 'netease', providerId: '901', kind: 'podcast', title: 'Old' })
    const response = await call('GET', `/api/music/comments/${old.id}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ hot: [], latest: [], total: 0, hasMore: false })
  })

  it('validates pagination and comment ids', async () => {
    const track = await store.upsertTrack({ provider: 'netease', providerId: '42', title: 'Song' })
    expect((await call('GET', `/api/music/comments/${track.id}?limit=0`)).status).toBe(400)
    expect((await call('GET', `/api/music/comments/${track.id}?offset=-1`)).status).toBe(400)
    expect((await call('POST', `/api/music/comments/${track.id}/like`, { commentId: '', liked: true })).status).toBe(400)
    expect((await call('POST', `/api/music/comments/${track.id}/like`, { commentId: '3' })).status).toBe(400)
    expect(provider.likeComment).not.toHaveBeenCalled()
  })

  it('forwards a like to the same thread', async () => {
    const track = await store.upsertTrack({ provider: 'netease', providerId: '42', title: 'Song' })
    const response = await call('POST', `/api/music/comments/${track.id}/like`, { commentId: '3', liked: true })
    expect(response.status).toBe(200)
    expect(provider.likeComment).toHaveBeenCalledWith({ thread: 'R_SO_4_42', commentId: '3', liked: true })
  })

  it('hides another account\'s track behind a 404', async () => {
    const other = new MusicStore(env.DB, 'user-other')
    const track = await other.upsertTrack({ provider: 'netease', providerId: '42', title: 'Song' })
    const response = await call('GET', `/api/music/comments/${track.id}`)
    expect(response.status).toBe(404)
  })
})
