/**
 * The YouTube Data API client and the deployment's quota ledger.
 *
 * The API key belongs to the deployment, so every reader spends one shared daily budget. `ytFetch`
 * records each request it actually puts on the wire, successful or not, and the routes preflight a
 * composite call against the ledger before spending it. Upstream responses are capped and must be
 * JSON; refusals are translated into the app's own `ApiError` vocabulary so no route has to read
 * upstream status codes.
 */
import {
  YOUTUBE_DAILY_QUOTA_DEFAULT,
  YOUTUBE_QUOTA_COSTS,
  parseDuration,
  type YouTubeChannel,
  type YouTubeComment,
  type YouTubePlaylist,
  type YouTubeVideo,
} from '@shared/youtube/model'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { NO_REDIRECT } from '../lib/no-redirect'
import { readStreamTextWithinLimit } from '../lib/request'

const DEFAULT_API_BASE = 'https://www.googleapis.com/youtube/v3'
const FETCH_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_DAILY_QUOTA = 1_000_000

export type YouTubeEndpoint =
  | 'search'
  | 'videos'
  | 'channels'
  | 'playlists'
  | 'playlistItems'
  | 'commentThreads'

export interface YouTubeConfig {
  key: string
  base: string
  region: string | null
  limit: number
}

type JsonObject = Record<string, unknown>

function configError(message: string): ApiError {
  return new ApiError(500, 'internal', message)
}

/** Whether a key is present at all; the quota panel answers this without probing upstream. */
export function youtubeConfigured(env: Env): boolean {
  return Boolean((env.YOUTUBE_API_KEY ?? '').trim())
}

/**
 * The two-letter region `mostPopular` should describe.
 *
 * Optional, but a value that is set has to be exactly the shape the upstream accepts; guessing at a
 * malformed code would spend a request only to have it refused.
 */
export function youtubeRegion(env: Env): string | null {
  const region = (env.YOUTUBE_REGION_CODE ?? '').trim()
  if (!region) return null
  if (!/^[A-Z]{2}$/.test(region)) {
    throw configError('YOUTUBE_REGION_CODE must be two uppercase letters')
  }
  return region
}

/** The deployment's own daily unit budget, which may be below Google's 10,000. */
export function youtubeDailyLimit(env: Env): number {
  const raw = (env.YOUTUBE_DAILY_QUOTA ?? '').trim()
  if (!raw) return YOUTUBE_DAILY_QUOTA_DEFAULT
  if (!/^\d+$/.test(raw)) {
    throw configError('YOUTUBE_DAILY_QUOTA must be an integer between 1 and 1000000')
  }
  const limit = Number(raw)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DAILY_QUOTA) {
    throw configError('YOUTUBE_DAILY_QUOTA must be an integer between 1 and 1000000')
  }
  return limit
}

function youtubeApiBase(env: Env): string {
  const raw = (env.YOUTUBE_API_BASE ?? '').trim() || DEFAULT_API_BASE
  let url: URL
  try {
    url = new URL(raw)
  }
  catch {
    throw configError('YOUTUBE_API_BASE must be an https URL')
  }
  if (url.protocol !== 'https:') throw configError('YOUTUBE_API_BASE must use https')
  if (url.username || url.password) throw configError('YOUTUBE_API_BASE may not carry credentials')
  if (url.search || url.hash) throw configError('YOUTUBE_API_BASE may not carry a query or fragment')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** The resolved configuration for a real upstream call; a missing key is the 503 the API promises. */
export function youtubeConfig(env: Env): YouTubeConfig {
  const key = (env.YOUTUBE_API_KEY ?? '').trim()
  if (!key) {
    throw new ApiError(503, 'youtube_not_configured', 'The YouTube API key is not configured on this deployment')
  }
  return {
    key,
    base: youtubeApiBase(env),
    region: youtubeRegion(env),
    limit: youtubeDailyLimit(env),
  }
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function videoThumbnails(snippet: JsonObject): Pick<YouTubeVideo, 'thumbnailUrl' | 'thumbnailHighUrl'> {
  const thumbs = asObject(snippet.thumbnails)
  const medium = asString(asObject(thumbs.medium).url)
  const small = asString(asObject(thumbs.default).url)
  const high = asString(asObject(thumbs.high).url)
  const standard = medium || small
  return { thumbnailUrl: standard, thumbnailHighUrl: high || standard }
}

/** The id a `search.list` video result names, which may be a bare id or wrapped in `{ videoId }`. */
export function searchItemVideoId(item: unknown): string {
  const id = asObject(item).id
  return typeof id === 'string' ? id : asString(asObject(id).videoId)
}

/** The channel a `search.list type=channel` result names. */
export function channelIdFromSearchItem(item: unknown): string {
  return asString(asObject(asObject(item).snippet).channelId)
}

/** A `playlistItems.list` entry's video id, from either place the API puts it. */
export function playlistItemVideoId(item: unknown): string {
  const row = asObject(item)
  return asString(asObject(asObject(row.snippet).resourceId).videoId)
    || asString(asObject(row.contentDetails).videoId)
}

/** A video as `videos.list` describes it: statistics and duration included. */
export function videoFromItem(item: unknown): YouTubeVideo {
  const row = asObject(item)
  const snippet = asObject(row.snippet)
  const statistics = asObject(row.statistics)
  const content = asObject(row.contentDetails)
  const live = asObject(row.liveStreamingDetails)
  const started = asString(live.actualStartTime)
  const ended = asString(live.actualEndTime)

  return {
    id: asString(row.id),
    title: asString(snippet.title),
    description: asString(snippet.description),
    publishedAt: asString(snippet.publishedAt),
    channelId: asString(snippet.channelId),
    channelTitle: asString(snippet.channelTitle),
    ...videoThumbnails(snippet),
    duration: parseDuration(asString(content.duration)),
    viewCount: asNumber(statistics.viewCount),
    likeCount: asNumber(statistics.likeCount),
    commentCount: asNumber(statistics.commentCount),
    tags: asArray(snippet.tags).filter((tag): tag is string => typeof tag === 'string'),
    categoryId: asString(snippet.categoryId),
    isLive: snippet.liveBroadcastContent === 'live' || Boolean(started && !ended),
  }
}

/**
 * A search result before `videos.list` has filled it in.
 *
 * Search has no statistics and no duration, so the fields the upstream does not carry are zero or
 * empty rather than invented; the caller replaces this with the detailed row whenever one exists.
 */
export function videoFromSearchItem(item: unknown): YouTubeVideo {
  const row = asObject(item)
  const snippet = asObject(row.snippet)
  return {
    id: searchItemVideoId(item),
    title: asString(snippet.title),
    description: asString(snippet.description),
    publishedAt: asString(snippet.publishedAt),
    channelId: asString(snippet.channelId),
    channelTitle: asString(snippet.channelTitle),
    ...videoThumbnails(snippet),
    duration: '',
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    tags: [],
    categoryId: '',
    isLive: snippet.liveBroadcastContent === 'live',
  }
}

export function channelFromItem(item: unknown): YouTubeChannel {
  const row = asObject(item)
  const snippet = asObject(row.snippet)
  const statistics = asObject(row.statistics)
  const content = asObject(row.contentDetails)
  const thumbs = asObject(snippet.thumbnails)
  const small = asString(asObject(thumbs.default).url)
  const medium = asString(asObject(thumbs.medium).url)
  const hidden = statistics.hiddenSubscriberCount === true

  return {
    id: asString(row.id),
    title: asString(snippet.title),
    description: asString(snippet.description),
    customUrl: typeof snippet.customUrl === 'string' ? snippet.customUrl : null,
    thumbnailUrl: small || medium,
    subscriberCount: hidden ? -1 : asNumber(statistics.subscriberCount),
    videoCount: asNumber(statistics.videoCount),
    uploadsPlaylistId: asString(asObject(content.relatedPlaylists).uploads),
    publishedAt: asString(snippet.publishedAt),
  }
}

export function playlistFromItem(item: unknown): YouTubePlaylist {
  const row = asObject(item)
  const snippet = asObject(row.snippet)
  const content = asObject(row.contentDetails)
  const thumbs = asObject(snippet.thumbnails)
  const medium = asString(asObject(thumbs.medium).url)
  const small = asString(asObject(thumbs.default).url)

  return {
    id: asString(row.id),
    title: asString(snippet.title),
    description: asString(snippet.description),
    channelId: asString(snippet.channelId),
    channelTitle: asString(snippet.channelTitle),
    thumbnailUrl: medium || small,
    itemCount: asNumber(content.itemCount),
    publishedAt: asString(snippet.publishedAt),
  }
}

export function commentFromItem(item: unknown): YouTubeComment {
  const row = asObject(item)
  const thread = asObject(row.snippet)
  const top = asObject(thread.topLevelComment)
  const snippet = Object.keys(top).length ? asObject(top.snippet) : thread

  return {
    id: asString(row.id),
    videoId: asString(snippet.videoId),
    authorDisplayName: asString(snippet.authorDisplayName),
    authorProfileImageUrl: asString(snippet.authorProfileImageUrl),
    textDisplay: asString(snippet.textDisplay),
    textOriginal: asString(snippet.textOriginal),
    likeCount: asNumber(snippet.likeCount),
    publishedAt: asString(snippet.publishedAt),
    updatedAt: asString(snippet.updatedAt),
    replyCount: asNumber(thread.totalReplyCount),
  }
}

/** Today's UTC date, the key the quota ledger files each day's units under. */
export function utcDate(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

/**
 * Add one request to today's ledger.
 *
 * This runs after the request was sent, so a failure here says the accounting is incomplete, not
 * that the reader's call failed; the route must still answer. The warning is the only trace, which
 * is why it names the endpoint and never the key or the response.
 */
export async function recordQuotaUsage(db: D1Database, endpoint: YouTubeEndpoint): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO youtube_quota_usage (date, endpoint, units, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(date, endpoint) DO UPDATE SET units = units + excluded.units, count = count + 1`,
    )
      .bind(utcDate(), endpoint, YOUTUBE_QUOTA_COSTS[endpoint] ?? 1)
      .run()
  }
  catch (error) {
    console.warn('[youtube] quota usage could not be recorded', endpoint, error)
  }
}

/**
 * Refuse a composite call whose known cost would cross today's budget.
 *
 * The upstream is not touched; a 429 here says the deployment's own ledger is full, which is the
 * number the quota panel shows. Checking before the call keeps a search from half-spending 100 units
 * and then failing on the follow-up lookup.
 */
export async function assertYouTubeQuota(env: Env, db: D1Database, cost: number): Promise<void> {
  const config = youtubeConfig(env)
  const row = await db.prepare(
    'SELECT COALESCE(SUM(units), 0) AS used FROM youtube_quota_usage WHERE date = ?',
  )
    .bind(utcDate())
    .first<{ used: number }>()
  const used = asNumber(row?.used)
  if (used + cost > config.limit) {
    throw new ApiError(
      429,
      'youtube_quota_exceeded',
      'The YouTube API quota for today is used up',
      { reason: 'quotaExceeded', used, limit: config.limit, cost },
    )
  }
}

function isJsonContentType(value: string): boolean {
  const type = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return type === 'application/json' || type.endsWith('+json')
}

async function readJsonObject(response: Response): Promise<JsonObject | null> {
  let text: string | null
  try {
    text = await readStreamTextWithinLimit(response.body, MAX_RESPONSE_BYTES)
  }
  catch {
    return null
  }
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonObject
      : null
  }
  catch {
    return null
  }
}

function redact(message: string, key: string): string {
  return message.replaceAll(key, '[redacted]')
}

function upstreamRefusal(status: number, body: JsonObject | null, key: string): ApiError {
  const error = asObject(body?.error)
  const first = asObject(asArray(error.errors)[0])
  const message = redact(asString(error.message), key)
  const reason = asString(first.reason)

  if (status === 403 || status === 429) {
    const effective = reason || (status === 429 ? 'rateLimitExceeded' : '')
    if (effective === 'quotaExceeded' || effective === 'rateLimitExceeded' || status === 429) {
      return new ApiError(
        429,
        'youtube_quota_exceeded',
        message || 'The YouTube API quota is exhausted',
        { reason: effective },
      )
    }
  }
  if (status === 400 || status === 404) {
    return new ApiError(404, 'youtube_not_found', message || 'The YouTube resource was not found')
  }
  if (status >= 500) {
    return new ApiError(502, 'youtube_upstream', message || 'The YouTube API failed')
  }
  return new ApiError(502, 'youtube_upstream', message || `The YouTube API refused the request (${status})`)
}

/**
 * One upstream request: key injected, timeout enforced, body capped, refusal translated.
 *
 * The ledger write happens once a response arrives and before its answer is interpreted, so a
 * quota-refused request is counted too. A request that never got a response — a timeout or a
 * network failure — is not counted, and neither is one refused for a missing key: no units were
 * spent upstream.
 */
export async function ytFetch(
  env: Env,
  db: D1Database,
  endpoint: YouTubeEndpoint,
  params: Record<string, string>,
): Promise<JsonObject> {
  const config = youtubeConfig(env)
  const url = new URL(`${config.base}/${endpoint}`)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  url.searchParams.set('key', config.key)

  let response: Response
  try {
    response = await fetch(url, { redirect: NO_REDIRECT, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  }
  catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new ApiError(
      502,
      'youtube_upstream',
      timedOut ? 'The YouTube API did not answer within 15 seconds' : 'The YouTube API could not be reached',
    )
  }
  await recordQuotaUsage(db, endpoint)

  const contentType = response.headers.get('content-type') ?? ''
  if (!isJsonContentType(contentType)) {
    // A body this client refuses is released rather than left for the runtime to drain; a refusal
    // that is not JSON cannot be classified, so it is reported as an upstream failure.
    await response.body?.cancel().catch(() => undefined)
    throw new ApiError(502, 'youtube_upstream', 'The YouTube API did not answer with JSON')
  }

  const body = await readJsonObject(response)
  if (!response.ok) throw upstreamRefusal(response.status, body, config.key)
  if (!body) throw new ApiError(502, 'youtube_upstream', 'The YouTube API answered with an unreadable body')
  return body
}
