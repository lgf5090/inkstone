/**
 * Byte-serving routes for the music app.
 *
 * Every path here is owner-scoped: the track is looked up through `MusicStore`, whose queries all
 * carry the session's user id, so another account's id is a 404 and never a 403. Streaming is a GET
 * (and HEAD) and deliberately does not require the client header — an `<audio>` element cannot send
 * one. The stream itself lives in `music/stream.ts`; this file only resolves the track, its cover and
 * the export headers.
 */
import { Hono, type Context } from 'hono'
import { MUSIC_LIMITS, MUSIC_MIME_BY_FORMAT, isMusicFormat } from '@shared/music/constants'
import { parseMusicAlistProviderId, parseMusicWebdavProviderId, type MusicTrack } from '@shared/music/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { contentDisposition } from '../lib/http-range'
import { readStreamWithinLimit } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { MusicStore } from '../music/store'
import { musicProviderFor } from '../music/providers/account'
import { createMusicSourceResolver } from '../music/providers/source'
import { resolveMusicWebdav } from '../music/cloud/config'
import { fetchAlistStream, resolveAlistMount } from '../music/cloud/alist'
import { fetchMusicObject } from '../music/cloud/webdav'
import {
  MUSIC_COVER_CACHE_CONTROL,
  hasMusicStorage,
  readMusicObjectStream,
  requireMusicStorage,
} from '../music/storage'
import {
  fetchRelayableMusicSource,
  serveMusicStream,
} from '../music/stream'

const COVER_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}
const COVER_FETCH_TIMEOUT_MS = 15_000
/** Raster formats only: an SVG from a cover host is markup, not a picture this route should relay. */
const COVER_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])

export const musicFileRoutes = new Hono<AppBindings>()

musicFileRoutes.use('*', requireAuth)

musicFileRoutes.get('/stream/:trackId', async (c) => {
  const track = await ownedTrack(c, 'trackId')
  if (track.provider === 'webdav') return serveWebdavTrack(c, track)
  if (track.provider === 'alist') return serveAlistTrack(c, track)
  const userId = c.get('userId')
  const provider = track.r2Key ? undefined : await musicProviderFor(c.env, userId, { spendBudget: false })
  const settings = track.r2Key ? null : await new MusicStore(c.env.DB, userId).getSettings()
  const resolver = settings ? createMusicSourceResolver(track, settings) : undefined
  const cacheKey = track.r2Key ? undefined : `${userId}:${track.id}:${settings?.quality ?? ''}`
  return serveMusicStream(c.env, track, c.req.raw, provider, settings?.quality, resolver, cacheKey)
})

/**
 * A WebDAV reference played through this worker.
 *
 * The client's Range is forwarded untouched; the upstream 206 is relayed and an upstream 200 stays a
 * 200 (the browser plays a full body just as well). Bytes are never held: the body is the upstream
 * stream. The reference embeds the target it was imported from, so a changed target is refused
 * rather than silently reading a same-named file from a different server.
 */
async function serveWebdavTrack(c: Context<AppBindings>, track: MusicTrack): Promise<Response> {
  const reference = parseMusicWebdavProviderId(track.providerId)
  if (!reference) {
    throw new ApiError(
      502,
      'music_source_unavailable',
      'This track no longer points at a WebDAV file. Import it again from the cloud drive.',
    )
  }
  const contentType = isMusicFormat(track.format) ? MUSIC_MIME_BY_FORMAT[track.format] : null
  if (!contentType || !/^(?:audio|video)\//.test(contentType)) {
    throw new ApiError(502, 'music_source_unavailable', 'This WebDAV track has no playable media type.')
  }
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const ctx = await resolveMusicWebdav(c.env, store, c.get('userId'))
  if (reference.targetId !== ctx.targetId) {
    throw new ApiError(
      502,
      'music_source_unavailable',
      'This track was imported from a different WebDAV target. Import it again from the cloud drive.',
    )
  }
  const request = c.req.raw
  const upstream = await fetchMusicObject(ctx, reference.path, request.headers.get('Range'), request.signal)
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': 'inline',
    'Accept-Ranges': 'bytes',
    // A reference can change under the reader; nothing here is immutable or shared.
    'Cache-Control': 'private, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  })
  const length = upstream.headers.get('Content-Length')
  if (length) headers.set('Content-Length', length)
  if (upstream.status === 206) {
    const range = upstream.headers.get('Content-Range')
    if (range) headers.set('Content-Range', range)
  }
  const status = upstream.status === 206 ? 206 : 200
  return new Response(await bodyForMethod(request.method, upstream), { status, headers })
}

/** An Alist reference: the mount resolves a fresh download address on every play. */
async function serveAlistTrack(c: Context<AppBindings>, track: MusicTrack): Promise<Response> {
  const reference = parseMusicAlistProviderId(track.providerId)
  if (!reference) {
    throw new ApiError(
      502,
      'music_source_unavailable',
      'This track no longer points at an Alist file. Import it again from the cloud drive.',
    )
  }
  const contentType = isMusicFormat(track.format) ? MUSIC_MIME_BY_FORMAT[track.format] : null
  if (!contentType || !/^(?:audio|video)\//.test(contentType)) {
    throw new ApiError(502, 'music_source_unavailable', 'This Alist track has no playable media type.')
  }
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const ctx = await resolveAlistMount(c.env, store, reference.mountId)
  const request = c.req.raw
  const upstream = await fetchAlistStream(ctx, reference.path, request.headers.get('Range'), request.signal)
  if (upstream.status >= 400) {
    await upstream.body?.cancel().catch(() => undefined)
    throw new ApiError(502, 'music_source_unavailable', 'The Alist file host refused this file.')
  }
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': 'inline',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  })
  const length = upstream.headers.get('Content-Length')
  if (length) headers.set('Content-Length', length)
  if (upstream.status === 206) {
    const range = upstream.headers.get('Content-Range')
    if (range) headers.set('Content-Range', range)
  }
  return new Response(await bodyForMethod(request.method, upstream), {
    status: upstream.status === 206 ? 206 : 200,
    headers,
  })
}

/** A HEAD answer has no body; cancel the upstream transfer instead of letting it run to completion. */
async function bodyForMethod(method: string, upstream: Response): Promise<BodyInit | null> {
  if (method !== 'HEAD') return upstream.body
  try {
    await upstream.body?.cancel()
  } catch (error) {
    console.warn('[inkstone] HEAD cloud-music stream body could not be cancelled:', error)
  }
  return null
}

/**
 * A provider image, proxied so the browser never talks to the CDN directly.
 *
 * Discovery shelves carry cover URLs that expire and name an upstream host. Routing them through the
 * same allowlist and cache policy as track covers keeps a reader's address off the CDN and keeps the
 * image loader same-origin.
 */
musicFileRoutes.get('/provider-cover', async (c) => {
  const url = c.req.query('url') ?? ''
  if (!url || url.length > 2_048) throw ApiError.badRequest('A cover address is required')
  return proxiedProviderCoverResponse(url, c.req.raw)
})

musicFileRoutes.get('/cover/:trackId', async (c) => {
  const track = await ownedTrack(c, 'trackId')

  if (track.coverKey && hasMusicStorage(c.env)) {
    const object = await readMusicObjectStream(c.env, track.coverKey)
    if (object) return storedCoverResponse(object, track, c.req.header('if-none-match'))
  }
  if (track.coverUrl) return proxiedProviderCoverResponse(track.coverUrl, c.req.raw)
  if (track.coverKey) requireMusicStorage(c.env)
  throw ApiError.notFound('This track has no cover')
})

/** A playlist cover uploaded by its owner: the same private cache as a track cover. */
musicFileRoutes.get('/cover/playlist/:playlistId', async (c) => {
  const id = c.req.param('playlistId')
  if (!id || id.length > 128) throw ApiError.notFound('Playlist not found')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const key = await store.getPlaylistCoverKey(id)
  if (!key) throw ApiError.notFound('This playlist has no cover')
  requireMusicStorage(c.env)
  const object = await readMusicObjectStream(c.env, key)
  if (!object) throw ApiError.notFound('This playlist cover is no longer stored')
  return storedImageResponse(object, key, c.req.header('if-none-match'))
})

musicFileRoutes.get('/export/track/:id', async (c) => {
  const track = await ownedTrack(c, 'id')
  if (!track.r2Key) {
    throw new ApiError(409, 'music_source_unavailable', 'The track has no file stored in the music library')
  }
  requireMusicStorage(c.env)
  const object = await readMusicObjectStream(c.env, track.r2Key)
  if (!object) throw ApiError.notFound('The track file is no longer stored')

  const filename = exportFilename(track)
  const headers = new Headers({
    'Content-Type': trackMime(track) ?? object.contentType ?? 'application/octet-stream',
    'Content-Disposition': contentDisposition('application/octet-stream', filename),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  })
  if (object.size !== null) headers.set('Content-Length', String(object.size))
  return new Response(object.body as BodyInit, { headers })
})

async function ownedTrack(
  c: Context<AppBindings>,
  param: 'trackId' | 'id',
): Promise<MusicTrack> {
  const id = c.req.param(param)
  // Provider ids are numeric or opaque strings, while a row this deployment created is a 26-char id.
  // Resolving the provider identity as a fallback is what lets a track played straight from search
  // stream before the reader has saved it to the library.
  if (!id || id.length > 128) throw ApiError.notFound('Track not found')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const track = await store.getTrack(id) ?? await store.findTrack('netease', id)
  if (!track) throw ApiError.notFound('Track not found')
  return track
}

function storedCoverResponse(
  object: { body: ReadableStream<Uint8Array>; size: number | null; contentType: string | null; etag: string | null },
  track: MusicTrack,
  ifNoneMatch?: string,
): Response {
  return storedImageResponse(object, track.coverKey ?? '', ifNoneMatch)
}

function storedImageResponse(
  object: { body: ReadableStream<Uint8Array>; size: number | null; contentType: string | null; etag: string | null },
  key: string,
  ifNoneMatch?: string,
): Response {
  const extension = key.split('.').pop()?.toLowerCase() ?? ''
  const contentType = object.contentType ?? COVER_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
  const etag = object.etag
  if (etag && ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } })
  }
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': 'inline',
    'Cache-Control': MUSIC_COVER_CACHE_CONTROL,
    'X-Content-Type-Options': 'nosniff',
  })
  if (etag) headers.set('ETag', etag)
  if (object.size !== null) headers.set('Content-Length', String(object.size))
  return new Response(object.body as BodyInit, { headers })
}

/**
 * A provider or custom cover URL, proxied through the public-HTTPS guard.
 *
 * The allowlist is deliberately wider than Netease here: a playlist restored from a backup may name
 * another public image host. The response stays capped at the cover ceiling and is never shared.
 */
async function proxiedProviderCoverResponse(url: string, request: Request): Promise<Response> {
  const upstream = await fetchRelayableMusicSource(url, {
    headers: { Accept: 'image/*' },
    signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS),
  })
  if (upstream.status !== 200) {
    await discardBody(upstream)
    throw new ApiError(502, 'music_source_unavailable', 'The cover could not be loaded')
  }
  const contentType = (upstream.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!COVER_MIME_TYPES.has(contentType)) {
    await discardBody(upstream)
    throw new ApiError(502, 'music_source_unavailable', 'The cover source did not return a supported image')
  }
  const declared = Number(upstream.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MUSIC_LIMITS.coverMaxBytes) {
    await discardBody(upstream)
    throw ApiError.tooLarge(`Covers must be ${Math.round(MUSIC_LIMITS.coverMaxBytes / (1024 * 1024))} MB or smaller.`)
  }
  const etag = upstream.headers.get('etag')
  const ifNoneMatch = request.headers.get('if-none-match')
  if (etag && ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
    await discardBody(upstream)
    return new Response(null, { status: 304, headers: { ETag: etag } })
  }
  const bytes = await readStreamWithinLimit(upstream.body, MUSIC_LIMITS.coverMaxBytes)
  if (bytes === null) {
    throw ApiError.tooLarge(`Covers must be ${Math.round(MUSIC_LIMITS.coverMaxBytes / (1024 * 1024))} MB or smaller.`)
  }
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, max-age=3600',
    'Content-Length': String(bytes.byteLength),
    'X-Content-Type-Options': 'nosniff',
  })
  if (etag) headers.set('ETag', etag)
  return new Response(bytes, { headers })
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The refused response is dropped with its body; nothing downstream reads it.
  }
}

function trackMime(track: MusicTrack): string | null {
  return isMusicFormat(track.format) ? MUSIC_MIME_BY_FORMAT[track.format] : null
}

function exportFilename(track: MusicTrack): string {
  const extension = isMusicFormat(track.format)
    ? track.format
    : track.r2Key?.split('.').pop()?.toLowerCase() ?? 'bin'
  return `${track.title || 'track'}.${extension}`
}
