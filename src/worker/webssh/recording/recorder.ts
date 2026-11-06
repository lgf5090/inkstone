// The per-session recorder. It taps the terminal's raw output in the session Durable Object and
// writes an asciinema cast v2 file to R2 without ever interpreting the terminal bytes.
//
// Short recordings are held and written with one `put`; once the buffered cast crosses the R2
// multipart floor the recorder switches to parts, so a long session never accumulates the whole
// recording in memory. The D1 row is the authority: it is created before any object, marked
// `finalizing` before the upload completes, and only `ready` once the object is readable.

import type { WebsshCastHeader, WebsshRecordingStatus } from '@shared/webssh/types'
import { recordAudit } from '../audit'
import {
  WEBSSH_RECORDING_EVENT_CHARS,
  WEBSSH_RECORDING_PART_BYTES,
  WEBSSH_RECORDING_RETENTION_MS,
} from '../constants'
import { isValidId, newId } from '../../lib/id'
import {
  castOutputEvent,
  castResizeEvent,
  encodeCastEvent,
  encodeCastHeader,
  splitCastText,
} from './cast'

const CAST_CONTENT_TYPE = 'application/x-asciicast'

/** `webssh/txt/recordings/<user_id>/<yyyy>/<mm>/<session_id>.cast` (plan §5.4). */
export function recordingObjectKey(userId: string, sessionId: string, createdAt: number): string {
  if (!isValidId(userId) || !isValidId(sessionId)) throw new Error('invalid_webssh_recording_key')
  const date = new Date(createdAt)
  const year = String(date.getUTCFullYear())
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `webssh/txt/recordings/${userId}/${year}/${month}/${sessionId}.cast`
}

export interface StartRecorderInput {
  db: D1Database
  bucket: R2Bucket
  userId: string
  sessionId: string
  hostId: string
  cols: number
  rows: number
  term: string
  now?: number
  /** Only tests lower this; production uses the R2 multipart floor. */
  partBytes?: number
}

export class WebsshSessionRecorder {
  readonly recordingId: string
  readonly r2Key: string
  readonly startedAt: number

  private readonly db: D1Database
  private readonly bucket: R2Bucket
  private readonly userId: string
  private readonly sessionId: string
  private readonly hostId: string
  private readonly partBytes: number
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()

  private cols: number
  private rows: number
  private chunks: Uint8Array[] = []
  private bufferedBytes = 0
  private totalBytes = 0
  private upload: R2MultipartUpload | null = null
  private uploadedParts: R2UploadedPart[] = []
  private uploadQueue: Promise<void> = Promise.resolve()
  private uploadError: Error | null = null
  private finished = false
  private broken = false

  private constructor(input: StartRecorderInput, recordingId: string, r2Key: string, startedAt: number) {
    this.db = input.db
    this.bucket = input.bucket
    this.userId = input.userId
    this.sessionId = input.sessionId
    this.hostId = input.hostId
    this.cols = input.cols
    this.rows = input.rows
    this.partBytes = Math.max(1, input.partBytes ?? WEBSSH_RECORDING_PART_BYTES)
    this.recordingId = recordingId
    this.r2Key = r2Key
    this.startedAt = startedAt
    const header: WebsshCastHeader = {
      version: 2,
      width: input.cols,
      height: input.rows,
      timestamp: Math.floor(startedAt / 1000),
      env: { TERM: input.term },
    }
    this.appendLine(encodeCastHeader(header))
  }

  /**
   * Create the D1 row and point the session at it. A failed insert answers `null` so the caller
   * simply runs the session without a recording rather than failing the connection.
   */
  static async start(input: StartRecorderInput): Promise<WebsshSessionRecorder | null> {
    const now = input.now ?? Date.now()
    if (!isValidId(input.userId) || !isValidId(input.sessionId) || !isValidId(input.hostId)) return null
    const recordingId = newId()
    const r2Key = recordingObjectKey(input.userId, input.sessionId, now)
    const recorder = new WebsshSessionRecorder(input, recordingId, r2Key, now)
    try {
      await input.db
        .prepare(
          `INSERT INTO webssh_recordings
             (id, user_id, session_id, host_id, format, r2_key, size_bytes, duration_ms, cols, rows,
              status, visibility, created_at, finalized_at, expires_at, deleted_at)
           VALUES (?1, ?2, ?3, ?4, 'cast', ?5, 0, 0, ?6, ?7, 'recording', 'private', ?8, NULL, ?9, NULL)`,
        )
        .bind(
          recordingId,
          input.userId,
          input.sessionId,
          input.hostId,
          r2Key,
          input.cols,
          input.rows,
          now,
          now + WEBSSH_RECORDING_RETENTION_MS,
        )
        .run()
    } catch (error) {
      console.warn('[inkstone] WebSSH recording start failed:', (error as Error).message)
      return null
    }
    await input.db
      .prepare(`UPDATE webssh_sessions SET recording_id = ?3 WHERE id = ?1 AND user_id = ?2`)
      .bind(input.sessionId, input.userId, recordingId)
      .run()
      .catch((error) => console.warn('[inkstone] WebSSH recording link failed:', (error as Error).message))
    await recordAudit(input.db, {
      userId: input.userId,
      sessionId: input.sessionId,
      hostId: input.hostId,
      eventType: 'recording_start',
      metadata: { recordingId, cols: input.cols, rows: input.rows },
      now,
    }).catch((error) => console.warn('[inkstone] WebSSH recording audit failed:', (error as Error).message))
    return recorder
  }

  /** Raw SSH output, recorded as decoded text with a streaming decoder. */
  tapOutput(data: Uint8Array): void {
    if (this.finished || this.broken) return
    try {
      this.appendOutput(this.decoder.decode(data, { stream: true }))
    } catch (error) {
      this.broken = true
      console.warn('[inkstone] WebSSH recording tap failed:', (error as Error).message)
    }
  }

  resize(cols: number, rows: number): void {
    if (this.finished || this.broken) return
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    try {
      this.appendLine(encodeCastEvent(castResizeEvent(this.startedAt, Date.now(), cols, rows)))
    } catch {
      this.broken = true
    }
  }

  /**
   * Close the object and finish the D1 row. Called once from the session's idempotent `finalize`;
   * a second call is a no-op. Upload failures leave `failed`, and retention later removes both the
   * row and any partial object.
   */
  async finish(now = Date.now()): Promise<void> {
    if (this.finished) return
    this.finished = true
    const durationMs = Math.max(0, now - this.startedAt)
    try {
      this.appendOutput(this.decoder.decode())
    } catch {
      // An incomplete trailing multi-byte sequence is not replayable text; the session's own
      // output decoder drops the same tail.
    }
    await this.markStatus('finalizing')
    try {
      await this.uploadQueue
      if (this.uploadError) throw this.uploadError
      if (this.upload) {
        if (this.chunks.length > 0) {
          const bytes = this.takeChunks()
          const part = await this.upload.uploadPart(this.uploadedParts.length + 1, bytes)
          this.uploadedParts.push(part)
        }
        await this.upload.complete(this.uploadedParts)
        this.upload = null
      } else {
        await this.bucket.put(this.r2Key, this.takeChunks(), {
          httpMetadata: { contentType: CAST_CONTENT_TYPE },
        })
      }
      await this.db
        .prepare(
          `UPDATE webssh_recordings
              SET status = 'ready', size_bytes = ?3, duration_ms = ?4, cols = ?5, rows = ?6, finalized_at = ?7
            WHERE id = ?1 AND user_id = ?2`,
        )
        .bind(this.recordingId, this.userId, this.totalBytes, durationMs, this.cols, this.rows, now)
        .run()
      await recordAudit(this.db, {
        userId: this.userId,
        sessionId: this.sessionId,
        hostId: this.hostId,
        eventType: 'recording_finalize',
        metadata: { recordingId: this.recordingId, bytes: this.totalBytes, durationMs },
        now,
      }).catch(() => undefined)
    } catch (error) {
      await this.fail(error, durationMs, now)
    }
  }

  private appendOutput(text: string): void {
    if (!text) return
    for (const piece of splitCastText(text, WEBSSH_RECORDING_EVENT_CHARS)) {
      this.appendLine(encodeCastEvent(castOutputEvent(this.startedAt, Date.now(), piece)))
    }
  }

  private appendLine(line: string): void {
    const bytes = this.encoder.encode(line)
    this.chunks.push(bytes)
    this.bufferedBytes += bytes.byteLength
    this.totalBytes += bytes.byteLength
    if (this.bufferedBytes >= this.partBytes) this.scheduleFlush()
  }

  private scheduleFlush(): void {
    this.uploadQueue = this.uploadQueue
      .then(async () => {
        if (this.uploadError) return
        if (this.chunks.length === 0) return
        if (!this.upload) {
          this.upload = await this.bucket.createMultipartUpload(this.r2Key, {
            httpMetadata: { contentType: CAST_CONTENT_TYPE },
          })
        }
        const bytes = this.takeChunks()
        const part = await this.upload.uploadPart(this.uploadedParts.length + 1, bytes)
        this.uploadedParts.push(part)
      })
      .catch((error: unknown) => {
        this.uploadError = error instanceof Error ? error : new Error(String(error))
      })
  }

  private takeChunks(): Uint8Array {
    const pending = this.chunks
    this.chunks = []
    this.bufferedBytes = 0
    let size = 0
    for (const chunk of pending) size += chunk.byteLength
    const joined = new Uint8Array(size)
    let offset = 0
    for (const chunk of pending) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return joined
  }

  private async markStatus(status: WebsshRecordingStatus): Promise<void> {
    await this.db
      .prepare(
        `UPDATE webssh_recordings SET status = ?3
          WHERE id = ?1 AND user_id = ?2 AND status != 'deleted'`,
      )
      .bind(this.recordingId, this.userId, status)
      .run()
      .catch((error) => console.warn('[inkstone] WebSSH recording status failed:', (error as Error).message))
  }

  private async fail(error: unknown, durationMs: number, now: number): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    try {
      await this.upload?.abort()
    } catch {
      // Nothing to abort when the upload never left the single-put path.
    }
    this.upload = null
    await this.markStatus('failed')
    await this.db
      .prepare(
        `UPDATE webssh_recordings SET finalized_at = ?3, duration_ms = ?4
          WHERE id = ?1 AND user_id = ?2 AND status != 'deleted'`,
      )
      .bind(this.recordingId, this.userId, now, durationMs)
      .run()
      .catch(() => undefined)
    await recordAudit(this.db, {
      userId: this.userId,
      sessionId: this.sessionId,
      hostId: this.hostId,
      eventType: 'recording_fail',
      metadata: { recordingId: this.recordingId, message: message.slice(0, 200) },
      now,
    }).catch(() => undefined)
    console.warn('[inkstone] WebSSH recording finalize failed:', message)
  }
}
