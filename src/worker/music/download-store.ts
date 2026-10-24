/**
 * Download tasks for the music library.
 *
 * A task is a request, not an object: the row records the quality and the container hint the reader
 * asked for, plus how far the queue has come. Every query carries this account's `user_id`, so a
 * guessed id answers `null` instead of leaking another reader's queue, and the unique key
 * `(user_id, track_id, quality, format)` is what makes enqueueing the same request twice answer with
 * the task that already exists.
 *
 * Pause, resume, retry and cancel are status transitions rather than a second intent column. The queue
 * reads the status before every slice, so a paused task stops at the next boundary and a canceled one
 * releases its multipart upload. `done` is terminal except for deletion; deleting a task releases the
 * R2 key only when no track or other task still names it, which is the same rule `MusicStore` applies
 * to a deleted track.
 */
import {
  MUSIC_QUALITIES,
  type MusicDownload,
  type MusicDownloadStatus,
  type MusicQuality,
  type MusicTrack,
} from '@shared/music/model'
import { newId } from '../lib/id'
import { ApiError } from '../lib/errors'
import { MusicStore } from './store'

/** The list route never returns more than one page of tasks, newest first. */
export const MUSIC_DOWNLOAD_LIST_LIMIT = 100
/** Three attempts is the same budget a provider read gets before the reader has to ask again. */
export const MUSIC_DOWNLOAD_MAX_ATTEMPTS = 3
/** The container hints the settings screen offers; `auto` lets the provider's answer decide. */
export const MUSIC_DOWNLOAD_FORMAT_HINTS = ['auto', 'mp3', 'flac', 'm4a'] as const
export type MusicDownloadFormatHint = (typeof MUSIC_DOWNLOAD_FORMAT_HINTS)[number]
/** The queue runs this many tasks at once; the settings screen offers 1-5 and v1 honors one. */
export const MUSIC_DOWNLOAD_CONCURRENCY_MAX = 5

const MAX_STORED_ERROR_CHARS = 300

const DOWNLOAD_COLUMNS = `user_id, id, track_id, quality, format, status, progress, size, r2_key,
  error, attempts, created_at, updated_at, completed_at`

interface DownloadRow {
  user_id: string
  id: string
  track_id: string
  quality: string
  format: string
  status: string
  progress: number
  size: number | null
  r2_key: string | null
  error: string
  attempts: number
  created_at: number
  updated_at: number
  completed_at: number | null
}

export interface MusicDownloadWithTrack extends MusicDownload {
  track: MusicTrack | null
}

export interface MusicDownloadTransition {
  /** `null` when this account has no such task. */
  download: MusicDownload | null
  /** False when the task exists but its current status does not allow the action. */
  changed: boolean
}

export interface MusicDownloadEnqueue {
  download: MusicDownload
  /** False when an identical request was already queued, which is not an error. */
  created: boolean
}

export interface MusicDownloadCompletion {
  r2Key: string
  size: number
  format: string
  quality: string
  trackId: string
}

/**
 * The quality ladder a download may ask for. `original` belongs to uploads: a provider stream is
 * always one of the levels the upstream offers, and a task that claimed `original` could never be
 * matched against one.
 */
export function normalizeDownloadQuality(value: unknown): MusicQuality {
  if (typeof value === 'string' && value !== 'original' &&
    (MUSIC_QUALITIES as readonly string[]).includes(value)) {
    return value as MusicQuality
  }
  throw ApiError.badRequest('The download quality is not supported')
}

export function normalizeDownloadFormat(value: unknown): MusicDownloadFormatHint {
  if (typeof value === 'string' && (MUSIC_DOWNLOAD_FORMAT_HINTS as readonly string[]).includes(value)) {
    return value as MusicDownloadFormatHint
  }
  throw ApiError.badRequest('The download format is not supported')
}

/** One account's download queue. */
export class MusicDownloadStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /**
   * Queue one request. The insert is idempotent on the unique key, so a repeated request answers with
   * the row that already exists rather than a second task for the same bytes.
   */
  async enqueue(input: {
    trackId: string
    quality: MusicQuality
    format: MusicDownloadFormatHint
  }): Promise<MusicDownloadEnqueue> {
    const now = Date.now()
    const inserted = await this.db.prepare(
      `INSERT INTO music_download
         (user_id, id, track_id, quality, format, status, progress, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'queued', 0, ?6, ?6)
       ON CONFLICT(user_id, track_id, quality, format) DO NOTHING`,
    ).bind(this.userId, newId(), input.trackId, input.quality, input.format, now).run()

    const row = await this.rowByRequest(input.trackId, input.quality, input.format)
    if (!row) throw new Error('music_download_enqueue_failed')
    return { download: toDownload(row), created: (inserted.meta.changes ?? 0) > 0 }
  }

  async get(id: string): Promise<MusicDownload | null> {
    const row = await this.row(id)
    return row ? toDownload(row) : null
  }

  /** Newest first, each task with the track snapshot it names. */
  async list(limit: number = MUSIC_DOWNLOAD_LIST_LIMIT): Promise<MusicDownloadWithTrack[]> {
    const capped = Math.max(1, Math.min(MUSIC_DOWNLOAD_LIST_LIMIT, Math.trunc(limit)))
    const { results } = await this.db.prepare(
      `SELECT ${DOWNLOAD_COLUMNS} FROM music_download
        WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2`,
    ).bind(this.userId, capped).all<DownloadRow>()
    if (!results.length) return []
    const tracks = await new MusicStore(this.db, this.userId)
      .getTracks(results.map((row) => row.track_id))
    const byId = new Map(tracks.map((track) => [track.id, track]))
    return results.map((row) => ({
      ...toDownload(row),
      track: byId.get(row.track_id) ?? null,
    }))
  }

  async requestPause(id: string): Promise<MusicDownloadTransition> {
    const changed = await this.update(
      `UPDATE music_download SET status = 'paused', updated_at = ?3
        WHERE user_id = ?1 AND id = ?2 AND status IN ('queued', 'running')`,
      id,
    )
    return this.transition(id, changed)
  }

  async requestResume(id: string): Promise<MusicDownloadTransition> {
    const changed = await this.update(
      `UPDATE music_download SET status = 'queued', updated_at = ?3
        WHERE user_id = ?1 AND id = ?2 AND status = 'paused'`,
      id,
    )
    return this.transition(id, changed)
  }

  /** A manual retry gets a fresh attempt budget; progress restarts because the partial upload is gone. */
  async requestRetry(id: string): Promise<MusicDownloadTransition> {
    const changed = await this.update(
      `UPDATE music_download SET status = 'queued', progress = 0, error = '', attempts = 0,
         completed_at = NULL, updated_at = ?3
        WHERE user_id = ?1 AND id = ?2 AND status IN ('failed', 'canceled')`,
      id,
    )
    return this.transition(id, changed)
  }

  /** A canceled task keeps its row so the queue can release the multipart upload it started. */
  async requestCancel(id: string): Promise<MusicDownloadTransition> {
    const changed = await this.update(
      `UPDATE music_download SET status = 'canceled', error = '', updated_at = ?3
        WHERE user_id = ?1 AND id = ?2 AND status IN ('queued', 'running', 'paused', 'failed')`,
      id,
    )
    return this.transition(id, changed)
  }

  /** Remove the task row and answer the object key the caller may now release. */
  async remove(id: string): Promise<{ deleted: boolean; r2Key: string | null }> {
    const row = await this.row(id)
    if (!row) return { deleted: false, r2Key: null }
    const result = await this.db.prepare(
      `DELETE FROM music_download WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).run()
    return { deleted: (result.meta.changes ?? 0) > 0, r2Key: row.r2_key }
  }

  // Queue --------------------------------------------------------------------------------------

  /**
   * Take the oldest queued tasks and mark them running.
   *
   * The claim is a conditional update per id, so a task the reader paused or canceled between the
   * select and the update is left alone instead of being run anyway. A task that has spent its whole
   * attempt budget is failed here rather than selected forever.
   */
  async claimNextQueued(concurrency = 1): Promise<MusicDownload[]> {
    const limit = Math.max(1, Math.min(MUSIC_DOWNLOAD_CONCURRENCY_MAX, Math.trunc(concurrency)))
    const { results } = await this.db.prepare(
      `SELECT id FROM music_download WHERE user_id = ?1 AND status = 'queued'
        ORDER BY created_at, id LIMIT ?2`,
    ).bind(this.userId, limit).all<{ id: string }>()

    const claimed: MusicDownload[] = []
    for (const entry of results) {
      const row = await this.claim(entry.id)
      if (row) claimed.push(row)
    }
    return claimed
  }

  /** Claim one named task, for a retry that should start its own row rather than the queue head. */
  async claimQueued(id: string): Promise<MusicDownload | null> {
    return this.claim(id)
  }

  /** Re-mark a task the queue is resuming with a stored cursor; this is not a new attempt. */
  async reopen(id: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE music_download SET status = 'running', updated_at = ?3
        WHERE user_id = ?1 AND id = ?2 AND status = 'queued'`,
    ).bind(this.userId, id, Date.now()).run()
    return (result.meta.changes ?? 0) > 0
  }

  /**
   * Put tasks a dead isolate left running back on the queue. The attempt they were in stays counted,
   * so a crash loop cannot escape the budget.
   */
  async requeueStale(maxAgeMs: number, now = Date.now()): Promise<number> {
    const result = await this.db.prepare(
      `UPDATE music_download SET status = 'queued', updated_at = ?2
        WHERE user_id = ?1 AND status = 'running' AND updated_at < ?3`,
    ).bind(this.userId, now, now - Math.max(0, Math.trunc(maxAgeMs))).run()
    return result.meta.changes ?? 0
  }

  /**
   * Store the slice's progress. False means the queue no longer owns the task — paused, canceled or
   * deleted while the slice was in flight — which the caller reads back to decide what to release.
   */
  async saveProgress(id: string, input: { progress: number; size: number | null }): Promise<boolean> {
    const progress = Math.max(0, Math.min(99, Math.trunc(input.progress)))
    const result = await this.db.prepare(
      `UPDATE music_download SET progress = ?3, size = COALESCE(?4, size), updated_at = ?5
        WHERE user_id = ?1 AND id = ?2 AND status = 'running'`,
    ).bind(this.userId, id, progress, input.size, Date.now()).run()
    return (result.meta.changes ?? 0) > 0
  }

  /**
   * Record a failed attempt. `retryable` is the caller's judgment: a quota refusal or an expired
   * login will not improve by trying again, so those fail at once.
   */
  async failAttempt(
    id: string,
    error: string,
    retryable: boolean,
  ): Promise<MusicDownload | null> {
    const row = await this.row(id)
    if (!row || row.status !== 'running') return row ? toDownload(row) : null
    const retry = retryable && row.attempts < MUSIC_DOWNLOAD_MAX_ATTEMPTS
    await this.db.prepare(
      `UPDATE music_download SET status = ?3, progress = CASE WHEN ?3 = 'queued' THEN 0 ELSE progress END,
         error = ?4, updated_at = ?5
        WHERE user_id = ?1 AND id = ?2 AND status = 'running'`,
    ).bind(
      this.userId,
      id,
      retry ? 'queued' : 'failed',
      truncate(error, MAX_STORED_ERROR_CHARS),
      Date.now(),
    ).run()
    const saved = await this.row(id)
    return saved ? toDownload(saved) : null
  }

  /**
   * Publish a finished object: the ledger row, the track's new preferred key and the task itself, in
   * one batch. The ledger write is what the quota counts, so it must not exist without the key.
   */
  async complete(id: string, input: MusicDownloadCompletion): Promise<void> {
    const now = Date.now()
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO music_object (user_id, r2_key, track_id, format, quality, size, sha256, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7)
         ON CONFLICT(user_id, r2_key) DO UPDATE SET
           track_id = excluded.track_id,
           format = excluded.format,
           quality = excluded.quality,
           size = excluded.size`,
      ).bind(this.userId, input.r2Key, input.trackId, input.format, input.quality, input.size, now),
      this.db.prepare(
        `UPDATE music_track SET r2_key = ?3, format = ?4, size = ?5, source_quality = ?6,
           updated_at = ?7
          WHERE user_id = ?1 AND id = ?2`,
      ).bind(this.userId, input.trackId, input.r2Key, input.format, input.size, input.quality, now),
      this.db.prepare(
        `UPDATE music_download SET status = 'done', progress = 100, size = ?3, r2_key = ?4,
           error = '', completed_at = ?5, updated_at = ?5
          WHERE user_id = ?1 AND id = ?2`,
      ).bind(this.userId, id, input.size, input.r2Key, now),
    ])
  }

  // Internals ----------------------------------------------------------------------------------

  private async claim(id: string): Promise<MusicDownload | null> {
    const now = Date.now()
    const claimed = await this.db.prepare(
      `UPDATE music_download SET status = 'running', attempts = attempts + 1, error = '', updated_at = ?3
        WHERE user_id = ?1 AND id = ?2 AND status = 'queued' AND attempts < ?4`,
    ).bind(this.userId, id, now, MUSIC_DOWNLOAD_MAX_ATTEMPTS).run()
    if ((claimed.meta.changes ?? 0) === 0) {
      await this.db.prepare(
        `UPDATE music_download SET status = 'failed', error = ?3, updated_at = ?4
          WHERE user_id = ?1 AND id = ?2 AND status = 'queued' AND attempts >= ?5`,
      ).bind(
        this.userId,
        id,
        'The download used its whole attempt budget',
        now,
        MUSIC_DOWNLOAD_MAX_ATTEMPTS,
      ).run()
      return null
    }
    const row = await this.row(id)
    return row ? toDownload(row) : null
  }

  private async update(sql: string, id: string): Promise<boolean> {
    const result = await this.db.prepare(sql).bind(this.userId, id, Date.now()).run()
    return (result.meta.changes ?? 0) > 0
  }

  private async transition(id: string, changed: boolean): Promise<MusicDownloadTransition> {
    const row = await this.row(id)
    return { download: row ? toDownload(row) : null, changed }
  }

  private async row(id: string): Promise<DownloadRow | null> {
    return this.db.prepare(
      `SELECT ${DOWNLOAD_COLUMNS} FROM music_download WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).first<DownloadRow>()
  }

  private async rowByRequest(
    trackId: string,
    quality: string,
    format: string,
  ): Promise<DownloadRow | null> {
    return this.db.prepare(
      `SELECT ${DOWNLOAD_COLUMNS} FROM music_download
        WHERE user_id = ?1 AND track_id = ?2 AND quality = ?3 AND format = ?4`,
    ).bind(this.userId, trackId, quality, format).first<DownloadRow>()
  }
}

function toDownload(row: DownloadRow): MusicDownload {
  return {
    id: row.id,
    trackId: row.track_id,
    quality: row.quality as MusicQuality,
    format: row.format,
    status: row.status as MusicDownloadStatus,
    progress: row.progress,
    size: row.size,
    r2Key: row.r2_key,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function truncate(value: string, limit: number): string {
  const trimmed = value.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}
