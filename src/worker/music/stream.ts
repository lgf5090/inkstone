/**
 * Same-origin playback for stored and online tracks.
 *
 * A stored track is read from R2 with the client's Range, so the browser can seek without the worker
 * holding the file. An online track is proxied: the provider names one URL, the client never does.
 * Only Netease's music CDN hosts are fetched, and every redirect hop is checked again before it is
 * followed. A 403 or an already-expired URL buys one fresh provider lookup; if that fails the answer
 * is a 502 rather than a stream that dies halfway through.
 *
 * Response bodies are handed to the client as they arrive; nothing here reads an audio file into
 * memory.
 */
import {
  MUSIC_MIME_BY_FORMAT,
  isMusicFormat,
} from '@shared/music/constants'
import { MUSIC_QUALITIES, type MusicQuality, type MusicTrack } from '@shared/music/model'
import { assertRelayableEndpoint, isBlockedTarget } from '@shared/ai-proxy-guard'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { contentDisposition, parseByteRange } from '../lib/http-range'
import { MusicProviderError, type MusicProvider, type MusicStreamSource } from './providers/types'
import type { MusicSourceResolver } from './providers/source'
import {
  MUSIC_AUDIO_CACHE_CONTROL,
  headMusicObject,
  readMusicObjectRange,
  readMusicObjectStream,
  requireMusicStorage,
} from './storage'

const MAX_REDIRECTS = 3
/** How long to wait for response headers. The body of a track may legitimately stream for minutes. */
const HEADER_TIMEOUT_MS = 8_000
const DEFAULT_STREAM_QUALITY: MusicQuality = 'exhigh'
const STREAM_SOURCE_CACHE_MS = 60_000
const STREAM_SOURCE_CACHE_MAX = 200
const streamSourceCache = new Map<string, { source: MusicStreamSource; storedAt: number }>()
const UPSTREAM_USER_AGENT = 'Mozilla/5.0 (compatible; Inkstone/1.0; +https://github.com/shuaiplus/inkstone)'
const UPSTREAM_REFERER = 'https://music.163.com'

/**
 * The hosts the Netease player URLs and cover URLs use. A source address outside this list is
 * refused before any fetch: a provider payload must not be able to turn the worker into an open
 * proxy for an arbitrary host.
 */
export function isAllowedMusicSourceHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host.endsWith('.music.126.net') ||
    host.endsWith('.126.net') ||
    host.endsWith('.127.net') ||
    host.endsWith('.163.com')
}

/**
 * Fetch a media URL with the app's redirect policy: HTTPS on an allowlisted host, one hop at a
 * time, at most three hops. A cancelled redirect body keeps the connection from lingering.
 */
export async function fetchAllowedMusicUrl(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  return await fetchWithPolicy(rawUrl, init, allowedMusicUrl)
}

/** A URL returned by the account's resolver: public HTTPS only, and no open-proxy redirects. */
export async function fetchRelayableMusicSource(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  return await fetchWithPolicy(rawUrl, init, allowedRelayableUrl)
}

type UrlPolicy = (raw: string) => URL | null

async function fetchWithPolicy(rawUrl: string, init: RequestInit, policy: UrlPolicy): Promise<Response> {
  let url = policy(rawUrl)
  if (!url) throw sourceUnavailable('The music source address is not allowed')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS)
  // The header deadline must not outlive the response: a whole song takes longer than eight seconds.
  // A caller that needs a body deadline passes its own signal, and it stays connected for the body.
  const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal
  try {
    for (let redirects = 0; ; redirects += 1) {
      let response: Response
      try {
        response = await fetch(url.toString(), {
          ...init,
          redirect: 'manual',
          signal,
        })
      } catch (error) {
        throw sourceUnavailable('The music source could not be reached', error)
      }
      if (!isRedirect(response.status)) return response

      const location = response.headers.get('location')
      await cancelBody(response)
      if (!location) throw sourceUnavailable('The music source redirected without a location')
      if (redirects >= MAX_REDIRECTS) throw sourceUnavailable('The music source redirected too many times')
      let next: URL | null
      try {
        next = policy(new URL(location, url).toString())
      } catch {
        next = null
      }
      if (!next) throw sourceUnavailable('The music source redirected to an address this worker will not follow')
      url = next
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function serveMusicStream(
  env: Env,
  track: MusicTrack,
  request: Request,
  provider?: MusicProvider,
  requestedQuality?: MusicQuality,
  sourceResolver?: MusicSourceResolver,
  cacheKey?: string,
): Promise<Response> {
  if (track.r2Key) return serveStoredTrack(env, track, request)
  return serveOnlineTrack(track, request, provider, requestedQuality, sourceResolver, cacheKey)
}

async function serveStoredTrack(env: Env, track: MusicTrack, request: Request): Promise<Response> {
  requireMusicStorage(env)
  const key = track.r2Key!
  const head = await headMusicObject(env, key)
  if (!head) throw ApiError.notFound('The track file is no longer stored')

  const contentType = trackMime(track) ?? head.contentType ?? 'application/octet-stream'
  const headers = baseStreamHeaders(contentType, track)
  if (head.etag) {
    headers.set('ETag', head.etag)
    const ifNoneMatch = request.headers.get('if-none-match')
    if (ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim() === head.etag)) {
      return new Response(null, { status: 304, headers })
    }
  }
  const rangeHeader = request.headers.get('range')
  const range = rangeHeader ? parseByteRange(rangeHeader, head.size) : null

  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${head.size}`)
    return new Response(null, { status: 416, headers })
  }

  if (range) {
    const length = range.end - range.start + 1
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`)
    headers.set('Content-Length', String(length))
    if (request.method === 'HEAD') return new Response(null, { status: 206, headers })
    const object = await readMusicObjectRange(env, key, range.start, length)
    if (!object) throw ApiError.notFound('The track file is no longer stored')
    return new Response(object.body as BodyInit, { status: 206, headers })
  }

  headers.set('Content-Length', String(head.size))
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  const object = await readMusicObjectStream(env, key)
  if (!object) throw ApiError.notFound('The track file is no longer stored')
  return new Response(object.body as BodyInit, { status: 200, headers })
}

async function serveOnlineTrack(
  track: MusicTrack,
  request: Request,
  provider: MusicProvider | undefined,
  requestedQuality?: MusicQuality,
  sourceResolver?: MusicSourceResolver,
  cacheKey?: string,
): Promise<Response> {
  if (!provider) {
    throw new ApiError(502, 'music_provider_unavailable', 'No music provider is available to resolve this track')
  }
  const method = request.method === 'HEAD' ? 'HEAD' : 'GET'
  const range = request.headers.get('range')
  const upstreamHeaders: Record<string, string> = {
    'Accept': '*/*',
    'User-Agent': UPSTREAM_USER_AGENT,
    'Referer': UPSTREAM_REFERER,
  }
  if (range) upstreamHeaders.Range = range

  const quality = streamQuality(track, requestedQuality)
  let custom = false
  const nextSource = async (): Promise<MusicStreamSource> => {
    if (sourceResolver) {
      try {
        const candidate = await sourceResolver.resolveCustom(quality)
        if (candidate) {
          custom = true
          return candidate
        }
      } catch (error) {
        if (!sourceResolver.officialAllowed) throw customSourceError(error)
        console.warn('[inkstone] Custom music resolver failed; falling back to the official source:',
          error instanceof Error ? error.message : error)
      }
    }
    custom = false
    const cached = cacheKey ? cachedSource(cacheKey) : null
    if (cached) return cached
    const official = await resolveStreamSource(provider, track, quality)
    if (cacheKey) rememberSource(cacheKey, official)
    return official
  }
  let source = await nextSource()
  const resolvedSource = source
  let refreshed = resolvedSource.expiresAt > 0 && resolvedSource.expiresAt <= Date.now()
  if (refreshed) {
    if (cacheKey) forgetSource(cacheKey)
    source = await nextSource()
  }
  const fetchSource = custom ? fetchRelayableMusicSource : fetchAllowedMusicUrl

  let upstream: Response
  try {
    upstream = await fetchSource(source.url, {
      method,
      headers: upstreamHeaders,
      signal: request.signal,
    })
  } catch (error) {
    // Workerd egress can be slower than the browser's own path to a CDN; a checked redirect keeps
    // the track playable without turning the Worker into the only network hop that must work. A
    // resolver URL is not on the media CSP allowlist, so it can only be proxied.
    console.warn('[inkstone] Music stream proxy could not reach the CDN; redirecting:', error instanceof Error ? error.message : error)
    if (custom) throw sourceUnavailable('The custom music source could not be reached')
    return directSourceRedirect(source)
  }

  if (upstream.status === 403 && !refreshed) {
    // The URL expired between the provider lookup and the fetch; the range is unchanged.
    refreshed = true
    await cancelBody(upstream)
    if (cacheKey) forgetSource(cacheKey)
    source = await nextSource()
    try {
      const retry = custom ? fetchRelayableMusicSource : fetchAllowedMusicUrl
      upstream = await retry(source.url, {
        method,
        headers: upstreamHeaders,
        signal: request.signal,
      })
    } catch {
      if (custom) throw sourceUnavailable('The custom music source could not be reached')
      return directSourceRedirect(source)
    }
  }

  if (upstream.status === 403) {
    await cancelBody(upstream)
    if (custom) throw sourceUnavailable('The custom music source refused this track')
    return directSourceRedirect(source)
  }

  if (upstream.status === 416) {
    await cancelBody(upstream)
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Range': upstream.headers.get('content-range') ?? 'bytes */*',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    return new Response(null, { status: 416, headers })
  }

  if (upstream.status !== 200 && upstream.status !== 206) {
    await cancelBody(upstream)
    throw sourceUnavailable(`The music source answered ${upstream.status}`)
  }

  const contentType = upstreamMediaType(upstream, track)
  const headers = baseStreamHeaders(contentType, track)
  headers.set('Cache-Control', 'private, no-store')
  headers.set('X-Music-Free-Trial', source.freeTrial ? '1' : '0')
  headers.set('X-Music-Quality', source.level || source.quality)
  headers.set('X-Music-Gain', String(source.gain))
  headers.set('X-Music-Peak', String(source.peak))
  copyHeader(upstream, headers, 'content-length')
  copyHeader(upstream, headers, 'content-range')
  copyHeader(upstream, headers, 'etag')
  copyHeader(upstream, headers, 'last-modified')
  headers.set('Accept-Ranges', 'bytes')

  return new Response(await bodyForMethod(method, upstream), {
    status: upstream.status,
    headers,
  })
}

/** A HEAD answer has no body; cancel the upstream transfer instead of letting it run to completion. */
async function bodyForMethod(method: string, upstream: Response): Promise<BodyInit | null> {
  if (method !== 'HEAD') return upstream.body
  try {
    await upstream.body?.cancel()
  } catch (error) {
    console.warn('[inkstone] HEAD music stream body could not be cancelled:', error)
  }
  return null
}

/** The provider call, with its errors translated into the music API's vocabulary. */
async function resolveStreamSource(
  provider: MusicProvider,
  track: MusicTrack,
  quality: MusicQuality,
): Promise<MusicStreamSource> {
  try {
    if (track.kind === 'mv') {
      const mv = await provider.mvUrl(track.providerId)
      return {
        url: mv.url,
        expiresAt: mv.expiresAt,
        format: isMusicFormat(track.format) ? track.format : 'mp4',
        bitrate: null,
        size: mv.size,
        quality: 'original',
        level: 'original',
        gain: 0,
        peak: 0,
        freeTrial: false,
      }
    }
    return await provider.stream(track.providerId, quality)
  } catch (error) {
    if (!(error instanceof MusicProviderError)) throw error
    console.warn('[inkstone] Music provider could not resolve a stream:', error.code, error.status)
    if (error.code === 'auth_required') {
      throw new ApiError(
        409,
        'music_provider_auth_required',
        'The connected music account needs to sign in again before this track can play',
      )
    }
    if (error.status === 404) throw ApiError.notFound('The provider has no playable stream for this track')
    throw new ApiError(502, 'music_provider_unavailable', 'The music provider could not provide this track')
  }
}

function customSourceError(error: unknown): unknown {
  if (!(error instanceof MusicProviderError)) return error
  console.warn('[inkstone] Custom music resolver could not provide a stream:', error.code, error.status)
  return new ApiError(502, 'music_source_unavailable', error.message || 'The custom resolver could not provide this track')
}

function streamQuality(track: MusicTrack, requested?: MusicQuality): MusicQuality {
  if (track.kind === 'mv') return 'original'
  if (requested && requested !== 'original' && (MUSIC_QUALITIES as readonly string[]).includes(requested)) {
    return requested
  }
  const value = track.sourceQuality
  if (!value || value === 'original' || !(MUSIC_QUALITIES as readonly string[]).includes(value)) {
    return DEFAULT_STREAM_QUALITY
  }
  return value as MusicQuality
}

function trackMime(track: MusicTrack): string | null {
  return isMusicFormat(track.format) ? MUSIC_MIME_BY_FORMAT[track.format] : null
}

function upstreamMediaType(response: Response, track: MusicTrack): string {
  const reported = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (reported.startsWith('audio/') || reported.startsWith('video/')) return reported
  return trackMime(track) ?? 'application/octet-stream'
}

function baseStreamHeaders(contentType: string, track: MusicTrack): Headers {
  const filename = `${track.title || 'track'}.${trackExtension(track)}`
  return new Headers({
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition(contentType, filename),
    'Cache-Control': MUSIC_AUDIO_CACHE_CONTROL,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  })
}

function trackExtension(track: MusicTrack): string {
  const fromKey = track.r2Key?.split('.').pop()?.toLowerCase() ?? ''
  if (/^[a-z0-9]{1,8}$/.test(fromKey)) return fromKey
  return isMusicFormat(track.format) ? track.format : 'bin'
}

function copyHeader(from: Response, to: Headers, name: string): void {
  const value = from.headers.get(name)
  if (value) to.set(name, value)
}

function allowedMusicUrl(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!isAllowedMusicSourceHost(url.hostname)) return null
  // Netease still emits a few http picture URLs; the host is allowlisted, so upgrading the scheme
  // is the only change that keeps the browser from blocking the mixed content.
  url.protocol = 'https:'
  if (url.port && url.port !== '443') return null
  url.username = ''
  url.password = ''
  return url
}

function allowedRelayableUrl(raw: string): URL | null {
  let url: URL
  try {
    url = assertRelayableEndpoint(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || isBlockedTarget(url.hostname.replace(/\.+$/, ''))) return null
  if (url.port && url.port !== '443') return null
  url.username = ''
  url.password = ''
  return url
}

function cachedSource(key: string): MusicStreamSource | null {
  const entry = streamSourceCache.get(key)
  if (!entry) return null
  const fresh = Date.now() - entry.storedAt < STREAM_SOURCE_CACHE_MS
    && (entry.source.expiresAt === 0 || entry.source.expiresAt > Date.now() + 5_000)
  if (!fresh) {
    streamSourceCache.delete(key)
    return null
  }
  return entry.source
}

function rememberSource(key: string, source: MusicStreamSource): void {
  if (streamSourceCache.size >= STREAM_SOURCE_CACHE_MAX) {
    const oldest = streamSourceCache.keys().next().value
    if (oldest !== undefined) streamSourceCache.delete(oldest)
  }
  streamSourceCache.set(key, { source, storedAt: Date.now() })
}

function forgetSource(key: string): void {
  streamSourceCache.delete(key)
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is being discarded; a body that refuses to cancel is dropped with it.
  }
}

/** The browser can fetch the CDN itself when this deployment's egress cannot. */
function directSourceRedirect(source: MusicStreamSource): Response {
  const url = allowedMusicUrl(source.url)
  if (!url) throw sourceUnavailable('The music source address is not allowed')
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      'Cache-Control': 'private, no-store',
      'X-Music-Direct': '1',
    },
  })
}

function sourceUnavailable(message: string, cause?: unknown): ApiError {
  if (cause !== undefined) {
    console.warn('[inkstone] Music stream fetch failed:', cause instanceof Error ? cause.message : cause)
  }
  return new ApiError(502, 'music_source_unavailable', message)
}
