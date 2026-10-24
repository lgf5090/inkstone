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
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { contentDisposition, parseByteRange } from '../lib/http-range'
import { MusicProviderError, type MusicProvider, type MusicStreamSource } from './providers/types'
import {
  MUSIC_AUDIO_CACHE_CONTROL,
  headMusicObject,
  readMusicObjectRange,
  readMusicObjectStream,
  requireMusicStorage,
} from './storage'

const MAX_REDIRECTS = 3
const DEFAULT_STREAM_QUALITY: MusicQuality = 'exhigh'
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
  let url = allowedMusicUrl(rawUrl)
  if (!url) throw sourceUnavailable('The music source address is not allowed')

  for (let redirects = 0; ; redirects += 1) {
    let response: Response
    try {
      response = await fetch(url.toString(), { ...init, redirect: 'manual' })
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
      next = allowedMusicUrl(new URL(location, url).toString())
    } catch {
      next = null
    }
    if (!next) throw sourceUnavailable('The music source redirected to an address this worker will not follow')
    url = next
  }
}

export async function serveMusicStream(
  env: Env,
  track: MusicTrack,
  request: Request,
  provider?: MusicProvider,
): Promise<Response> {
  if (track.r2Key) return serveStoredTrack(env, track, request)
  return serveOnlineTrack(track, request, provider)
}

async function serveStoredTrack(env: Env, track: MusicTrack, request: Request): Promise<Response> {
  requireMusicStorage(env)
  const key = track.r2Key!
  const head = await headMusicObject(env, key)
  if (!head) throw ApiError.notFound('The track file is no longer stored')

  const contentType = trackMime(track) ?? head.contentType ?? 'application/octet-stream'
  const headers = baseStreamHeaders(contentType, track)
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

  const quality = streamQuality(track)
  let source = await resolveStreamSource(provider, track, quality)
  let refreshed = source.expiresAt > 0 && source.expiresAt <= Date.now()
  if (refreshed) source = await resolveStreamSource(provider, track, quality)

  let upstream = await fetchAllowedMusicUrl(source.url, {
    method,
    headers: upstreamHeaders,
  })

  if (upstream.status === 403 && !refreshed) {
    // The URL expired between the provider lookup and the fetch; the range is unchanged.
    refreshed = true
    await cancelBody(upstream)
    source = await resolveStreamSource(provider, track, quality)
    upstream = await fetchAllowedMusicUrl(source.url, { method, headers: upstreamHeaders })
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
  copyHeader(upstream, headers, 'content-length')
  copyHeader(upstream, headers, 'content-range')
  copyHeader(upstream, headers, 'etag')
  copyHeader(upstream, headers, 'last-modified')
  headers.set('Accept-Ranges', 'bytes')

  return new Response(method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  })
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

function streamQuality(track: MusicTrack): MusicQuality {
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

function sourceUnavailable(message: string, cause?: unknown): ApiError {
  if (cause !== undefined) {
    console.warn('[inkstone] Music stream fetch failed:', cause instanceof Error ? cause.message : cause)
  }
  return new ApiError(502, 'music_source_unavailable', message)
}
