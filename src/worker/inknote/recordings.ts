/**
 * Recording metadata rows and the timeline objects that sit beside them in R2.
 *
 * The audio itself is an `inknote_assets` row of kind `audio`; this table carries what the player
 * needs around it (duration, peaks, a title) and the key of the timeline the recorder wrote.
 */
import { INKNOTE_LIMITS } from '@shared/inknote/constants'
import type { InknoteRecording } from '@shared/inknote/types'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { inknoteAssetById, scheduleInknoteCleanup } from './assets'

type Row = Record<string, unknown>

function timelineKey(userId: string, id: string): string {
  return `inknote/txt/${userId}/recordings/${id}.json`
}

function toRecording(row: Row): InknoteRecording {
  const audioAssetId = String(row.audio_asset_id)
  return {
    id: String(row.id),
    noteId: String(row.note_id),
    title: String(row.title),
    durationMs: Number(row.duration_ms),
    audioAssetId,
    audioUrl: `/api/inknote/assets/${audioAssetId}`,
    peaks: (() => { try { const value = JSON.parse(String(row.peaks)); return Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number') : [] } catch { return [] } })(),
    createdAt: Number(row.created_at),
  }
}

export async function listInknoteRecordings(db: D1Database, userId: string, noteId: string): Promise<InknoteRecording[]> {
  const { results } = await db.prepare(
    `SELECT id, note_id, title, duration_ms, audio_asset_id, peaks, created_at FROM inknote_recordings WHERE user_id = ?1 AND note_id = ?2 ORDER BY created_at, id`,
  ).bind(userId, noteId).all<Row>()
  return results.map((row) => toRecording(row))
}

export interface CreateInknoteRecordingInput {
  noteId: string
  audioAssetId: string
  title: string
  durationMs: number
  peaks: number[]
  timeline: unknown[]
}

export async function createInknoteRecording(
  env: Env,
  userId: string,
  input: CreateInknoteRecordingInput,
): Promise<InknoteRecording> {
  const note = await env.DB.prepare(`SELECT id FROM inknote_notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`).bind(userId, input.noteId).first()
  if (!note) throw ApiError.notFound('Note not found')
  const asset = await inknoteAssetById(env.DB, userId, input.audioAssetId)
  if (!asset || asset.kind !== 'audio') throw ApiError.badRequest('Unknown audio asset')
  const serialized = JSON.stringify(input.timeline)
  if (new TextEncoder().encode(serialized).length > INKNOTE_LIMITS.timelineMaxBytes) throw ApiError.tooLarge('The recording timeline is too large')
  const id = newId()
  const now = Date.now()
  const key = timelineKey(userId, id)
  if (!env.FILES) throw new ApiError(503, 'storage_unavailable', 'Recording storage is not configured')
  await env.FILES.put(key, serialized, { httpMetadata: { contentType: 'application/json' }, customMetadata: { userId, objectId: id, kind: 'recording-timeline' } })
  await env.DB.prepare(
    `INSERT INTO inknote_recordings (user_id, id, note_id, title, duration_ms, audio_asset_id, timeline_key, peaks, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(userId, id, input.noteId, input.title, input.durationMs, input.audioAssetId, key, JSON.stringify(input.peaks), now).run()
  return {
    id,
    noteId: input.noteId,
    title: input.title,
    durationMs: input.durationMs,
    audioAssetId: input.audioAssetId,
    audioUrl: `/api/inknote/assets/${input.audioAssetId}`,
    peaks: input.peaks,
    createdAt: now,
  }
}

export async function readInknoteRecordingTimeline(env: Env, userId: string, id: string): Promise<unknown[]> {
  const row = await env.DB.prepare(`SELECT timeline_key FROM inknote_recordings WHERE user_id = ?1 AND id = ?2`).bind(userId, id).first<{ timeline_key: string }>()
  if (!row) throw ApiError.notFound('Recording not found')
  if (!env.FILES) throw new ApiError(503, 'storage_unavailable', 'Recording storage is not configured')
  const object = await env.FILES.get(row.timeline_key)
  if (!object) return []
  try {
    const value = await object.json() as unknown
    return Array.isArray(value) ? value : []
  } catch {
    throw ApiError.badRequest('The recording timeline is damaged')
  }
}

export async function deleteInknoteRecording(env: Env, userId: string, id: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT audio_asset_id, timeline_key FROM inknote_recordings WHERE user_id = ?1 AND id = ?2`).bind(userId, id).first<{ audio_asset_id: string, timeline_key: string }>()
  if (!row) throw ApiError.notFound('Recording not found')
  await env.DB.prepare(`DELETE FROM inknote_recordings WHERE user_id = ?1 AND id = ?2`).bind(userId, id).run()
  // The row is already gone, so a failed timeline delete leaves one unreachable object and has no
  // response surface left to report on; the audio asset below goes through the cleanup queue instead.
  if (env.FILES && row.timeline_key) await env.FILES.delete(row.timeline_key).catch((error) => { console.warn('[inkstone] Recording timeline object outlived its row:', error) })
  const audio = await inknoteAssetById(env.DB, userId, row.audio_asset_id)
  if (audio) await scheduleInknoteCleanup(env.DB, userId, [{ objectKey: audio.object_key, storage: audio.storage }])
}
