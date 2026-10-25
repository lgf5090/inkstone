// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { musicRoutes } from '../src/worker/routes/music'
import { musicSharePublicRoutes } from '../src/worker/routes/music-share'
import { testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

// Valid generated ids: cover keys and the credential vault reject arbitrary account labels.
const ALICE = 'a'.repeat(26)
const BOB = 'b'.repeat(26)
const PNG_1PX = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3CnwAAAABJRU5ErkJggg==',
  'base64',
))
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
let bucket: TestR2Bucket
const app = new Hono<AppBindings>()
app.onError((error, c) => errorResponse(c, error))
app.route('/api/music', musicRoutes)

const publicApp = new Hono<AppBindings>()
publicApp.onError((error, c) => errorResponse(c, error))
publicApp.route('/api/public/music', musicSharePublicRoutes)

function env(): AppBindings['Bindings'] {
  return { DB: db, FILES: bucket } as unknown as AppBindings['Bindings']
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

async function publicSend(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return publicApp.request(`/api/public/music${path}`, { headers }, env())
}

beforeEach(() => {
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  bucket = testR2Bucket()
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

  it('removes every play of one track by its library id', async () => {
    const first = await send('POST', '/library/history', { track })
    const { entry } = await json<{ entry: { trackId: string } }>(first)
    await send('POST', '/library/history', { track })

    const removed = await send('DELETE', `/library/history/track/${entry.trackId}`)
    expect(removed.status).toBe(200)
    expect(await json<{ removed: number }>(removed)).toEqual({ ok: true, removed: 2 })
    expect((await json<{ totalPlays: number }>(await send('GET', '/library/history/summary'))).totalPlays).toBe(0)
  })

  it('searches history by title, artist and album and treats wildcards as text', async () => {
    await send('POST', '/library/history', {
      track: {
        ...track,
        providerId: 'night',
        title: '夜曲',
        artists: [{ id: '7', name: '周杰伦' }],
        album: '十一月的萧邦',
      },
    })
    await send('POST', '/library/history', {
      track: {
        ...track,
        providerId: 'alpha',
        title: 'Alpha',
        artists: [{ id: '8', name: 'Beta' }],
        album: 'Gamma',
      },
    })

    const titles = await json<{ items: Array<{ track: { title: string } }>; total: number }>(
      await send('GET', `/library/history?q=${encodeURIComponent('夜曲')}`),
    )
    expect(titles.items.map((item) => item.track.title)).toEqual(['夜曲'])
    expect(titles.total).toBe(1)
    const artists = await json<{ items: Array<{ track: { title: string } }> }>(
      await send('GET', `/library/history?q=${encodeURIComponent('周杰伦')}`),
    )
    expect(artists.items.map((item) => item.track.title)).toEqual(['夜曲'])
    const albums = await json<{ items: Array<{ track: { title: string } }> }>(
      await send('GET', `/library/history?q=${encodeURIComponent('萧邦')}`),
    )
    expect(albums.items.map((item) => item.track.title)).toEqual(['夜曲'])
    const caseInsensitive = await json<{ items: Array<{ track: { title: string } }> }>(
      await send('GET', '/library/history?q=ALPHA'),
    )
    expect(caseInsensitive.items.map((item) => item.track.title)).toEqual(['Alpha'])

    expect((await json<{ items: unknown[] }>(await send('GET', '/library/history?q=%25'))).items).toEqual([])
    expect((await json<{ items: unknown[] }>(
      await send('GET', `/library/history?q=${encodeURIComponent("' OR 1=1 --")}`),
    )).items).toEqual([])
  })

  it('pins a favourite and edits a saved track snapshot', async () => {
    const added = await send('POST', '/library/favorites', { track })
    const { trackId } = await json<{ trackId: string }>(added)

    const pinned = await send('PATCH', `/library/favorites/${trackId}`, { pinned: true })
    expect(pinned.status).toBe(200)
    expect(typeof (await json<{ pinnedAt: number }>(pinned)).pinnedAt).toBe('number')

    const edited = await send('PATCH', `/library/tracks/${trackId}`, {
      title: 'Renamed',
      artists: [{ id: '1', name: 'New Artist' }],
      album: 'New Album',
    })
    expect(edited.status).toBe(200)
    const body = await json<{ track: { title: string; artists: Array<{ name: string }>; album: string } }>(edited)
    expect(body.track).toMatchObject({ title: 'Renamed', album: 'New Album', artists: [{ name: 'New Artist' }] })
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

  it('pins a playlist ahead of the shelf without changing its name', async () => {
    const first = await json<{ id: string }>(await send('POST', '/library/playlists', { name: 'First' }))
    await send('POST', '/library/playlists', { name: 'Second' })

    const pinned = await send('PATCH', `/library/playlists/${first.id}`, { pinned: true })
    expect(pinned.status).toBe(200)
    const body = await json<{ id: string; pinnedAt: number | null }>(pinned)
    expect(body.id).toBe(first.id)
    expect(typeof body.pinnedAt).toBe('number')

    const list = await json<{ items: Array<{ id: string; pinnedAt: number | null }> }>(await send('GET', '/library/playlists'))
    expect(list.items[0]?.id).toBe(first.id)
    expect(typeof list.items[0]?.pinnedAt).toBe('number')
  })

  it('publishes a read-only playlist projection and revokes it on demand', async () => {
    const playlist = await json<{ id: string }>(await send('POST', '/library/playlists', {
      name: 'Shared',
      description: 'Listen along',
    }))
    const added = await send('POST', `/library/playlists/${playlist.id}/items`, { tracks: [track] })
    expect(added.status).toBe(200)

    const shared = await send('POST', `/library/playlists/${playlist.id}/share`)
    expect(shared.status).toBe(200)
    const body = await json<{ url: string; playlist: { shareSlug: string } }>(shared)
    expect(body.url).toContain('/m/')
    const slug = body.playlist.shareSlug

    const response = await publicSend(`/playlists/${slug}`)
    expect(response.status).toBe(200)
    const published = await response.json() as {
      playlist: { name: string; description: string; trackCount: number }
      tracks: Array<{ title: string; artists: string }>
      truncated: boolean
    }
    expect(published.playlist).toMatchObject({ name: 'Shared', description: 'Listen along', trackCount: 1 })
    expect(published.tracks[0]).toMatchObject({ title: 'Song', artists: 'Artist' })
    expect(published.truncated).toBe(false)
    const wire = JSON.stringify(published)
    expect(wire).not.toContain('providerId')
    expect(wire).not.toContain('r2Key')
    expect(wire).not.toContain(ALICE)

    const revoked = await send('DELETE', `/library/playlists/${playlist.id}/share`)
    expect(revoked.status).toBe(200)
    expect((await json<{ playlist: { shareSlug: string | null } }>(revoked)).playlist.shareSlug).toBeNull()
    expect((await publicSend(`/playlists/${slug}`)).status).toBe(404)
  })

  it('meters public reads per address and playlist, and does not cache a revocable cover', async () => {
    const playlist = await json<{ id: string }>(await send('POST', '/library/playlists', { name: 'Metered' }))
    const form = new FormData()
    form.append('cover', new File([PNG_1PX], 'cover.png', { type: 'image/png' }))
    expect((await app.request(`/api/music/library/playlists/${playlist.id}/cover`, {
      method: 'POST',
      body: form,
    }, env())).status).toBe(200)
    const shared = await json<{ playlist: { shareSlug: string } }>(
      await send('POST', `/library/playlists/${playlist.id}/share`),
    )
    const slug = shared.playlist.shareSlug
    const reader = { 'cf-connecting-ip': '203.0.113.9' }

    const cover = await publicSend(`/playlists/${slug}/cover`, reader)
    expect(cover.status).toBe(200)
    expect(cover.headers.get('cache-control')).toBe('private, no-store')

    // The cover request above used one of the 120 requests allowed in a minute.
    for (let request = 0; request < 119; request += 1) {
      expect((await publicSend(`/playlists/${slug}`, reader)).status).toBe(200)
    }
    const blocked = await publicSend(`/playlists/${slug}`, reader)
    expect(blocked.status).toBe(429)
    expect((await publicSend(`/playlists/${slug}`, { 'cf-connecting-ip': '203.0.113.10' })).status).toBe(200)
  })

  it('uses the shared Durable Object counter when the deployment binds it', async () => {
    const playlist = await json<{ id: string }>(await send('POST', '/library/playlists', { name: 'Shared meter' }))
    const shared = await json<{ playlist: { shareSlug: string } }>(
      await send('POST', `/library/playlists/${playlist.id}/share`),
    )
    const slug = shared.playlist.shareSlug
    const seen: Array<{ key: string; limit: number; windowMs: number }> = []
    const namespace = {
      idFromName: () => 'public-share',
      get: () => ({
        async fetch(_url: string, init: RequestInit) {
          seen.push(JSON.parse(String(init.body)))
          return Response.json({ allowed: false, retryAfter: 12 }, { status: 429 })
        },
      }),
    } as unknown as DurableObjectNamespace
    const response = await publicApp.request(`/api/public/music/playlists/${slug}`, {
      headers: { 'cf-connecting-ip': '203.0.113.20' },
    }, { ...env(), MUSIC_SHARE_LIMITER: namespace } as AppBindings['Bindings'])
    expect(response.status).toBe(429)
    expect((await json<{ error: { code: string; details?: { retryAfter: number } } }>(response)).error)
      .toMatchObject({ code: 'too_many_attempts', details: { retryAfter: 12 } })
    expect(seen).toEqual([{ key: `203.0.113.20:${slug}`, limit: 120, windowMs: 60_000 }])
  })

  it('proxies a public provider cover, revalidates it and refuses a private address', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (input: URL | string) => {
      calls += 1
      if (String(input).includes('markup.svg')) {
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' },
        })
      }
      if (String(input).includes('photo.jpg')) {
        return new Response(new Uint8Array([4, 5, 6]), {
          status: 200,
          headers: { 'content-type': 'image/jpg; charset=UTF-8' },
        })
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/webp', 'etag': '"cover-1"' },
      })
    })
    const address = `/api/music/media/provider-cover?url=${encodeURIComponent('https://cdn.example.test/a.webp')}`
    const first = await app.request(address, {}, env())
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/webp')
    expect(first.headers.get('etag')).toBe('"cover-1"')
    expect([...(new Uint8Array(await first.arrayBuffer()))]).toEqual([1, 2, 3])
    const revalidated = await app.request(address, { headers: { 'if-none-match': '"cover-1"' } }, env())
    expect(revalidated.status).toBe(304)

    const neteaseJpg = await app.request(
      `/api/music/media/provider-cover?url=${encodeURIComponent('https://cdn.example.test/photo.jpg')}`,
      {},
      env(),
    )
    expect(neteaseJpg.status).toBe(200)
    expect(neteaseJpg.headers.get('content-type')).toBe('image/jpeg')

    const markup = await app.request(
      `/api/music/media/provider-cover?url=${encodeURIComponent('https://cdn.example.test/markup.svg')}`,
      {},
      env(),
    )
    expect(markup.status).toBe(502)

    const before = calls
    const denied = await app.request(
      `/api/music/media/provider-cover?url=${encodeURIComponent('http://127.0.0.1/cover.png')}`,
      {},
      env(),
    )
    expect(denied.status).toBe(502)
    expect(calls).toBe(before)
  })

  it('serves a saved track provider cover through the same capped proxy', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([7, 8]), {
      status: 200,
      headers: { 'content-type': 'image/webp', 'etag': '"track-cover"' },
    }))
    const saved = await json<{ tracks: Array<{ id: string }> }>(await send('POST', '/library/tracks', {
      tracks: [{ ...track, coverUrl: 'https://cdn.example.test/track.webp' }],
    }))
    const address = `/api/music/media/cover/${saved.tracks[0]!.id}`
    const first = await app.request(address, {}, env())
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/webp')
    expect(first.headers.get('cache-control')).toBe('private, max-age=3600')
    const second = await app.request(address, { headers: { 'if-none-match': '"track-cover"' } }, env())
    expect(second.status).toBe(304)
  })

  it('stores an uploaded cover and serves it through the playlist media route', async () => {
    const playlist = await json<{ id: string }>(await send('POST', '/library/playlists', { name: 'Covered' }))
    const form = new FormData()
    form.append('cover', new File([
      PNG_1PX,
    ], 'cover.png', { type: 'image/png' }))
    const upload = await app.request(`/api/music/library/playlists/${playlist.id}/cover`, {
      method: 'POST',
      body: form,
    }, env())
    expect(upload.status).toBe(200)
    const answered = await json<{ playlist: { coverUrl: string } }>(upload)
    expect(answered.playlist.coverUrl).toContain(`/api/music/media/cover/playlist/${playlist.id}`)
    const key = `music/covers/${ALICE}/${playlist.id}.png`
    expect(bucket.objects.has(key)).toBe(true)

    const served = await app.request(`/api/music/media/cover/playlist/${playlist.id}`, {}, env())
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(served.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate')
    const etag = served.headers.get('etag')
    expect(etag).toBeTruthy()
    const revalidated = await app.request(`/api/music/media/cover/playlist/${playlist.id}`, {
      headers: { 'if-none-match': etag! },
    }, env())
    expect(revalidated.status).toBe(304)

    const removed = await app.request(`/api/music/library/playlists/${playlist.id}/cover`, {
      method: 'DELETE',
    }, env())
    expect(removed.status).toBe(200)
    expect((await json<{ playlist: { coverUrl: string } }>(removed)).playlist.coverUrl).toBe('')
    expect(bucket.objects.has(key)).toBe(false)
  })

  it('drops an uploaded cover with the playlist that owned it', async () => {
    const playlist = await json<{ id: string }>(await send('POST', '/library/playlists', { name: 'Doomed' }))
    const form = new FormData()
    form.append('cover', new File([
      PNG_1PX,
    ], 'cover.png', { type: 'image/png' }))
    expect((await app.request(`/api/music/library/playlists/${playlist.id}/cover`, { method: 'POST', body: form }, env())).status).toBe(200)
    const key = `music/covers/${ALICE}/${playlist.id}.png`
    expect(bucket.objects.has(key)).toBe(true)

    expect((await send('DELETE', `/library/playlists/${playlist.id}`)).status).toBe(200)
    expect(bucket.objects.has(key)).toBe(false)
  })

  it('refuses a cover whose bytes have no readable dimensions', async () => {
    const playlist = await json<{ id: string }>(await send('POST', '/library/playlists', { name: 'Bad cover' }))
    const form = new FormData()
    form.append('cover', new File([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    ], 'cover.png', { type: 'image/png' }))
    const response = await app.request(`/api/music/library/playlists/${playlist.id}/cover`, {
      method: 'POST',
      body: form,
    }, env())
    expect(response.status).toBe(415)
    expect([...bucket.objects.keys()].some((key) => key.includes(playlist.id))).toBe(false)
  })

  it('refuses a playedAt outside the Date range instead of poisoning the summary', async () => {
    const saved = await json<{ tracks: Array<{ id: string }> }>(
      await send('POST', '/library/tracks', { tracks: [track] }),
    )
    const rejected = await send('POST', '/library/history', {
      trackId: saved.tracks[0]!.id,
      playedAt: Number.MAX_SAFE_INTEGER,
    })
    expect(rejected.status).toBe(400)
    expect((await send('GET', '/library/history/summary')).status).toBe(200)
  })

  it('caps a reorder request before building D1 statements', async () => {
    const playlist = await json<{ id: string }>(await send('POST', '/library/playlists', { name: 'Huge' }))
    const trackIds = Array.from({ length: 5_001 }, (_, index) => `track-${index}`)
    const response = await send('PUT', `/library/playlists/${playlist.id}/items/order`, { trackIds })
    expect(response.status).toBe(400)
  })
})
