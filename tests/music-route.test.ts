// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MUSIC_LIMITS } from '../src/shared/music/constants'
import { DEFAULT_MUSIC_SETTINGS } from '../src/shared/music/model'
import type { MusicProvider } from '../src/worker/music/providers/types'
import { MUSIC_SCHEMA_STATEMENTS } from '../src/worker/music/schema'
import { MusicStore } from '../src/worker/music/store'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { musicRoutes } from '../src/worker/routes/music'
import { createMusicDiscoveryRoutes } from '../src/worker/routes/music-discovery'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER = 'user-owner'
const MEMBER = 'user-member'

interface CallOptions {
  user?: string | null
  role?: 'owner' | 'member'
  body?: unknown
}

function testApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('/api/music/*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) {
      const role = c.req.header('x-test-role') === 'owner' ? 'owner' : 'member'
      c.set('userId', userId)
      c.set('user', {
        id: userId,
        username: userId,
        login: userId,
        name: userId,
        avatarUrl: '',
        role,
        createdAt: 0,
        settingsRaw: '{}',
      })
    }
    await next()
  })
  app.route('/api/music', musicRoutes)
  return app
}

const app = testApp()

async function call(
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const userId = options.user === undefined ? OWNER : options.user
  const headers: Record<string, string> = {}
  if (userId) {
    headers['x-test-user'] = userId
    headers['x-test-role'] = options.role ?? 'member'
  }
  if (method !== 'GET' && method !== 'HEAD') headers['X-Inkstone-Client'] = '1'
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return app.fetch(new Request(`http://localhost${path}`, { method, headers, body }), env)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

let sqlite: DatabaseSync
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of MUSIC_SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite))
})

afterEach(() => {
  sqlite.close()
})

function track(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'netease',
    providerId: '42',
    kind: 'song',
    title: 'A Song',
    artists: [{ id: '7', name: 'An Artist' }],
    album: 'An Album',
    albumId: '9',
    coverUrl: 'https://p1.music.126.net/cover.jpg',
    durationMs: 180_000,
    format: 'mp3',
    bitrate: 320_000,
    ...overrides,
  }
}

describe('music route authentication and health', () => {
  it('refuses every path without a session, including health', async () => {
    for (const path of ['/api/music/health', '/api/music/home', '/api/music/library']) {
      const response = await call('GET', path, { user: null })
      expect(response.status).toBe(401)
      expect((await json<{ error: { code: string } }>(response)).error.code).toBe('unauthenticated')
    }
  })

  it('reports provider and storage without any credential', async () => {
    const response = await call('GET', '/api/music/health')
    expect(response.status).toBe(200)
    const text = await response.clone().text()
    expect(text).not.toContain('cookie')
    await expect(json(response)).resolves.toMatchObject({
      provider: 'native',
      storage: 'none',
      netease: false,
      upstream: false,
      account: { netease: false },
    })
  })
})

describe('discovery routes', () => {
  function discoveryApp(overrides: Partial<Record<keyof MusicProvider, unknown>> = {}) {
    const calls: string[] = []
    const provider = {
      playlistCategories: async () => {
        calls.push('categories')
        return [{ name: 'Pop', hot: true }]
      },
      playlist: async (id: string) => {
        calls.push(`playlist:${id}`)
        return {
          playlist: {
            id,
            provider: 'netease',
            providerId: id,
            name: `Playlist ${id}`,
            description: '',
            coverUrl: '',
            trackCount: 0,
          },
          tracks: [],
          total: 0,
          hasMore: false,
        }
      },
      search: async (query: { type: string; limit: number; offset: number }) => {
        calls.push(`search:${query.limit}:${query.offset}`)
        return {
          type: query.type,
          tracks: [],
          albums: [],
          playlists: [],
          mvs: [],
          radios: [],
          total: 0,
          hasMore: false,
        }
      },
      ...overrides,
    } as unknown as MusicProvider
    const local = new Hono<AppBindings>()
    local.onError((err, c) => errorResponse(c, err))
    local.route('/api/music', createMusicDiscoveryRoutes({
      provider: async () => provider,
      translate: (error) => error,
    }))
    return { local, calls }
  }

  it('claims static segments before the id route', async () => {
    const { local, calls } = discoveryApp()
    const categories = await local.fetch(new Request('http://localhost/api/music/playlists/categories'))
    expect(categories.status).toBe(200)
    await expect(json(categories)).resolves.toEqual({ items: [{ name: 'Pop', hot: true }] })
    expect(calls).toEqual(['categories'])

    const detail = await local.fetch(new Request('http://localhost/api/music/playlists/123'))
    expect(detail.status).toBe(200)
    expect(calls).toEqual(['categories', 'playlist:123'])
  })

  it('clamps page and limit before they reach the provider', async () => {
    const { local, calls } = discoveryApp()

    const second = await local.fetch(new Request(
      'http://localhost/api/music/search?q=hello&type=song&page=2&limit=500',
    ))
    expect(second.status).toBe(200)
    expect(calls).toContain('search:100:100')

    const floored = await local.fetch(new Request(
      'http://localhost/api/music/search?q=hello&type=song&page=0&limit=0',
    ))
    expect(floored.status).toBe(200)
    expect(calls).toContain('search:1:0')
  })

  it('rejects an unknown search type', async () => {
    const { local } = discoveryApp()
    const response = await local.fetch(new Request('http://localhost/api/music/search?q=x&type=video'))
    expect(response.status).toBe(400)
  })

  it('maps MV area codes to the upstream labels', async () => {
    const queries: Array<Record<string, unknown>> = []
    const { local } = discoveryApp({
      mvList: async (query: unknown) => {
        queries.push(query as Record<string, unknown>)
        return { items: [], total: 0, hasMore: false }
      },
    })
    const expected: Record<string, string> = {
      ALL: '',
      ZH: '内地',
      EA: '港台',
      US: '欧美',
      JP: '日本',
      KR: '韩国',
    }
    for (const [code, label] of Object.entries(expected)) {
      const response = await local.fetch(new Request(
        `http://localhost/api/music/mvs?area=${code}&type=ALL&order=new&page=1&limit=12`,
      ))
      expect(response.status).toBe(200)
      expect(queries.at(-1)).toMatchObject({ area: label, type: '', order: '最新' })
    }
  })

  it('answers an unfiltered podcast shelf with recommended shows', async () => {
    const calls: string[] = []
    const radio = {
      id: 'radio-1',
      name: 'A show',
      coverUrl: '',
      description: '',
      programCount: 1,
      subscriberCount: 0,
    }
    const { local } = discoveryApp({
      radioRecommend: async () => {
        calls.push('recommend')
        return [radio]
      },
      radioHot: async () => {
        calls.push('hot')
        return { items: [], total: 0, hasMore: false }
      },
    })

    const response = await local.fetch(new Request('http://localhost/api/music/podcasts?page=1&limit=12'))
    await expect(json(response)).resolves.toEqual({ items: [radio], total: 1, hasMore: false })
    expect(calls).toEqual(['recommend'])

    const filtered = await local.fetch(new Request('http://localhost/api/music/podcasts?cat=3&page=2&limit=12'))
    expect(filtered.status).toBe(200)
    expect(calls).toEqual(['recommend', 'hot'])
  })
})

describe('library routes', () => {
  it('keeps one account out of another account playlist', async () => {
    const created = await call('POST', '/api/music/library/playlists', {
      user: OWNER,
      body: { name: 'Mine' },
    })
    expect(created.status).toBe(201)
    const playlist = await json<{ id: string }>(created)

    const items = await call('GET', `/api/music/library/playlists/${playlist.id}/items`, { user: MEMBER })
    expect(items.status).toBe(404)

    const patch = await call('PATCH', `/api/music/library/playlists/${playlist.id}`, {
      user: MEMBER,
      body: { name: 'Theirs' },
    })
    expect(patch.status).toBe(404)

    const remove = await call('DELETE', `/api/music/library/playlists/${playlist.id}`, { user: MEMBER })
    expect(remove.status).toBe(404)

    const mine = await call('GET', `/api/music/library/playlists/${playlist.id}/items`, { user: OWNER })
    expect(mine.status).toBe(200)
    await expect(json(mine)).resolves.toEqual({ items: [], total: 0, hasMore: false })
  })

  it('refuses a favourite removal that names another account track', async () => {
    const added = await call('POST', '/api/music/library/favorites', {
      user: OWNER,
      body: { track: track() },
    })
    expect(added.status).toBe(200)
    const { trackId } = await json<{ trackId: string }>(added)

    const other = await call('DELETE', `/api/music/library/favorites/${trackId}`, { user: MEMBER })
    expect(other.status).toBe(404)

    const aggregate = await call('GET', '/api/music/library', { user: OWNER })
    expect(aggregate.status).toBe(200)
    await expect(json(aggregate)).resolves.toMatchObject({
      favorites: [{ id: trackId }],
      tracks: [{ id: trackId }],
    })
  })
})

describe('account routes', () => {
  it('disconnects without echoing the stored cookie', async () => {
    const store = new MusicStore(env.DB, OWNER)
    await store.saveAccount({
      accountId: '42',
      nickname: 'Listener',
      avatarUrl: 'https://example.com/avatar.png',
      cookieCiphertext: 'sealed-cookie-value',
      status: 'connected',
    })

    const response = await call('DELETE', '/api/music/account/netease')
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain('sealed-cookie-value')
    expect(text).not.toContain('cookie')
    await expect(store.getAccount('netease')).resolves.toBeNull()
  })
})

describe('settings and owner-only sources', () => {
  it('normalises settings and pins the server quota', async () => {
    const response = await call('PUT', '/api/music/settings', {
      body: {
        settings: {
          quality: 'not-a-quality',
          downloadConcurrency: 99,
          sourcePriority: ['custom', 'custom', 'nonsense'],
          storageQuotaBytes: 1,
        },
      },
    })
    expect(response.status).toBe(200)
    const { settings } = await json<{ settings: Record<string, unknown> }>(response)
    expect(settings).toMatchObject({
      quality: DEFAULT_MUSIC_SETTINGS.quality,
      downloadConcurrency: 5,
      sourcePriority: ['custom'],
      storageQuotaBytes: MUSIC_LIMITS.quotaBytes,
    })
  })

  it('rejects a resolver URL that is not public HTTPS', async () => {
    const response = await call('PUT', '/api/music/settings', {
      body: { settings: { customResolverUrl: 'http://resolver.example/api' } },
    })
    expect(response.status).toBe(400)
  })

  it('does not let a member set the resolver through the general settings route', async () => {
    const response = await call('PUT', '/api/music/settings', {
      user: MEMBER,
      role: 'member',
      body: {
        settings: {
          quality: 'hires',
          customResolverEnabled: true,
          customResolverUrl: 'https://member.example/api',
          customResolverResponsePath: 'data.url',
        },
      },
    })
    expect(response.status).toBe(200)
    const { settings } = await json<{ settings: Record<string, unknown> }>(response)
    expect(settings).toMatchObject({
      quality: 'hires',
      customResolverEnabled: false,
      customResolverUrl: '',
      customResolverResponsePath: '',
    })
  })

  it('limits sources to the owner and stores only coordinates', async () => {
    const memberRead = await call('GET', '/api/music/settings/sources', { user: MEMBER, role: 'member' })
    expect(memberRead.status).toBe(403)

    const ownerRead = await call('GET', '/api/music/settings/sources', { role: 'owner' })
    expect(ownerRead.status).toBe(200)
    await expect(json(ownerRead)).resolves.toMatchObject({
      sources: { enabled: false, url: '', method: 'GET', params: {}, qualityMap: {} },
    })

    const write = await call('PUT', '/api/music/settings/sources', {
      role: 'owner',
      body: {
        enabled: true,
        url: 'https://resolver.example/api',
        method: 'POST',
        params: { id: '{id}' },
        responsePath: 'data.url',
      },
    })
    expect(write.status).toBe(200)
    await expect(json(write)).resolves.toMatchObject({
      sources: {
        enabled: true,
        url: 'https://resolver.example/api',
        method: 'POST',
        params: { id: '{id}' },
        responsePath: 'data.url',
      },
    })

    const memberWrite = await call('PUT', '/api/music/settings/sources', {
      user: MEMBER,
      role: 'member',
      body: { url: 'https://other.example/api' },
    })
    expect(memberWrite.status).toBe(403)

    const settings = await call('GET', '/api/music/settings', { role: 'owner' })
    await expect(json(settings)).resolves.toMatchObject({
      settings: {
        customResolverEnabled: true,
        customResolverUrl: 'https://resolver.example/api',
        customResolverResponsePath: 'data.url',
      },
    })
  })
})
