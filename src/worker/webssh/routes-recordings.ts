// Replay API for recorded sessions. Everything is session-scoped and owner-only: another account
// asking for the same id gets a 404, and the R2 key is never exposed. Frames are read in bounded
// byte ranges so one request never pulls a whole recording into the Worker.

import { Hono, type Context } from 'hono'
import type { WebsshRecordingFrames, WebsshRecordingView, WebsshCastEvent, WebsshCastHeader } from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { recordAudit } from './audit'
import {
  WEBSSH_RECORDING_SLICE_DEFAULT_BYTES,
  WEBSSH_RECORDING_SLICE_MAX_BYTES,
} from './constants'
import { parseCastLine } from './recording/cast'
import { purgeExpiredRecording } from './recording/retention'

interface RecordingRow {
  id: string
  user_id: string
  session_id: string
  host_id: string
  format: string
  r2_key: string
  size_bytes: number
  duration_ms: number
  cols: number
  rows: number
  status: string
  created_at: number
  finalized_at: number | null
  expires_at: number
  deleted_at: number | null
}

const RECORDING_COLUMNS =
  'id, user_id, session_id, host_id, format, r2_key, size_bytes, duration_ms, cols, rows, status, created_at, finalized_at, expires_at, deleted_at'

async function loadRecording(c: Context<AppBindings>, userId: string, sessionId: string): Promise<RecordingRow> {
  if (!isValidId(sessionId)) throw ApiError.badRequest('Invalid session id')
  const row = await c.env.DB.prepare(
    `SELECT ${RECORDING_COLUMNS} FROM webssh_recordings
      WHERE session_id = ?1 AND user_id = ?2
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(sessionId, userId)
    .first<RecordingRow>()
  if (!row) throw ApiError.notFound('That session has no recording')
  if (row.status === 'deleted' || row.deleted_at !== null) throw ApiError.notFound('That session has no recording')
  const now = Date.now()
  if (row.expires_at <= now) {
    await purgeExpiredRecording(c.env, row, now)
    throw ApiError.notFound('That session has no recording')
  }
  return row
}

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

function requireReady(row: RecordingRow): void {
  if (row.status !== 'ready') {
    throw ApiError.conflict('That recording is not ready to replay', { status: row.status })
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

function integerQuery(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) throw ApiError.badRequest('The offset and limit must be non-negative integers')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw ApiError.badRequest('The offset and limit are out of range')
  return parsed
}

export const websshRecordingRoutes = new Hono<AppBindings>()

websshRecordingRoutes.get('/sessions/:id/recording', async (c) => {
  const row = await loadRecording(c, c.get('userId'), c.req.param('id'))
  auditAccess(c, row, 'metadata')
  return c.json<WebsshRecordingView>(toView(row))
})

/**
 * One byte-addressed slice of the cast file. The first partial line is skipped and only lines
 * terminated by a newline are returned, so passing `nextOffset` from one slice to the next neither
 * repeats nor drops a frame.
 */
websshRecordingRoutes.get('/sessions/:id/recording/frames', async (c) => {
  const row = await loadRecording(c, c.get('userId'), c.req.param('id'))
  requireReady(row)
  const bucket = c.env.FILES
  if (!bucket) throw new ApiError(503, 'storage_unavailable', 'The recording store is not bound')

  const offset = integerQuery(c.req.query('offset'), 0)
  const limit = integerQuery(c.req.query('limit'), WEBSSH_RECORDING_SLICE_DEFAULT_BYTES)
  if (limit < 1 || limit > WEBSSH_RECORDING_SLICE_MAX_BYTES) {
    throw ApiError.badRequest(`The limit must be between 1 and ${WEBSSH_RECORDING_SLICE_MAX_BYTES}`)
  }

  const head = await bucket.head(row.r2_key)
  if (!head) throw ApiError.notFound('The recording object is missing')
  const totalSize = head.size
  if (offset >= totalSize) {
    return c.json<WebsshRecordingFrames>({
      recordingId: row.id,
      sessionId: row.session_id,
      offset,
      startOffset: offset,
      nextOffset: offset,
      totalSize,
      complete: true,
      frames: [],
    })
  }

  // One byte before the requested offset tells us whether it begins a line; the extra byte is then
  // skipped so it never enters the returned frames.
  const readOffset = offset > 0 ? offset - 1 : 0
  const readLength = Math.min(totalSize - readOffset, limit + (offset > 0 ? 1 : 0))
  const object = await bucket.get(row.r2_key, { range: { offset: readOffset, length: readLength } })
  if (!object) throw ApiError.notFound('The recording object is missing')
  const bytes = new Uint8Array(await object.arrayBuffer())
  const decoder = new TextDecoder()

  let cursor = 0
  if (offset > 0) {
    if (bytes[0] === 0x0a) {
      cursor = 1
    } else {
      const newline = bytes.indexOf(0x0a)
      if (newline === -1) {
        throw new ApiError(500, 'internal', 'The replay slice starts inside an event larger than the limit')
      }
      cursor = newline + 1
    }
  }
  const startOffset = readOffset + cursor

  let lineStart = cursor
  let lastComplete = cursor
  let header: WebsshCastHeader | undefined
  const frames: WebsshCastEvent[] = []
  for (let index = cursor; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue
    const parsed = parseCastLine(decoder.decode(bytes.subarray(lineStart, index)))
    if (parsed.header) header = parsed.header
    else if (parsed.event) frames.push(parsed.event)
    lastComplete = index + 1
    lineStart = index + 1
  }

  const nextOffset = readOffset + lastComplete
  if (nextOffset === startOffset && nextOffset < totalSize) {
    // No complete line fit in the slice. Answering an unchanged offset would make a caller loop
    // forever, and widening the read would break the bounded-memory promise.
    throw ApiError.badRequest('The limit is too small to include a complete event')
  }
  return c.json<WebsshRecordingFrames>({
    recordingId: row.id,
    sessionId: row.session_id,
    offset,
    startOffset,
    nextOffset,
    totalSize,
    complete: nextOffset >= totalSize,
    ...(header ? { header } : {}),
    frames,
  })
})

/** The whole cast as a stream; no range is held in memory, the R2 body is passed through. */
websshRecordingRoutes.get('/sessions/:id/recording/content', async (c) => {
  const row = await loadRecording(c, c.get('userId'), c.req.param('id'))
  requireReady(row)
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
