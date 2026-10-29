/** Recording metadata, timelines and the account usage summary. */
import { Hono } from 'hono'
import { INKNOTE_LIMITS } from '@shared/inknote/constants'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  createInknoteRecording,
  deleteInknoteRecording,
  listInknoteRecordings,
  readInknoteRecordingTimeline,
} from '../inknote/recordings'
import { inknoteUsage } from '../inknote/usage'

export const inknoteRecordingsRoutes = new Hono<AppBindings>()
inknoteRecordingsRoutes.use('*', requireAuth)

inknoteRecordingsRoutes.get('/recordings', async (c) => {
  const noteId = c.req.query('noteId')
  if (!noteId || !isValidId(noteId)) throw ApiError.badRequest('noteId is required')
  return c.json({ recordings: await listInknoteRecordings(c.env.DB, c.get('userId'), noteId) })
})

inknoteRecordingsRoutes.post('/recordings', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<Record<string, unknown>>(c, 8 * 1024 * 1024 + 64 * 1024)
  const noteId = typeof body.noteId === 'string' && isValidId(body.noteId) ? body.noteId : null
  const audioAssetId = typeof body.audioAssetId === 'string' && isValidId(body.audioAssetId) ? body.audioAssetId : null
  if (!noteId || !audioAssetId) throw ApiError.badRequest('noteId and audioAssetId are required')
  const title = (typeof body.title === 'string' ? body.title : '').trim().slice(0, 200) || 'Recording'
  const durationMs = typeof body.durationMs === 'number' && Number.isFinite(body.durationMs)
    ? Math.min(INKNOTE_LIMITS.recordingMaxMs, Math.max(0, Math.round(body.durationMs)))
    : 0
  const peaks = Array.isArray(body.peaks) ? body.peaks.filter((n): n is number => typeof n === 'number').slice(0, 64) : []
  const timeline = Array.isArray(body.timeline) ? body.timeline : []
  const recording = await createInknoteRecording(c.env, userId, { noteId, audioAssetId, title, durationMs, peaks, timeline })
  return c.json(recording, 201)
})

inknoteRecordingsRoutes.get('/recordings/:id/timeline', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Recording not found')
  return c.json({ events: await readInknoteRecordingTimeline(c.env, c.get('userId'), id) })
})

inknoteRecordingsRoutes.delete('/recordings/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Recording not found')
  await deleteInknoteRecording(c.env, c.get('userId'), id)
  return c.json({ ok: true })
})

inknoteRecordingsRoutes.get('/usage', async (c) => {
  return c.json(await inknoteUsage(c.env, c.get('userId')))
})
