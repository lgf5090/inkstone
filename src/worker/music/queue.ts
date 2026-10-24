/**
 * The download queue: one 8 MiB slice per alarm, into an R2 multipart upload.
 *
 * A Worker request cannot hold a 300 MB body, and a download that only exists while the reader keeps
 * the page open is not a library copy. So the queue lives in a Durable Object keyed by the account id:
 * `alarm()` reads the task from D1, asks the provider for a fresh URL, fetches exactly one slice with a
 * Range request, uploads it as one multipart part, records the progress and schedules the next slice.
 * The multipart id and the parts already stored sit in the object's own storage, keyed by task, so a
 * paused task keeps its bytes and a crash resumes at the next part instead of starting over.
 *
 * The engine below is deliberately separate from the object: `runMusicDownloadSlice` takes the cursor
 * it should continue, the provider and the stores, and returns the cursor to keep. A test can run it
 * with an in-memory bucket and a fake provider, and the object only owns storage and alarms.
 *
 * Pause, resume, cancel and retry arrive as status changes in D1. The engine checks the status before
 * every slice and after every upload part, so a task paused mid-slice stops at the part boundary
 * rather than at the end of the file; a canceled task's multipart is aborted, never completed.
 */
import {
  MUSIC_LIMITS,
  MUSIC_MIME_BY_FORMAT,
  isMusicFormat,
  type MusicFormat,
} from '@shared/music/constants'
import type { MusicDownload, MusicTrack } from '@shared/music/model'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { decryptMusicCookie } from '../lib/crypto'
import { evaluateInternalGuard } from '../lib/internal-auth'
import { MusicDownloadStore } from './download-store'
import { MusicStore } from './store'
import {
  MUSIC_AUDIO_CACHE_CONTROL,
  discardMusicObjects,
  musicObjectKeyFor,
  requireMusicBucket,
  withMusicQuotaLease,
} from './storage'
import { fetchAllowedMusicUrl } from './stream'
import { createNeteaseProvider } from './providers/netease/client'
import { MusicProviderError, type MusicProvider, type MusicStreamSource } from './providers/types'

/** One slice is one upload part: the same 8 MiB the upload path uses, and above R2's 5 MiB minimum. */
export const MUSIC_DOWNLOAD_SLICE_BYTES = MUSIC_LIMITS.uploadPartBytes
/** A part list longer than this means the source is not the size it claimed. */
const MAX_DOWNLOAD_PARTS = 10_000
/** Matches the provider read's own header expectations; the CDN refuses requests without them. */
const UPSTREAM_USER_AGENT = 'Mozilla/5.0 (compatible; Inkstone/1.0; +https://github.com/shuaiplus/inkstone)'
const UPSTREAM_REFERER = 'https://music.163.com'
/** A URL this close to its expiry is replaced before the slice is requested. */
const URL_REFRESH_MARGIN_MS = 60 * 1000
/** A running row this old belongs to an isolate that died; the queue takes it back. */
const STALE_RUNNING_MS = 10 * 60 * 1000
/** Slice-to-slice pause: alarms are cheap and the next one should start as soon as the platform allows. */
const NEXT_SLICE_DELAY_MS = 100
/** A failed attempt waits long enough that a provider outage is not spent in three quick retries. */
const RETRY_DELAY_MS = 15_000
/** A parked cursor for a task deleted elsewhere is forgotten after the failed-task retention window. */
const CURSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000

const USER_ID_KEY = 'userId'
const ACTIVE_KEY = 'active'
const CURSORS_KEY = 'cursors'

/**
 * Where one task stands between slices. Everything here is JSON: the object stores it as is, and the
 * parts are the ones R2 will merge, so a resumed task never re-uploads a part it already paid for.
 */
export interface MusicDownloadCursor {
  downloadId: string
  trackId: string
  key: string
  uploadId: string
  parts: Array<{ partNumber: number; etag: string }>
  offset: number
  /** The full size when the provider or the first response stated it. */
  totalSize: number | null
  url: string
  expiresAt: number
  /** The container the bytes actually are, which is also what the R2 key and the track record. */
  format: MusicFormat
  quality: string
  updatedAt: number
}

export type MusicSliceOutcome = 'idle' | 'progress' | 'completed' | 'failed' | 'paused' | 'canceled'

export interface MusicSliceInput {
  env: Env
  userId: string
  provider: MusicProvider
  downloads: MusicDownloadStore
  musicStore: MusicStore
  /** The task to continue, or null to take the next queued one. */
  cursor: MusicDownloadCursor | null
  /** A task the caller asked to wake; used only when no cursor is being resumed. */
  preferredId?: string | null
}

export interface MusicSliceResult {
  outcome: MusicSliceOutcome
  /** The cursor to keep, or null when the task finished, failed or was released. */
  cursor: MusicDownloadCursor | null
  downloadId: string | null
  /** Why the slice stopped, for the log; the task row carries the reader-facing sentence. */
  message?: string
}

/** A failure the engine has already decided how to retry. */
class DownloadFailure extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message)
    this.name = 'DownloadFailure'
  }
}

/**
 * Run one slice of one task.
 *
 * Every path answers with the cursor the object should keep. A throw from this function is an
 * infrastructure failure the queue can only retry later: the task-level outcomes (failed, paused,
 * canceled) are values, because the object still has to park or drop the cursor for them.
 */
export async function runMusicDownloadSlice(input: MusicSliceInput): Promise<MusicSliceResult> {
  const { env, userId, provider, downloads, musicStore } = input
  const bucket = requireMusicBucket(env)
  let cursor = input.cursor

  if (cursor) {
    const continued = await continueCursor(downloads, bucket, cursor)
    if (continued) return continued
  } else {
    const row = await claimNext(downloads, input.preferredId ?? null)
    if (!row) return { outcome: 'idle', cursor: null, downloadId: null }
    try {
      const track = await musicStore.getTrack(row.trackId)
      if (!track) throw new DownloadFailure('The track is no longer in the library', false)
      cursor = await beginCursor(env, userId, provider, track, row)
    } catch (error) {
      const message = describeFailure(error, row.id)
      await downloads.failAttempt(row.id, message, isRetryable(error))
      return { outcome: 'failed', cursor: null, downloadId: row.id, message }
    }
  }

  const track = await musicStore.getTrack(cursor.trackId)
  if (!track) {
    await abortMultipart(bucket, cursor)
    const message = 'The track is no longer in the library'
    await downloads.failAttempt(cursor.downloadId, message, false)
    return { outcome: 'failed', cursor: null, downloadId: cursor.downloadId, message }
  }

  try {
    return await advanceSlice(env, downloads, musicStore, provider, track, cursor)
  } catch (error) {
    await abortMultipart(bucket, cursor)
    const message = describeFailure(error, cursor.downloadId)
    await downloads.failAttempt(cursor.downloadId, message, isRetryable(error))
    return { outcome: 'failed', cursor: null, downloadId: cursor.downloadId, message }
  }
}

/**
 * Decide whether a stored cursor may continue.
 *
 * A null answer means "go on"; an answer means the task stopped before this slice. A paused task
 * keeps its cursor (the multipart is still in R2), while a task that left `running` for any other
 * reason is released: the bytes would never be completed.
 */
async function continueCursor(
  downloads: MusicDownloadStore,
  bucket: R2Bucket,
  cursor: MusicDownloadCursor,
): Promise<MusicSliceResult | null> {
  const row = await downloads.get(cursor.downloadId)
  if (!row) {
    await abortMultipart(bucket, cursor)
    return { outcome: 'canceled', cursor: null, downloadId: cursor.downloadId }
  }
  if (row.status === 'paused') return { outcome: 'paused', cursor, downloadId: cursor.downloadId }
  if (row.status === 'queued') {
    if (await downloads.reopen(cursor.downloadId)) return null
    const latest = await downloads.get(cursor.downloadId)
    if (latest?.status === 'paused') return { outcome: 'paused', cursor, downloadId: cursor.downloadId }
    await abortMultipart(bucket, cursor)
    return { outcome: 'canceled', cursor: null, downloadId: cursor.downloadId }
  }
  if (row.status === 'running') return null
  await abortMultipart(bucket, cursor)
  return { outcome: 'canceled', cursor: null, downloadId: cursor.downloadId }
}

async function claimNext(downloads: MusicDownloadStore, preferredId: string | null): Promise<MusicDownload | null> {
  if (preferredId) {
    const preferred = await downloads.claimQueued(preferredId)
    if (preferred) return preferred
  }
  const [claimed] = await downloads.claimNextQueued(1)
  return claimed ?? null
}

/** Resolve the source, decide the container and open the multipart upload this task will fill. */
async function beginCursor(
  env: Env,
  userId: string,
  provider: MusicProvider,
  track: MusicTrack,
  download: MusicDownload,
): Promise<MusicDownloadCursor> {
  if (track.provider !== provider.id) {
    throw new DownloadFailure('This track has no downloadable source', false)
  }
  const source = await downloadSource(provider, track, download.quality)
  const format = resolveDownloadFormat(source.format, download.format)
  const key = musicObjectKeyFor({ format, userId, trackId: track.id, quality: download.quality })
  const bucket = requireMusicBucket(env)

  let multipart: R2MultipartUpload
  try {
    multipart = await bucket.createMultipartUpload(key, {
      httpMetadata: {
        contentType: MUSIC_MIME_BY_FORMAT[format],
        cacheControl: MUSIC_AUDIO_CACHE_CONTROL,
      },
      customMetadata: { userId, trackId: track.id, kind: 'track' },
    })
  } catch (error) {
    console.warn('[inkstone] Music download multipart could not be created:', error)
    throw new DownloadFailure('The music library could not start the download')
  }

  return {
    downloadId: download.id,
    trackId: track.id,
    key,
    uploadId: multipart.uploadId,
    parts: [],
    offset: 0,
    totalSize: source.size && source.size > 0 ? source.size : null,
    url: source.url,
    expiresAt: source.expiresAt,
    format,
    quality: download.quality,
    updatedAt: Date.now(),
  }
}

/**
 * The container the object is stored as.
 *
 * The provider's own answer wins: it names the bytes it served, and the R2 key, the MIME type and the
 * track row all have to agree with that. The reader's hint only fills in when the provider stays
 * silent, and with `auto` there is nothing honest left to name the file with.
 */
export function resolveDownloadFormat(sourceFormat: string, hint: string): MusicFormat {
  const reported = sourceFormat.trim().toLowerCase()
  if (isMusicFormat(reported)) return reported
  if (hint === 'mp3' || hint === 'flac' || hint === 'm4a') return hint
  throw new DownloadFailure('The music source did not report a file format', false)
}

async function advanceSlice(
  env: Env,
  downloads: MusicDownloadStore,
  musicStore: MusicStore,
  provider: MusicProvider,
  track: MusicTrack,
  cursor: MusicDownloadCursor,
): Promise<MusicSliceResult> {
  const bucket = requireMusicBucket(env)
  const requested = cursor.totalSize === null
    ? MUSIC_DOWNLOAD_SLICE_BYTES
    : Math.min(MUSIC_DOWNLOAD_SLICE_BYTES, cursor.totalSize - cursor.offset)
  if (requested <= 0) return await finishCursor(env, downloads, musicStore, cursor)

  const response = await requestSlice(provider, track, cursor, requested)

  if (response.status === 416) {
    await cancelBody(response)
    const range = parseContentRange(response.headers.get('content-range'))
    if (range.total !== null && cursor.offset >= range.total) {
      cursor.totalSize = range.total
      return await finishCursor(env, downloads, musicStore, cursor)
    }
    throw new DownloadFailure('The music source refused the requested byte range')
  }

  if (response.status === 200) {
    // The source ignored the Range header. The first slice can still be the whole file, read in
    // parts; after that the offsets it answered no longer match the task, so the download stops.
    return await consumeWholeBody(env, downloads, musicStore, cursor, response)
  }

  if (response.status !== 206) {
    await cancelBody(response)
    throw new DownloadFailure(`The music source answered ${response.status}`)
  }

  const range = parseContentRange(response.headers.get('content-range'))
  if (range.start !== null && range.start !== cursor.offset) {
    await cancelBody(response)
    throw new DownloadFailure('The music source answered a different byte range')
  }
  if (range.total !== null) cursor.totalSize = range.total
  if (!response.body) throw new DownloadFailure('The music source returned an empty response')

  const bytes = await readSliceBytes(response.body, requested)
  if (bytes.byteLength === 0) {
    if (cursor.parts.length === 0) throw new DownloadFailure('The music source returned no audio bytes')
    cursor.totalSize = cursor.offset
    return await finishCursor(env, downloads, musicStore, cursor)
  }

  await uploadPart(bucket, cursor, bytes)
  const reachedEnd = cursor.totalSize !== null
    ? cursor.offset >= cursor.totalSize
    : bytes.byteLength < requested
  if (cursor.totalSize === null && reachedEnd) cursor.totalSize = cursor.offset

  if (!(await saveProgress(downloads, cursor))) {
    return await stopAfterLoss(downloads, bucket, cursor)
  }
  if (reachedEnd) return await finishCursor(env, downloads, musicStore, cursor)
  return { outcome: 'progress', cursor, downloadId: cursor.downloadId }
}

/**
 * The whole-body fallback: a source that answers `200` to a Range request.
 *
 * The body is cut into part-sized slices and uploaded as they arrive, so the isolate never holds more
 * than one part. Progress is still checked between parts, which is where a pause or cancel lands.
 */
async function consumeWholeBody(
  env: Env,
  downloads: MusicDownloadStore,
  musicStore: MusicStore,
  cursor: MusicDownloadCursor,
  response: Response,
): Promise<MusicSliceResult> {
  if (cursor.offset !== 0 || cursor.parts.length > 0) {
    await cancelBody(response)
    throw new DownloadFailure('The music source stopped honoring byte ranges', false)
  }
  if (!response.body) throw new DownloadFailure('The music source returned an empty response')
  const bucket = requireMusicBucket(env)
  let alive = true
  await forEachBodySlice(response.body, MUSIC_DOWNLOAD_SLICE_BYTES, async (bytes) => {
    await uploadPart(bucket, cursor, bytes)
    alive = await saveProgress(downloads, cursor)
    return alive
  })
  if (!alive) return await stopAfterLoss(downloads, bucket, cursor)
  if (cursor.parts.length === 0) throw new DownloadFailure('The music source returned no audio bytes')

  cursor.totalSize = cursor.offset
  await saveProgress(downloads, cursor)
  return await finishCursor(env, downloads, musicStore, cursor)
}

/** Ask for one range, replacing an expiring URL and retrying once on the CDN's 403. */
async function requestSlice(
  provider: MusicProvider,
  track: MusicTrack,
  cursor: MusicDownloadCursor,
  requested: number,
): Promise<Response> {
  if (cursor.expiresAt - URL_REFRESH_MARGIN_MS <= Date.now()) {
    await refreshSource(provider, track, cursor)
  }
  const range = `bytes=${cursor.offset}-${cursor.offset + requested - 1}`
  let response = await fetchSlice(cursor.url, range)
  if (response.status !== 403) return response

  // The URL expired between the lookup and the fetch; the byte range is unchanged.
  await cancelBody(response)
  await refreshSource(provider, track, cursor)
  return await fetchSlice(cursor.url, range)
}

function fetchSlice(url: string, range: string): Promise<Response> {
  return fetchAllowedMusicUrl(url, {
    headers: {
      'Range': range,
      'Accept': '*/*',
      'User-Agent': UPSTREAM_USER_AGENT,
      'Referer': UPSTREAM_REFERER,
    },
  })
}

async function refreshSource(
  provider: MusicProvider,
  track: MusicTrack,
  cursor: MusicDownloadCursor,
): Promise<void> {
  const source = await downloadSource(provider, track, cursor.quality)
  cursor.url = source.url
  cursor.expiresAt = source.expiresAt
  if (cursor.totalSize === null && source.size && source.size > 0) cursor.totalSize = source.size
}

async function downloadSource(
  provider: MusicProvider,
  track: MusicTrack,
  quality: string,
): Promise<MusicStreamSource> {
  try {
    return await provider.downloadUrl(track.providerId, quality)
  } catch (error) {
    if (!(error instanceof MusicProviderError)) throw error
    if (error.code === 'auth_required' || error.status === 401) {
      throw new DownloadFailure('The connected music account needs to sign in again', false)
    }
    if (error.code === 'not_found' || error.status === 404) {
      throw new DownloadFailure('The provider has no download source for this track', false)
    }
    console.warn('[inkstone] Music provider could not resolve a download:', error.code, error.status)
    throw new DownloadFailure('The music provider could not provide this track')
  }
}

async function uploadPart(bucket: R2Bucket, cursor: MusicDownloadCursor, bytes: Uint8Array): Promise<void> {
  if (cursor.parts.length >= MAX_DOWNLOAD_PARTS) {
    throw new DownloadFailure('The music source returned a file that is too large', false)
  }
  const partNumber = cursor.parts.length + 1
  const uploaded = await bucket.resumeMultipartUpload(cursor.key, cursor.uploadId).uploadPart(partNumber, bytes)
  cursor.parts.push({ partNumber: uploaded.partNumber, etag: uploaded.etag })
  cursor.offset += bytes.byteLength
  cursor.updatedAt = Date.now()
}

function progressOf(cursor: MusicDownloadCursor): number {
  if (!cursor.totalSize || cursor.totalSize <= 0) return 0
  return Math.floor((cursor.offset * 100) / cursor.totalSize)
}

async function saveProgress(downloads: MusicDownloadStore, cursor: MusicDownloadCursor): Promise<boolean> {
  return await downloads.saveProgress(cursor.downloadId, {
    progress: progressOf(cursor),
    size: cursor.totalSize,
  })
}

/** The task stopped mid-slice: a pause keeps the cursor, anything else releases the multipart. */
async function stopAfterLoss(
  downloads: MusicDownloadStore,
  bucket: R2Bucket,
  cursor: MusicDownloadCursor,
): Promise<MusicSliceResult> {
  const row = await downloads.get(cursor.downloadId)
  if (row?.status === 'paused') return { outcome: 'paused', cursor, downloadId: cursor.downloadId }
  await abortMultipart(bucket, cursor)
  return { outcome: 'canceled', cursor: null, downloadId: cursor.downloadId }
}

/**
 * Merge the parts under the quota lease, then publish the three rows that make the bytes playable.
 *
 * The lease covers only the merge: the ledger row the quota counts is written right after it, and a
 * completion that loses the race against another upload is refused before any bytes are merged, so
 * the multipart is aborted rather than left to expire.
 */
async function finishCursor(
  env: Env,
  downloads: MusicDownloadStore,
  musicStore: MusicStore,
  cursor: MusicDownloadCursor,
): Promise<MusicSliceResult> {
  if (cursor.parts.length === 0) throw new DownloadFailure('The music source returned no audio bytes')
  const bucket = requireMusicBucket(env)
  const multipart = bucket.resumeMultipartUpload(cursor.key, cursor.uploadId)
  const parts = cursor.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag }))

  let completed: R2Object
  try {
    completed = await withMusicQuotaLease(
      env,
      musicStore,
      cursor.totalSize ?? cursor.offset,
      async () => await multipart.complete(parts),
    )
  } catch (error) {
    await abortMultipart(bucket, cursor)
    throw error
  }

  try {
    await downloads.complete(cursor.downloadId, {
      r2Key: cursor.key,
      size: completed.size,
      format: cursor.format,
      quality: cursor.quality,
      trackId: cursor.trackId,
    })
  } catch (error) {
    // The object exists but no row names it. Keep the bytes only when an older task or the track
    // already points at this key; otherwise the ledger would pay for an unreachable file.
    if (!(await musicStore.isObjectReferenced(cursor.key))) {
      await discardMusicObjects(env, musicStore, [cursor.key])
    }
    throw error
  }

  return { outcome: 'completed', cursor: null, downloadId: cursor.downloadId }
}

async function abortMultipart(bucket: R2Bucket, cursor: MusicDownloadCursor): Promise<void> {
  try {
    await bucket.resumeMultipartUpload(cursor.key, cursor.uploadId).abort()
  } catch (error) {
    // The session may already be gone; the task row already records why this attempt stopped.
    console.warn('[inkstone] Music download multipart could not be aborted:', error)
  }
}

/** Whether trying the same task again could plausibly answer differently. */
function isRetryable(error: unknown): boolean {
  if (error instanceof DownloadFailure) return error.retryable
  if (error instanceof ApiError) {
    if (error.code === 'music_quota_exceeded') return false
    if (error.code === 'music_provider_auth_required') return false
    return error.status === 409 || error.status === 429 || error.status === 502 || error.status === 503
  }
  return true
}

function describeFailure(error: unknown, downloadId: string): string {
  if (error instanceof DownloadFailure || error instanceof ApiError) return error.message
  console.warn(`[inkstone] Music download ${downloadId} stopped with an unexpected error:`, error)
  return 'The download could not be completed'
}

/** Read at most `limit` bytes and drop the rest of the body instead of buffering it. */
async function readSliceBytes(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        chunks.push(value)
        total += value.byteLength
      }
    }
  } finally {
    // A non-conforming range answer can carry the rest of the file; it is dropped, not buffered, and a
    // body that refuses to cancel is already being discarded with the response.
    // The slice reader is being abandoned; a failed cancel has no body left to observe, but the
    // low-level warning is what keeps this from being a silent swallow.
    await reader.cancel().catch((error) => {
      console.warn('[inkstone] Music download slice reader could not be cancelled:', error)
    })
  }
  const length = Math.min(total, limit)
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= length) break
    const take = Math.min(chunk.byteLength, length - offset)
    bytes.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return bytes
}

/**
 * Hand a whole response body to `sink` in part-sized slices, stopping when the sink says the task no
 * longer wants bytes. The last slice is whatever is left, which is the one R2 allows to be shorter.
 */
async function forEachBodySlice(
  body: ReadableStream<Uint8Array>,
  sliceBytes: number,
  sink: (bytes: Uint8Array) => Promise<boolean>,
): Promise<void> {
  const reader = body.getReader()
  let buffer = new Uint8Array(sliceBytes)
  let filled = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      let chunk = value ?? new Uint8Array()
      while (chunk.byteLength > 0) {
        const take = Math.min(chunk.byteLength, sliceBytes - filled)
        buffer.set(chunk.subarray(0, take), filled)
        filled += take
        chunk = chunk.subarray(take)
        if (filled === sliceBytes) {
          const keepGoing = await sink(buffer)
          buffer = new Uint8Array(sliceBytes)
          filled = 0
          if (!keepGoing) return
        }
      }
    }
    if (filled > 0 && !(await sink(buffer.subarray(0, filled)))) return
  } finally {
    // Stopping early leaves the upstream stream unread on purpose: the task was paused or canceled, and
    // the connection is worth more than the rest of a file nobody will store.
    // The slice reader is being abandoned; a failed cancel has no body left to observe, but the
    // low-level warning is what keeps this from being a silent swallow.
    await reader.cancel().catch((error) => {
      console.warn('[inkstone] Music download slice reader could not be cancelled:', error)
    })
  }
}

interface ParsedContentRange {
  start: number | null
  total: number | null
}

/** A `Content-Range` value: a start and a total, either of which an unsatisfied range leaves blank. */
function parseContentRange(value: string | null): ParsedContentRange {
  const match = /^bytes\s+(?:(\d+)-\d+|\*)\/(\d+|\*)$/i.exec((value ?? '').trim())
  if (!match) return { start: null, total: null }
  return {
    start: match[1] === undefined ? null : Number(match[1]),
    total: match[2] === undefined || match[2] === '*' ? null : Number(match[2]),
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is being discarded; a body that refuses to cancel is dropped with it.
  }
}

/** The provider a download reads through, built from this account's stored (encrypted) cookie. */
async function downloadProvider(env: Env, userId: string): Promise<MusicProvider> {
  const stored = await new MusicStore(env.DB, userId).getAccountCookie('netease')
  let cookie: string | undefined
  if (stored) {
    try {
      cookie = (await decryptMusicCookie(env, userId, stored)) ?? undefined
    } catch (error) {
      // Anonymous downloads are honest: public tracks still resolve, and a vault problem must not stop
      // a queue that the reader can see. The provider falls back to the same anonymous read path.
      console.warn('[inkstone] Music account cookie could not be decrypted; downloading anonymously:', error)
    }
  }
  return createNeteaseProvider({ cookie, upstreamBaseUrl: env.MUSIC_UPSTREAM_API })
}

function musicQueueNamespace(env: Env): DurableObjectNamespace | null {
  return env.MUSIC_QUEUE ?? null
}

/** A deployment without the queue cannot download, and says so instead of queueing a task forever. */
export function requireMusicQueue(env: Env): DurableObjectNamespace {
  const namespace = musicQueueNamespace(env)
  if (!namespace) {
    throw new ApiError(
      503,
      'music_storage_unavailable',
      'Music downloads require the MUSIC_QUEUE Durable Object binding.',
    )
  }
  return namespace
}

/**
 * Wake the account's queue. `downloadId` names the task a resume, retry or cancel is about; without
 * it the queue simply continues with whatever it was doing, or takes the next queued task.
 */
export async function kickMusicQueue(env: Env, userId: string, downloadId?: string): Promise<void> {
  const namespace = requireMusicQueue(env)
  let response: Response
  try {
    const stub = namespace.get(namespace.idFromName(userId))
    response = await stub.fetch('https://music-queue.internal/kick', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.DO_AUTH_KEY ? { 'X-Inkstone-Internal': env.DO_AUTH_KEY } : {}),
      },
      body: JSON.stringify({ action: 'kick', userId, ...(downloadId ? { downloadId } : {}) }),
    })
  } catch (error) {
    console.warn('[inkstone] Music queue could not be notified:', error)
    throw new ApiError(502, 'music_storage_unavailable', 'The download queue could not be notified')
  }
  if (!response.ok) {
    console.warn('[inkstone] Music queue refused a kick:', response.status)
    throw new ApiError(502, 'music_storage_unavailable', 'The download queue could not be notified')
  }
}

/**
 * The account's download queue. The object id is the account id, so one reader's slices are serial and
 * two readers cannot observe each other's queue; every row it touches is still scoped by `user_id`.
 */
export class MusicQueue implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const guard = evaluateInternalGuard(this.env, request)
    if (guard === 'denied') return new Response('Unauthorized', { status: 401 })
    if (guard === 'misconfigured') return new Response('DO_AUTH_KEY is set but empty', { status: 500 })

    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/kick') {
      return new Response('Unknown path', { status: 404 })
    }

    let body: { action?: unknown; userId?: unknown; downloadId?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      return new Response('Invalid kick body', { status: 400 })
    }
    if (body.action !== 'kick' || !isValidId(body.userId)) {
      return new Response('Invalid kick body', { status: 400 })
    }
    const userId = body.userId
    const known = await this.state.storage.get<string>(USER_ID_KEY)
    if (known && known !== userId) return new Response('Queue id mismatch', { status: 409 })

    await this.state.storage.put(USER_ID_KEY, userId)
    if (typeof body.downloadId === 'string' && isValidId(body.downloadId)) {
      await this.state.storage.put(ACTIVE_KEY, body.downloadId)
    }
    await this.ensureAlarm()
    return new Response(null, { status: 204 })
  }

  async alarm(): Promise<void> {
    const userId = await this.state.storage.get<string>(USER_ID_KEY)
    if (!userId || !isValidId(userId)) return

    const activeId = (await this.state.storage.get<string>(ACTIVE_KEY)) ?? null
    const cursors = (await this.state.storage.get<Record<string, MusicDownloadCursor>>(CURSORS_KEY)) ?? {}
    const cursor = activeId ? cursors[activeId] ?? null : null

    const downloads = new MusicDownloadStore(this.env.DB, userId)
    const musicStore = new MusicStore(this.env.DB, userId)
    let result: MusicSliceResult
    try {
      await downloads.requeueStale(STALE_RUNNING_MS)
      const provider = await downloadProvider(this.env, userId)
      result = await runMusicDownloadSlice({
        env: this.env,
        userId,
        provider,
        downloads,
        musicStore,
        cursor,
        preferredId: cursor ? null : activeId,
      })
    } catch (error) {
      // Nothing task-level reached a row: D1, R2 or the vault failed before the slice could decide.
      // The cursor is kept as it was, and the queue tries again after the retry delay.
      console.warn('[inkstone] Music download queue could not run a slice:', error)
      await this.state.storage.setAlarm(Date.now() + RETRY_DELAY_MS)
      return
    }

    await this.remember(result, cursors)
    const delay = nextSliceDelay(result.outcome)
    if (delay === null) return
    await this.state.storage.setAlarm(Date.now() + delay)
  }

  /** Keep or release the task's cursor, and point the next alarm at the task that just advanced. */
  private async remember(
    result: MusicSliceResult,
    cursors: Record<string, MusicDownloadCursor>,
  ): Promise<void> {
    if (result.downloadId) {
      if (result.cursor) {
        cursors[result.downloadId] = { ...result.cursor, updatedAt: Date.now() }
      } else {
        delete cursors[result.downloadId]
      }
      await this.state.storage.put(CURSORS_KEY, pruneCursors(cursors, Date.now()))
    }
    const active = result.outcome === 'progress' ? result.downloadId : null
    if (active) await this.state.storage.put(ACTIVE_KEY, active)
    else await this.state.storage.delete(ACTIVE_KEY)
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + NEXT_SLICE_DELAY_MS)
    }
  }
}

/** How soon the next alarm should run, or null when the queue has nothing left to do. */
function nextSliceDelay(outcome: MusicSliceOutcome): number | null {
  switch (outcome) {
    case 'idle':
      return null
    case 'failed':
      return RETRY_DELAY_MS
    case 'progress':
    case 'completed':
    case 'paused':
    case 'canceled':
      return NEXT_SLICE_DELAY_MS
  }
}

/** Parked cursors are only useful while their task can still be resumed; the rest are forgotten. */
function pruneCursors(
  cursors: Record<string, MusicDownloadCursor>,
  now: number,
): Record<string, MusicDownloadCursor> {
  const kept: Record<string, MusicDownloadCursor> = {}
  for (const [id, cursor] of Object.entries(cursors)) {
    if (now - cursor.updatedAt <= CURSOR_TTL_MS) kept[id] = cursor
  }
  return kept
}
