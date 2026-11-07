// The one read of a recording row. The owner-facing replay routes and the public share routes both
// address recordings by (owner, id), and a second copy of this liveness rule would be a second place
// for the expiry check to drift.

import type { Env } from '../../env'
import { ApiError } from '../../lib/errors'
import { isValidId } from '../../lib/id'
import { purgeExpiredRecording } from './retention'

export interface RecordingRow {
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

export const RECORDING_COLUMNS =
  'id, user_id, session_id, host_id, format, r2_key, size_bytes, duration_ms, cols, rows, status, created_at, finalized_at, expires_at, deleted_at'

/**
 * Answers a recording only while it is still replayable: a marked, deleted or expired row is purged
 * first and then reads as absent, so no caller ever sees metadata for an object the sweep removed.
 */
function isLive(row: RecordingRow, now: number): boolean {
  return row.status !== 'deleted' && row.deleted_at === null && row.expires_at > now
}

export async function findSessionRecording(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<RecordingRow | null> {
  if (!isValidId(sessionId)) return null
  return await env.DB.prepare(
    `SELECT ${RECORDING_COLUMNS} FROM webssh_recordings
      WHERE session_id = ?1 AND user_id = ?2
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(sessionId, userId)
    .first<RecordingRow>()
}

export async function loadSessionRecording(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<RecordingRow> {
  if (!isValidId(sessionId)) throw ApiError.badRequest('Invalid session id')
  const row = await findSessionRecording(env, userId, sessionId)
  if (!row) throw ApiError.notFound('That session has no recording')
  const now = Date.now()
  if (!isLive(row, now)) {
    await purgeExpiredRecording(env, row, now)
    throw ApiError.notFound('That session has no recording')
  }
  return row
}

export async function loadRecordingById(
  env: Env,
  userId: string,
  recordingId: string,
): Promise<RecordingRow | null> {
  if (!isValidId(recordingId)) return null
  const row = await env.DB.prepare(
    `SELECT ${RECORDING_COLUMNS} FROM webssh_recordings WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(recordingId, userId)
    .first<RecordingRow>()
  if (!row) return null
  const now = Date.now()
  if (!isLive(row, now)) {
    await purgeExpiredRecording(env, row, now)
    return null
  }
  return row
}

/** Replay only reads a finished object; anything still recording answers 409 with its status. */
export function requireReadyRecording(row: RecordingRow): void {
  if (row.status !== 'ready') {
    throw ApiError.conflict('That recording is not ready to replay', { status: row.status })
  }
}
