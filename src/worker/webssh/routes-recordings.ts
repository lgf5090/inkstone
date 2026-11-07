// Replay API for recorded sessions. Everything is session-scoped and owner-only: another account
// asking for the same id gets a 404, and the R2 key is never exposed. Frames are read in bounded
// byte ranges so one request never pulls a whole recording into the Worker.

import { Hono, type Context } from 'hono'
import type { WebsshRecordingFrames, WebsshRecordingView } from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { recordAudit } from './audit'
import { loadSessionRecording, requireReadyRecording, type RecordingRow } from './recording/repository'
import { parseSliceBounds, readCastSlice } from './recording/slice'

function toView(row: RecordingRow): WebsshRecordingView {
  return {
    id: row.id,
    sessionId: row.session_id,
    hostId: row.host_id,
    format: 'cast',
    status: row.status as WebsshRecordingView['status'],
    sizeBytes: Number(row.size_bytes),
    durationMs: Number(row.duration_ms),
    cols: Number(row.cols),
    rows: Number(row.rows),
    createdAt: Number(row.created_at),
    finalizedAt: row.finalized_at === null ? null : Number(row.finalized_at),
    expiresAt: Number(row.expires_at),
  }
}

function auditAccess(c: Context<AppBindings>, row: RecordingRow, action: 'metadata' | 'content'): void {
  const userId = c.get('userId')
  if (!userId) return
  void recordAudit(c.env.DB, {
    userId,
    sessionId: row.session_id,
    hostId: row.host_id,
    eventType: 'recording_access',
    metadata: { recordingId: row.id, action },
  }).catch(() => undefined)
}

export const websshRecordingRoutes = new Hono<AppBindings>()

websshRecordingRoutes.get('/sessions/:id/recording', async (c) => {
  const row = await loadSessionRecording(c.env, c.get('userId'), c.req.param('id'))
  auditAccess(c, row, 'metadata')
  return c.json<WebsshRecordingView>(toView(row))
})

/** One byte-addressed slice of the cast file; the slicing rules live in `recording/slice.ts`. */
websshRecordingRoutes.get('/sessions/:id/recording/frames', async (c) => {
  const row = await loadSessionRecording(c.env, c.get('userId'), c.req.param('id'))
  requireReadyRecording(row)
  const bucket = c.env.FILES
  if (!bucket) throw new ApiError(503, 'storage_unavailable', 'The recording store is not bound')

  const { offset, limit } = parseSliceBounds(c.req.query('offset'), c.req.query('limit'))
  const slice = await readCastSlice(bucket, row.r2_key, offset, limit)
  if (!slice) throw ApiError.notFound('The recording object is missing')
  return c.json<WebsshRecordingFrames>({
    recordingId: row.id,
    sessionId: row.session_id,
    offset,
    startOffset: slice.startOffset,
    nextOffset: slice.nextOffset,
    totalSize: slice.totalSize,
    complete: slice.complete,
    ...(slice.header ? { header: slice.header } : {}),
    frames: slice.frames,
  })
})

/** The whole cast as a stream; no range is held in memory, the R2 body is passed through. */
websshRecordingRoutes.get('/sessions/:id/recording/content', async (c) => {
  const row = await loadSessionRecording(c.env, c.get('userId'), c.req.param('id'))
  requireReadyRecording(row)
  const bucket = c.env.FILES
  if (!bucket) throw new ApiError(503, 'storage_unavailable', 'The recording store is not bound')
  const object = await bucket.get(row.r2_key)
  if (!object) throw ApiError.notFound('The recording object is missing')
  auditAccess(c, row, 'content')
  return new Response(object.body, {
    headers: {
      'content-type': 'application/x-asciicast',
      'content-length': String(object.size),
      'cache-control': 'no-store',
    },
  })
})
