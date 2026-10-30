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
 *
 * TODO: `POST /uploads/url` (SSRF-checked remote fetch) is not implemented in this pass.
 */
import { Hono, type Context } from 'hono'
import { pinyin } from 'pinyin-pro'
import {
  CLOUDDRIVE_LIMITS,
  autoSuffixName,
  categoryFor,
  childPath,
  cloudDriveNameProblem,
  foldedName,
  normalizeCloudDrivePath,
  parentPathOf,
  type CloudDriveCategory,
  type CloudDriveEntry,
} from '@shared/clouddrive/model'
import type { AppBindings, Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { readJson } from '../lib/request'
import { PRIMARY_MOUNT_ID, ensurePrimaryMount, readCloudDriveSettings } from './store'
import { storageKeyReferenced } from './store-files'

export const clouddriveUploadRoutes = new Hono<AppBindings>()

const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const UPLOAD_JSON_MAX_BYTES = 64 * 1024
const COMPLETE_JSON_MAX_BYTES = 1024 * 1024
const MAX_RENAME_ATTEMPTS = 1000
const MIME_MAX_LENGTH = 255

/**
 * The session table has no `conflict` column, so the one decision that must survive from init to
 * complete is kept in its free-text `error` column behind a recognisable JSON prefix. A real error
 * is never valid JSON of this shape, so `decodeSessionConflict` cannot mistake one for the other.
 */
const SESSION_CONFLICT_PREFIX = '{"conflict":"'

const UPLOAD_CONFLICTS = ['rename', 'overwrite', 'skip'] as const
type UploadConflict = (typeof UPLOAD_CONFLICTS)[number]

interface UploadInitBody {
  mountId?: unknown
  parentPath?: unknown
  name?: unknown
  size?: unknown
  mime?: unknown
  conflict?: unknown
}

interface UploadSessionRow {
  id: string
  user_id: string
  mount_id: string
  parent_id: string
  path: string
  name: string
  name_folded: string
  mime: string
  category: string
  size: number
  strategy: string
  part_size: number
  total_parts: number
  provider_upload_id: string | null
  storage_key: string | null
  parts_uploaded: number
  bytes_uploaded: number
  status: string
  error: string | null
  created_at: number
  updated_at: number
  expires_at: number
}

interface ParentRow {
  id: string
  kind: string
}

interface FileRow {
  id: string
  name: string
  path: string
  kind: string
  category: string
  mime: string
  size: number
  etag: string | null
  checksum: string | null
  storage_key: string | null
  color: string
  starred_at: number | null
  uploaded_at: number
  modified_at: number
}

interface PartRow {
  part_number: number
  etag: string | null
  size: number
}

function requireUserId(c: Context<AppBindings>): string {
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  return userId
}

function invalidPath(message: string): ApiError {
  return new ApiError(400, 'clouddrive_path_invalid', message)
}

function parseConflict(value: unknown): UploadConflict {
  if (value === undefined || value === null || value === '') return 'rename'
  if (typeof value !== 'string' || !UPLOAD_CONFLICTS.includes(value as UploadConflict)) {
    throw ApiError.badRequest('conflict must be rename, overwrite or skip')
  }
  return value as UploadConflict
}

function decodeSessionConflict(value: string | null): UploadConflict {
  if (!value || !value.startsWith(SESSION_CONFLICT_PREFIX)) return 'rename'
  try {
    const parsed = JSON.parse(value) as { conflict?: unknown }
    return UPLOAD_CONFLICTS.includes(parsed.conflict as UploadConflict)
      ? parsed.conflict as UploadConflict
      : 'rename'
  } catch (error) {
    // The field is ours, but a corrupted row must still leave the upload usable under the default.
    console.warn('[inkstone] CloudDrive upload session conflict metadata is unreadable:', error)
    return 'rename'
  }
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

async function findParent(
  db: D1Database,
  userId: string,
  mountId: string,
  parentPath: string,
): Promise<string> {
  if (parentPath === '/') return ''
  const row = await db.prepare(
    `SELECT id, kind FROM CloudDrive_files
      WHERE user_id = ?1 AND mount_id = ?2 AND path = ?3 AND deleted_at IS NULL`,
  ).bind(userId, mountId, parentPath).first<ParentRow>()
  if (!row || row.kind !== 'folder') throw ApiError.notFound('Parent folder not found')
  return row.id
}

async function findLiveSibling(
  db: D1Database,
  userId: string,
  mountId: string,
  parentId: string,
  folded: string,
): Promise<FileRow | null> {
  return await db.prepare(
    `SELECT id, name, path, kind, category, mime, size, etag, checksum, storage_key, color, starred_at,
            uploaded_at, modified_at
       FROM CloudDrive_files
      WHERE user_id = ?1 AND mount_id = ?2 AND parent_id = ?3 AND name_folded = ?4
        AND deleted_at IS NULL`,
  ).bind(userId, mountId, parentId, folded).first<FileRow>()
}

async function uniqueName(
  db: D1Database,
  userId: string,
  mountId: string,
  parentId: string,
  name: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_RENAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? name : autoSuffixName(name, attempt)
    if (!(await findLiveSibling(db, userId, mountId, parentId, foldedName(candidate)))) return candidate
  }
  throw ApiError.conflict('Too many files share this name')
}

/** The quota is the deduplicated object bytes of the user's primary-mount rows, trash included. */
async function usedPrimaryBytes(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(size), 0) AS bytes FROM (
       SELECT storage_key, MAX(size) AS size FROM CloudDrive_files
        WHERE user_id = ?1 AND storage_key IS NOT NULL
        GROUP BY storage_key
     )`,
  ).bind(userId).first<{ bytes: number }>()
  return Number(row?.bytes ?? 0)
}

async function mountNameFor(db: D1Database, userId: string, mountId: string): Promise<string> {
  const row = await db.prepare(
    `SELECT name FROM CloudDrive_mounts WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, mountId).first<{ name: string }>()
  return row?.name ?? 'Cloud Drive'
}

/**
 * The pinyin first letters written next to a name. `pinyin-pro` is a dictionary call that can fail
 * on input it cannot segment; the file is still valid then, so the index stays empty and the folded
 * name search keeps working.
 */
function initialsFor(name: string): string {
  try {
    const parts = pinyin(name.normalize('NFC'), {
      pattern: 'first',
      toneType: 'none',
      type: 'array',
      nonZh: 'removed',
    })
    return parts.join('').toLocaleLowerCase().replace(/[^a-z0-9]/g, '')
  } catch (error) {
    console.warn('[inkstone] CloudDrive pinyin initials failed:', error)
    return ''
  }
}

function entryOf(
  row: FileRow,
  mountId: string,
  mountName: string,
  hasThumbnail: boolean,
): CloudDriveEntry {
  return {
    id: row.id,
    kind: row.kind === 'folder' ? 'folder' : 'file',
    name: row.name,
    path: row.path,
    mountId,
    mountName,
    category: row.category as CloudDriveCategory,
    mime: row.mime,
    size: row.size,
    uploadedAt: row.uploaded_at,
    modifiedAt: row.modified_at,
    starredAt: row.starred_at,
    readOnly: false,
    hasThumbnail,
    storage: 'primary',
    storageKind: 'r2',
    color: row.color ? row.color : null,
    tags: [],
  }
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

async function abortMultipart(bucket: R2Bucket | undefined, session: UploadSessionRow): Promise<void> {
  if (session.strategy !== 'multipart' || !session.storage_key || !session.provider_upload_id || !bucket) return
  try {
    await bucket.resumeMultipartUpload(session.storage_key, session.provider_upload_id).abort()
  } catch (error) {
    // R2 refuses to abort an upload it no longer knows (already completed, expired by the platform,
    // or removed with the bucket binding); the D1 row is the authority for the client either way.
    console.warn('[inkstone] CloudDrive multipart abort found no live upload:', error)
  }
}

/** A direct upload has already put its object, so aborting or expiring it must remove those bytes. */
async function discardDirectObject(bucket: R2Bucket | undefined, session: UploadSessionRow): Promise<void> {
  if (session.strategy !== 'direct' || !session.storage_key || !bucket) return
  try {
    await bucket.delete(session.storage_key)
  } catch (error) {
    // The object is unreferenced either way; a failed delete leaves work for the orphan scan.
    console.warn('[inkstone] CloudDrive direct upload cleanup failed:', error)
  }
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
  const conflict = parseConflict(body.conflict)

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
    if (used + size > settings.quotaDefaultBytes) {
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

  let strategy: 'direct' | 'multipart' = 'direct'
  let partSize = 0
  let totalParts = 0
  if (size > CLOUDDRIVE_LIMITS.directUploadMaxBytes) {
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
  try {
    await c.env.DB.prepare(
      `INSERT INTO CloudDrive_upload_sessions
         (id, user_id, mount_id, parent_id, path, name, name_folded, mime, category, size, strategy,
          part_size, total_parts, provider_upload_id, storage_key, parts_uploaded, bytes_uploaded,
          status, error, created_at, updated_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, 0,
               'active', ?16, ?17, ?17, ?18)`,
    ).bind(
      sessionId, userId, mountId, parentId, entryPath, finalName, foldedName(finalName), mime,
      category, size, strategy, partSize, totalParts, multipart?.uploadId ?? null, storageKey,
      conflict === 'overwrite' ? `${SESSION_CONFLICT_PREFIX}overwrite"}` : null,
      now, now + SESSION_TTL_MS,
    ).run()
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
  const bucket = c.env.FILES
  if (!bucket) throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound on this deployment')
  const key = session.storage_key
  if (!key) throw new ApiError(500, 'internal', 'The upload session has no storage key')

  const body = await readOptionalJson(c)
  const conflict = body.conflict === undefined
    ? decodeSessionConflict(session.error)
    : parseConflict(body.conflict)

  const parentPath = parentPathOf(session.path)
  const existing = await findLiveSibling(
    c.env.DB, userId, session.mount_id, session.parent_id, foldedName(session.name),
  )
  if (existing && existing.kind === 'folder' && conflict === 'overwrite') {
    throw ApiError.conflict('A folder with that name already exists')
  }
  if (existing && conflict === 'skip') {
    await abortMultipart(bucket, session)
    await discardDirectObject(bucket, session)
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM CloudDrive_upload_parts WHERE session_id = ?1').bind(session.id),
      c.env.DB.prepare('DELETE FROM CloudDrive_upload_sessions WHERE user_id = ?1 AND id = ?2')
        .bind(userId, session.id),
    ])
    const mountName = await mountNameFor(c.env.DB, userId, session.mount_id)
    const hasThumbnail = Boolean(c.env.IMAGES) && existing.mime.startsWith('image/')
    return c.json({
      skipped: true,
      existing: entryOf(existing, session.mount_id, mountName, hasThumbnail),
      entryPath: existing.path,
    })
  }

  let etag: string | null = null
  if (session.strategy === 'direct') {
    const object = await bucket.head(key)
    if (!object) throw ApiError.badRequest('The uploaded content is missing')
    if (object.size !== session.size) {
      await bucket.delete(key)
      throw ApiError.badRequest('The uploaded content does not match the declared size')
    }
    etag = object.etag
  } else if (session.strategy === 'multipart') {
    if (!session.provider_upload_id) throw new ApiError(500, 'internal', 'The multipart upload id is missing')
    const { results } = await c.env.DB.prepare(
      `SELECT p.part_number, p.etag, p.size
         FROM CloudDrive_upload_parts p
         JOIN CloudDrive_upload_sessions s ON s.id = p.session_id
        WHERE s.user_id = ?1 AND p.session_id = ?2
        ORDER BY p.part_number`,
    ).bind(userId, session.id).all<PartRow>()
    const parts = results ?? []
    if (parts.length !== session.total_parts || parts.some((part, index) => part.part_number !== index + 1)) {
      throw ApiError.conflict('The upload is incomplete', {
        uploadedParts: parts.length,
        totalParts: session.total_parts,
      })
    }
    const totalBytes = parts.reduce((sum, part) => sum + part.size, 0)
    if (totalBytes !== session.size) {
      throw ApiError.badRequest(`The uploaded parts hold ${totalBytes} bytes but the session declared ${session.size}`)
    }
    if (parts.some((part) => !part.etag)) throw ApiError.badRequest('A part is missing its etag')
    const object = await bucket
      .resumeMultipartUpload(key, session.provider_upload_id)
      .complete(parts.map((part) => ({ partNumber: part.part_number, etag: part.etag! })))
    etag = object.etag
  } else {
    throw ApiError.badRequest('The upload strategy is not supported')
  }

  let finalName = session.name
  if (existing && conflict === 'rename') {
    finalName = await uniqueName(c.env.DB, userId, session.mount_id, session.parent_id, session.name)
  }
  const finalPath = childPath(parentPath, finalName)
  const fileId = key.slice(key.lastIndexOf('/') + 1)
  if (!fileId) throw new ApiError(500, 'internal', 'The upload storage key has no object id')

  const now = Date.now()
  const statements: D1PreparedStatement[] = []
  if (existing && conflict === 'overwrite') {
    if (existing.storage_key) {
      const latest = await c.env.DB.prepare(
        `SELECT COALESCE(MAX(version), 0) AS version FROM CloudDrive_file_versions
          WHERE user_id = ? AND file_id = ?`,
      ).bind(userId, existing.id).first<{ version: number }>()
      statements.push(
        c.env.DB.prepare(
          `UPDATE CloudDrive_file_versions SET file_id = ?3 WHERE user_id = ?1 AND file_id = ?2`,
        ).bind(userId, existing.id, fileId),
      )
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO CloudDrive_file_versions
             (user_id, file_id, version, storage_key, size, mime, etag, checksum, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        ).bind(
          userId, fileId, (latest?.version ?? 0) + 1, existing.storage_key,
          existing.size, existing.mime, existing.etag, existing.checksum, now,
        ),
      )
    }
    statements.push(
      c.env.DB.prepare(
        `UPDATE CloudDrive_files SET deleted_at = ?3, trash_batch = ?4, updated_at = ?3
          WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
      ).bind(userId, existing.id, now, newId()),
    )
    // The old row is now in the trash; its public links must stop resolving to it.
    statements.push(
      c.env.DB.prepare(
        `UPDATE CloudDrive_shares SET revoked_at = ?3
          WHERE user_id = ?1 AND file_id = ?2 AND revoked_at IS NULL`,
      ).bind(userId, existing.id, now),
    )
  }
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO CloudDrive_files
         (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path, category,
          mime, size, etag, checksum, storage_kind, storage_key, metadata, color, starred_at,
          last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
       VALUES (?1, ?2, ?3, ?4, 'file', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, 'r2', ?13, '{}', '',
               NULL, NULL, NULL, NULL, ?14, ?14, ?14, ?14)`,
    ).bind(
      fileId, userId, session.mount_id, session.parent_id, finalName, foldedName(finalName),
      initialsFor(finalName), finalPath, session.category, session.mime, session.size, etag, key, now,
    ),
  )
  statements.push(
    c.env.DB.prepare('DELETE FROM CloudDrive_upload_parts WHERE session_id = ?1').bind(session.id),
  )
  statements.push(
    c.env.DB.prepare('DELETE FROM CloudDrive_upload_sessions WHERE user_id = ?1 AND id = ?2')
      .bind(userId, session.id),
  )
  await c.env.DB.batch(statements)
  if (existing && conflict === 'overwrite') {
    await pruneVersions(c.env.DB, c.env.FILES, userId, fileId)
  }

  const mountName = await mountNameFor(c.env.DB, userId, session.mount_id)
  const hasThumbnail = Boolean(c.env.IMAGES) && session.mime.startsWith('image/')
  return c.json({
    entry: {
      id: fileId,
      kind: 'file',
      name: finalName,
      path: finalPath,
      mountId: session.mount_id,
      mountName,
      category: session.category as CloudDriveCategory,
      mime: session.mime,
      size: session.size,
      uploadedAt: now,
      modifiedAt: now,
      starredAt: null,
      readOnly: false,
      hasThumbnail,
      storage: 'primary',
      storageKind: 'r2',
      color: null,
      tags: [],
    } satisfies CloudDriveEntry,
  })
})

const VERSION_KEEP = 10

async function pruneVersions(
  db: D1Database,
  bucket: Env['FILES'],
  userId: string,
  fileId: string,
): Promise<void> {
  const { results } = await db.prepare(
    `SELECT version, storage_key FROM CloudDrive_file_versions
      WHERE user_id = ? AND file_id = ? ORDER BY version DESC`,
  ).bind(userId, fileId).all<{ version: number; storage_key: string }>()
  const extra = (results ?? []).slice(VERSION_KEEP)
  if (extra.length === 0) return
  await db.batch(extra.map((row) => db.prepare(
    `DELETE FROM CloudDrive_file_versions WHERE user_id = ? AND file_id = ? AND version = ?`,
  ).bind(userId, fileId, row.version)))
  if (!bucket) return
  for (const key of new Set(extra.map((row) => row.storage_key))) {
    if (await storageKeyReferenced(db, userId, key)) continue
    try {
      await bucket.delete(key)
    } catch (error) {
      console.warn('[clouddrive] pruning an old file version left an orphan object:', key, error)
    }
  }
}

clouddriveUploadRoutes.post('/uploads/:id/abort', async (c) => {
  const userId = requireUserId(c)
  const session = await sessionById(c.env.DB, userId, c.req.param('id'))
  if (!session) throw ApiError.notFound('Upload session not found')

  if (session.status === 'active') {
    await abortMultipart(c.env.FILES, session)
    await discardDirectObject(c.env.FILES, session)
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM CloudDrive_upload_parts WHERE session_id = ?1').bind(session.id),
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
