/**
 * `POST /uploads/url` starts an offline download: the worker pulls a remote HTTP file into R2.
 *
 * The probe runs in the request so the reader learns immediately whether the address is reachable,
 * how large the file is and whether the server honours ranged reads. The transfer itself runs as a
 * `url_upload` task so the progress is visible in the transfer centre, cancellation is honoured
 * between parts, and the cron sweep can continue a task whose isolate was killed.
 */
import { Hono, type Context } from 'hono'
import {
  CLOUDDRIVE_LIMITS,
  categoryFor,
  childPath,
  cloudDriveNameProblem,
  foldedName,
  normalizeCloudDrivePath,
} from '@shared/clouddrive/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { readJson } from '../lib/request'
import { assertMetaAccess } from './routes-meta'
import { PRIMARY_MOUNT_ID, ensurePrimaryMount, readCloudDriveSettings } from './store'
import {
  SESSION_TTL_MS,
  entryOf,
  findLiveSibling,
  findParent,
  mountNameFor,
  parseUploadConflict,
  sessionConflictValue,
  uniqueName,
  usedPrimaryBytes,
} from './upload-finalize'
import { failRemoteTask, probeRemote, runRemoteUploadTask, type RemoteTaskRow } from './remote'

export const clouddriveUploadUrlRoutes = new Hono<AppBindings>()

const JSON_MAX_BYTES = 64 * 1024
const MAX_URL_LENGTH = 4096
const MIME_MAX_LENGTH = 255
/** A task owns its lock while the request that started it is still working. */
const TASK_LOCK_MS = 120_000

interface UrlUploadBody {
  url?: unknown
  mountId?: unknown
  parentPath?: unknown
  name?: unknown
  conflict?: unknown
}

function requireUserId(c: Context<AppBindings>): string {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  return userId
}

function invalidPath(message: string): ApiError {
  return new ApiError(400, 'clouddrive_path_invalid', message)
}

clouddriveUploadUrlRoutes.post('/uploads/url', async (c) => {
  const userId = requireUserId(c)
  await ensurePrimaryMount(c.env.DB, userId)
  const body = await readJson<UrlUploadBody>(c, JSON_MAX_BYTES)
  const mountId = body.mountId === undefined || body.mountId === ''
    ? PRIMARY_MOUNT_ID
    : body.mountId
  if (mountId !== PRIMARY_MOUNT_ID) {
    throw new ApiError(400, 'clouddrive_mount_unavailable', 'Only the primary mount accepts uploads in this release')
  }
  if (!c.env.FILES) throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound on this deployment')

  const rawParent = body.parentPath === undefined ? '/' : body.parentPath
  if (typeof rawParent !== 'string') throw invalidPath('The parent path is not valid')
  let parentPath: string
  try {
    parentPath = normalizeCloudDrivePath(rawParent)
  } catch {
    throw invalidPath('The parent path is not valid')
  }
  await assertMetaAccess(c, userId, mountId, parentPath)

  if (typeof body.url !== 'string') throw ApiError.badRequest('A remote URL is required')
  const url = body.url.trim()
  if (url.length === 0 || url.length > MAX_URL_LENGTH) throw ApiError.badRequest('The remote URL is not valid')
  const probe = await probeRemote(url)
  if (probe.size === null) {
    throw ApiError.badRequest('The remote server did not declare a file size, so a resumable transfer cannot be planned')
  }

  const requestedName = body.name === undefined || body.name === '' ? probe.filename : body.name
  if (typeof requestedName !== 'string') throw invalidPath('A file name is required')
  const name = requestedName.normalize('NFC')
  const nameProblem = cloudDriveNameProblem(name)
  if (nameProblem) throw invalidPath(nameProblem)

  const conflict = parseUploadConflict(body.conflict)
  const parentId = await findParent(c.env.DB, userId, mountId, parentPath)
  const existing = await findLiveSibling(c.env.DB, userId, mountId, parentId, foldedName(name))
  const mountName = await mountNameFor(c.env.DB, userId, mountId)
  const mime = probe.mime.slice(0, MIME_MAX_LENGTH)
  const hasThumbnail = Boolean(c.env.IMAGES) && mime.startsWith('image/')
  if (existing && conflict === 'skip') {
    return c.json({
      skipped: true,
      existing: entryOf(existing, mountId, mountName, hasThumbnail),
      entryPath: existing.path,
    })
  }
  if (existing && existing.kind === 'folder' && conflict === 'overwrite') {
    throw ApiError.conflict('A folder with that name already exists')
  }

  const settings = await readCloudDriveSettings(c.env.DB, userId)
  if (probe.size > settings.uploadMaxFileBytes) {
    throw ApiError.tooLarge(`The file is larger than the ${settings.uploadMaxFileBytes}-byte limit`)
  }
  if (settings.quotaDefaultBytes !== null) {
    const used = await usedPrimaryBytes(c.env.DB, userId)
    const replaced = existing && conflict === 'overwrite' && existing.kind === 'file' ? existing.size : 0
    if (used + probe.size - replaced > settings.quotaDefaultBytes) {
      throw new ApiError(403, 'clouddrive_quota_exceeded', 'This upload would exceed the storage quota', {
        usedBytes: used,
        quotaBytes: settings.quotaDefaultBytes,
      })
    }
  }

  const finalName = conflict === 'rename'
    ? await uniqueName(c.env.DB, userId, mountId, parentId, name)
    : name
  const category = categoryFor(finalName, mime)
  const fileId = newId()
  const storageKey = `CloudDrive/${category}/${fileId}`
  const entryPath = childPath(parentPath, finalName)

  const strategy: 'direct' | 'multipart' = probe.size <= CLOUDDRIVE_LIMITS.directUploadMaxBytes ? 'direct' : 'multipart'
  if (strategy === 'multipart' && !probe.ranges) {
    throw ApiError.badRequest('The remote server does not support range requests, so a large file cannot be fetched in resumable parts')
  }
  let partSize = 0
  let totalParts = 1
  if (strategy === 'multipart') {
    partSize = Math.min(
      Math.max(settings.uploadPartSizeBytes, CLOUDDRIVE_LIMITS.partSizeMinBytes),
      CLOUDDRIVE_LIMITS.partSizeMaxBytes,
    )
    totalParts = Math.ceil(probe.size / partSize)
    if (totalParts > CLOUDDRIVE_LIMITS.partsMax) {
      partSize = Math.ceil(probe.size / CLOUDDRIVE_LIMITS.partsMax)
      if (partSize > CLOUDDRIVE_LIMITS.partSizeMaxBytes) {
        throw ApiError.tooLarge('The file needs more parts than the multipart limit allows')
      }
      totalParts = Math.ceil(probe.size / partSize)
    }
  }

  let multipart: R2MultipartUpload | null = null
  if (strategy === 'multipart') {
    multipart = await c.env.FILES.createMultipartUpload(storageKey, { httpMetadata: { contentType: mime } })
  }

  const now = Date.now()
  const sessionId = newId()
  const taskId = newId()
  const task: RemoteTaskRow = {
    id: taskId,
    user_id: userId,
    status: 'queued',
    payload: JSON.stringify({ sessionId, url: probe.url, size: probe.size, mode: strategy }),
    progress: JSON.stringify({ done: 0, total: totalParts, bytes: 0 }),
  }
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO CloudDrive_upload_sessions
           (id, user_id, mount_id, parent_id, path, name, name_folded, mime, category, size, strategy,
            part_size, total_parts, provider_upload_id, storage_key, parts_uploaded, bytes_uploaded,
            status, error, created_at, updated_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, 0,
                 'active', ?16, ?17, ?17, ?18)`,
      ).bind(
        sessionId, userId, mountId, parentId, entryPath, finalName, foldedName(finalName), mime,
        category, probe.size, strategy, partSize, totalParts, multipart?.uploadId ?? null, storageKey,
        sessionConflictValue(conflict), now, now + SESSION_TTL_MS,
      ),
      c.env.DB.prepare(
        `INSERT INTO CloudDrive_tasks
           (id, user_id, type, status, payload, progress, error, locked_until,
            created_at, started_at, finished_at, updated_at)
         VALUES (?, ?, 'url_upload', 'queued', ?, ?, NULL, ?, ?, NULL, NULL, ?)`,
      ).bind(
        taskId, userId, task.payload,
        JSON.stringify({ done: 0, total: totalParts, bytes: 0 }),
        now + TASK_LOCK_MS, now, now,
      ),
    ])
  } catch (error) {
    if (multipart) {
      await multipart.abort().catch((abortError: unknown) => {
        console.warn('[inkstone] CloudDrive remote upload abort after a failed session insert failed:', abortError)
      })
    }
    throw error
  }

  const run = runRemoteUploadTask(c.env, task, now).catch(async (error: unknown) => {
    console.warn('[clouddrive] the started remote upload failed:', taskId, error)
    await failRemoteTask(c.env, task, error)
  })
  try {
    c.executionCtx.waitUntil(run)
  } catch {
    // A unit-test context has no ExecutionContext; awaiting the same promise keeps the behaviour.
    await run
  }
  return c.json({ taskId, sessionId, entryPath, strategy }, 202)
})
