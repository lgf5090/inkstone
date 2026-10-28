import { LIMITS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { sha256Hex } from '../lib/encoding'
import { acquireLease } from '../lib/lease'
import {
  hasReasonableImageDimensions,
  readImageSize,
  safeAttachmentMime,
} from '../lib/image'
import {
  attachmentQuotaBytesForEnv,
  deleteAttachmentObjects,
  putAttachmentObject,
  selectAttachmentStorage,
} from './backend'
import { drainAttachmentCleanup } from './cleanup'
import {
  attachmentCleanupTarget,
  emailAttachmentObjectKey,
  type AttachmentObjectStorage,
  newAttachmentObjectKey,
} from './keys'
import type { AttachmentScope } from './scopes'

export interface PersistAttachmentInput {
  id: string
  userId: string
  /** Which application the file belongs to; decides the object prefix and the hub that lists it. */
  scope: AttachmentScope
  noteId: string | null
  filename: string
  reportedMime: string
  bytes: Uint8Array
  createdAt: number
  /**
   * Where to write the object when the scope's own layout is not `<prefix>/<user>/<id>.<ext>`.
   *
   * Calendar uploads file themselves under a category folder (`calendar/images/…`), and the key must
   * be the one the row will name, so the caller that knows the category chooses it.
   */
  objectKey?: string
}

export interface PersistedAttachment {
  id: string
  userId: string
  scope: AttachmentScope
  noteId: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  storage: AttachmentObjectStorage
  /** The key the bytes were written under, kept so a rollback never has to guess it back. */
  objectKey: string
  createdAt: number
}


export async function persistAttachmentWithinQuota(
  env: Env,
  input: PersistAttachmentInput,
): Promise<PersistedAttachment> {
  const ceiling = attachmentQuotaBytesForEnv(env)
  return withAttachmentQuotaLease(env, input.userId, async (usedBytes) => {
    if (usedBytes + input.bytes.byteLength > ceiling) {
      throw ApiError.tooLarge('The account attachment quota has been reached')
    }
    return persistAttachment(env, input)
  })
}

export async function attachmentBytesUsed(db: D1Database, userId: string): Promise<number> {
  const usage = await db.prepare(
    `SELECT
       COALESCE((SELECT SUM(size) FROM attachments WHERE user_id = ?1), 0)
       + COALESCE((SELECT SUM(size) FROM memos_attachments WHERE user_id = ?1), 0)
       + COALESCE((SELECT SUM(size) FROM inknote_assets WHERE user_id = ?1), 0) AS bytes`,
  ).bind(userId).first<{ bytes: number }>()
  return Number(usage?.bytes ?? 0)
}

export async function withAttachmentQuotaLease<T>(
  env: Env,
  userId: string,
  run: (usedBytes: number) => Promise<T>,
): Promise<T> {
  const release = await acquireLease(
    env.DB,
    `attachment-quota:${userId}`,
    2 * 60 * 1000,
    'Another attachment upload is being finalized. Try again shortly',
  )
  try {
    return await run(await attachmentBytesUsed(env.DB, userId))
  } finally {
    await release()
  }
}


export async function persistAttachment(
  env: Env,
  input: PersistAttachmentInput,
): Promise<PersistedAttachment> {
  if (input.bytes.byteLength > LIMITS.attachmentMaxBytes) {
    throw ApiError.tooLarge('The file exceeds the 25 MB limit')
  }
  const storage = selectAttachmentStorage(env)
  if (!storage) {
    throw new ApiError(
      503,
      'storage_unavailable',
      'Attachment storage is not configured. Bind R2 or Workers KV before uploading files.',
    )
  }

  let mime = safeAttachmentMime(input.bytes, input.reportedMime)
  let dimensions = readImageSize(input.bytes, mime)
  if (!hasReasonableImageDimensions(dimensions)) {
    mime = 'application/octet-stream'
    dimensions = null
  }

  const filename = sanitizeAttachmentFilename(input.filename)
  const sha256 = await sha256Hex(input.bytes)
  let storedObject = false

  const objectKey = input.objectKey ?? newAttachmentObjectKey(input.scope, {
    user_id: input.userId,
    id: input.id,
    mime,
    filename,
  })
  await putAttachmentObject(env, storage, objectKey, input.bytes, {
    userId: input.userId,
    objectId: input.id,
    kind: 'attachment',
    filename,
    mime,
    sha256,
  })
  storedObject = true

  try {
    await env.DB.prepare(
      `INSERT INTO attachments (id, user_id, scope, note_id, filename, mime, size, sha256, object_key, width, height, storage, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
      .bind(
        input.id,
        input.userId,
        input.scope,
        input.noteId,
        filename,
        mime,
        input.bytes.byteLength,
        sha256,
        objectKey,
        dimensions?.width ?? null,
        dimensions?.height ?? null,
        storage,
        input.createdAt,
      )
      .run()
  } catch (error) {
    if (storedObject) {
      try {
        await deleteAttachmentObjects(env, storage, [objectKey])
      } catch (cleanupError) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
           VALUES (?1, ?2, ?3)`,
        )
          .bind(attachmentCleanupTarget(storage, objectKey), input.userId, Date.now())
          .run()
          .catch(() => {})
        console.warn('[inkstone] Attachment cleanup after a write rollback will retry later:', cleanupError)
      }
    }
    throw error
  }

  return {
    id: input.id,
    userId: input.userId,
    scope: input.scope,
    noteId: input.noteId,
    filename,
    mime,
    size: input.bytes.byteLength,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    storage,
    objectKey,
    createdAt: input.createdAt,
  }
}


export function sanitizeAttachmentFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  return truncateText(cleaned || 'file', 180)
}


export async function rollbackPersistedAttachments(
  env: Env,
  attachments: readonly PersistedAttachment[],
): Promise<void> {
  let statements: D1PreparedStatement[] = []
  const flush = async () => {
    if (!statements.length) return
    await env.DB.batch(statements)
    statements = []
  }

  for (const attachment of attachments) {
    const needed = 3
    if (statements.length + needed > 100) await flush()
    const objectKey = attachment.objectKey
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
         SELECT ?1, user_id, ?2 FROM attachments WHERE id = ?3 AND user_id = ?4`,
      ).bind(
        attachmentCleanupTarget(attachment.storage, objectKey),
        Date.now(),
        attachment.id,
        attachment.userId,
      ),
    )
    statements.push(
      env.DB.prepare(
        `DELETE FROM import_mappings
          WHERE user_id = ?1 AND entity = 'attachment' AND target_id = ?2`,
      ).bind(attachment.userId, attachment.id),
    )
    statements.push(
      env.DB.prepare(`DELETE FROM attachments WHERE id = ?1 AND user_id = ?2`).bind(
        attachment.id,
        attachment.userId,
      ),
    )
  }
  await flush()
  await drainAttachmentCleanup(env).catch((error) => {
    console.warn('[inkstone] Attachment cleanup after an import rollback will retry later:', error)
  })
}

export interface PersistEmailAttachmentInput {
  id: string
  userId: string
  accountId: string | null
  emailId: string | null
  filename: string
  reportedMime: string
  bytes: Uint8Array
  contentId?: string | null
  disposition?: string | null
  locked: boolean
  createdAt: number
}

export interface PersistedEmailAttachment {
  id: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  objectKey: string
  createdAt: number
}

export async function persistEmailAttachment(
  env: Env,
  input: PersistEmailAttachmentInput,
): Promise<PersistedEmailAttachment> {
  if (input.bytes.byteLength > LIMITS.attachmentMaxBytes) {
    throw ApiError.tooLarge('The file exceeds the 25 MB limit')
  }
  const storage = selectAttachmentStorage(env)
  if (storage !== 'r2') {
    throw new ApiError(503, 'storage_unavailable', 'Email attachments require R2 storage')
  }
  const release = await acquireLease(
    env.DB,
    `email-attachment-quota:${input.userId}`,
    2 * 60 * 1000,
    'Another email attachment upload is being finalized. Try again shortly',
  )
  try {
    const usage = await env.DB.prepare(
      `SELECT COALESCE(SUM(size), 0) AS bytes FROM email_attachments WHERE user_id = ?1`,
    ).bind(input.userId).first<{ bytes: number }>()
    if ((usage?.bytes ?? 0) + input.bytes.byteLength > LIMITS.attachmentQuotaBytes) {
      throw ApiError.tooLarge('The account email attachment quota has been reached')
    }

    let mime = safeAttachmentMime(input.bytes, input.reportedMime)
    let dimensions = readImageSize(input.bytes, mime)
    if (!hasReasonableImageDimensions(dimensions)) {
      mime = 'application/octet-stream'
      dimensions = null
    }
    const filename = sanitizeAttachmentFilename(input.filename)
    const sha256 = await sha256Hex(input.bytes)
    const objectKey = emailAttachmentObjectKey({
      user_id: input.userId,
      id: input.id,
      mime,
      filename,
    })
    await putAttachmentObject(env, storage, objectKey, input.bytes, {
      userId: input.userId,
      objectId: input.id,
      kind: 'attachment',
      filename,
      mime,
      sha256,
    })
    try {
      await env.DB.prepare(
        `INSERT INTO email_attachments (
           id, user_id, account_id, email_id, filename, mime, size, width, height,
           content_id, disposition, object_key, storage, folder_id, is_starred,
           is_pinned, tags, locked, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'r2', NULL, 0, 0, '[]', ?13, ?14)`,
      )
        .bind(
          input.id,
          input.userId,
          input.accountId,
          input.emailId,
          filename,
          mime,
          input.bytes.byteLength,
          dimensions?.width ?? null,
          dimensions?.height ?? null,
          input.contentId ?? null,
          input.disposition ?? null,
          objectKey,
          input.locked ? 1 : 0,
          input.createdAt,
        )
        .run()
    } catch (error) {
      await deleteAttachmentObjects(env, storage, [objectKey]).catch((cleanupError) => {
        console.warn('[inkstone] Email attachment cleanup after a write rollback will retry later:', cleanupError)
      })
      throw error
    }
    return {
      id: input.id,
      filename,
      mime,
      size: input.bytes.byteLength,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      objectKey,
      createdAt: input.createdAt,
    }
  } finally {
    await release()
  }
}
