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
import { MUSIC_MIME_BY_FORMAT, isMusicFormat } from '@shared/music/constants'
import { parseMusicWebdavProviderId, type MusicTrack } from '@shared/music/model'
import type { AppBindings, Env } from '../env'
import { ApiError } from '../lib/errors'
import { contentDisposition } from '../lib/http-range'
import { decryptMusicCookie } from '../lib/crypto'
import { requireAuth } from '../middleware/auth'
import { MusicStore } from '../music/store'
import { resolveMusicWebdav } from '../music/cloud/config'
import { fetchMusicObject } from '../music/cloud/webdav'
import {
  MUSIC_COVER_CACHE_CONTROL,
  hasMusicStorage,
  readMusicObjectStream,
  requireMusicStorage,
} from '../music/storage'
import {
  fetchAllowedMusicUrl,
  serveMusicStream,
} from '../music/stream'
import { createNeteaseProvider } from '../music/providers/netease/client'
import type { MusicProvider } from '../music/providers/types'

const COVER_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}

export const musicFileRoutes = new Hono<AppBindings>()

musicFileRoutes.use('*', requireAuth)

musicFileRoutes.get('/stream/:trackId', async (c) => {
  const track = await ownedTrack(c, 'trackId')
  if (track.provider === 'webdav') return serveWebdavTrack(c, track)
  const provider = track.r2Key ? undefined : await musicProviderFor(c.env, c.get('userId'))
  return serveMusicStream(c.env, track, c.req.raw, provider)
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
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status, headers })
}

musicFileRoutes.get('/cover/:trackId', async (c) => {
  const track = await ownedTrack(c, 'trackId')

  if (track.coverKey && hasMusicStorage(c.env)) {
    const object = await readMusicObjectStream(c.env, track.coverKey)
    if (object) return storedCoverResponse(object, track)
  }
  if (track.coverUrl) return proxiedCoverResponse(track.coverUrl)
  if (track.coverKey) requireMusicStorage(c.env)
  throw ApiError.notFound('This track has no cover')
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

/**
 * Build the provider for an online track. The stored cookie is a ciphertext, so it is decrypted only
 * for this call; a vault that cannot open it degrades to anonymous playback (non-VIP tracks still
 * work) and says so in the log rather than pretending the account is connected.
 */
async function musicProviderFor(env: Env, userId: string): Promise<MusicProvider> {
  const stored = await new MusicStore(env.DB, userId).getAccountCookie('netease')
  if (!stored) return createNeteaseProvider()
  let cookie: string | null = null
  try {
    cookie = await decryptMusicCookie(env, userId, stored)
  } catch (error) {
    console.warn('[inkstone] Music account cookie could not be decrypted; streaming anonymously:', error)
  }
  return createNeteaseProvider(cookie ? { cookie } : {})
}

function storedCoverResponse(
  object: { body: ReadableStream<Uint8Array>; size: number | null; contentType: string | null },
  track: MusicTrack,
): Response {
  const extension = track.coverKey?.split('.').pop()?.toLowerCase() ?? ''
  const contentType = object.contentType ?? COVER_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': 'inline',
    'Cache-Control': MUSIC_COVER_CACHE_CONTROL,
    'X-Content-Type-Options': 'nosniff',
  })
  if (object.size !== null) headers.set('Content-Length', String(object.size))
  return new Response(object.body as BodyInit, { headers })
}

/**
 * Cover bytes from the provider are proxied through the same host allowlist as the audio stream. An
 * address outside it is a 502, and a response that is not an image is refused rather than relayed.
 */
async function proxiedCoverResponse(url: string): Promise<Response> {
  const upstream = await fetchAllowedMusicUrl(url, { headers: { Accept: 'image/*' } })
  if (upstream.status !== 200) {
    await discardBody(upstream)
    throw new ApiError(502, 'music_source_unavailable', 'The cover could not be loaded')
  }
  const contentType = (upstream.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!contentType.startsWith('image/')) {
    await discardBody(upstream)
    throw new ApiError(502, 'music_source_unavailable', 'The cover source did not return an image')
  }
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': 'inline',
    'Cache-Control': MUSIC_COVER_CACHE_CONTROL,
    'X-Content-Type-Options': 'nosniff',
  })
  const length = upstream.headers.get('content-length')
  if (length) headers.set('Content-Length', length)
  return new Response(upstream.body, { headers })
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
