// @vitest-environment node
// The image proxy: R2 hit/miss, exact key layout, passthrough without R2, byte validation and the
// channel-icon host whitelist. The upstream is a fetch stub and R2 is the in-memory double.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { youtubeMediaRoutes } from '../src/worker/youtube/routes-media'
import { YOUTUBE_SCHEMA_STATEMENTS } from '../src/worker/youtube/schema'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const VIDEO_ID = 'dQw4w9WgXcQ'
const CHANNEL_ID = `UC${'b'.repeat(22)}`
const THUMBNAIL_KEY = `YouTube/images/thumbnails/${VIDEO_ID}.jpg`
const CHANNEL_ICON_KEY = `YouTube/icons/channels/${CHANNEL_ID}.jpg`
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

const mocks = { userId: 'u1' }
const app = new Hono<AppBindings>()
app.onError((error, c) => errorResponse(c, error))
app.use('*', async (c, next) => {
  c.set('userId', mocks.userId)
  await next()
})
app.route('/api/youtube/media', youtubeMediaRoutes)

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
}

let sqlite: DatabaseSync
let db: D1Database
let calls: URL[]

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(YOUTUBE_SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  calls = []
  mocks.userId = 'u1'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(handler: (url: URL) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof URL
      ? input
      : new URL(input instanceof Request ? input.url : input)
    calls.push(url)
    return await handler(url)
  }))
}

function imageResponse(bytes: Uint8Array = JPEG, type = 'image/jpeg'): Response {
  return new Response(bytes as BodyInit, { headers: { 'content-type': type } })
}

function envWith(overrides: Partial<Env> = {}): Env {
  return testBindings(db, overrides)
}

async function get(path: string, env: Env): Promise<Response> {
  return await app.request(`/api/youtube/media${path}`, { method: 'GET' }, env, ctx)
}

async function readError(response: Response): Promise<{ error: { code: string; message: string } }> {
  return await response.json() as { error: { code: string; message: string } }
}

async function seedChannel(userId: string, id: string, thumbnailUrl: string): Promise<void> {
  const now = Date.now()
  await db.prepare(
    `INSERT INTO youtube_channels
       (user_id, id, data_json, tag_ids, pinned, notes, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 0, '', ?, ?)`,
  )
    .bind(userId, id, JSON.stringify({ thumbnailUrl }), now, now)
    .run()
}

describe('youtube thumbnail media', () => {
  it('fetches, validates and writes the thumbnail under the exact key', async () => {
    const bucket = testR2Bucket()
    stubFetch((url) => {
      expect(url.href).toBe(`https://i.ytimg.com/vi/${VIDEO_ID}/mqdefault.jpg`)
      return imageResponse()
    })

    const response = await get(`/thumbnail/${VIDEO_ID}`, envWith({ FILES: bucket }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(JPEG)

    expect(calls).toHaveLength(1)
    expect(bucket.objects.has(THUMBNAIL_KEY)).toBe(true)
    expect(bucket.types.get(THUMBNAIL_KEY)).toBe('image/jpeg')
    const metadata = bucket.metadata.get(THUMBNAIL_KEY)
    expect(metadata?.source).toBe(`https://i.ytimg.com/vi/${VIDEO_ID}/mqdefault.jpg`)
    expect(metadata?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('serves the second read from R2 with its etag and no second fetch', async () => {
    const bucket = testR2Bucket()
    stubFetch(() => imageResponse())
    const env = envWith({ FILES: bucket })

    expect((await get(`/thumbnail/${VIDEO_ID}`, env)).status).toBe(200)
    const second = await get(`/thumbnail/${VIDEO_ID}`, env)
    expect(second.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(second.headers.get('etag')).toBeTruthy()
    expect(second.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(JPEG)
  })

  it('treats a zero-byte object as a miss and refetches it', async () => {
    const bucket = testR2Bucket()
    await bucket.put(THUMBNAIL_KEY, new Uint8Array(0), { httpMetadata: { contentType: 'image/jpeg' } })
    stubFetch(() => imageResponse())

    const response = await get(`/thumbnail/${VIDEO_ID}`, envWith({ FILES: bucket }))
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(bucket.objects.get(THUMBNAIL_KEY)?.byteLength).toBe(JPEG.byteLength)
  })

  it('passes the image through without writing when R2 is not bound', async () => {
    stubFetch(() => imageResponse())
    const response = await get(`/thumbnail/${VIDEO_ID}`, envWith())

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(response.headers.get('etag')).toBeNull()
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(JPEG)
    expect(calls).toHaveLength(1)
  })

  it('refuses a non-image content type without writing', async () => {
    const bucket = testR2Bucket()
    stubFetch(() => new Response('<html>not an image</html>', {
      headers: { 'content-type': 'text/html' },
    }))

    const response = await get(`/thumbnail/${VIDEO_ID}`, envWith({ FILES: bucket }))
    expect(response.status).toBe(502)
    const body = await readError(response)
    expect(body.error.code).toBe('youtube_upstream')
    expect(bucket.objects.size).toBe(0)
  })

  it('refuses an image above two mebibytes without writing', async () => {
    const bucket = testR2Bucket()
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1)
    stubFetch(() => imageResponse(oversized))

    const response = await get(`/thumbnail/${VIDEO_ID}`, envWith({ FILES: bucket }))
    expect(response.status).toBe(502)
    expect(bucket.objects.size).toBe(0)
  })

  it('rejects a malformed video id before any fetch', async () => {
    stubFetch(() => imageResponse())
    const response = await get('/thumbnail/short', envWith())
    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('youtube channel icon media', () => {
  it('reads the saved icon address and caches it under the channel key', async () => {
    const bucket = testR2Bucket()
    const iconUrl = 'https://yt3.googleusercontent.com/ytc/icon=s88'
    await seedChannel('u1', CHANNEL_ID, iconUrl)
    stubFetch((url) => {
      expect(url.href).toBe(iconUrl)
      return imageResponse(JPEG, 'image/png')
    })

    const response = await get(`/channel/${CHANNEL_ID}`, envWith({ FILES: bucket }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(bucket.objects.has(CHANNEL_ICON_KEY)).toBe(true)
    expect(bucket.types.get(CHANNEL_ICON_KEY)).toBe('image/png')
    expect(bucket.metadata.get(CHANNEL_ICON_KEY)?.source).toBe(iconUrl)
  })

  it('refuses a saved icon on a host outside the whitelist', async () => {
    await seedChannel('u1', CHANNEL_ID, 'https://evil.example/icon.jpg')
    stubFetch(() => imageResponse())

    const response = await get(`/channel/${CHANNEL_ID}`, envWith({ FILES: testR2Bucket() }))
    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('refuses a saved icon over plain http', async () => {
    await seedChannel('u1', CHANNEL_ID, 'http://yt3.googleusercontent.com/icon.jpg')
    stubFetch(() => imageResponse())

    const response = await get(`/channel/${CHANNEL_ID}`, envWith())
    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('answers 404 when the account has not saved the channel', async () => {
    stubFetch(() => imageResponse())
    const response = await get(`/channel/${CHANNEL_ID}`, envWith())
    expect(response.status).toBe(404)
    const body = await readError(response)
    expect(body.error.code).toBe('youtube_not_found')
    expect(calls).toHaveLength(0)
  })

  it('cannot read another account\'s saved channel', async () => {
    await seedChannel('u2', CHANNEL_ID, 'https://yt3.googleusercontent.com/icon.jpg')
    stubFetch(() => imageResponse())

    const response = await get(`/channel/${CHANNEL_ID}`, envWith())
    expect(response.status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it('answers 404 when the saved channel has no icon address', async () => {
    await seedChannel('u1', CHANNEL_ID, '')
    stubFetch(() => imageResponse())
    const response = await get(`/channel/${CHANNEL_ID}`, envWith())
    expect(response.status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})
