/**
 * The image cache behind the YouTube rows.
 *
 * A list of fifty rows would otherwise ask Google for fifty pictures on every render. Thumbnails
 * and channel icons are fetched once, validated, and kept in R2 under the fixed `YouTube/` prefix;
 * a deployment without R2 still gets the picture, but with a short-lived cache header and no write.
 * The image bytes never depend on a user's library, so one cache serves every account.
 */
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { NO_REDIRECT } from '../lib/no-redirect'
import { readStreamWithinLimit } from '../lib/request'

const FETCH_TIMEOUT_MS = 15_000
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const CACHED_MAX_AGE_SECONDS = 86_400
const PASSTHROUGH_MAX_AGE_SECONDS = 3_600
const DEFAULT_IMAGE_TYPE = 'image/jpeg'
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

export const THUMBNAIL_PREFIX = 'YouTube/images/thumbnails/'
export const CHANNEL_ICON_PREFIX = 'YouTube/icons/channels/'
export const THUMBNAIL_SOURCE_BASE = 'https://i.ytimg.com/vi/'
export const CHANNEL_ICON_HOSTS = new Set(['yt3.googleusercontent.com', 'yt3.ggpht.com'])

export function thumbnailKey(videoId: string): string {
  return `${THUMBNAIL_PREFIX}${videoId}.jpg`
}

export function thumbnailSource(videoId: string): string {
  return `${THUMBNAIL_SOURCE_BASE}${videoId}/mqdefault.jpg`
}

export function channelIconKey(channelId: string): string {
  return `${CHANNEL_ICON_PREFIX}${channelId}.jpg`
}

/**
 * The icon address a saved channel row may be fetched from.
 *
 * The snapshot is written by the client, so its `thumbnailUrl` is not trusted as a fetch target: only
 * an https address on one of Google's two image hosts is allowed, and anything else is refused
 * before the network is touched.
 */
export function channelIconSource(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(404, 'youtube_not_found', 'The saved channel has no icon')
  }
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new ApiError(400, 'bad_request', 'The saved channel icon address is not valid')
  }
  if (
    url.protocol !== 'https:'
    || Boolean(url.username)
    || Boolean(url.password)
    || !CHANNEL_ICON_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new ApiError(400, 'bad_request', 'The saved channel icon address is not allowed')
  }
  return url.href
}

function normalizeImageType(value: string): string | null {
  const type = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return IMAGE_TYPES.has(type) ? type : null
}

function imageHeaders(contentType: string, maxAgeSeconds: number, etag: string | null): Headers {
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': `private, max-age=${maxAgeSeconds}`,
    'X-Content-Type-Options': 'nosniff',
  })
  if (etag) headers.set('ETag', etag)
  return headers
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  }
  catch {
    // The refused body is dropped with the response; nothing downstream reads it.
  }
}

async function fetchImage(source: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(source, {
      headers: { accept: 'image/jpeg, image/png, image/webp, image/gif' },
      redirect: NO_REDIRECT,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  }
  catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new ApiError(
      502,
      'youtube_upstream',
      timedOut ? 'The image source did not answer within 15 seconds' : 'The image source could not be reached',
    )
  }
  if (response.status === 404) {
    await discard(response)
    throw new ApiError(404, 'youtube_not_found', 'The image was not found')
  }
  if (!response.ok) {
    await discard(response)
    throw new ApiError(502, 'youtube_upstream', `The image source answered ${response.status}`)
  }
  return response
}

async function storeImage(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  source: string,
): Promise<string | null> {
  try {
    const object = await bucket.put(key, bytes, {
      httpMetadata: {
        contentType,
        cacheControl: `private, max-age=${CACHED_MAX_AGE_SECONDS}`,
      },
      customMetadata: {
        source,
        fetchedAt: new Date().toISOString(),
      },
    })
    return object.httpEtag || `"${object.etag}"`
  }
  catch (error) {
    // The picture is already in hand; a cache that refused the write costs a refetch next time and
    // must not fail the reader's request, but it is still reported.
    console.warn('[youtube] image cache write failed', key, error)
    return null
  }
}

/**
 * Serve one image: R2 first, then the validated source, then write the bytes back.
 *
 * A zero-byte object is treated as a miss, because an interrupted write leaves a key that exists but
 * cannot be shown. Without an R2 binding nothing is written and the cache header is the short one.
 */
export async function serveYouTubeImage(env: Env, key: string, source: string): Promise<Response> {
  const bucket = env.FILES
  if (bucket) {
    const cached = await bucket.get(key)
    if (cached && cached.size > 0) {
      const headers = imageHeaders(
        cached.httpMetadata?.contentType || DEFAULT_IMAGE_TYPE,
        CACHED_MAX_AGE_SECONDS,
        cached.httpEtag,
      )
      headers.set('Content-Length', String(cached.size))
      return new Response(cached.body as BodyInit, { headers })
    }
  }

  const upstream = await fetchImage(source)
  const contentType = normalizeImageType(upstream.headers.get('content-type') ?? '')
  if (!contentType) {
    await discard(upstream)
    throw new ApiError(502, 'youtube_upstream', 'The image source did not return a supported image')
  }
  const declared = Number(upstream.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    await discard(upstream)
    throw new ApiError(502, 'youtube_upstream', 'The image is too large to cache')
  }
  let bytes: Uint8Array | null
  try {
    bytes = await readStreamWithinLimit(upstream.body, MAX_IMAGE_BYTES)
  }
  catch {
    throw new ApiError(502, 'youtube_upstream', 'The image source returned an unreadable image')
  }
  if (bytes === null || bytes.byteLength === 0) {
    throw new ApiError(502, 'youtube_upstream', 'The image source returned an unreadable image')
  }

  if (!bucket) {
    return new Response(bytes as BodyInit, {
      headers: imageHeaders(contentType, PASSTHROUGH_MAX_AGE_SECONDS, null),
    })
  }
  const etag = await storeImage(bucket, key, bytes, contentType, source)
  return new Response(bytes as BodyInit, {
    headers: imageHeaders(contentType, CACHED_MAX_AGE_SECONDS, etag),
  })
}
