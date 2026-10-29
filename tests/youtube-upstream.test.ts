// @vitest-environment node
// Behavioural coverage for the YouTube upstream proxy: request shapes, transforms, quota preflight,
// ledger accumulation, search throttling and upstream error mapping. The upstream is a fetch stub;
// the database is real sqlite behind the D1 double.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  rangeCutoff,
  startOfLocalDay,
  type YouTubeCommentList,
  type YouTubeDiscoverResult,
  type YouTubeListResult,
  type YouTubeVideo,
} from '../src/shared/youtube/model'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { youtubeUpstreamRoutes } from '../src/worker/youtube/routes-upstream'
import { YOUTUBE_SCHEMA_STATEMENTS } from '../src/worker/youtube/schema'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER_ID = 'u1'
const CHANNEL_ID = `UC${'a'.repeat(22)}`

const LOGIN_ATTEMPTS_SCHEMA = `CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  last_fail_at INTEGER NOT NULL,
  locked_until INTEGER
)`

const mocks = { userId: USER_ID }
const app = new Hono<AppBindings>()
app.onError((error, c) => errorResponse(c, error))
app.use('*', async (c, next) => {
  c.set('userId', mocks.userId)
  await next()
})
app.route('/api/youtube', youtubeUpstreamRoutes)

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
  sqlite.exec(LOGIN_ATTEMPTS_SCHEMA)
  db = makeD1(sqlite)
  calls = []
  mocks.userId = USER_ID
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function envWith(overrides: Partial<Env> = {}): Env {
  return testBindings(db, { YOUTUBE_API_KEY: 'test-key', ...overrides })
}

async function get(path: string, env: Env = envWith()): Promise<Response> {
  return await app.request(`/api/youtube${path}`, { method: 'GET' }, env, ctx)
}

async function read<T>(response: Response): Promise<T> {
  return await response.json() as T
}

interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function seedUsage(date: string, endpoint: string, units: number, count: number): Promise<void> {
  await db.prepare(
    'INSERT INTO youtube_quota_usage (date, endpoint, units, count) VALUES (?, ?, ?, ?)',
  )
    .bind(date, endpoint, units, count)
    .run()
}

async function usageRow(endpoint: string): Promise<{ units: number; count: number } | null> {
  return await db.prepare(
    'SELECT units, count FROM youtube_quota_usage WHERE date = ? AND endpoint = ?',
  )
    .bind(today(), endpoint)
    .first<{ units: number; count: number }>()
}

function videoItem(
  id: string,
  options: {
    live?: boolean
    liveStreaming?: boolean
    stats?: boolean
    duration?: string
    title?: string
  } = {},
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id,
    snippet: {
      title: options.title ?? `Video ${id}`,
      description: `About ${id}`,
      publishedAt: '2026-10-01T00:00:00Z',
      channelId: CHANNEL_ID,
      channelTitle: 'Channel title',
      thumbnails: {
        default: { url: `https://i.ytimg.com/vi/${id}/default.jpg` },
        medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` },
        high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` },
      },
      tags: ['one', 2, 'two'],
      categoryId: '28',
      liveBroadcastContent: options.live ? 'live' : 'none',
    },
    contentDetails: { duration: options.duration ?? 'PT1H2M3S' },
  }
  if (options.stats !== false) {
    item.statistics = { viewCount: '1234', likeCount: '56', commentCount: '7' }
  }
  if (options.liveStreaming) {
    item.liveStreamingDetails = { actualStartTime: '2026-10-01T00:00:00Z' }
  }
  return item
}

function searchVideoItem(id: string, title = 'Search title'): Record<string, unknown> {
  return {
    id: { kind: 'youtube#video', videoId: id },
    snippet: {
      title,
      description: 'Search description',
      publishedAt: '2026-10-01T00:00:00Z',
      channelId: CHANNEL_ID,
      channelTitle: 'Channel title',
      thumbnails: {
        default: { url: `https://i.ytimg.com/vi/${id}/default.jpg` },
        medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` },
        high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` },
      },
      liveBroadcastContent: 'none',
    },
  }
}

function channelItem(id: string, options: { hiddenSubscribers?: boolean } = {}): Record<string, unknown> {
  return {
    id,
    snippet: {
      title: 'Channel title',
      description: 'Channel description',
      customUrl: '@channel',
      publishedAt: '2020-01-01T00:00:00Z',
      thumbnails: {
        default: { url: 'https://yt3.googleusercontent.com/icon-default' },
        medium: { url: 'https://yt3.googleusercontent.com/icon-medium' },
      },
    },
    statistics: {
      subscriberCount: '5000',
      videoCount: '12',
      hiddenSubscriberCount: options.hiddenSubscribers === true,
    },
    contentDetails: { relatedPlaylists: { uploads: `UU${id.slice(2)}` } },
  }
}

function playlistEntry(id: string): Record<string, unknown> {
  return {
    id,
    snippet: {
      title: 'Playlist title',
      description: 'Playlist description',
      channelId: CHANNEL_ID,
      channelTitle: 'Channel title',
      publishedAt: '2024-01-01T00:00:00Z',
      thumbnails: {
        default: { url: 'https://i.ytimg.com/vi/p/default.jpg' },
        medium: { url: 'https://i.ytimg.com/vi/p/mqdefault.jpg' },
      },
    },
    contentDetails: { itemCount: '8' },
  }
}

function playlistItemEntry(videoId: string): Record<string, unknown> {
  return {
    snippet: { resourceId: { videoId } },
    contentDetails: { videoId },
  }
}

function commentThread(id: string, videoId: string): Record<string, unknown> {
  return {
    id,
    snippet: {
      totalReplyCount: 2,
      topLevelComment: {
        id,
        snippet: {
          videoId,
          authorDisplayName: 'Ada',
          authorProfileImageUrl: 'https://yt3.googleusercontent.com/avatar',
          textDisplay: '<b>hello</b>',
          textOriginal: 'hello',
          likeCount: '4',
          publishedAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-02T00:00:00Z',
        },
      },
    },
  }
}

describe('youtube discover', () => {
  it('asks for the most popular chart with the region and 50-row ceiling', async () => {
    stubFetch(() => json({
      items: [
        videoItem('vid00000001', { live: true }),
        videoItem('vid00000002', { liveStreaming: true }),
        videoItem('vid00000003'),
      ],
      nextPageToken: 'ignored',
    }))

    const response = await get('/discover', envWith({ YOUTUBE_REGION_CODE: 'US' }))
    expect(response.status).toBe(200)
    const body = await read<YouTubeDiscoverResult>(response)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.pathname).toBe('/youtube/v3/videos')
    expect(call.searchParams.get('part')).toBe('snippet,statistics,contentDetails')
    expect(call.searchParams.get('chart')).toBe('mostPopular')
    expect(call.searchParams.get('maxResults')).toBe('50')
    expect(call.searchParams.get('regionCode')).toBe('US')
    expect(call.searchParams.get('key')).toBe('test-key')

    expect(body.mode).toBe('popular')
    expect(body.total).toBe(3)
    expect(body.nextPageToken).toBeNull()
    expect(body.prevPageToken).toBeNull()
    expect(body.items[0]!.duration).toBe('1:02:03')
    expect(body.items[0]!.viewCount).toBe(1234)
    expect(body.items[0]!.likeCount).toBe(56)
    expect(body.items[0]!.commentCount).toBe(7)
    expect(body.items[0]!.tags).toEqual(['one', 'two'])
    expect(body.items[0]!.isLive).toBe(true)
    expect(body.items[1]!.isLive).toBe(true)
    expect(body.items[2]!.isLive).toBe(false)
  })

  it('searches with order, range and token, then merges the detailed video rows', async () => {
    const before = Date.now()
    stubFetch((url) => {
      if (url.pathname.endsWith('/search')) {
        return json({
          items: [searchVideoItem('vid00000001'), searchVideoItem('vid00000002', 'Only in search')],
          pageInfo: { totalResults: 42 },
          nextPageToken: 'NEXT',
          prevPageToken: 'PREV',
        })
      }
      if (url.pathname.endsWith('/videos')) {
        return json({ items: [videoItem('vid00000001', { duration: 'PT3M4S' })] })
      }
      return json({}, 500)
    })

    const response = await get('/discover?q=%20space%20&order=date&range=week&pageToken=TOKEN')
    expect(response.status).toBe(200)
    const body = await read<YouTubeDiscoverResult>(response)

    expect(calls).toHaveLength(2)
    const search = calls[0]!
    expect(search.pathname).toBe('/youtube/v3/search')
    expect(search.searchParams.get('q')).toBe('space')
    expect(search.searchParams.get('type')).toBe('video')
    expect(search.searchParams.get('order')).toBe('date')
    expect(search.searchParams.get('maxResults')).toBe('20')
    expect(search.searchParams.get('pageToken')).toBe('TOKEN')
    const publishedAfter = Date.parse(search.searchParams.get('publishedAfter') ?? '')
    expect(publishedAfter).toBeGreaterThanOrEqual(rangeCutoff('week', before)!)
    expect(publishedAfter).toBeLessThanOrEqual(rangeCutoff('week', Date.now())!)

    const videos = calls[1]!
    expect(videos.pathname).toBe('/youtube/v3/videos')
    expect(videos.searchParams.get('id')).toBe('vid00000001,vid00000002')
    expect(videos.searchParams.get('maxResults')).toBe('2')

    expect(body.mode).toBe('search')
    expect(body.total).toBe(42)
    expect(body.nextPageToken).toBe('NEXT')
    expect(body.prevPageToken).toBe('PREV')
    expect(body.items).toHaveLength(2)
    expect(body.items[0]!.title).toBe('Video vid00000001')
    expect(body.items[0]!.duration).toBe('3:04')
    expect(body.items[0]!.viewCount).toBe(1234)
    expect(body.items[1]!.title).toBe('Only in search')
    expect(body.items[1]!.duration).toBe('')
    expect(body.items[1]!.viewCount).toBe(0)
  })

  it('anchors the today range at local midnight', async () => {
    const before = Date.now()
    stubFetch(() => json({ items: [] }))

    const response = await get('/discover?q=space&range=today')
    expect(response.status).toBe(200)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.searchParams.get('publishedAfter'))
      .toBe(new Date(startOfLocalDay(before)).toISOString())
    expect(calls[0]!.searchParams.get('order')).toBe('relevance')
  })

  it('leaves publishedAfter out for the all range', async () => {
    stubFetch(() => json({ items: [] }))
    const response = await get('/discover?q=space&range=all')
    expect(response.status).toBe(200)
    expect(calls[0]!.searchParams.get('publishedAfter')).toBeNull()
  })

  it('rejects a page token outside the safe alphabet before spending a request', async () => {
    stubFetch(() => json({ items: [] }))
    const response = await get('/discover?q=space&pageToken=%3Cscript%3E')
    expect(response.status).toBe(400)
    const body = await read<ApiErrorBody>(response)
    expect(body.error.code).toBe('bad_request')
    expect(calls).toHaveLength(0)
  })

  it('rejects an unknown order', async () => {
    stubFetch(() => json({ items: [] }))
    const response = await get('/discover?q=space&order=shuffle')
    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('youtube quota guards', () => {
  it('answers 503 when the key is not configured', async () => {
    stubFetch(() => json({ items: [] }))
    const response = await get('/discover', envWith({ YOUTUBE_API_KEY: '' }))
    expect(response.status).toBe(503)
    const body = await read<ApiErrorBody>(response)
    expect(body.error.code).toBe('youtube_not_configured')
    expect(calls).toHaveLength(0)
  })

  it('refuses a search before the upstream when today cannot hold its cost', async () => {
    stubFetch(() => json({ items: [] }))
    await seedUsage(today(), 'search', 9900, 99)

    const response = await get('/discover?q=space')
    expect(response.status).toBe(429)
    const body = await read<ApiErrorBody>(response)
    expect(body.error.code).toBe('youtube_quota_exceeded')
    expect(body.error.details?.reason).toBe('quotaExceeded')
    expect(calls).toHaveLength(0)
  })

  it('records every request and accumulates units across calls', async () => {
    stubFetch((url) => url.pathname.endsWith('/search')
      ? json({ items: [searchVideoItem('vid00000001')] })
      : json({ items: [videoItem('vid00000001')] }))

    expect((await get('/discover?q=space')).status).toBe(200)
    expect(await usageRow('search')).toEqual({ units: 100, count: 1 })
    expect(await usageRow('videos')).toEqual({ units: 1, count: 1 })

    expect((await get('/discover?q=space')).status).toBe(200)
    expect(await usageRow('search')).toEqual({ units: 200, count: 2 })
    expect(await usageRow('videos')).toEqual({ units: 2, count: 2 })
  })

  it('does not count a request that never got a response', async () => {
    stubFetch(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    })

    const response = await get('/videos/vid00000001')
    expect(response.status).toBe(502)
    const body = await read<ApiErrorBody>(response)
    expect(body.error.code).toBe('youtube_upstream')
    expect(body.error.message).toContain('15 seconds')
    expect(await usageRow('videos')).toBeNull()
  })

  it('locks search after ten attempts in the window', async () => {
    stubFetch((url) => url.pathname.endsWith('/search')
      ? json({ items: [searchVideoItem('vid00000001')] })
      : json({ items: [videoItem('vid00000001')] }))

    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await get('/discover?q=space')).status).toBe(200)
    }
    expect(calls).toHaveLength(20)

    const response = await get('/discover?q=space')
    expect(response.status).toBe(429)
    const body = await read<ApiErrorBody>(response)
    expect(body.error.code).toBe('too_many_attempts')
    expect(calls).toHaveLength(20)
  })
})

describe('youtube channel lookup', () => {
  it('reads a UC id directly and maps a hidden subscriber count to -1', async () => {
    stubFetch((url) => {
      expect(url.pathname).toBe('/youtube/v3/channels')
      expect(url.searchParams.get('id')).toBe(CHANNEL_ID)
      return json({ items: [channelItem(CHANNEL_ID, { hiddenSubscribers: true })] })
    })

    const response = await get(`/channels/${CHANNEL_ID}`)
    expect(response.status).toBe(200)
    const body = await read<{ channel: Record<string, unknown> }>(response)
    expect(body.channel.id).toBe(CHANNEL_ID)
    expect(body.channel.subscriberCount).toBe(-1)
    expect(body.channel.videoCount).toBe(12)
    expect(body.channel.uploadsPlaylistId).toBe(`UU${CHANNEL_ID.slice(2)}`)
    expect(calls).toHaveLength(1)
  })

  it('uses forHandle for an @handle and never searches when the handle misses', async () => {
    stubFetch(() => json({ items: [] }))

    const response = await get('/channels/@studio')
    expect(response.status).toBe(404)
    const body = await read<ApiErrorBody>(response)
    expect(body.error.code).toBe('youtube_not_found')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.searchParams.get('forHandle')).toBe('studio')
    expect(calls[0]!.searchParams.get('forUsername')).toBeNull()
  })

  it('extracts an id from a youtube.com channel address', async () => {
    stubFetch((url) => {
      expect(url.searchParams.get('id')).toBe(CHANNEL_ID)
      return json({ items: [channelItem(CHANNEL_ID)] })
    })
    const reference = encodeURIComponent(`https://www.youtube.com/channel/${CHANNEL_ID}`)
    const response = await get(`/channels/${reference}`)
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('extracts a handle from a youtube.com handle address', async () => {
    stubFetch((url) => {
      expect(url.searchParams.get('forHandle')).toBe('studio')
      return json({ items: [channelItem(CHANNEL_ID)] })
    })
    const reference = encodeURIComponent('https://youtube.com/@studio')
    const response = await get(`/channels/${reference}`)
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('falls back to one channel search for a legacy username', async () => {
    stubFetch((url) => {
      if (url.pathname.endsWith('/channels')) {
        if (url.searchParams.get('forUsername')) return json({ items: [] })
        return json({ items: [channelItem(CHANNEL_ID)] })
      }
      if (url.pathname.endsWith('/search')) {
        return json({ items: [{ snippet: { channelId: CHANNEL_ID } }] })
      }
      return json({}, 500)
    })

    const response = await get('/channels/olduser')
    expect(response.status).toBe(200)
    const body = await read<{ channel: { id: string } }>(response)
    expect(body.channel.id).toBe(CHANNEL_ID)

    expect(calls).toHaveLength(3)
    expect(calls[0]!.searchParams.get('forUsername')).toBe('olduser')
    expect(calls[1]!.searchParams.get('type')).toBe('channel')
    expect(calls[1]!.searchParams.get('q')).toBe('olduser')
    expect(calls[1]!.searchParams.get('maxResults')).toBe('1')
    expect(calls[2]!.searchParams.get('id')).toBe(CHANNEL_ID)

    expect(await usageRow('channels')).toEqual({ units: 2, count: 2 })
    expect(await usageRow('search')).toEqual({ units: 100, count: 1 })
  })

  it('returns 404 when both the lookup and the fallback find nothing', async () => {
    stubFetch(() => json({ items: [] }))
    const response = await get('/channels/olduser')
    expect(response.status).toBe(404)
    expect(calls).toHaveLength(2)
  })
})

describe('youtube list routes', () => {
  it('loads a channel uploads page and fills statistics', async () => {
    const uploads = `UU${CHANNEL_ID.slice(2)}`
    stubFetch((url) => {
      if (url.pathname.endsWith('/channels')) {
        return json({ items: [channelItem(CHANNEL_ID)] })
      }
      if (url.pathname.endsWith('/playlistItems')) {
        expect(url.searchParams.get('playlistId')).toBe(uploads)
        expect(url.searchParams.get('maxResults')).toBe('20')
        return json({
          items: [playlistItemEntry('vid00000001'), playlistItemEntry('vid00000002')],
          pageInfo: { totalResults: 40 },
          nextPageToken: 'NEXT',
          prevPageToken: 'PREV',
        })
      }
      if (url.pathname.endsWith('/videos')) {
        return json({
          items: [
            videoItem('vid00000001', { duration: 'PT3M4S' }),
            videoItem('vid00000002'),
          ],
        })
      }
      return json({}, 500)
    })

    const response = await get(`/channels/${CHANNEL_ID}/videos`)
    expect(response.status).toBe(200)
    const body = await read<YouTubeListResult<YouTubeVideo>>(response)
    expect(body.items).toHaveLength(2)
    expect(body.total).toBe(40)
    expect(body.nextPageToken).toBe('NEXT')
    expect(body.prevPageToken).toBe('PREV')
    expect(body.items[0]!.duration).toBe('3:04')
    expect(calls).toHaveLength(3)
  })

  it('lists a channel playlists with the 25-row page size', async () => {
    stubFetch((url) => {
      expect(url.pathname).toBe('/youtube/v3/playlists')
      expect(url.searchParams.get('channelId')).toBe(CHANNEL_ID)
      expect(url.searchParams.get('maxResults')).toBe('25')
      return json({ items: [playlistEntry('PL0000000001')], pageInfo: { totalResults: 1 } })
    })

    const response = await get(`/channels/${CHANNEL_ID}/playlists`)
    expect(response.status).toBe(200)
    const body = await read<YouTubeListResult<Record<string, unknown>>>(response)
    expect(body.items[0]!.itemCount).toBe(8)
    expect(body.total).toBe(1)
  })

  it('reads a whole channel URL encoded into one path segment', async () => {
    stubFetch((url) => {
      expect(url.pathname).toBe('/youtube/v3/channels')
      expect(url.searchParams.get('forHandle')).toBe('demo')
      return json({ items: [channelItem(CHANNEL_ID)] })
    })

    const response = await get(`/channels/${encodeURIComponent('https://www.youtube.com/@demo')}`)
    expect(response.status).toBe(200)
    const body = await read<{ channel: { id: string } }>(response)
    expect(body.channel.id).toBe(CHANNEL_ID)
  })

  it('loads a playlist metadata row by id', async () => {
    stubFetch((url) => {
      expect(url.pathname).toBe('/youtube/v3/playlists')
      expect(url.searchParams.get('id')).toBe('PL0000000001')
      expect(url.searchParams.get('maxResults')).toBe('1')
      return json({ items: [playlistEntry('PL0000000001')] })
    })

    const response = await get('/playlists/PL0000000001')
    expect(response.status).toBe(200)
    const body = await read<{ playlist: { title: string; itemCount: number } }>(response)
    expect(body.playlist.title).toBe('Playlist title')
    expect(body.playlist.itemCount).toBe(8)
    expect(await usageRow('playlists')).toEqual({ units: 1, count: 1 })
  })

  it('loads a playlist page and fills statistics', async () => {
    stubFetch((url) => {
      if (url.pathname.endsWith('/playlistItems')) {
        expect(url.searchParams.get('pageToken')).toBe('TOKEN')
        return json({
          items: [playlistItemEntry('vid00000001')],
          pageInfo: { totalResults: 1 },
        })
      }
      if (url.pathname.endsWith('/videos')) {
        return json({ items: [videoItem('vid00000001')] })
      }
      return json({}, 500)
    })

    const response = await get('/playlists/PL0000000001/videos?pageToken=TOKEN')
    expect(response.status).toBe(200)
    const body = await read<YouTubeListResult<YouTubeVideo>>(response)
    expect(body.items[0]!.viewCount).toBe(1234)
    expect(await usageRow('playlistItems')).toEqual({ units: 1, count: 1 })
    expect(await usageRow('videos')).toEqual({ units: 1, count: 1 })
  })

  it('returns a video detail and treats missing statistics as zero', async () => {
    stubFetch(() => json({
      items: [videoItem('vid00000001', { stats: false, duration: 'PT45S' })],
    }))

    const response = await get('/videos/vid00000001')
    expect(response.status).toBe(200)
    const body = await read<{ video: YouTubeVideo }>(response)
    expect(body.video.duration).toBe('0:45')
    expect(body.video.viewCount).toBe(0)
    expect(body.video.likeCount).toBe(0)
    expect(body.video.commentCount).toBe(0)
    expect(body.video.isLive).toBe(false)
  })

  it('returns 404 when a video detail has no item', async () => {
    stubFetch(() => json({ items: [] }))
    const response = await get('/videos/vid00000001')
    expect(response.status).toBe(404)
    const body = await read<ApiErrorBody>(response)
    expect(body.error.code).toBe('youtube_not_found')
  })

  it('maps comment threads and passes the order through', async () => {
    stubFetch((url) => {
      expect(url.pathname).toBe('/youtube/v3/commentThreads')
      expect(url.searchParams.get('videoId')).toBe('vid00000001')
      expect(url.searchParams.get('order')).toBe('time')
      expect(url.searchParams.get('maxResults')).toBe('20')
      expect(url.searchParams.get('pageToken')).toBe('TOKEN')
      return json({
        items: [commentThread('comment-1', 'vid00000001')],
        pageInfo: { totalResults: 1 },
        nextPageToken: 'NEXT',
      })
    })

    const response = await get('/videos/vid00000001/comments?order=time&pageToken=TOKEN')
    expect(response.status).toBe(200)
    const body = await read<YouTubeCommentList>(response)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.authorDisplayName).toBe('Ada')
    expect(body.items[0]!.textDisplay).toBe('<b>hello</b>')
    expect(body.items[0]!.replyCount).toBe(2)
    expect(body.total).toBe(1)
    expect(body.nextPageToken).toBe('NEXT')
  })
})

describe('youtube upstream errors', () => {
  it('maps a quota refusal to 429 with the upstream reason', async () => {
    stubFetch(() => json({
      error: {
        message: 'The request cannot be completed because you have exceeded your quota.',
        errors: [{ reason: 'quotaExceeded' }],
      },
    }, 403))

    const response = await get('/videos/vid00000001')
    expect(response.status).toBe(429)
    const body = await read<ApiErrorBody>(response)
    expect(body.error.code).toBe('youtube_quota_exceeded')
    expect(body.error.details?.reason).toBe('quotaExceeded')
  })

  it('maps an upstream 404 to youtube_not_found', async () => {
    stubFetch(() => json({ error: { message: 'Video not found' } }, 404))
    const response = await get('/videos/vid00000001')
    expect(response.status).toBe(404)
    const body = await read<ApiErrorBody>(response)
    expect(body.error.code).toBe('youtube_not_found')
  })

  it('maps a non-JSON answer to 502', async () => {
    stubFetch(() => new Response('<html>nope</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }))
    const response = await get('/discover')
    expect(response.status).toBe(502)
    const body = await read<ApiErrorBody>(response)
    expect(body.error.code).toBe('youtube_upstream')
  })

  it('maps an upstream 5xx to 502', async () => {
    stubFetch(() => json({ error: { message: 'Backend error' } }, 500))
    const response = await get('/discover')
    expect(response.status).toBe(502)
    const body = await read<ApiErrorBody>(response)
    expect(body.error.code).toBe('youtube_upstream')
  })

  it('accepts a loopback http base for a local adapter', async () => {
    stubFetch((url) => {
      expect(url.origin).toBe('http://127.0.0.1:5198')
      expect(url.pathname).toBe('/youtube/v3/videos')
      return json({ items: [] })
    })
    const response = await get('/discover', envWith({
      YOUTUBE_API_BASE: 'http://127.0.0.1:5198/youtube/v3',
    }))
    expect(response.status).toBe(200)
  })

  it('refuses an insecure API base without touching the network', async () => {
    stubFetch(() => json({ items: [] }))
    const response = await get('/discover', envWith({
      YOUTUBE_API_BASE: 'http://www.googleapis.com/youtube/v3',
    }))
    expect(response.status).toBe(500)
    const body = await read<ApiErrorBody>(response)
    expect(body.error.code).toBe('internal')
    expect(calls).toHaveLength(0)
  })
})
