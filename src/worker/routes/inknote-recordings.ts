/** Recording metadata, timelines and the account usage summary. */
import { Hono } from 'hono'
import { INKNOTE_LIMITS } from '@shared/inknote/constants'
import type { InknoteRecording } from '@shared/inknote/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId, isValidId } from '../lib/id'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { attachmentQuotaBytesForEnv } from '../attachments/backend'
import { scheduleInknoteCleanup, inknoteAssetById } from '../inknote/assets'

export const inknoteRecordingsRoutes = new Hono<AppBindings>()
inknoteRecordingsRoutes.use('*', requireAuth)

function timelineKey(userId: string, id: string): string {
  return `inknote/txt/${userId}/recordings/${id}.json`
}

function toRecording(row: Record<string, unknown>): InknoteRecording {
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

inknoteRecordingsRoutes.get('/recordings', async (c) => {
  const noteId = c.req.query('noteId')
  if (!noteId || !isValidId(noteId)) throw ApiError.badRequest('noteId is required')
  const { results } = await c.env.DB.prepare(
    `SELECT id, note_id, title, duration_ms, audio_asset_id, peaks, created_at FROM inknote_recordings WHERE user_id = ?1 AND note_id = ?2 ORDER BY created_at, id`,
  ).bind(c.get('userId'), noteId).all<Record<string, unknown>>()
  return c.json({ recordings: results.map((row) => toRecording(row)) })
})

inknoteRecordingsRoutes.post('/recordings', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<Record<string, unknown>>(c, 8 * 1024 * 1024 + 64 * 1024)
  const noteId = typeof body.noteId === 'string' && isValidId(body.noteId) ? body.noteId : null
  const audioAssetId = typeof body.audioAssetId === 'string' && isValidId(body.audioAssetId) ? body.audioAssetId : null
  if (!noteId || !audioAssetId) throw ApiError.badRequest('noteId and audioAssetId are required')
  const note = await c.env.DB.prepare(`SELECT id FROM inknote_notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`).bind(userId, noteId).first()
  if (!note) throw ApiError.notFound('Note not found')
  const asset = await inknoteAssetById(c.env.DB, userId, audioAssetId)
  if (!asset || asset.kind !== 'audio') throw ApiError.badRequest('Unknown audio asset')
  const timeline = Array.isArray(body.timeline) ? body.timeline : []
  const serialized = JSON.stringify(timeline)
  if (new TextEncoder().encode(serialized).length > INKNOTE_LIMITS.timelineMaxBytes) throw ApiError.tooLarge('The recording timeline is too large')
  const id = newId()
  const now = Date.now()
  const title = (typeof body.title === 'string' ? body.title : '').trim().slice(0, 200) || 'Recording'
  const durationMs = typeof body.durationMs === 'number' && Number.isFinite(body.durationMs)
    ? Math.min(INKNOTE_LIMITS.recordingMaxMs, Math.max(0, Math.round(body.durationMs)))
    : 0
  const peaks = Array.isArray(body.peaks) ? body.peaks.filter((n): n is number => typeof n === 'number').slice(0, 64) : []
  const key = timelineKey(userId, id)
  if (!c.env.FILES) throw new ApiError(503, 'storage_unavailable', 'Recording storage is not configured')
  await c.env.FILES.put(key, serialized, { httpMetadata: { contentType: 'application/json' }, customMetadata: { userId, objectId: id, kind: 'recording-timeline' } })
  await c.env.DB.prepare(
    `INSERT INTO inknote_recordings (user_id, id, note_id, title, duration_ms, audio_asset_id, timeline_key, peaks, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(userId, id, noteId, title, durationMs, audioAssetId, key, JSON.stringify(peaks), now).run()
  return c.json({ id, noteId, title, durationMs, audioAssetId, audioUrl: `/api/inknote/assets/${audioAssetId}`, peaks, createdAt: now }, 201)
})

inknoteRecordingsRoutes.get('/recordings/:id/timeline', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Recording not found')
  const row = await c.env.DB.prepare(`SELECT timeline_key FROM inknote_recordings WHERE user_id = ?1 AND id = ?2`).bind(c.get('userId'), id).first<{ timeline_key: string }>()
  if (!row) throw ApiError.notFound('Recording not found')
  if (!c.env.FILES) throw new ApiError(503, 'storage_unavailable', 'Recording storage is not configured')
  const object = await c.env.FILES.get(row.timeline_key)
  if (!object) return c.json({ events: [] })
  try {
    const value = await object.json() as unknown
    return c.json({ events: Array.isArray(value) ? value : [] })
  } catch {
    throw ApiError.badRequest('The recording timeline is damaged')
  }
})

inknoteRecordingsRoutes.delete('/recordings/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Recording not found')
  const row = await c.env.DB.prepare(`SELECT audio_asset_id, timeline_key FROM inknote_recordings WHERE user_id = ?1 AND id = ?2`).bind(userId, id).first<{ audio_asset_id: string, timeline_key: string }>()
  if (!row) throw ApiError.notFound('Recording not found')
  await c.env.DB.prepare(`DELETE FROM inknote_recordings WHERE user_id = ?1 AND id = ?2`).bind(userId, id).run()
  if (c.env.FILES && row.timeline_key) await c.env.FILES.delete(row.timeline_key).catch(() => {})
  const audio = await inknoteAssetById(c.env.DB, userId, row.audio_asset_id)
  if (audio) await scheduleInknoteCleanup(c.env.DB, userId, [{ objectKey: audio.object_key, storage: audio.storage }])
  return c.json({ ok: true })
})

inknoteRecordingsRoutes.get('/usage', async (c) => {
  const userId = c.get('userId')
  const [notes, pages, assets] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM inknote_notes WHERE user_id = ?1 AND deleted_at IS NULL`).bind(userId).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM inknote_pages WHERE user_id = ?1`).bind(userId).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM inknote_assets WHERE user_id = ?1`).bind(userId).first<{ n: number, bytes: number }>(),
  ])
  return c.json({
    notes: Number(notes?.n ?? 0),
    pages: Number(pages?.n ?? 0),
    assets: Number(assets?.n ?? 0),
    assetsBytes: Number(assets?.bytes ?? 0),
    snapshotsBytes: 0,
    quotaBytes: attachmentQuotaBytesForEnv(c.env),
  })
})
