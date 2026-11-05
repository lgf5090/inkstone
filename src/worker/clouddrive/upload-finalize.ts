/**
 * Turning a finished upload session into a file row.
 *
 * The session routes and the background URL fetch both end here, so the conflict rules, version
 * history, share refresh and part cleanup stay one implementation rather than two that drift.
 */
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import {
  autoSuffixName,
  childPath,
  foldedName,
  parentPathOf,
  type CloudDriveCategory,
  type CloudDriveEntry,
} from '@shared/clouddrive/model'
import { exifTakenAt } from './exif'
import { initialsOf } from './lib'
import { deleteFileParts, deleteUploadPartObjects } from './distributed'
import { storageKeyReferenced } from './store-files'

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_RENAME_ATTEMPTS = 1000
export const EXIF_HEAD_BYTES = 64 * 1024
const VERSION_KEEP = 10

/** The session table has no `conflict` column, so the overwrite decision rides in `error`. */
export const SESSION_CONFLICT_PREFIX = '{"conflict":"'

export const UPLOAD_CONFLICTS = ['rename', 'overwrite', 'skip'] as const
export type UploadConflict = (typeof UPLOAD_CONFLICTS)[number]

export interface UploadSessionRow {
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

export interface FileRow {
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
  storage_kind: string
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

export function parseUploadConflict(value: unknown): UploadConflict {
  if (value === undefined || value === null || value === '') return 'rename'
  if (typeof value !== 'string' || !UPLOAD_CONFLICTS.includes(value as UploadConflict)) {
    throw ApiError.badRequest('conflict must be rename, overwrite or skip')
  }
  return value as UploadConflict
}

export function decodeSessionConflict(value: string | null): UploadConflict {
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

export function sessionConflictValue(conflict: UploadConflict): string | null {
  return conflict === 'overwrite' ? `${SESSION_CONFLICT_PREFIX}overwrite"}` : null
}

export async function findParent(
  db: D1Database,
  userId: string,
  mountId: string,
  parentPath: string,
): Promise<string> {
  if (parentPath === '/') return ''
  const row = await db.prepare(
    `SELECT id, kind FROM CloudDrive_files
      WHERE user_id = ?1 AND mount_id = ?2 AND path = ?3 AND deleted_at IS NULL`,
  ).bind(userId, mountId, parentPath).first<{ id: string; kind: string }>()
  if (!row || row.kind !== 'folder') throw ApiError.notFound('Parent folder not found')
  return row.id
}

export async function findLiveSibling(
  db: D1Database,
  userId: string,
  mountId: string,
  parentId: string,
  folded: string,
): Promise<FileRow | null> {
  return await db.prepare(
    `SELECT id, name, path, kind, category, mime, size, etag, checksum, storage_key, storage_kind, color, starred_at,
            uploaded_at, modified_at
       FROM CloudDrive_files
      WHERE user_id = ?1 AND mount_id = ?2 AND parent_id = ?3 AND name_folded = ?4
        AND deleted_at IS NULL`,
  ).bind(userId, mountId, parentId, folded).first<FileRow>()
}

export async function uniqueName(
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
export async function usedPrimaryBytes(db: D1Database, userId: string): Promise<number> {
  // Version objects are real bytes in the bucket: leaving them out let a file with ten stored versions
  // quietly occupy ten times the quota it was charged for.
  const row = await db.prepare(
    `SELECT COALESCE(SUM(size), 0) AS bytes FROM (
       SELECT storage_key, MAX(size) AS size FROM (
         SELECT storage_key, size FROM CloudDrive_files
          WHERE user_id = ?1 AND storage_key IS NOT NULL
         UNION ALL
         SELECT storage_key, size FROM CloudDrive_file_versions
          WHERE user_id = ?1 AND storage_key IS NOT NULL
       )
       GROUP BY storage_key
     )`,
  ).bind(userId).first<{ bytes: number }>()
  const parts = await db.prepare(
    `SELECT COALESCE(SUM(p.size), 0) AS bytes FROM CloudDrive_file_parts p
       JOIN CloudDrive_files f ON f.user_id = p.user_id AND f.id = p.file_id
      WHERE p.user_id = ?1 AND p.mount_id = 'primary' AND f.deleted_at IS NULL`,
  ).bind(userId).first<{ bytes: number }>()
  return Number(row?.bytes ?? 0) + Number(parts?.bytes ?? 0)
}

export async function mountNameFor(db: D1Database, userId: string, mountId: string): Promise<string> {
  const row = await db.prepare(
    `SELECT name FROM CloudDrive_mounts WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, mountId).first<{ name: string }>()
  return row?.name ?? 'Cloud Drive'
}

export function entryOf(
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

/**
 * The capture time a freshly stored JPEG carries, read from the head of the object the upload just
 * wrote. EXIF sits in the first few kilobytes, so the whole file is never pulled back; a distributed
 * upload has no single object to read and stays unstamped.
 */
export async function exifTakenAtOf(
  env: Env,
  key: string | null,
  storageKind: string,
  mime: string,
): Promise<number | null> {
  if (storageKind !== 'r2' || !key || mime !== 'image/jpeg' || !env.FILES) return null
  try {
    const head = await env.FILES.get(key, { range: { offset: 0, length: EXIF_HEAD_BYTES - 1 } })
    if (!head) return null
    return exifTakenAt(new Uint8Array(await head.arrayBuffer()))
  } catch (error) {
    // The file is stored and valid; only the album's grouping loses the date, so this stays a log.
    console.warn('[clouddrive] EXIF capture time could not be read:', key, error)
    return null
  }
}

export async function abortMultipart(bucket: R2Bucket | undefined, session: UploadSessionRow): Promise<void> {
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
export async function discardDirectObject(bucket: R2Bucket | undefined, session: UploadSessionRow): Promise<void> {
  if (session.strategy !== 'direct' || !session.storage_key || !bucket) return
  try {
    await bucket.delete(session.storage_key)
  } catch (error) {
    // The object is unreferenced either way; a failed delete leaves work for the orphan scan.
    console.warn('[inkstone] CloudDrive direct upload cleanup failed:', error)
  }
}

/** Releases every object a session still holds, whichever strategy it used. */
export async function discardSessionObjects(env: Env, session: UploadSessionRow): Promise<void> {
  await abortMultipart(env.FILES, session)
  await discardDirectObject(env.FILES, session)
}

export type CompleteUploadResult =
  | { skipped: true; existing: CloudDriveEntry; entryPath: string }
  | { entry: CloudDriveEntry }

export async function completeUploadSession(
  env: Env,
  userId: string,
  session: UploadSessionRow,
  conflict: UploadConflict,
): Promise<CompleteUploadResult> {
  const bucket = env.FILES
  if (!bucket) throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound on this deployment')
  const key = session.storage_key
  if (session.strategy !== 'distributed' && !key) {
    throw new ApiError(500, 'internal', 'The upload session has no storage key')
  }

  const parentPath = parentPathOf(session.path)
  const existing = await findLiveSibling(
    env.DB, userId, session.mount_id, session.parent_id, foldedName(session.name),
  )
  if (existing && existing.kind === 'folder' && conflict === 'overwrite') {
    throw ApiError.conflict('A folder with that name already exists')
  }
  if (existing && conflict === 'skip') {
    await abortMultipart(bucket, session)
    await discardDirectObject(bucket, session)
    if (session.strategy === 'distributed') {
      await deleteUploadPartObjects(env, env.DB, userId, session.id)
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM CloudDrive_upload_parts WHERE session_id = ?1').bind(session.id),
      env.DB.prepare('DELETE FROM CloudDrive_upload_part_objects WHERE session_id = ?1').bind(session.id),
      env.DB.prepare('DELETE FROM CloudDrive_upload_sessions WHERE user_id = ?1 AND id = ?2')
        .bind(userId, session.id),
    ])
    const mountName = await mountNameFor(env.DB, userId, session.mount_id)
    const hasThumbnail = Boolean(env.IMAGES) && existing.mime.startsWith('image/')
    return {
      skipped: true,
      existing: entryOf(existing, session.mount_id, mountName, hasThumbnail),
      entryPath: existing.path,
    }
  }

  let etag: string | null = null
  if (session.strategy === 'distributed') {
    const { results } = await env.DB.prepare(
      `SELECT part_number, mount_id, storage_key, size, etag, uploaded_at
         FROM CloudDrive_upload_part_objects
        WHERE session_id = ? ORDER BY part_number`,
    ).bind(session.id).all<{
      part_number: number
      mount_id: string
      storage_key: string
      size: number
      etag: string | null
      uploaded_at: number | null
    }>()
    const parts = results ?? []
    if (parts.length !== session.total_parts || parts.some((part, index) => part.part_number !== index + 1)) {
      throw ApiError.conflict('The upload is incomplete', {
        uploadedParts: parts.filter((part) => part.uploaded_at !== null).length,
        totalParts: session.total_parts,
      })
    }
    if (parts.some((part) => part.uploaded_at === null)) {
      throw ApiError.conflict('The upload is incomplete', {
        uploadedParts: parts.filter((part) => part.uploaded_at !== null).length,
        totalParts: session.total_parts,
      })
    }
    for (const [index, part] of parts.entries()) {
      const expected = index === parts.length - 1
        ? session.size - session.part_size * (session.total_parts - 1)
        : session.part_size
      if (part.size !== expected) throw ApiError.badRequest('A distributed part has the wrong size')
    }
    const totalBytes = parts.reduce((sum, part) => sum + part.size, 0)
    if (totalBytes !== session.size) throw ApiError.badRequest('The distributed parts do not add up to the declared size')
  } else if (session.strategy === 'direct') {
    if (!key) throw new ApiError(500, 'internal', 'The upload session has no storage key')
    const object = await bucket.head(key)
    if (!object) throw ApiError.badRequest('The uploaded content is missing')
    if (object.size !== session.size) {
      await bucket.delete(key)
      throw ApiError.badRequest('The uploaded content does not match the declared size')
    }
    etag = object.etag
  } else if (session.strategy === 'multipart') {
    if (!key) throw new ApiError(500, 'internal', 'The upload session has no storage key')
    if (!session.provider_upload_id) throw new ApiError(500, 'internal', 'The multipart upload id is missing')
    const { results } = await env.DB.prepare(
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
    finalName = await uniqueName(env.DB, userId, session.mount_id, session.parent_id, session.name)
  }
  const finalPath = childPath(parentPath, finalName)
  const storageKind = session.strategy === 'distributed' ? 'distributed' : 'r2'
  // An overwrite keeps the row. Its id is what tags, stars, folder colour, ACL grants and share links
  // point at, so replacing the row silently unshared and untagged the file the reader meant to update.
  const overwrites = existing !== null && conflict === 'overwrite'
  const fileId = overwrites && existing
    ? existing.id
    : session.strategy === 'distributed'
      ? newId()
      : key?.slice(key.lastIndexOf('/') + 1) ?? ''
  if (!fileId) throw new ApiError(500, 'internal', 'The upload storage key has no object id')

  const now = Date.now()
  const takenAt = await exifTakenAtOf(env, key, storageKind, session.mime)
  const metadata = takenAt === null ? '{}' : JSON.stringify({ takenAt })
  const statements: D1PreparedStatement[] = []
  if (overwrites && existing) {
    if (existing.storage_key) {
      const latest = await env.DB.prepare(
        `SELECT COALESCE(MAX(version), 0) AS version FROM CloudDrive_file_versions
          WHERE user_id = ? AND file_id = ?`,
      ).bind(userId, existing.id).first<{ version: number }>()
      statements.push(
        env.DB.prepare(
          `INSERT INTO CloudDrive_file_versions
             (user_id, file_id, version, storage_key, size, mime, etag, checksum, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        ).bind(
          userId, existing.id, (latest?.version ?? 0) + 1, existing.storage_key,
          existing.size, existing.mime, existing.etag, existing.checksum, now,
        ),
      )
    }
    if (existing.storage_kind === 'distributed') {
      // A distributed predecessor has no single object to hand to the version table: its parts are
      // released instead of orphaned, and versioning that shape stays a documented gap.
      await deleteFileParts(env.DB, env, userId, [existing.id])
    }
    statements.push(
      env.DB.prepare(
        `UPDATE CloudDrive_files
            SET name = ?3, name_folded = ?4, name_initials = ?5, path = ?6, category = ?7, mime = ?8,
                size = ?9, etag = ?10, checksum = NULL, storage_kind = ?11, storage_key = ?12,
                metadata = ?14, updated_at = ?13, modified_at = ?13
          WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
      ).bind(
        userId, existing.id, finalName, foldedName(finalName), initialsOf(finalName), finalPath,
        session.category, session.mime, session.size, etag, storageKind, key, now, metadata,
      ),
    )
    // The link still resolves to this row, so its cached name, size and type follow the new bytes.
    statements.push(
      env.DB.prepare(
        `UPDATE CloudDrive_shares SET name = ?3, size = ?4, mime = ?5
          WHERE user_id = ?1 AND file_id = ?2 AND revoked_at IS NULL`,
      ).bind(userId, existing.id, finalName, session.size, session.mime),
    )
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO CloudDrive_files
           (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path, category,
            mime, size, etag, checksum, storage_kind, storage_key, metadata, color, starred_at,
            last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
         VALUES (?1, ?2, ?3, ?4, 'file', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?15, ?13, ?16, '',
                 NULL, NULL, NULL, NULL, ?14, ?14, ?14, ?14)`,
      ).bind(
        fileId, userId, session.mount_id, session.parent_id, finalName, foldedName(finalName),
        initialsOf(finalName), finalPath, session.category, session.mime, session.size, etag, key, now,
        storageKind, metadata,
      ),
    )
  }
  if (session.strategy === 'distributed') {
    // One statement copies every assignment instead of one INSERT per part: a 200-part upload would
    // otherwise build a batch D1 refuses (see `chunkedBatch`), and the part rows are already in D1.
    statements.push(
      env.DB.prepare(
        `INSERT INTO CloudDrive_file_parts
           (user_id, file_id, part_number, mount_id, storage_key, size, etag, created_at)
         SELECT ?1, ?2, part_number, mount_id, storage_key, size, etag, ?3
           FROM CloudDrive_upload_part_objects
          WHERE session_id = ?4
          ORDER BY part_number`,
      ).bind(userId, fileId, now, session.id),
    )
  }
  statements.push(
    env.DB.prepare('DELETE FROM CloudDrive_upload_parts WHERE session_id = ?1').bind(session.id),
  )
  statements.push(
    env.DB.prepare('DELETE FROM CloudDrive_upload_part_objects WHERE session_id = ?1').bind(session.id),
  )
  statements.push(
    env.DB.prepare('DELETE FROM CloudDrive_upload_sessions WHERE user_id = ?1 AND id = ?2')
      .bind(userId, session.id),
  )
  await env.DB.batch(statements)
  if (existing && conflict === 'overwrite') {
    await pruneVersions(env.DB, env.FILES, userId, fileId)
  }

  const mountName = await mountNameFor(env.DB, userId, session.mount_id)
  const hasThumbnail = Boolean(env.IMAGES) && session.mime.startsWith('image/')
  return {
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
      // An overwrite keeps the row, so the file's own history and star survive the replacement.
      uploadedAt: overwrites && existing ? existing.uploaded_at : now,
      modifiedAt: now,
      starredAt: overwrites && existing ? existing.starred_at : null,
      readOnly: false,
      hasThumbnail: session.strategy === 'distributed' ? false : hasThumbnail,
      storage: session.strategy === 'distributed' ? 'distributed' : 'primary',
      storageKind: session.strategy === 'distributed' ? 'distributed' : 'r2',
      color: null,
      tags: [],
    } satisfies CloudDriveEntry,
  }
}

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
    if (await storageKeyReferenced(db, key)) continue
    try {
      await bucket.delete(key)
    } catch (error) {
      console.warn('[clouddrive] pruning an old file version left an orphan object:', key, error)
    }
  }
}
