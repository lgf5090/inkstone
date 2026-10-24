/**
 * Chunked uploads into the music library.
 *
 * A 300 MB file cannot cross a Worker request in one body, so the browser sends 8 MiB parts into an
 * R2 multipart upload. This module owns the task row that survives between those requests: the R2
 * upload id, the parts already accepted, and the metadata the browser reported. It is also the only
 * place that finishes a task, which is where the object becomes a `music_track` plus its ledger row.
 *
 * Completion is the trust boundary. The declared extension chose the multipart key at init, but the
 * bytes decide the recorded format: the first four kilobytes are sniffed from R2, and a container
 * that does not match its declared family aborts the whole upload. If any write after the multipart
 * merge fails, the object is deleted (or queued for the cleanup sweep) so no unreachable bytes are
 * paid for.
 */
import {
  MUSIC_LIMITS,
  MUSIC_MIME_BY_FORMAT,
  isMusicFormat,
  type MusicFormat,
} from '@shared/music/constants'
import type { MusicUploadPartResult, MusicUploadInit } from '@shared/music/api'
import type { MusicTrack, MusicUpload, MusicUploadStatus } from '@shared/music/model'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { truncateText } from '@shared/text-utils'
import {
  declaredUploadFormat,
  formatCompatibleWithContainer,
  inspectMusicCover,
  MUSIC_MAGIC_HEADER_BYTES,
  parseStoredUploadMetadata,
  sanitizeMusicFilename,
  sanitizeUploadMetadata,
  sniffMusicFormat,
  titleFromFilename,
  type MusicUploadMetadata,
} from './metadata'
import {
  MUSIC_AUDIO_CACHE_CONTROL,
  MUSIC_COVER_CACHE_CONTROL,
  assertMusicQuota,
  discardMusicObjects,
  headMusicObject,
  musicCoverKeyFor,
  musicObjectKeyFor,
  putMusicObject,
  readMusicObjectRange,
  requireMusicBucket,
  withMusicQuotaLease,
  type MusicObjectStream,
} from './storage'
import { MusicStore } from './store'

const MAX_UPLOAD_PARTS = 10_000
const MAX_STORED_ERROR_CHARS = 300
const UPLOAD_LIST_LIMIT = 100

const UPLOAD_COLUMNS = `user_id, id, filename, mime, size, format, status, r2_key, track_id,
  cover_key, metadata_json, upload_id, parts_json, error, created_at, updated_at`

interface UploadRow {
  user_id: string
  id: string
  filename: string
  mime: string
  size: number
  format: string
  status: string
  r2_key: string | null
  track_id: string | null
  cover_key: string | null
  metadata_json: string
  upload_id: string | null
  parts_json: string
  error: string
  created_at: number
  updated_at: number
}

export interface MusicUploadPart {
  partNumber: number
  etag: string
  size: number
}

export interface MusicUploadSnapshot {
  upload: MusicUpload
  r2UploadId: string | null
  metadata: MusicUploadMetadata
  parts: MusicUploadPart[]
}

export interface MusicUploadInitInput {
  filename: unknown
  mime: unknown
  size: unknown
  format: unknown
  metadata: unknown
}

export interface MusicUploadCompletion {
  track: MusicTrack
  upload: MusicUpload
}

/** How many parts a declared size needs at the server's part size. */
export function musicPartCount(size: number): number {
  if (!Number.isSafeInteger(size) || size <= 0) return 0
  return Math.ceil(size / MUSIC_LIMITS.uploadPartBytes)
}

/** The exact byte length part `partNumber` must carry; `null` when the number is outside the file. */
export function musicPartLength(size: number, partNumber: number): number | null {
  const count = musicPartCount(size)
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > count) return null
  const start = (partNumber - 1) * MUSIC_LIMITS.uploadPartBytes
  return Math.min(MUSIC_LIMITS.uploadPartBytes, size - start)
}

/** The upload task row, scoped to the account that owns it. */
export class MusicUploadStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  async get(id: string): Promise<MusicUploadSnapshot | null> {
    const row = await this.db.prepare(
      `SELECT ${UPLOAD_COLUMNS} FROM music_upload WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).first<UploadRow>()
    if (!row) return null
    return {
      upload: toUpload(row),
      r2UploadId: row.upload_id || null,
      metadata: parseStoredUploadMetadata(row.metadata_json, titleFromFilename(row.filename)),
      parts: parseParts(row.parts_json),
    }
  }

  async list(limit = UPLOAD_LIST_LIMIT): Promise<MusicUpload[]> {
    const capped = Math.max(1, Math.min(UPLOAD_LIST_LIMIT, Math.trunc(limit)))
    const { results } = await this.db.prepare(
      `SELECT ${UPLOAD_COLUMNS} FROM music_upload
        WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2`,
    ).bind(this.userId, capped).all<UploadRow>()
    return results.map(toUpload)
  }

  async insert(input: {
    id: string
    filename: string
    mime: string
    size: number
    format: MusicFormat
    r2Key: string
    r2UploadId: string
    metadata: MusicUploadMetadata
  }): Promise<void> {
    const now = Date.now()
    await this.db.prepare(
      `INSERT INTO music_upload
         (user_id, id, filename, mime, size, format, status, r2_key, upload_id,
          metadata_json, parts_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'uploading', ?7, ?8, ?9, '[]', ?10, ?10)`,
    ).bind(
      this.userId,
      input.id,
      input.filename,
      input.mime,
      input.size,
      input.format,
      input.r2Key,
      input.r2UploadId,
      JSON.stringify(input.metadata),
      now,
    ).run()
  }

  /** Replace the whole part list; false means the task stopped accepting parts meanwhile. */
  async setParts(id: string, parts: readonly MusicUploadPart[]): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE music_upload SET parts_json = ?3, updated_at = ?4
        WHERE user_id = ?1 AND id = ?2 AND status = 'uploading'`,
    ).bind(this.userId, id, JSON.stringify(parts), Date.now()).run()
    return (result.meta.changes ?? 0) > 0
  }

  async setCoverKey(id: string, coverKey: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE music_upload SET cover_key = ?3, updated_at = ?4
        WHERE user_id = ?1 AND id = ?2 AND status = 'uploading'`,
    ).bind(this.userId, id, coverKey, Date.now()).run()
    return (result.meta.changes ?? 0) > 0
  }

  async clearCover(id: string): Promise<void> {
    await this.db.prepare(
      `UPDATE music_upload SET cover_key = NULL, updated_at = ?3
        WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id, Date.now()).run()
  }

  async markCompleted(
    id: string,
    input: { trackId: string; format: MusicFormat; size: number },
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE music_upload SET status = 'completed', track_id = ?3, format = ?4, size = ?5,
         error = '', updated_at = ?6
        WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id, input.trackId, input.format, input.size, Date.now()).run()
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.prepare(
      `UPDATE music_upload SET status = 'failed', error = ?3, updated_at = ?4
        WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id, truncateText(error, MAX_STORED_ERROR_CHARS), Date.now()).run()
  }

  async markAborted(id: string): Promise<void> {
    await this.db.prepare(
      `UPDATE music_upload SET status = 'aborted', cover_key = NULL, error = '', updated_at = ?3
        WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id, Date.now()).run()
  }
}

/** Create the R2 multipart upload and the task row that lets later requests resume it. */
export async function startMusicUpload(
  env: Env,
  userId: string,
  input: MusicUploadInitInput,
): Promise<MusicUploadInit> {
  const bucket = requireMusicBucket(env)
  const rawName = typeof input.filename === 'string' ? input.filename.trim() : ''
  if (!rawName) throw invalidUpload('A filename is required')
  const filename = sanitizeMusicFilename(rawName)
  const format = declaredUploadFormat(filename, input.format)
  if (!format) {
    throw new ApiError(
      415,
      'music_upload_invalid',
      'The file type is not a supported audio or video format',
    )
  }
  if (!Number.isSafeInteger(input.size) || (input.size as number) <= 0) {
    throw invalidUpload('The upload size is invalid')
  }
  const size = input.size as number
  if (size > MUSIC_LIMITS.uploadMaxBytes) {
    throw ApiError.tooLarge(`The file exceeds the ${MUSIC_LIMITS.uploadMaxBytes / (1024 * 1024)} MB limit`)
  }

  const musicStore = new MusicStore(env.DB, userId)
  const uploads = new MusicUploadStore(env.DB, userId)
  const metadata = sanitizeUploadMetadata(input.metadata, titleFromFilename(filename))

  await assertMusicQuota(env, musicStore, size)

  const id = newId()
  const r2Key = musicObjectKeyFor({ format, userId, trackId: id, quality: 'original' })
  let multipart: R2MultipartUpload
  try {
    multipart = await bucket.createMultipartUpload(r2Key, {
      httpMetadata: {
        contentType: MUSIC_MIME_BY_FORMAT[format],
        cacheControl: MUSIC_AUDIO_CACHE_CONTROL,
      },
      customMetadata: { userId, trackId: id, kind: 'track' },
    })
  } catch (error) {
    console.warn('[inkstone] Music multipart upload could not be created:', error)
    throw new ApiError(502, 'music_storage_unavailable', 'The upload could not be started')
  }

  try {
    await uploads.insert({
      id,
      filename,
      mime: MUSIC_MIME_BY_FORMAT[format],
      size,
      format,
      r2Key,
      r2UploadId: multipart.uploadId,
      metadata,
    })
  } catch (error) {
    await abortMultipart(env, r2Key, multipart.uploadId)
    throw error
  }

  return { uploadId: id, partSize: MUSIC_LIMITS.uploadPartBytes, uploadedParts: [] }
}

/** Store one part after checking it is the exact length the declared file size implies. */
export async function uploadMusicPart(
  env: Env,
  userId: string,
  id: string,
  partNumber: number,
  bytes: Uint8Array,
): Promise<MusicUploadPartResult> {
  const bucket = requireMusicBucket(env)
  const uploads = new MusicUploadStore(env.DB, userId)
  const snapshot = await uploads.get(id)
  if (!snapshot) throw uploadNotFound()
  if (snapshot.upload.status !== 'uploading') throw uploadClosed()
  const r2Key = snapshot.upload.r2Key
  const r2UploadId = snapshot.r2UploadId
  if (!r2Key || !r2UploadId) throw uploadClosed()

  const expected = musicPartLength(snapshot.upload.size, partNumber)
  if (expected === null) throw invalidUpload(`Part ${partNumber} is outside this upload`)
  if (bytes.byteLength !== expected) {
    throw invalidUpload(`Part ${partNumber} must be exactly ${expected} bytes`)
  }

  let uploaded: R2UploadedPart
  try {
    uploaded = await bucket.resumeMultipartUpload(r2Key, r2UploadId).uploadPart(partNumber, bytes)
  } catch (error) {
    console.warn('[inkstone] Music upload part could not be stored:', error)
    throw new ApiError(502, 'music_storage_unavailable', 'The upload part could not be stored')
  }

  const parts = upsertPart(snapshot.parts, {
    partNumber: uploaded.partNumber,
    etag: uploaded.etag,
    size: bytes.byteLength,
  })
  if (!(await uploads.setParts(id, parts))) throw uploadClosed()
  return { partNumber: uploaded.partNumber, etag: uploaded.etag }
}

/** Store the extracted cover under its own immutable key and remember it on the task row. */
export async function storeMusicCover(
  env: Env,
  userId: string,
  id: string,
  bytes: Uint8Array,
  reportedMime: string,
): Promise<{ key: string }> {
  const musicStore = new MusicStore(env.DB, userId)
  const uploads = new MusicUploadStore(env.DB, userId)
  const snapshot = await uploads.get(id)
  if (!snapshot) throw uploadNotFound()
  if (snapshot.upload.status !== 'uploading') throw uploadClosed()
  if (bytes.byteLength === 0) throw invalidUpload('The cover is empty')
  if (bytes.byteLength > MUSIC_LIMITS.coverMaxBytes) {
    throw ApiError.tooLarge(`The cover exceeds the ${MUSIC_LIMITS.coverMaxBytes / (1024 * 1024)} MB limit`)
  }

  const cover = inspectMusicCover(bytes, reportedMime)
  const key = musicCoverKeyFor({ userId, trackId: id, extension: cover.extension })
  await putMusicObject(env, key, bytes, {
    contentType: cover.mime,
    cacheControl: MUSIC_COVER_CACHE_CONTROL,
    userId,
    trackId: id,
    kind: 'cover',
  })

  if (!(await uploads.setCoverKey(id, key))) {
    await discardMusicObjects(env, musicStore, [key])
    throw uploadClosed()
  }
  const previous = snapshot.upload.coverKey
  if (previous && previous !== key) await discardMusicObjects(env, musicStore, [previous])
  return { key }
}

/**
 * Merge the parts, verify the bytes, then publish the track and its ledger row.
 *
 * The quota lease is taken before the merge and held until the ledger row exists. If anything after
 * the merge fails, the object is discarded and the task is marked failed; a failed task is not
 * resumable because its multipart session is gone.
 */
export async function completeMusicUpload(
  env: Env,
  userId: string,
  id: string,
): Promise<MusicUploadCompletion> {
  const musicStore = new MusicStore(env.DB, userId)
  const uploads = new MusicUploadStore(env.DB, userId)
  const snapshot = await uploads.get(id)
  if (!snapshot) throw uploadNotFound()

  if (snapshot.upload.status === 'completed') {
    const track = snapshot.upload.trackId ? await musicStore.getTrack(snapshot.upload.trackId) : null
    if (track && snapshot.upload.r2Key) return { track, upload: snapshot.upload }
    throw uploadClosed()
  }
  if (snapshot.upload.status !== 'uploading') throw uploadClosed()

  const r2Key = snapshot.upload.r2Key
  const r2UploadId = snapshot.r2UploadId
  if (!r2Key || !r2UploadId) throw uploadClosed()

  const expectedParts = musicPartCount(snapshot.upload.size)
  const parts = [...snapshot.parts].sort((left, right) => left.partNumber - right.partNumber)
  if (parts.length !== expectedParts || parts.some((part, index) => part.partNumber !== index + 1)) {
    throw invalidUpload('The upload is missing one or more parts')
  }

  return withMusicQuotaLease(env, musicStore, snapshot.upload.size, async () => {
    const bucket = requireMusicBucket(env)
    try {
      await bucket.resumeMultipartUpload(r2Key, r2UploadId).complete(
        parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
      )
    } catch (error) {
      console.warn('[inkstone] Music multipart upload could not be completed:', error)
      await abortMultipart(env, r2Key, r2UploadId)
      await uploads.markFailed(id, 'The upload could not be completed')
      throw new ApiError(502, 'music_storage_unavailable', 'The upload could not be completed')
    }

    let track: MusicTrack | null = null
    try {
      const head = await headMusicObject(env, r2Key)
      if (!head) throw invalidUpload('The completed object is missing')
      if (head.size !== snapshot.upload.size) {
        throw invalidUpload('The uploaded size does not match the declared size')
      }

      const declared = isMusicFormat(snapshot.upload.format) ? snapshot.upload.format : null
      if (!declared) throw invalidUpload('The upload format is unknown')
      const header = await readHeaderBytes(env, r2Key, Math.min(MUSIC_MAGIC_HEADER_BYTES, head.size))
      const format = sniffMusicFormat(header, declared)
      if (!format) {
        throw new ApiError(415, 'music_upload_invalid', 'The file is not a supported audio or video container')
      }
      if (!formatCompatibleWithContainer(declared, format)) {
        throw new ApiError(415, 'music_upload_invalid', 'The file content does not match its extension')
      }

      track = await musicStore.upsertTrack({
        id: snapshot.upload.id,
        provider: 'upload',
        providerId: snapshot.upload.id,
        kind: 'song',
        title: snapshot.metadata.title,
        artists: snapshot.metadata.artists.map((name) => ({ id: '', name })),
        album: snapshot.metadata.album,
        durationMs: snapshot.metadata.durationMs,
        format,
        bitrate: snapshot.metadata.bitrate,
        size: head.size,
        r2Key,
        coverKey: snapshot.upload.coverKey ?? undefined,
        source: 'upload',
        sourceQuality: 'original',
      })
      await musicStore.registerObject({
        r2Key,
        trackId: track.id,
        format,
        quality: 'original',
        size: head.size,
      })
      await uploads.markCompleted(id, { trackId: track.id, format, size: head.size })

      const saved = await uploads.get(id)
      if (!saved) throw new Error('music_upload_completion_not_saved')
      return { track, upload: saved.upload }
    } catch (error) {
      await discardMusicObjects(env, musicStore, [r2Key])
      if (track) {
        await musicStore.deleteTrack(track.id).catch((cleanupError) => {
          console.warn('[inkstone] A failed music upload left its track row to be cleaned up:', cleanupError)
        })
      }
      if (snapshot.upload.coverKey) {
        await uploads.clearCover(id)
        await discardMusicObjects(env, musicStore, [snapshot.upload.coverKey])
      }
      await uploads.markFailed(id, failureMessage(error))
      if (error instanceof ApiError) throw error
      console.warn('[inkstone] Music upload completion failed:', error)
      throw new ApiError(500, 'internal', 'The upload could not be completed')
    }
  })
}

/** Abort the multipart session and release the cover. Repeating the call is harmless. */
export async function abortMusicUpload(env: Env, userId: string, id: string): Promise<void> {
  const musicStore = new MusicStore(env.DB, userId)
  const uploads = new MusicUploadStore(env.DB, userId)
  const snapshot = await uploads.get(id)
  if (!snapshot) throw uploadNotFound()
  if (snapshot.upload.status === 'completed') throw uploadClosed()
  if (snapshot.upload.status === 'aborted') return

  if (snapshot.upload.r2Key && snapshot.r2UploadId) {
    await abortMultipart(env, snapshot.upload.r2Key, snapshot.r2UploadId)
  }
  if (snapshot.upload.coverKey) await discardMusicObjects(env, musicStore, [snapshot.upload.coverKey])
  await uploads.markAborted(id)
}

export async function readMusicUpload(
  env: Env,
  userId: string,
  id: string,
): Promise<MusicUploadSnapshot | null> {
  return new MusicUploadStore(env.DB, userId).get(id)
}

export async function listMusicUploads(env: Env, userId: string): Promise<MusicUpload[]> {
  return new MusicUploadStore(env.DB, userId).list()
}

async function readHeaderBytes(env: Env, key: string, length: number): Promise<Uint8Array> {
  const object: MusicObjectStream | null = await readMusicObjectRange(env, key, 0, length)
  if (!object) return new Uint8Array()
  return new Uint8Array(await new Response(object.body as BodyInit).arrayBuffer())
}

async function abortMultipart(env: Env, key: string, uploadId: string): Promise<void> {
  try {
    await requireMusicBucket(env).resumeMultipartUpload(key, uploadId).abort()
  } catch (error) {
    // The multipart session may already have expired; the task row still records the failure.
    console.warn('[inkstone] Music multipart upload could not be aborted:', error)
  }
}

function upsertPart(parts: readonly MusicUploadPart[], next: MusicUploadPart): MusicUploadPart[] {
  const updated = parts.filter((part) => part.partNumber !== next.partNumber)
  updated.push(next)
  return updated.sort((left, right) => left.partNumber - right.partNumber)
}

function parseParts(raw: string): MusicUploadPart[] {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    console.warn('[inkstone] Music upload parts are not valid JSON:', error)
    return []
  }
  if (!Array.isArray(value)) return []
  const parts: MusicUploadPart[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { partNumber?: unknown; etag?: unknown; size?: unknown }
    if (!Number.isSafeInteger(record.partNumber)) continue
    const partNumber = record.partNumber as number
    if (partNumber < 1 || partNumber > MAX_UPLOAD_PARTS) continue
    if (typeof record.etag !== 'string' || !record.etag) continue
    if (!Number.isSafeInteger(record.size) || (record.size as number) < 0) continue
    parts.push({ partNumber, etag: record.etag, size: record.size as number })
  }
  return parts.sort((left, right) => left.partNumber - right.partNumber)
}

function toUpload(row: UploadRow): MusicUpload {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    format: row.format,
    status: row.status as MusicUploadStatus,
    r2Key: row.r2_key,
    trackId: row.track_id,
    coverKey: row.cover_key,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function failureMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The upload could not be completed'
}

function invalidUpload(message: string): ApiError {
  return new ApiError(400, 'music_upload_invalid', message)
}

function uploadNotFound(): ApiError {
  return ApiError.notFound('Upload not found')
}

function uploadClosed(): ApiError {
  return new ApiError(409, 'music_upload_invalid', 'The upload is no longer accepting changes')
}
