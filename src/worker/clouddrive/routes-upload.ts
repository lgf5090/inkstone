/**
 * Session-based uploads into the primary R2 mount.
 *
 * Small files take one PUT of raw bytes; everything else becomes an R2 multipart upload whose parts
 * are recorded in `CloudDrive_upload_parts` so a refresh can resume. The object key is allocated at
 * init (`CloudDrive/{category}/{fileId}`) and the file row is only written on completion, which keeps
 * an abandoned upload out of the virtual tree.
 *
 * Only the primary mount is accepted here. External mounts need a storage driver and are out of scope
 * for this pass; the `clouddrive_mount_unavailable` answer is explicit rather than a silent fallback.
 * A remote read from an HTTP address lives in `routes-upload-url.ts`; it ends in the same session
 * table and the same finalizer, so a URL upload and a browser upload produce identical rows.
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
import { assignParts, deletePartObject, deleteUploadPartObjects, partMounts, writePartObject } from './distributed'
import {
  SESSION_TTL_MS,
  abortMultipart,
  completeUploadSession,
  decodeSessionConflict,
  discardDirectObject,
  entryOf,
  findLiveSibling,
  findParent,
  mountNameFor,
  parseUploadConflict,
  sessionConflictValue,
  uniqueName,
  usedPrimaryBytes,
  type UploadSessionRow,
} from './upload-finalize'

export const clouddriveUploadRoutes = new Hono<AppBindings>()

const UPLOAD_JSON_MAX_BYTES = 64 * 1024
const COMPLETE_JSON_MAX_BYTES = 1024 * 1024
const MIME_MAX_LENGTH = 255

interface UploadInitBody {
  mountId?: unknown
  parentPath?: unknown
  name?: unknown
  size?: unknown
  mime?: unknown
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

async function readOptionalJson(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  const declared = c.req.header('content-length')
  if (declared !== undefined && Number(declared) > COMPLETE_JSON_MAX_BYTES) {
    throw ApiError.tooLarge('The completion payload is too large')
  }
  const text = await c.req.text()
  if (text.length > COMPLETE_JSON_MAX_BYTES) throw ApiError.tooLarge('The completion payload is too large')
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw ApiError.badRequest('The request body is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ApiError.badRequest('The request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

async function sessionById(
  db: D1Database,
  userId: string,
  id: string,
): Promise<UploadSessionRow | null> {
  return await db.prepare(
    `SELECT id, user_id, mount_id, parent_id, path, name, name_folded, mime, category, size,
            strategy, part_size, total_parts, provider_upload_id, storage_key, parts_uploaded,
            bytes_uploaded, status, error, created_at, updated_at, expires_at
       FROM CloudDrive_upload_sessions
      WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<UploadSessionRow>()
}

async function expireSession(c: Context<AppBindings>, session: UploadSessionRow): Promise<void> {
  await abortMultipart(c.env.FILES, session)
  await discardDirectObject(c.env.FILES, session)
  const now = Date.now()
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM CloudDrive_upload_parts WHERE session_id = ?1').bind(session.id),
    c.env.DB.prepare(
      `UPDATE CloudDrive_upload_sessions SET status = 'expired', updated_at = ?3
        WHERE user_id = ?1 AND id = ?2 AND status = 'active'`,
    ).bind(session.user_id, session.id, now),
  ])
}

async function activeSession(
  c: Context<AppBindings>,
  userId: string,
  id: string,
): Promise<UploadSessionRow> {
  const session = await sessionById(c.env.DB, userId, id)
  if (!session || session.status !== 'active') throw ApiError.notFound('Upload session not found')
  if (session.expires_at <= Date.now()) {
    await expireSession(c, session)
    throw new ApiError(400, 'clouddrive_upload_expired', 'The upload session expired')
  }
  return session
}

clouddriveUploadRoutes.post('/uploads', async (c) => {
  const userId = requireUserId(c)
  await ensurePrimaryMount(c.env.DB, userId)

  const body = await readJson<UploadInitBody>(c, UPLOAD_JSON_MAX_BYTES)
  const mountId = body.mountId === undefined || body.mountId === ''
    ? PRIMARY_MOUNT_ID
    : body.mountId
  if (mountId !== PRIMARY_MOUNT_ID) {
    throw new ApiError(400, 'clouddrive_mount_unavailable', 'Only the primary mount accepts uploads in this release')
  }
  const bucket = c.env.FILES
  if (!bucket) throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound on this deployment')

  const rawParentPath = body.parentPath === undefined ? '/' : body.parentPath
  if (typeof rawParentPath !== 'string') throw invalidPath('The parent path is not valid')
  let parentPath: string
  try {
    parentPath = normalizeCloudDrivePath(rawParentPath)
  } catch {
    throw invalidPath('The parent path is not valid')
  }

  await assertMetaAccess(c, userId, mountId, parentPath)
  if (typeof body.name !== 'string') throw invalidPath('A file name is required')
  const name = body.name.normalize('NFC')
  const nameProblem = cloudDriveNameProblem(name)
  if (nameProblem) throw invalidPath(nameProblem)

  const size = body.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw ApiError.badRequest('size must be a non-negative integer')
  }
  const mime = typeof body.mime === 'string' && body.mime.trim()
    ? body.mime.trim().slice(0, MIME_MAX_LENGTH)
    : 'application/octet-stream'
  const conflict = parseUploadConflict(body.conflict)

  const parentId = await findParent(c.env.DB, userId, mountId, parentPath)
  const existing = await findLiveSibling(c.env.DB, userId, mountId, parentId, foldedName(name))
  const mountName = await mountNameFor(c.env.DB, userId, mountId)
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
  if (size > settings.uploadMaxFileBytes) {
    throw ApiError.tooLarge(`The file is larger than the ${settings.uploadMaxFileBytes}-byte limit`)
  }
  if (settings.quotaDefaultBytes !== null) {
    const used = await usedPrimaryBytes(c.env.DB, userId)
    // An overwrite replaces those bytes and the predecessor is kept only as a version, which the quota
    // does not count; charging both would refuse a same-size update on a nearly full drive.
    const replaced = existing && conflict === 'overwrite' && existing.kind === 'file' ? existing.size : 0
    if (used + size - replaced > settings.quotaDefaultBytes) {
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
  const storageKey: string | null = `CloudDrive/${category}/${fileId}`
  const entryPath = childPath(parentPath, finalName)

  let strategy: 'direct' | 'multipart' | 'distributed' = 'direct'
  let partSize = 0
  let totalParts = 0
  let distributedMounts: Awaited<ReturnType<typeof partMounts>> = []
  const distributedPartSize = Math.min(Math.max(32 * 1024 * 1024, settings.uploadPartSizeBytes), CLOUDDRIVE_LIMITS.partSizeMaxBytes)
  if (size >= settings.uploadDistributedMinBytes) {
    distributedMounts = await partMounts(c.env.DB, userId, distributedPartSize)
  }
  if (distributedMounts.length >= 2) {
    strategy = 'distributed'
    partSize = distributedPartSize
    totalParts = Math.ceil(size / partSize)
    if (totalParts < 1) totalParts = 1
    if (totalParts > CLOUDDRIVE_LIMITS.partsMax) {
      throw ApiError.tooLarge('The file needs more parts than the multipart limit allows')
    }
  } else if (size > CLOUDDRIVE_LIMITS.directUploadMaxBytes) {
    strategy = 'multipart'
    partSize = Math.max(settings.uploadPartSizeBytes, Math.ceil(size / CLOUDDRIVE_LIMITS.partsMax))
    partSize = Math.min(partSize, CLOUDDRIVE_LIMITS.partSizeMaxBytes)
    totalParts = Math.ceil(size / partSize)
    if (totalParts < 1) totalParts = 1
    if (totalParts > CLOUDDRIVE_LIMITS.partsMax) {
      throw ApiError.tooLarge('The file needs more parts than the multipart limit allows')
    }
  }

  let multipart: R2MultipartUpload | null = null
  if (strategy === 'multipart') {
    multipart = await bucket.createMultipartUpload(storageKey, { httpMetadata: { contentType: mime } })
  }

  const now = Date.now()
  const sessionId = newId()
  const sessionKey = strategy === 'distributed' ? null : storageKey
  const assignments = strategy === 'distributed' ? assignParts(sessionId, totalParts, distributedMounts, partSize, size) : []
  try {
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO CloudDrive_upload_sessions
           (id, user_id, mount_id, parent_id, path, name, name_folded, mime, category, size, strategy,
            part_size, total_parts, provider_upload_id, storage_key, parts_uploaded, bytes_uploaded,
            status, error, created_at, updated_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, 0,
                 'active', ?16, ?17, ?17, ?18)`,
      ).bind(
        sessionId, userId, mountId, parentId, entryPath, finalName, foldedName(finalName), mime,
        category, size, strategy, partSize, totalParts, multipart?.uploadId ?? null, sessionKey,
        conflict === 'overwrite' ? sessionConflictValue(conflict) : null,
        now, now + SESSION_TTL_MS,
      ),
      ...assignments.map((part) => c.env.DB.prepare(
        `INSERT INTO CloudDrive_upload_part_objects
           (session_id, part_number, mount_id, storage_key, size, etag, uploaded_at)
         VALUES (?, ?, ?, ?, 0, NULL, NULL)`,
      ).bind(sessionId, part.partNumber, part.mountId, part.storageKey)),
    ]
    await c.env.DB.batch(statements)
  } catch (error) {
    if (multipart) await multipart.abort().catch((abortError: unknown) => {
      console.warn('[inkstone] CloudDrive multipart abort after a failed session insert failed:', abortError)
    })
    throw error
  }

  return c.json({
    session: { id: sessionId, strategy, partSize, totalParts, uploadedParts: 0 },
    entryPath,
  })
})

clouddriveUploadRoutes.put('/uploads/:id/content', async (c) => {
  const userId = requireUserId(c)
  const session = await activeSession(c, userId, c.req.param('id'))
  if (session.strategy !== 'direct') throw ApiError.badRequest('This upload expects multipart parts')
  const bucket = c.env.FILES
  if (!bucket) throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound on this deployment')
  const key = session.storage_key
  if (!key) throw new ApiError(500, 'internal', 'The upload session has no storage key')

  const declared = c.req.header('content-length')
  if (declared !== undefined) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) throw ApiError.badRequest('Content-Length is not a byte count')
    if (length > session.size) throw ApiError.tooLarge('The request body is larger than the declared file size')
  }

  const bytes = new Uint8Array(await c.req.arrayBuffer())
  const received = bytes.byteLength
  if (received > session.size) {
    throw ApiError.tooLarge('The request body is larger than the declared file size')
  }
  if (received !== session.size) {
    throw ApiError.badRequest(`The request body was ${received} bytes but the session declared ${session.size}`)
  }
  const object = await bucket.put(key, bytes, { httpMetadata: { contentType: session.mime } })

  const now = Date.now()
  await c.env.DB.prepare(
    `UPDATE CloudDrive_upload_sessions SET bytes_uploaded = ?3, updated_at = ?4
      WHERE user_id = ?1 AND id = ?2 AND status = 'active'`,
  ).bind(userId, session.id, received, now).run()

  return c.json({ etag: object.etag })
})

clouddriveUploadRoutes.put('/uploads/:id/parts/:n', async (c) => {
  const userId = requireUserId(c)
  const session = await activeSession(c, userId, c.req.param('id'))
  if (session.strategy === 'distributed') {
    const partNumber = Number(c.req.param('n'))
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > session.total_parts) {
      throw ApiError.badRequest('The part number is out of range')
    }
    const declared = c.req.header('content-length')
    if (declared !== undefined) {
      const length = Number(declared)
      if (!Number.isSafeInteger(length) || length < 0) throw ApiError.badRequest('Content-Length is not a byte count')
      if (length > session.part_size) throw ApiError.tooLarge('A part cannot be larger than the declared part size')
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const isLast = partNumber === session.total_parts
    if (bytes.byteLength > session.part_size) throw ApiError.tooLarge('A part cannot be larger than the declared part size')
    if ((!isLast && bytes.byteLength !== session.part_size) || (isLast && bytes.byteLength === 0)) {
      throw ApiError.badRequest('The part body does not match the declared part size')
    }
    const plan = await c.env.DB.prepare(
      `SELECT mount_id, storage_key FROM CloudDrive_upload_part_objects
        WHERE session_id = ? AND part_number = ?`,
    ).bind(session.id, partNumber).first<{ mount_id: string; storage_key: string }>()
    if (!plan) throw ApiError.badRequest('The part has no storage assignment')
    let mountId = plan.mount_id
    let etag: string | null
    try {
      etag = await writePartObject(c.env, c.env.DB, userId, mountId, plan.storage_key, bytes, session.mime)
    } catch (error) {
      if (mountId === 'primary') throw error
      console.warn('[inkstone] CloudDrive distributed part write failed; retrying on the primary mount:', error)
      try {
        await deletePartObject(c.env, c.env.DB, userId, mountId, plan.storage_key)
      } catch (cleanupError) {
        console.warn('[inkstone] removing a failed distributed part failed:', cleanupError)
      }
      mountId = 'primary'
      etag = await writePartObject(c.env, c.env.DB, userId, mountId, plan.storage_key, bytes, session.mime)
    }
    const now = Date.now()
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE CloudDrive_upload_part_objects
            SET mount_id = ?6, size = ?3, etag = ?4, uploaded_at = ?5
          WHERE session_id = ?1 AND part_number = ?2`,
      ).bind(session.id, partNumber, bytes.byteLength, etag, now, mountId),
      c.env.DB.prepare(
        `UPDATE CloudDrive_upload_sessions
            SET parts_uploaded = (SELECT COUNT(*) FROM CloudDrive_upload_part_objects
                                   WHERE session_id = ?2 AND uploaded_at IS NOT NULL),
                bytes_uploaded = (SELECT COALESCE(SUM(size), 0) FROM CloudDrive_upload_part_objects
                                   WHERE session_id = ?2),
                updated_at = ?3
          WHERE user_id = ?1 AND id = ?2 AND status = 'active'`,
      ).bind(userId, session.id, now),
    ])
    return c.json({ partNumber, etag })
  }
  if (session.strategy !== 'multipart') throw ApiError.badRequest('This upload is a single-request upload')
  const bucket = c.env.FILES
  if (!bucket) throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound on this deployment')
  const key = session.storage_key
  if (!key || !session.provider_upload_id) {
    throw new ApiError(500, 'internal', 'The multipart upload state is missing')
  }

  const partNumber = Number(c.req.param('n'))
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > session.total_parts) {
    throw ApiError.badRequest('The part number is out of range')
  }
  const declared = c.req.header('content-length')
  if (declared !== undefined) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) throw ApiError.badRequest('Content-Length is not a byte count')
    if (length > session.part_size) throw ApiError.tooLarge('A part cannot be larger than the declared part size')
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  const received = bytes.byteLength
  if (received > session.part_size) throw ApiError.tooLarge('A part cannot be larger than the declared part size')
  const uploaded = await bucket
    .resumeMultipartUpload(key, session.provider_upload_id)
    .uploadPart(partNumber, bytes)

  const isLast = partNumber === session.total_parts
  if ((!isLast && received !== session.part_size) || (isLast && received === 0)) {
    throw ApiError.badRequest('The part body does not match the declared part size')
  }
  if (!uploaded.etag) throw new ApiError(500, 'internal', 'R2 did not return a part etag')

  const now = Date.now()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO CloudDrive_upload_parts (session_id, part_number, etag, size, uploaded_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(session_id, part_number) DO UPDATE SET
         etag = excluded.etag, size = excluded.size, uploaded_at = excluded.uploaded_at`,
    ).bind(session.id, partNumber, uploaded.etag, received, now),
    c.env.DB.prepare(
      `UPDATE CloudDrive_upload_sessions
          SET parts_uploaded = (SELECT COUNT(*) FROM CloudDrive_upload_parts WHERE session_id = ?2),
              bytes_uploaded = (SELECT COALESCE(SUM(size), 0) FROM CloudDrive_upload_parts WHERE session_id = ?2),
              updated_at = ?3
        WHERE user_id = ?1 AND id = ?2 AND status = 'active'`,
    ).bind(userId, session.id, now),
  ])

  return c.json({ partNumber, etag: uploaded.etag })
})

clouddriveUploadRoutes.post('/uploads/:id/complete', async (c) => {
  const userId = requireUserId(c)
  const session = await activeSession(c, userId, c.req.param('id'))
  const body = await readOptionalJson(c)
  const conflict = body.conflict === undefined
    ? decodeSessionConflict(session.error)
    : parseUploadConflict(body.conflict)
  return c.json(await completeUploadSession(c.env, userId, session, conflict))
})

clouddriveUploadRoutes.post('/uploads/:id/abort', async (c) => {
  const userId = requireUserId(c)
  const session = await sessionById(c.env.DB, userId, c.req.param('id'))
  if (!session) throw ApiError.notFound('Upload session not found')

  if (session.status === 'active') {
    await abortMultipart(c.env.FILES, session)
    await discardDirectObject(c.env.FILES, session)
    if (session.strategy === 'distributed') {
      await deleteUploadPartObjects(c.env, c.env.DB, userId, session.id)
    }
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM CloudDrive_upload_parts WHERE session_id = ?1').bind(session.id),
      c.env.DB.prepare('DELETE FROM CloudDrive_upload_part_objects WHERE session_id = ?1').bind(session.id),
      c.env.DB.prepare(
        `UPDATE CloudDrive_upload_sessions SET status = 'aborted', updated_at = ?3
          WHERE user_id = ?1 AND id = ?2 AND status = 'active'`,
      ).bind(userId, session.id, Date.now()),
    ])
  } else {
    // A retried abort still clears any part rows a partial earlier attempt left behind.
    await c.env.DB.prepare('DELETE FROM CloudDrive_upload_parts WHERE session_id = ?1')
      .bind(session.id).run()
  }
  return c.json({ ok: true })
})

clouddriveUploadRoutes.get('/uploads/:id', async (c) => {
  const userId = requireUserId(c)
  // A reader coming back to an unfinished upload needs the part list, not a prefix count: parts may
  // have been written out of order, and re-sending one the bucket already holds costs the whole part.
  const session = await activeSession(c, userId, c.req.param('id'))
  const { results } = await c.env.DB.prepare(
    `SELECT part_number FROM CloudDrive_upload_parts WHERE session_id = ?1 ORDER BY part_number`,
  ).bind(session.id).all<{ part_number: number }>()
  return c.json({
    session: {
      id: session.id,
      mountId: session.mount_id,
      path: session.path,
      name: session.name,
      mime: session.mime,
      size: session.size,
      strategy: session.strategy,
      partSize: session.part_size,
      totalParts: session.total_parts,
      uploadedParts: (results ?? []).map((row) => row.part_number),
      expiresAt: session.expires_at,
    },
  })
})

clouddriveUploadRoutes.get('/uploads', async (c) => {
  const userId = requireUserId(c)
  const status = c.req.query('status') === 'all' ? 'all' : 'active'
  const { results } = status === 'active'
    ? await c.env.DB.prepare(
        `SELECT id, mount_id, path, name, mime, category, size, strategy, part_size, total_parts,
                parts_uploaded, bytes_uploaded, status, error, updated_at, expires_at
           FROM CloudDrive_upload_sessions
          WHERE user_id = ?1 AND status = 'active' AND expires_at > ?2
          ORDER BY updated_at DESC`,
      ).bind(userId, Date.now()).all<UploadSessionRow>()
    : await c.env.DB.prepare(
        `SELECT id, mount_id, path, name, mime, category, size, strategy, part_size, total_parts,
                parts_uploaded, bytes_uploaded, status, error, updated_at, expires_at
           FROM CloudDrive_upload_sessions
          WHERE user_id = ?1
          ORDER BY updated_at DESC`,
      ).bind(userId).all<UploadSessionRow>()

  const sessions = (results ?? []).map((row) => ({
    id: row.id,
    mountId: row.mount_id,
    entryPath: row.path,
    name: row.name,
    mime: row.mime,
    category: row.category,
    size: row.size,
    strategy: row.strategy,
    partSize: row.part_size,
    totalParts: row.total_parts,
    partsUploaded: row.parts_uploaded,
    bytesUploaded: row.bytes_uploaded,
    status: row.status,
    error: decodeSessionConflict(row.error) === 'rename' ? row.error : null,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  }))
  return c.json({ sessions, entryPath: sessions[0]?.entryPath ?? null })
})
