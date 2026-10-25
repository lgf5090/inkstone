/**
 * Maintenance for the music module's durable bookkeeping.
 *
 * Three kinds of state can outlive the request that created them: R2 keys whose delete failed, upload
 * jobs the browser abandoned mid-multipart, and download rows that were queued while the queue alarm
 * could not be reached. The hourly sweep owns all three so a transient failure becomes a retry rather
 * than a permanent leak.
 */
import { MUSIC_LIMITS } from '@shared/music/constants'
import type { Env } from '../env'
import { abortMusicUpload } from './upload-store'
import { kickMusicQueue } from './queue'

const CLEANUP_BATCH = 200
const DELETE_CHUNK = 50
const STALE_UPLOAD_BATCH = 25
const QUEUE_RECOVERY_BATCH = 50

export interface MusicMaintenanceResult {
  objectsRemoved: number
  objectsFailed: number
  uploadsAborted: number
  queuesNudged: number
}

export async function runMusicMaintenance(env: Env, now = Date.now()): Promise<MusicMaintenanceResult> {
  const [objects, uploads, queues] = await Promise.all([
    runMusicObjectCleanup(env),
    runStaleUploadCleanup(env, now),
    runQueuedDownloadRecovery(env),
  ])
  return { ...objects, uploadsAborted: uploads, queuesNudged: queues }
}

async function runMusicObjectCleanup(env: Env): Promise<{ objectsRemoved: number; objectsFailed: number }> {
  if (!env.FILES) return { objectsRemoved: 0, objectsFailed: 0 }
  const { results } = await env.DB.prepare(
    `SELECT object_key FROM music_cleanup ORDER BY created_at, object_key LIMIT ?1`,
  ).bind(CLEANUP_BATCH).all<{ object_key: string }>()
  if (results.length === 0) return { objectsRemoved: 0, objectsFailed: 0 }

  const bucket = env.FILES
  const removed: string[] = []
  try {
    await bucket.delete(results.map((row) => row.object_key))
    removed.push(...results.map((row) => row.object_key))
  } catch (error) {
    // One bad key must not keep the rest queued forever: retry each key so the successful ones can
    // leave the queue and only the genuine failures come back next hour.
    console.warn('[inkstone] Music cleanup batch failed; retrying keys one by one:', error)
    for (const row of results) {
      try {
        await bucket.delete(row.object_key)
        removed.push(row.object_key)
      } catch (failure) {
        console.warn('[inkstone] Music object cleanup failed:', row.object_key, failure)
      }
    }
  }

  for (let start = 0; start < removed.length; start += DELETE_CHUNK) {
    const keys = removed.slice(start, start + DELETE_CHUNK)
    const marks = keys.map((_, index) => `?${index + 1}`).join(', ')
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM music_cleanup WHERE object_key IN (${marks})`).bind(...keys),
      // A failed cover/audio discard can leave its ledger row behind; releasing it here keeps the
      // quota equal to the bytes that still exist.
      env.DB.prepare(`DELETE FROM music_object WHERE r2_key IN (${marks})`).bind(...keys),
    ])
  }
  return { objectsRemoved: removed.length, objectsFailed: results.length - removed.length }
}

async function runStaleUploadCleanup(env: Env, now: number): Promise<number> {
  const cutoff = now - MUSIC_LIMITS.uploadStaleMs
  const { results } = await env.DB.prepare(
    `SELECT user_id, id FROM music_upload
      WHERE status = 'uploading' AND updated_at < ?1
      ORDER BY updated_at, id LIMIT ?2`,
  ).bind(cutoff, STALE_UPLOAD_BATCH).all<{ user_id: string; id: string }>()
  let aborted = 0
  for (const row of results) {
    try {
      await abortMusicUpload(env, row.user_id, row.id)
      aborted += 1
    } catch (error) {
      // A completion that won the race is fine; the next sweep will see its terminal status.
      console.warn('[inkstone] Stale music upload could not be aborted:', row.id, error)
    }
  }
  return aborted
}

async function runQueuedDownloadRecovery(env: Env): Promise<number> {
  if (!env.MUSIC_QUEUE) return 0
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM music_download WHERE status = 'queued' LIMIT ?1`,
  ).bind(QUEUE_RECOVERY_BATCH).all<{ user_id: string }>()
  let nudged = 0
  for (const row of results) {
    try {
      await kickMusicQueue(env, row.user_id)
      nudged += 1
    } catch (error) {
      console.warn('[inkstone] Queued music downloads could not be re-woken:', row.user_id, error)
    }
  }
  return nudged
}
