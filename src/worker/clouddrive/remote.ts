/**
 * Remote URL uploads: pull a file from an HTTP address into the primary mount.
 *
 * OpenList calls this an offline download; in this deployment the bytes have to pass through the
 * worker, so the address is treated as attacker-controlled: every hop is re-checked against the
 * shared SSRF guard, redirects are followed by hand rather than by `fetch`, and the transfer is
 * split into ranged parts so a killed isolate leaves a resumable session instead of a half object.
 *
 * The probe decides the strategy. A server that answers `Range` with 206 gives a known total and
 * resumable parts; one that ignores it is only accepted for a file small enough to take in one
 * request, because a plain GET cannot be resumed.
 */
import { checkTarget } from '../lib/outbound'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import {
  completeUploadSession,
  decodeSessionConflict,
  discardSessionObjects,
  type UploadSessionRow,
} from './upload-finalize'

const MAX_REDIRECTS = 4
const TIME_BUDGET_MS = 6_000
const LOCK_MS = 90_000
const USER_AGENT = 'inkstone-clouddrive'
const MIME_MAX_LENGTH = 255

export interface RemoteProbe {
  /** The address after redirects; later part requests use it directly (and are re-checked). */
  url: string
  /** Null when the server declared neither a total nor a length. */
  size: number | null
  mime: string
  filename: string
  ranges: boolean
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch (error) {
    console.warn('[inkstone] CloudDrive could not cancel an unused remote response', error)
  }
}

/** `fetch` with every redirect hop checked, so a public address cannot hand the worker a private one. */
async function remoteFetch(rawUrl: string, init: RequestInit): Promise<{ response: Response; url: string }> {
  let current = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = checkTarget(current)
    if (!target.url) {
      throw new ApiError(502, 'clouddrive_mount_unavailable', `The remote address is not reachable: ${target.error}`)
    }
    const response = await fetch(target.url.toString(), {
      ...init,
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: target.url.toString() }
    const location = response.headers.get('location')
    await discard(response)
    if (!location) throw new ApiError(502, 'clouddrive_mount_unavailable', 'The remote server redirected without a location')
    try {
      current = new URL(location, target.url).toString()
    } catch {
      throw new ApiError(502, 'clouddrive_mount_unavailable', 'The remote server redirected to an invalid address')
    }
  }
  throw new ApiError(502, 'clouddrive_mount_unavailable', 'The remote server redirected too many times')
}

function filenameFrom(disposition: string | null, url: URL): string {
  const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition ?? '')?.[1]
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(disposition ?? '')?.[1]
  const plain = /filename\s*=\s*([^;]+)/i.exec(disposition ?? '')?.[1]?.trim()
  const candidate = encoded ?? quoted ?? plain ?? ''
  let name = candidate
  if (encoded) {
    try {
      name = decodeURIComponent(encoded)
    } catch {
      name = encoded
    }
  }
  if (!name) {
    const last = url.pathname.split('/').filter(Boolean).pop() ?? ''
    try {
      name = decodeURIComponent(last)
    } catch {
      name = last
    }
  }
  const segment = name.split(/[\\/]/).pop() ?? ''
  return segment.replace(/[\u0000-\u001f]/g, '').replace(/[. ]+$/, '').slice(0, 255)
}

function totalFromContentRange(value: string | null): number | null {
  const match = /\/\s*(\d+)\s*$/.exec(value ?? '')
  if (!match) return null
  const total = Number(match[1])
  return Number.isSafeInteger(total) && total >= 0 ? total : null
}

/**
 * One ranged request that discovers the size, the media type and whether the server honours ranges.
 * The body is cancelled immediately: the probe must not download a file the reader has not accepted.
 */
export async function probeRemote(rawUrl: string): Promise<RemoteProbe> {
  const { response, url } = await remoteFetch(rawUrl, {
    method: 'GET',
    headers: { Range: 'bytes=0-0', Accept: '*/*' },
  })
  const headers = response.headers
  let size: number | null = null
  let ranges = false
  if (response.status === 206) {
    size = totalFromContentRange(headers.get('content-range'))
    ranges = size !== null
  } else if (response.status === 200) {
    const declared = Number(headers.get('content-length') ?? '')
    size = Number.isSafeInteger(declared) && declared >= 0 ? declared : null
    ranges = false
  } else if (response.status === 416) {
    size = totalFromContentRange(headers.get('content-range')) ?? 0
    ranges = true
  } else {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `The remote server answered ${response.status}`)
  }
  const mime = (headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() || 'application/octet-stream'
  const filename = filenameFrom(headers.get('content-disposition'), new URL(url))
  await discard(response)
  return { url, size, mime: mime.slice(0, MIME_MAX_LENGTH), filename, ranges }
}

async function fetchRange(url: string, start: number, end: number, expected: number): Promise<Uint8Array> {
  const { response } = await remoteFetch(url, {
    method: 'GET',
    headers: { Range: `bytes=${start}-${end}` },
  })
  if (response.status !== 206) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `The remote server stopped honouring ranges (${response.status})`)
  }
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isSafeInteger(declared) && declared >= 0 && declared !== expected) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', 'The remote part has an unexpected length')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== expected) {
    throw new ApiError(502, 'clouddrive_mount_unavailable', 'The remote part does not match the requested range')
  }
  return bytes
}

async function fetchWhole(url: string, expected: number): Promise<Uint8Array> {
  const { response } = await remoteFetch(url, { method: 'GET', headers: { Accept: '*/*' } })
  if (!response.ok) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', `The remote server answered ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isSafeInteger(declared) && declared >= 0 && declared !== expected) {
    await discard(response)
    throw new ApiError(502, 'clouddrive_mount_unavailable', 'The remote file changed length after it was inspected')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== expected) {
    throw new ApiError(502, 'clouddrive_mount_unavailable', 'The remote file changed length after it was inspected')
  }
  return bytes
}

interface RemoteTaskPayload {
  sessionId: string
  url: string
  size: number
  mode: 'direct' | 'multipart'
}

export interface RemoteTaskRow {
  id: string
  user_id: string
  status: string
  payload: string
  progress: string
}

function payloadOf(value: string): RemoteTaskPayload {
  const parsed = JSON.parse(value) as Partial<RemoteTaskPayload>
  return {
    sessionId: String(parsed.sessionId ?? ''),
    url: String(parsed.url ?? ''),
    size: Number(parsed.size) || 0,
    mode: parsed.mode === 'direct' ? 'direct' : 'multipart',
  }
}

async function sessionById(db: D1Database, userId: string, id: string): Promise<UploadSessionRow | null> {
  return await db.prepare(
    `SELECT id, user_id, mount_id, parent_id, path, name, name_folded, mime, category, size,
            strategy, part_size, total_parts, provider_upload_id, storage_key, parts_uploaded,
            bytes_uploaded, status, error, created_at, updated_at, expires_at
       FROM CloudDrive_upload_sessions
      WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<UploadSessionRow>()
}

async function taskStatus(db: D1Database, userId: string, id: string): Promise<string | null> {
  const row = await db.prepare(
    'SELECT status FROM CloudDrive_tasks WHERE user_id = ? AND id = ?',
  ).bind(userId, id).first<{ status: string }>()
  return row?.status ?? null
}

async function writeTask(
  db: D1Database,
  task: RemoteTaskRow,
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
  progress: Record<string, unknown>,
  error: string | null,
  lockUntil: number | null,
): Promise<void> {
  const now = Date.now()
  await db.prepare(
    `UPDATE CloudDrive_tasks
        SET status = ?, progress = ?, error = ?, locked_until = ?, started_at = COALESCE(started_at, ?),
            finished_at = ?, updated_at = ?
      WHERE user_id = ? AND id = ?`,
  ).bind(
    status,
    JSON.stringify(progress),
    error,
    lockUntil,
    now,
    status === 'completed' || status === 'failed' || status === 'cancelled' ? now : null,
    now,
    task.user_id, task.id,
  ).run()
}

/** Leaves the session and its parts clean when a task fails or the reader cancels it. */
async function abandonSession(env: Env, task: RemoteTaskRow, session: UploadSessionRow, status: 'aborted' | 'failed'): Promise<void> {
  await discardSessionObjects(env, session)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM CloudDrive_upload_parts WHERE session_id = ?1').bind(session.id),
    env.DB.prepare(
      `UPDATE CloudDrive_upload_sessions SET status = ?3, updated_at = ?4
        WHERE user_id = ?1 AND id = ?2 AND status = 'active'`,
    ).bind(session.user_id, session.id, status, Date.now()),
    env.DB.prepare(
      `UPDATE CloudDrive_tasks SET status = 'failed', error = COALESCE(error, 'The remote upload did not finish'),
              locked_until = NULL, finished_at = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND status IN ('queued', 'running')`,
    ).bind(Date.now(), Date.now(), task.user_id, task.id),
  ])
}

/**
 * Works one URL upload until the budget runs out. One part per ranged request keeps each step small
 * enough for a worker invocation; the part rows make the next call continue where this one stopped.
 */
export async function runRemoteUploadTask(env: Env, task: RemoteTaskRow, now = Date.now()): Promise<'completed' | 'handed-off' | 'cancelled'> {
  const payload = payloadOf(task.payload)
  const bucket = env.FILES
  if (!bucket) throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound on this deployment')
  const session = await sessionById(env.DB, task.user_id, payload.sessionId)
  if (!session || session.status !== 'active') {
    // The session completes or is aborted elsewhere; a queued task has nothing left to do.
    if (payload.sessionId) await writeTask(env.DB, task, 'failed', { done: 0, total: 0 }, 'The upload session is no longer active', null)
    return 'cancelled'
  }
  const started = now
  const progressOf = (done: number, bytes: number): Record<string, unknown> => ({
    done,
    total: session.total_parts,
    bytes,
  })

  if (payload.mode === 'direct') {
    const bytes = await fetchWhole(payload.url, payload.size)
    const status = await taskStatus(env.DB, task.user_id, task.id)
    if (status === 'cancelled') {
      await abandonSession(env, task, session, 'aborted')
      return 'cancelled'
    }
    if (!session.storage_key) throw new ApiError(500, 'internal', 'The upload session has no storage key')
    await bucket.put(session.storage_key, bytes, { httpMetadata: { contentType: session.mime } })
    await completeUploadSession(env, task.user_id, session, decodeSessionConflict(session.error))
    await writeTask(env.DB, task, 'completed', progressOf(1, payload.size), null, null)
    return 'completed'
  }

  if (!session.storage_key || !session.provider_upload_id) {
    throw new ApiError(500, 'internal', 'The multipart upload state is missing')
  }
  const multipart = bucket.resumeMultipartUpload(session.storage_key, session.provider_upload_id)

  for (;;) {
    const status = await taskStatus(env.DB, task.user_id, task.id)
    // The reader may cancel while a part is in flight; the next step must not resume it.
    if (status === 'cancelled') {
      await abandonSession(env, task, session, 'aborted')
      return 'cancelled'
    }
    const { results } = await env.DB.prepare(
      'SELECT part_number FROM CloudDrive_upload_parts WHERE session_id = ? ORDER BY part_number',
    ).bind(session.id).all<{ part_number: number }>()
    const uploaded = new Set((results ?? []).map((row) => row.part_number))
    if (uploaded.size === session.total_parts) {
      await completeUploadSession(env, task.user_id, session, decodeSessionConflict(session.error))
      await writeTask(env.DB, task, 'completed', progressOf(session.total_parts, session.size), null, null)
      return 'completed'
    }
    let partNumber = 1
    while (uploaded.has(partNumber)) partNumber++
    const start = (partNumber - 1) * session.part_size
    const end = Math.min(start + session.part_size - 1, session.size - 1)
    const expected = end - start + 1
    const bytes = await fetchRange(payload.url, start, end, expected)
    const part = await multipart.uploadPart(partNumber, bytes)
    if (!part.etag) throw new ApiError(500, 'internal', 'R2 did not return a part etag')
    const stepNow = Date.now()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO CloudDrive_upload_parts (session_id, part_number, etag, size, uploaded_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(session_id, part_number) DO UPDATE SET
           etag = excluded.etag, size = excluded.size, uploaded_at = excluded.uploaded_at`,
      ).bind(session.id, partNumber, part.etag, bytes.byteLength, stepNow),
      env.DB.prepare(
        `UPDATE CloudDrive_upload_sessions
            SET parts_uploaded = (SELECT COUNT(*) FROM CloudDrive_upload_parts WHERE session_id = ?2),
                bytes_uploaded = (SELECT COALESCE(SUM(size), 0) FROM CloudDrive_upload_parts WHERE session_id = ?2),
                updated_at = ?3
          WHERE user_id = ?1 AND id = ?2 AND status = 'active'`,
      ).bind(task.user_id, session.id, stepNow),
    ])
    const done = uploaded.size + 1
    const bytesDone = Math.min(session.size, start + bytes.byteLength)
    await writeTask(env.DB, task, 'running', progressOf(done, bytesDone), null, stepNow + LOCK_MS)
    if (Date.now() - started > TIME_BUDGET_MS) return 'handed-off'
  }
}

async function failRemoteTask(env: Env, task: RemoteTaskRow, error: unknown): Promise<void> {
  const payload = payloadOf(task.payload)
  const session = await sessionById(env.DB, task.user_id, payload.sessionId)
  const message = error instanceof Error ? error.message.slice(0, 500) : 'The remote upload failed'
  if (session && session.status === 'active') {
    await discardSessionObjects(env, session)
    await env.DB.prepare(
      `UPDATE CloudDrive_upload_sessions SET status = 'failed', updated_at = ?
        WHERE user_id = ? AND id = ? AND status = 'active'`,
    ).bind(Date.now(), task.user_id, session.id).run()
  }
  await writeTask(env.DB, task, 'failed', { done: 0, total: session?.total_parts ?? 0 }, message, null)
}

/**
 * The cron's share: continue URL uploads that are queued, or whose isolate died mid-part. A task a
 * request is still working keeps a live `locked_until`, so the sweep cannot run it twice.
 */
export async function resumeCloudDriveRemoteTasks(env: Env, now = Date.now(), limit = 4): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, status, payload, progress FROM CloudDrive_tasks
      WHERE type = 'url_upload'
        AND status IN ('queued', 'running')
        AND (locked_until IS NULL OR locked_until < ?)
      ORDER BY created_at
      LIMIT ?`,
  ).bind(now, Math.max(1, Math.min(20, limit))).all<RemoteTaskRow>()
  let resumed = 0
  for (const task of results ?? []) {
    try {
      await runRemoteUploadTask(env, task, now)
      resumed++
    } catch (error) {
      console.warn('[clouddrive] a remote URL upload could not continue:', task.id, error)
      await failRemoteTask(env, task, error)
    }
  }
  return resumed
}

export { failRemoteTask, sessionById }
