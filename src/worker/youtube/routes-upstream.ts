/**
 * The YouTube upstream routes: discover, channel, playlist, video and comment reads.
 *
 * Every handler here spends the deployment's shared Data API budget. Each one preflights the full
 * cost of the call it is about to make (search plus its statistics fill, channel plus its uploads
 * page), so a refusal happens before the upstream is touched. Search also spends a per-account
 * budget, because one reader holding a refresh button should not empty the deployment's day.
 */
import { Hono, type Context } from 'hono'
import {
  YOUTUBE_QUOTA_COSTS,
  YOUTUBE_SEARCH_COST,
  isSortKey,
  isTimeRange,
  rangeCutoff,
  type SortKey,
  type TimeRange,
  type YouTubeVideo,
} from '@shared/youtube/model'
import {
  isSafePageToken,
  isYoutubeId,
  normalizeQuery,
} from '@shared/youtube/validate'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import {
  assertYouTubeQuota,
  channelFromItem,
  channelIdFromSearchItem,
  commentFromItem,
  playlistFromItem,
  playlistItemVideoId,
  searchItemVideoId,
  videoFromItem,
  videoFromSearchItem,
  ytFetch,
  youtubeRegion,
} from './upstream'

export const youtubeUpstreamRoutes = new Hono<AppBindings>()

type Ctx = Context<AppBindings>

const SEARCH_PAGE_SIZE = 20
const POPULAR_PAGE_SIZE = 50
const PLAYLIST_PAGE_SIZE = 20
const CHANNEL_PLAYLIST_PAGE_SIZE = 25
const MAX_CHANNEL_REFERENCE_LENGTH = 512

const POPULAR_COST = YOUTUBE_QUOTA_COSTS.videos ?? 1
const SEARCH_PAGE_COST = YOUTUBE_SEARCH_COST + (YOUTUBE_QUOTA_COSTS.videos ?? 1)
const CHANNEL_LOOKUP_COST = YOUTUBE_QUOTA_COSTS.channels ?? 1
const CHANNEL_VIDEOS_COST = CHANNEL_LOOKUP_COST
  + (YOUTUBE_QUOTA_COSTS.playlistItems ?? 1)
  + (YOUTUBE_QUOTA_COSTS.videos ?? 1)
const CHANNEL_PLAYLISTS_COST = YOUTUBE_QUOTA_COSTS.playlists ?? 1
const PLAYLIST_VIDEOS_COST = (YOUTUBE_QUOTA_COSTS.playlistItems ?? 1) + (YOUTUBE_QUOTA_COSTS.videos ?? 1)
const VIDEO_COST = YOUTUBE_QUOTA_COSTS.videos ?? 1
const COMMENTS_COST = YOUTUBE_QUOTA_COSTS.commentThreads ?? 1

const VIDEO_PART = 'snippet,statistics,contentDetails'
const CHANNEL_PART = 'snippet,statistics,contentDetails'

interface VideoListPage {
  items: YouTubeVideo[]
  total: number
  nextPageToken: string | null
  prevPageToken: string | null
}

function itemsOf(data: Record<string, unknown>): unknown[] {
  return Array.isArray(data.items) ? data.items : []
}

function textToken(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function pageTotal(data: Record<string, unknown>, fallback: number): number {
  const info = data.pageInfo
  if (info !== null && typeof info === 'object' && !Array.isArray(info)) {
    const total = Number((info as Record<string, unknown>).totalResults)
    if (Number.isFinite(total)) return total
  }
  return fallback
}

function pageToken(c: Ctx): string | null {
  const raw = c.req.query('pageToken') ?? ''
  if (!raw) return null
  if (!isSafePageToken(raw)) throw ApiError.badRequest('The page token is not valid')
  return raw
}

function searchOrder(c: Ctx): SortKey {
  const raw = c.req.query('order') ?? ''
  if (!raw) return 'relevance'
  if (!isSortKey(raw)) throw ApiError.badRequest('The order is not one of the supported sort keys')
  return raw
}

function searchRange(c: Ctx): TimeRange {
  const raw = c.req.query('range') ?? ''
  if (!raw) return 'week'
  if (!isTimeRange(raw)) throw ApiError.badRequest('The time range is not supported')
  return raw
}

function commentOrder(c: Ctx): 'relevance' | 'time' {
  const raw = c.req.query('order') ?? ''
  if (!raw) return 'relevance'
  if (raw !== 'relevance' && raw !== 'time') throw ApiError.badRequest('The comment order is not supported')
  return raw
}

/** The RFC 3339 boundary a range chip means; `all` has none. */
function publishedAfter(range: TimeRange, now: number = Date.now()): string | null {
  const cutoff = rangeCutoff(range, now)
  return cutoff === null ? null : new Date(cutoff).toISOString()
}

function videoIdParam(c: Ctx): string {
  const id = c.req.param('id') ?? ''
  if (!isYoutubeId(id)) throw ApiError.badRequest('The video id is not valid')
  return id
}

async function preflight(c: Ctx, cost: number): Promise<void> {
  await assertYouTubeQuota(c.env, c.env.DB, cost)
}

/** One search per ten minutes is cheap; ten is the ceiling, and the lockout is short. */
async function guardSearch(c: Ctx): Promise<void> {
  await assertAttemptBudget(
    () => consumeAttemptBudget(c.env.DB, [{
      key: `youtube-search:${c.get('userId')}`,
      maxAttempts: 10,
      windowMs: 10 * 60 * 1000,
      lockMs: 2 * 60 * 1000,
    }]),
    'Too many searches',
  )
}

/** Fill a page of ids with statistics and duration in one `videos.list` request. */
async function videoDetails(c: Ctx, ids: readonly string[]): Promise<Map<string, YouTubeVideo>> {
  const details = new Map<string, YouTubeVideo>()
  if (!ids.length) return details
  const data = await ytFetch(c.env, c.env.DB, 'videos', {
    part: VIDEO_PART,
    id: ids.join(','),
    maxResults: String(ids.length),
  })
  for (const item of itemsOf(data)) {
    const video = videoFromItem(item)
    if (video.id) details.set(video.id, video)
  }
  return details
}

/**
 * One page of a playlist's videos.
 *
 * The page the upstream returns is the order the reader expects; a video `videos.list` omits (made
 * private, deleted) is dropped rather than shown with invented statistics.
 */
async function playlistVideoPage(c: Ctx, playlistId: string, token: string | null): Promise<VideoListPage> {
  const params: Record<string, string> = {
    part: 'snippet,contentDetails',
    playlistId,
    maxResults: String(PLAYLIST_PAGE_SIZE),
  }
  if (token) params.pageToken = token
  const data = await ytFetch(c.env, c.env.DB, 'playlistItems', params)
  const ids = itemsOf(data).map(playlistItemVideoId).filter((id) => id.length > 0)
  const details = await videoDetails(c, ids)
  const items = ids
    .map((id) => details.get(id))
    .filter((video): video is YouTubeVideo => video !== undefined)
  return {
    items,
    total: pageTotal(data, items.length),
    nextPageToken: textToken(data.nextPageToken),
    prevPageToken: textToken(data.prevPageToken),
  }
}

interface ChannelLookup {
  param: 'id' | 'forHandle' | 'forUsername'
  value: string
  /** A handle is never resolved through search: `forHandle` is authoritative. */
  searchable: boolean
}

const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/
const HANDLE_PATTERN = /^@([A-Za-z0-9._-]{1,64})$/
const CHANNEL_URL_ID_PATTERN = /^\/channel\/(UC[A-Za-z0-9_-]{22})\/?$/
const CHANNEL_URL_HANDLE_PATTERN = /^\/@([A-Za-z0-9._-]{1,64})\/?$/
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])

function parseYouTubeUrl(input: string): URL | null {
  const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`
  let url: URL
  try {
    url = new URL(candidate)
  }
  catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return YOUTUBE_HOSTS.has(url.hostname.toLowerCase()) ? url : null
}

/**
 * What a channel reference names, in the order the reference app resolves it.
 *
 * A raw `UC...` id is an id, `@handle` is a handle, a `youtube.com` address contributes the id or
 * handle it holds, and everything else is a legacy username.
 */
function parseChannelLookup(input: string): ChannelLookup {
  if (CHANNEL_ID_PATTERN.test(input)) return { param: 'id', value: input, searchable: true }

  const handle = HANDLE_PATTERN.exec(input)
  if (handle) return { param: 'forHandle', value: handle[1]!, searchable: false }
  // A malformed handle is still a handle reference; searching for it would waste 100 units on a
  // value the user meant as `@name`.
  if (input.startsWith('@')) throw ApiError.badRequest('The channel handle is not valid')

  const url = parseYouTubeUrl(input)
  if (url) {
    const byId = CHANNEL_URL_ID_PATTERN.exec(url.pathname)
    if (byId) return { param: 'id', value: byId[1]!, searchable: true }
    const byHandle = CHANNEL_URL_HANDLE_PATTERN.exec(url.pathname)
    if (byHandle) return { param: 'forHandle', value: byHandle[1]!, searchable: false }
    throw ApiError.badRequest('The YouTube channel address is not one this app can read')
  }

  if (/^https?:\/\//i.test(input) || /youtube\.com/i.test(input)) {
    throw ApiError.badRequest('The YouTube channel address is not one this app can read')
  }
  return { param: 'forUsername', value: input, searchable: true }
}

function channelLookupParams(lookup: ChannelLookup): Record<string, string> {
  return { part: CHANNEL_PART, [lookup.param]: lookup.value }
}

/**
 * The one search fallback a channel reference may take.
 *
 * It runs only after the direct lookup answered nothing, costs the search endpoint's full 100
 * units, and then resolves the id it found through `channels.list` for the complete row.
 */
async function channelFromSearch(c: Ctx, query: string): Promise<unknown | null> {
  const data = await ytFetch(c.env, c.env.DB, 'search', {
    part: 'snippet',
    type: 'channel',
    q: query,
    maxResults: '1',
  })
  const id = channelIdFromSearchItem(itemsOf(data)[0])
  if (!id || !isYoutubeId(id)) return null
  const found = await ytFetch(c.env, c.env.DB, 'channels', { part: CHANNEL_PART, id })
  return itemsOf(found)[0] ?? null
}

youtubeUpstreamRoutes.get('/discover', async (c) => {
  const query = normalizeQuery(c.req.query('q'))
  const token = pageToken(c)

  if (!query) {
    await preflight(c, POPULAR_COST)
    const params: Record<string, string> = {
      part: VIDEO_PART,
      chart: 'mostPopular',
      maxResults: String(POPULAR_PAGE_SIZE),
    }
    const region = youtubeRegion(c.env)
    if (region) params.regionCode = region
    const data = await ytFetch(c.env, c.env.DB, 'videos', params)
    const items = itemsOf(data).map(videoFromItem)
    return c.json({
      items,
      total: pageTotal(data, items.length),
      nextPageToken: null,
      prevPageToken: null,
      mode: 'popular',
    })
  }

  const order = searchOrder(c)
  const range = searchRange(c)
  await guardSearch(c)
  await preflight(c, SEARCH_PAGE_COST)

  const params: Record<string, string> = {
    part: 'snippet',
    type: 'video',
    q: query,
    order,
    maxResults: String(SEARCH_PAGE_SIZE),
  }
  if (token) params.pageToken = token
  const after = publishedAfter(range)
  if (after) params.publishedAfter = after

  const data = await ytFetch(c.env, c.env.DB, 'search', params)
  const found = itemsOf(data)
  const ids = found.map(searchItemVideoId).filter((id) => id.length > 0)
  const details = await videoDetails(c, ids)
  const items: YouTubeVideo[] = []
  for (const item of found) {
    const id = searchItemVideoId(item)
    if (!id) continue
    items.push(details.get(id) ?? videoFromSearchItem(item))
  }
  return c.json({
    items,
    total: pageTotal(data, items.length),
    nextPageToken: textToken(data.nextPageToken),
    prevPageToken: textToken(data.prevPageToken),
    mode: 'search',
  })
})

youtubeUpstreamRoutes.get('/channels/:id', async (c) => {
  const reference = (c.req.param('id') ?? '').trim()
  if (!reference) throw ApiError.badRequest('A channel id, handle or address is required')
  if (reference.length > MAX_CHANNEL_REFERENCE_LENGTH) {
    throw ApiError.badRequest('That channel reference is too long')
  }

  await preflight(c, CHANNEL_LOOKUP_COST)
  const lookup = parseChannelLookup(reference)
  const data = await ytFetch(c.env, c.env.DB, 'channels', channelLookupParams(lookup))
  let item = itemsOf(data)[0]
  if (!item && lookup.searchable) {
    await assertYouTubeQuota(c.env, c.env.DB, YOUTUBE_SEARCH_COST)
    item = await channelFromSearch(c, lookup.value)
  }
  if (!item) throw new ApiError(404, 'youtube_not_found', 'Channel not found')
  return c.json({ channel: channelFromItem(item) })
})

youtubeUpstreamRoutes.get('/channels/:id/videos', async (c) => {
  const channelId = c.req.param('id') ?? ''
  if (!isYoutubeId(channelId)) throw ApiError.badRequest('The channel id is not valid')
  const token = pageToken(c)
  await preflight(c, CHANNEL_VIDEOS_COST)

  const data = await ytFetch(c.env, c.env.DB, 'channels', { part: 'contentDetails', id: channelId })
  const uploads = channelFromItem(itemsOf(data)[0]).uploadsPlaylistId
  if (!uploads) throw new ApiError(404, 'youtube_not_found', 'The channel has no uploads playlist')

  const page = await playlistVideoPage(c, uploads, token)
  return c.json(page)
})

youtubeUpstreamRoutes.get('/channels/:id/playlists', async (c) => {
  const channelId = c.req.param('id') ?? ''
  if (!isYoutubeId(channelId)) throw ApiError.badRequest('The channel id is not valid')
  const token = pageToken(c)
  await preflight(c, CHANNEL_PLAYLISTS_COST)

  const params: Record<string, string> = {
    part: 'snippet,contentDetails',
    channelId,
    maxResults: String(CHANNEL_PLAYLIST_PAGE_SIZE),
  }
  if (token) params.pageToken = token
  const data = await ytFetch(c.env, c.env.DB, 'playlists', params)
  const items = itemsOf(data).map(playlistFromItem)
  return c.json({
    items,
    total: pageTotal(data, items.length),
    nextPageToken: textToken(data.nextPageToken),
    prevPageToken: textToken(data.prevPageToken),
  })
})

youtubeUpstreamRoutes.get('/playlists/:id/videos', async (c) => {
  const playlistId = c.req.param('id') ?? ''
  if (!isYoutubeId(playlistId)) throw ApiError.badRequest('The playlist id is not valid')
  const token = pageToken(c)
  await preflight(c, PLAYLIST_VIDEOS_COST)
  const page = await playlistVideoPage(c, playlistId, token)
  return c.json(page)
})

youtubeUpstreamRoutes.get('/videos/:id', async (c) => {
  const id = videoIdParam(c)
  await preflight(c, VIDEO_COST)
  const data = await ytFetch(c.env, c.env.DB, 'videos', {
    part: VIDEO_PART,
    id,
    maxResults: '1',
  })
  const item = itemsOf(data)[0]
  if (!item) throw new ApiError(404, 'youtube_not_found', 'Video not found')
  return c.json({ video: videoFromItem(item) })
})

youtubeUpstreamRoutes.get('/videos/:id/comments', async (c) => {
  const videoId = videoIdParam(c)
  await preflight(c, COMMENTS_COST)

  const params: Record<string, string> = {
    part: 'snippet',
    videoId,
    maxResults: String(SEARCH_PAGE_SIZE),
    order: commentOrder(c),
  }
  const token = pageToken(c)
  if (token) params.pageToken = token
  const data = await ytFetch(c.env, c.env.DB, 'commentThreads', params)
  const items = itemsOf(data).map(commentFromItem)
  return c.json({
    items,
    total: pageTotal(data, items.length),
    nextPageToken: textToken(data.nextPageToken),
  })
})
