// @vitest-environment node
// Behavioural coverage for the saved-library half of the YouTube app: the three saved kinds, the tag
// tree, and the account boundary every statement keeps.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppBindings } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { youtubeLibraryRoutes } from '../src/worker/youtube/routes-library'
import { YOUTUBE_SCHEMA_STATEMENTS } from '../src/worker/youtube/schema'
import type {
  SavedYouTubeChannel,
  SavedYouTubePlaylist,
  SavedYouTubeVideo,
  YouTubeChannel,
  YouTubeLibrary,
  YouTubePlaylist,
  YouTubeTag,
  YouTubeVideo,
} from '../src/shared/youtube/model'
import { YOUTUBE_MAX_LIBRARY_VIDEOS } from '../src/shared/youtube/model'
import { YOUTUBE_MAX_DATA_BYTES, YOUTUBE_MAX_NOTES_LENGTH } from '../src/shared/youtube/validate'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'

const mocks = { userId: ALICE }
const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.use('*', async (c, next) => {
  c.set('userId', mocks.userId)
  await next()
})
app.route('/api/youtube/library', youtubeLibraryRoutes)

const ctx: ExecutionContext = { waitUntil() {}, passThroughOnException() {}, props: {} }

let sqlite: DatabaseSync
let db: D1Database
let now: number

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of YOUTUBE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  now = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(() => {
  vi.restoreAllMocks()
  sqlite.close()
})

async function send(user: string, method: string, path: string, body?: unknown): Promise<Response> {
  mocks.userId = user
  return await app.request(
    `/api/youtube/library${path}`,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { DB: db } as unknown as AppBindings['Bindings'],
    ctx,
  )
}

async function read<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function library(user = ALICE): Promise<YouTubeLibrary> {
  const response = await send(user, 'GET', '')
  expect(response.status).toBe(200)
  return await read<YouTubeLibrary>(response)
}

async function errorBody(response: Response): Promise<{ error: { code: string; message: string } }> {
  return await read<{ error: { code: string; message: string } }>(response)
}

function videoData(id: string, overrides: Partial<YouTubeVideo> = {}): YouTubeVideo {
  return {
    id,
    title: `Video ${id}`,
    description: '',
    publishedAt: '2026-01-01T00:00:00Z',
    channelId: 'UCabcdefghijklmnopqrstuv',
    channelTitle: 'Example channel',
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    thumbnailHighUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    duration: 'PT1M2S',
    viewCount: 10,
    likeCount: 2,
    commentCount: 1,
    tags: [],
    categoryId: '28',
    isLive: false,
    ...overrides,
  }
}

function channelData(id: string, overrides: Partial<YouTubeChannel> = {}): YouTubeChannel {
  return {
    id,
    title: `Channel ${id}`,
    description: '',
    customUrl: null,
    thumbnailUrl: 'https://yt3.googleusercontent.com/example',
    subscriberCount: 100,
    videoCount: 5,
    uploadsPlaylistId: 'UUabcdefghijklmnopqrstuv',
    publishedAt: '2020-01-01T00:00:00Z',
    ...overrides,
  }
}

function playlistData(id: string, overrides: Partial<YouTubePlaylist> = {}): YouTubePlaylist {
  return {
    id,
    title: `Playlist ${id}`,
    description: '',
    channelId: 'UCabcdefghijklmnopqrstuv',
    channelTitle: 'Example channel',
    thumbnailUrl: 'https://i.ytimg.com/vi/example/mqdefault.jpg',
    itemCount: 7,
    publishedAt: '2020-01-01T00:00:00Z',
    ...overrides,
  }
}

async function createTag(
  user: string,
  name: string,
  parentId: string | null = null,
  color = '#2563eb',
): Promise<YouTubeTag> {
  const response = await send(user, 'POST', '/tags', { name, color, parentId })
  expect(response.status).toBe(200)
  return (await read<{ tag: YouTubeTag }>(response)).tag
}

async function putVideo(
  user: string,
  data: YouTubeVideo,
  fields: Record<string, unknown> = {},
): Promise<SavedYouTubeVideo> {
  const response = await send(user, 'PUT', `/videos/${data.id}`, { data, ...fields })
  expect(response.status).toBe(200)
  return (await read<{ video: SavedYouTubeVideo }>(response)).video
}

async function putChannel(
  user: string,
  data: YouTubeChannel,
  fields: Record<string, unknown> = {},
): Promise<SavedYouTubeChannel> {
  const response = await send(user, 'PUT', `/channels/${data.id}`, { data, ...fields })
  expect(response.status).toBe(200)
  return (await read<{ channel: SavedYouTubeChannel }>(response)).channel
}

async function putPlaylist(
  user: string,
  data: YouTubePlaylist,
  fields: Record<string, unknown> = {},
): Promise<SavedYouTubePlaylist> {
  const response = await send(user, 'PUT', `/playlists/${data.id}`, { data, ...fields })
  expect(response.status).toBe(200)
  return (await read<{ playlist: SavedYouTubePlaylist }>(response)).playlist
}

describe('youtube library store', () => {
  it('round-trips all three saved kinds and keeps accounts apart', async () => {
    const tag = await createTag(ALICE, 'Watch later')
    expect(tag.id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
    expect(tag.parentId).toBeNull()
    expect(tag.sortOrder).toBe(0)
    expect(tag.createdAt).toBe(now)

    const video = videoData('vid000000001')
    const savedVideo = await putVideo(ALICE, video, {
      pinned: true,
      favorited: false,
      tagIds: [tag.id],
      notes: 'Watch on the train',
      user_id: BOB,
    })
    expect(savedVideo).toMatchObject({
      id: video.id,
      title: video.title,
      thumbnailUrl: video.thumbnailUrl,
      channelId: video.channelId,
      channelTitle: video.channelTitle,
      tagIds: [tag.id],
      pinned: true,
      favorited: false,
      notes: 'Watch on the train',
      createdAt: now,
      updatedAt: now,
    })
    expect(savedVideo.data).toEqual(video)

    const channel = channelData('UCabcdefghijklmnopqrstuv')
    const savedChannel = await putChannel(ALICE, channel, {
      pinned: true,
      tagIds: [tag.id],
      notes: 'Uploads weekly',
    })
    expect(savedChannel).toMatchObject({
      id: channel.id,
      tagIds: [tag.id],
      pinned: true,
      notes: 'Uploads weekly',
      createdAt: now,
      updatedAt: now,
    })
    expect(savedChannel.data).toEqual(channel)

    const playlist = playlistData('PLabcdefghijklmnopqrstuv')
    const savedPlaylist = await putPlaylist(ALICE, playlist, {
      pinned: false,
      favorited: true,
      tagIds: [tag.id],
      notes: 'Best of',
    })
    expect(savedPlaylist).toMatchObject({
      id: playlist.id,
      tagIds: [tag.id],
      pinned: false,
      favorited: true,
      notes: 'Best of',
      createdAt: now,
      updatedAt: now,
    })
    expect(savedPlaylist.data).toEqual(playlist)

    const alice = await library()
    expect(alice.tags).toEqual([tag])
    expect(alice.videos).toHaveLength(1)
    expect(alice.channels).toHaveLength(1)
    expect(alice.playlists).toHaveLength(1)
    expect(alice.truncated).toBe(false)

    const bob = await library(BOB)
    expect(bob).toEqual({ tags: [], videos: [], channels: [], playlists: [], truncated: false })
  })

  it('upserts by (user, id), preserving created_at and omitted flags', async () => {
    await createTag(ALICE, 'Later')
    const first = await putVideo(ALICE, videoData('vid000000001', { title: 'First title' }), {
      pinned: true,
      favorited: false,
      notes: 'first note',
    })
    expect(first.createdAt).toBe(now)

    now += 5_000
    const second = await putVideo(ALICE, videoData('vid000000001', {
      title: 'Second title',
      channelTitle: 'Renamed channel',
    }))

    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBe(now)
    expect(second.title).toBe('Second title')
    expect(second.channelTitle).toBe('Renamed channel')
    expect(second.pinned).toBe(true)
    expect(second.favorited).toBe(false)
    expect(second.notes).toBe('first note')

    const lib = await library()
    expect(lib.videos).toHaveLength(1)
  })

  it('rejects a data snapshot whose id disagrees with the path', async () => {
    const response = await send(ALICE, 'PUT', '/videos/vid000000001', {
      data: videoData('vid000000002'),
      pinned: true,
    })
    expect(response.status).toBe(400)
    expect((await errorBody(response)).error.code).toBe('youtube_invalid_input')

    const malformed = await send(ALICE, 'PUT', '/videos/not!valid', { data: videoData('not!valid') })
    expect(malformed.status).toBe(400)
    expect((await errorBody(malformed)).error.code).toBe('bad_request')

    expect((await library()).videos).toHaveLength(0)
  })

  it('rejects a snapshot above the byte ceiling with 413', async () => {
    const oversized = videoData('vid000000001', { description: 'x'.repeat(YOUTUBE_MAX_DATA_BYTES) })
    const response = await send(ALICE, 'PUT', '/videos/vid000000001', { data: oversized })
    expect(response.status).toBe(413)
    expect((await errorBody(response)).error.code).toBe('payload_too_large')
    expect((await library()).videos).toHaveLength(0)
  })

  it('rejects a tag id that belongs to another account', async () => {
    const aliceTag = await createTag(ALICE, 'Alice only')

    const response = await send(BOB, 'PUT', '/videos/vid000000001', {
      data: videoData('vid000000001'),
      pinned: true,
      tagIds: [aliceTag.id],
    })
    expect(response.status).toBe(400)
    expect(await errorBody(response)).toEqual({
      error: {
        code: 'youtube_invalid_input',
        message: 'tagIds contains a tag that does not belong to this account',
      },
    })
    expect((await library(BOB)).videos).toHaveLength(0)

    const bob = await putVideo(BOB, videoData('vid000000001'), { pinned: true })
    expect(bob.tagIds).toEqual([])
    expect((await library(ALICE)).videos).toHaveLength(0)

    const bobDelete = await send(BOB, 'DELETE', '/videos/vid000000001')
    expect(bobDelete.status).toBe(204)
    expect((await library(ALICE)).videos).toHaveLength(0)
  })

  it('orders videos, tags, channels and playlists the way the plan specifies', async () => {
    const tagA = await createTag(ALICE, 'A')
    now += 1_000
    const tagB = await createTag(ALICE, 'B')
    now += 1_000
    const tagC = await createTag(ALICE, 'C')
    const moved = await send(ALICE, 'PATCH', `/tags/${tagC.id}`, { sortOrder: 0 })
    expect(moved.status).toBe(200)

    now += 1_000
    await putChannel(ALICE, channelData('UCaaaaaaaaaaaaaaaaaaaaaa'), { pinned: false })
    now += 1_000
    await putChannel(ALICE, channelData('UCbbbbbbbbbbbbbbbbbbbbbb'), { pinned: true })
    now += 1_000
    await putChannel(ALICE, channelData('UCcccccccccccccccccccccc'), { pinned: false })

    now += 1_000
    await putPlaylist(ALICE, playlistData('PLaaaaaaaaaaaaaaaaaaaaaa'), { pinned: false, favorited: false })
    now += 1_000
    await putPlaylist(ALICE, playlistData('PLbbbbbbbbbbbbbbbbbbbbbb'), { pinned: true, favorited: false })
    now += 1_000
    await putPlaylist(ALICE, playlistData('PLcccccccccccccccccccccc'), { pinned: false, favorited: true })

    now += 1_000
    await putVideo(ALICE, videoData('vid000000001'), { pinned: true })
    now += 1_000
    await putVideo(ALICE, videoData('vid000000002'), { pinned: true })
    now += 1_000
    await putVideo(ALICE, videoData('vid000000003'), { pinned: true })

    const lib = await library()
    expect(lib.tags.map((tag) => tag.id)).toEqual([tagA.id, tagC.id, tagB.id])
    expect(lib.channels.map((channel) => channel.id)).toEqual([
      'UCbbbbbbbbbbbbbbbbbbbbbb',
      'UCcccccccccccccccccccccc',
      'UCaaaaaaaaaaaaaaaaaaaaaa',
    ])
    expect(lib.playlists.map((playlist) => playlist.id)).toEqual([
      'PLbbbbbbbbbbbbbbbbbbbbbb',
      'PLcccccccccccccccccccccc',
      'PLaaaaaaaaaaaaaaaaaaaaaa',
    ])
    expect(lib.videos.map((video) => video.id)).toEqual([
      'vid000000003',
      'vid000000002',
      'vid000000001',
    ])
  })

  it('caps the video list at the ceiling and raises truncated', async () => {
    const total = YOUTUBE_MAX_LIBRARY_VIDEOS + 1
    sqlite.exec(`WITH RECURSIVE n(x) AS (
      SELECT 1
      UNION ALL SELECT x + 1 FROM n WHERE x < ${total}
    )
    INSERT INTO youtube_videos
      (user_id, id, title, thumbnail_url, channel_id, channel_title, data_json, tag_ids,
       pinned, favorited, notes, created_at, updated_at)
    SELECT '${ALICE}', printf('bulk-%06d', x), 'Bulk', '', '', '', '{}', '[]', 0, 0, '', x, x
    FROM n`)

    const lib = await library()
    expect(lib.truncated).toBe(true)
    expect(lib.videos).toHaveLength(YOUTUBE_MAX_LIBRARY_VIDEOS)
    expect(lib.videos[0]?.id).toBe(`bulk-${String(total).padStart(6, '0')}`)
    expect(lib.videos.at(-1)?.id).toBe('bulk-000002')

    const bob = await library(BOB)
    expect(bob.truncated).toBe(false)
    expect(bob.videos).toHaveLength(0)
  })

  it('deletes a tag subtree, repairs every reference and drops zombie videos', async () => {
    const root = await createTag(ALICE, 'Root')
    const child = await createTag(ALICE, 'Child', root.id)
    const grandchild = await createTag(ALICE, 'Grandchild', child.id)
    const sibling = await createTag(ALICE, 'Sibling')
    const unrelated = await createTag(ALICE, 'Unrelated')

    await putVideo(ALICE, videoData('vid000000001'), { tagIds: [root.id, grandchild.id] })
    await putVideo(ALICE, videoData('vid000000002'), { pinned: true, tagIds: [root.id] })
    await putVideo(ALICE, videoData('vid000000003'), { favorited: true, tagIds: [child.id] })
    await putVideo(ALICE, videoData('vid000000004'), { tagIds: [unrelated.id] })
    await putChannel(ALICE, channelData('UCabcdefghijklmnopqrstuv'), {
      tagIds: [root.id, unrelated.id],
    })
    await putPlaylist(ALICE, playlistData('PLabcdefghijklmnopqrstuv'), {
      tagIds: [grandchild.id],
    })

    const response = await send(ALICE, 'DELETE', `/tags/${root.id}`)
    expect(response.status).toBe(200)
    const removed = await read<{ removedTagIds: string[] }>(response)
    expect(new Set(removed.removedTagIds)).toEqual(new Set([root.id, child.id, grandchild.id]))

    const lib = await library()
    expect(lib.tags.map((tag) => tag.id).sort()).toEqual([sibling.id, unrelated.id].sort())

    const videos = new Map(lib.videos.map((video) => [video.id, video]))
    expect(videos.has('vid000000001')).toBe(false)
    expect(videos.get('vid000000002')?.tagIds).toEqual([])
    expect(videos.get('vid000000003')?.tagIds).toEqual([])
    expect(videos.get('vid000000004')?.tagIds).toEqual([unrelated.id])
    expect(lib.channels[0]?.tagIds).toEqual([unrelated.id])
    expect(lib.playlists[0]?.tagIds).toEqual([])

    const again = await send(ALICE, 'DELETE', `/tags/${root.id}`)
    expect(again.status).toBe(200)
    expect(await read<{ removedTagIds: string[] }>(again)).toEqual({ removedTagIds: [] })
  })

  it('rejects moving a tag under itself or a descendant, and supports moving to the root', async () => {
    const a = await createTag(ALICE, 'A')
    const b = await createTag(ALICE, 'B', a.id)
    const c = await createTag(ALICE, 'C', b.id)

    const self = await send(ALICE, 'PATCH', `/tags/${a.id}`, { parentId: a.id })
    expect(self.status).toBe(400)
    expect((await errorBody(self)).error.code).toBe('youtube_invalid_input')

    const descendant = await send(ALICE, 'PATCH', `/tags/${a.id}`, { parentId: c.id })
    expect(descendant.status).toBe(400)
    expect((await errorBody(descendant)).error.code).toBe('youtube_invalid_input')

    const missing = await send(ALICE, 'PATCH', `/tags/${a.id}`, { parentId: '0'.repeat(26) })
    expect(missing.status).toBe(400)
    expect((await errorBody(missing)).error.code).toBe('youtube_invalid_input')

    let lib = await library()
    expect(lib.tags.find((tag) => tag.id === a.id)?.parentId).toBeNull()
    expect(lib.tags.find((tag) => tag.id === b.id)?.parentId).toBe(a.id)
    expect(lib.tags.find((tag) => tag.id === c.id)?.parentId).toBe(b.id)

    const toRoot = await send(ALICE, 'PATCH', `/tags/${b.id}`, { parentId: null })
    expect(toRoot.status).toBe(200)
    expect((await read<{ tag: YouTubeTag }>(toRoot)).tag.parentId).toBeNull()

    lib = await library()
    expect(lib.tags.find((tag) => tag.id === b.id)?.parentId).toBeNull()
  })

  it('returns 404 for an unknown tag patch and leaves other accounts untouched', async () => {
    const aliceTag = await createTag(ALICE, 'Alice')

    const missing = await send(ALICE, 'PATCH', `/tags/${'0'.repeat(26)}`, { name: 'Nope' })
    expect(missing.status).toBe(404)
    expect((await errorBody(missing)).error.code).toBe('youtube_not_found')

    const bobPatch = await send(BOB, 'PATCH', `/tags/${aliceTag.id}`, { name: 'Stolen' })
    expect(bobPatch.status).toBe(404)
    expect((await errorBody(bobPatch)).error.code).toBe('youtube_not_found')

    const bobDelete = await send(BOB, 'DELETE', `/tags/${aliceTag.id}`)
    expect(bobDelete.status).toBe(200)
    expect(await read<{ removedTagIds: string[] }>(bobDelete)).toEqual({ removedTagIds: [] })

    const lib = await library(ALICE)
    expect(lib.tags).toHaveLength(1)
    expect(lib.tags[0]?.name).toBe('Alice')
  })

  it('keeps DELETE idempotent for all three saved kinds', async () => {
    for (const path of ['/videos/missing0001', '/channels/UCmissing000000000000000', '/playlists/PLmissing000000000000000']) {
      const first = await send(ALICE, 'DELETE', path)
      expect(first.status).toBe(204)
      const second = await send(ALICE, 'DELETE', path)
      expect(second.status).toBe(204)
    }

    await putVideo(ALICE, videoData('vid000000001'), { pinned: true })
    expect((await send(ALICE, 'DELETE', '/videos/vid000000001')).status).toBe(204)
    expect((await library()).videos).toHaveLength(0)
  })

  it('caps notes and validates tag names, parents and colors', async () => {
    const saved = await putVideo(ALICE, videoData('vid000000001'), {
      pinned: true,
      notes: 'n'.repeat(YOUTUBE_MAX_NOTES_LENGTH + 500),
    })
    expect(saved.notes).toHaveLength(YOUTUBE_MAX_NOTES_LENGTH)

    const emptyName = await send(ALICE, 'POST', '/tags', { name: '   ', color: '#2563eb' })
    expect(emptyName.status).toBe(400)
    expect((await errorBody(emptyName)).error.code).toBe('youtube_invalid_input')

    const longName = await send(ALICE, 'POST', '/tags', { name: 'x'.repeat(33), color: '#2563eb' })
    expect(longName.status).toBe(400)

    const noParent = await send(ALICE, 'POST', '/tags', {
      name: 'Child',
      color: '#2563eb',
      parentId: '0'.repeat(26),
    })
    expect(noParent.status).toBe(400)

    const fallback = await send(ALICE, 'POST', '/tags', { name: 'Fallback', color: 'not-a-colour' })
    expect(fallback.status).toBe(200)
    expect((await read<{ tag: YouTubeTag }>(fallback)).tag.color).toBe('#64748b')

    const parent = await createTag(ALICE, 'Parent')
    const child = await createTag(ALICE, 'Child', parent.id)
    expect(child.sortOrder).toBe(0)
    const sibling = await createTag(ALICE, 'Sibling', parent.id)
    expect(sibling.sortOrder).toBe(1)
  })
})

describe('youtube sidebar ordering', () => {
  it('reorders channels and playlists and pins a tag above its siblings', async () => {
    const firstChannel = await putChannel(ALICE, channelData('UCaaaaaaaaaaaaaaaaaaaaaa'))
    const secondChannel = await putChannel(ALICE, channelData('UCbbbbbbbbbbbbbbbbbbbbbb'))
    const channelOrder = await send(ALICE, 'PATCH', '/channels/order', {
      ids: [secondChannel.id, firstChannel.id],
    })
    expect(orderStatus(channelOrder)).toBe(204)
    let lib = await library()
    expect(lib.channels.map((channel) => channel.id)).toEqual([secondChannel.id, firstChannel.id])
    expect(lib.channels.map((channel) => channel.sortOrder)).toEqual([0, 1])

    const firstPlaylist = await putPlaylist(ALICE, playlistData('PLaaaaaaaaaaaaaaaaaaaaaa'))
    const secondPlaylist = await putPlaylist(ALICE, playlistData('PLbbbbbbbbbbbbbbbbbbbbbb'))
    const playlistOrder = await send(ALICE, 'PATCH', '/playlists/order', {
      ids: [secondPlaylist.id, firstPlaylist.id],
    })
    expect(orderStatus(playlistOrder)).toBe(204)
    lib = await library()
    expect(lib.playlists.map((playlist) => playlist.id)).toEqual([secondPlaylist.id, firstPlaylist.id])

    const firstTag = await createTag(ALICE, 'First')
    const secondTag = await createTag(ALICE, 'Second')
    await send(ALICE, 'PATCH', '/tags/order', { ids: [secondTag.id, firstTag.id] })
    await send(ALICE, 'PATCH', `/tags/${firstTag.id}`, { pinned: true })
    lib = await library()
    expect(lib.tags.map((tag) => tag.id)).toEqual([firstTag.id, secondTag.id])
    expect(lib.tags[0]?.pinned).toBe(true)
  })

  it('refuses an order list that names another account', async () => {
    const aliceTag = await createTag(ALICE, 'Alice')
    const bobTag = await createTag(BOB, 'Bob')
    const response = await send(ALICE, 'PATCH', '/tags/order', { ids: [aliceTag.id, bobTag.id] })
    expect(response.status).toBe(400)
    expect((await errorBody(response)).error.code).toBe('youtube_invalid_input')
  })

  it('keeps the reorder list unique and non-empty', async () => {
    const tag = await createTag(ALICE, 'Only')
    expect((await send(ALICE, 'PATCH', '/tags/order', { ids: [] })).status).toBe(400)
    expect((await send(ALICE, 'PATCH', '/tags/order', { ids: [tag.id, tag.id] })).status).toBe(400)
  })
})

function orderStatus(response: Response): number {
  return response.status
}
