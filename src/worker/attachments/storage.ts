import { LIMITS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import type { NoteAttachmentEncryption } from '@shared/types'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'
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
  attachmentObjectKey,
  emailAttachmentObjectKey,
  type AttachmentObjectStorage,
  newAttachmentObjectKey,
} from './keys'
import type { AttachmentScope } from './scopes'
import { attachmentScope } from './scopes'
import { AttachmentsStore } from './store'

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
  encryption?: NoteAttachmentEncryption
  plaintextSize?: number
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
  sha256: string
  width: number | null
  height: number | null
  storage: AttachmentObjectStorage
  encryption: NoteAttachmentEncryption
  plaintextSize: number | null
  /** The key the bytes were written under, kept so a rollback never has to guess it back. */
  objectKey: string
  createdAt: number
}

export interface ReplaceNoteAttachmentInput {
  id: string
  userId: string
  filename: string
  reportedMime: string
  bytes: Uint8Array
  encryption?: NoteAttachmentEncryption
  plaintextSize?: number
  expectedSha256?: string
}

/**
 * Copy-on-write replacement of an existing note attachment.
 *
 * The row is re-read under the same quota lease that serializes uploads, so the size being subtracted
 * is the size currently committed rather than a stale pre-request value. The new object is written
 * before D1 changes; a failed update removes only that new object and leaves the old row readable.
 */
export async function replaceNoteAttachment(
  env: Env,
  input: ReplaceNoteAttachmentInput,
): Promise<PersistedAttachment> {
  const ceiling = attachmentQuotaBytesForEnv(env)
  return withAttachmentQuotaLease(env, input.userId, async (usedBytes) => {
    const store = new AttachmentsStore(env.DB, input.userId)
    const previous = await store.forNoteReplacement(input.id)
    if (!previous) throw ApiError.notFound('Attachment not found')
    if (input.expectedSha256 && previous.sha256 !== input.expectedSha256) {
      throw ApiError.conflict('The attachment changed while it was being replaced')
    }
    if (usedBytes - previous.size + input.bytes.byteLength > ceiling) {
      throw ApiError.tooLarge('The account attachment quota has been reached')
    }

    const prepared = await prepareAttachment(env, {
      id: input.id,
      userId: input.userId,
      scope: 'notes',
      noteId: previous.note_id,
      filename: input.filename,
      reportedMime: input.reportedMime,
      bytes: input.bytes,
      encryption: input.encryption,
      plaintextSize: input.plaintextSize,
    })
    const previousObjectKey = attachmentObjectKey(previous)
    const keyNeedsVersioning = prepared.objectKey === previousObjectKey ||
      await store.hasPendingCleanup(prepared.storage, prepared.objectKey)
    const objectKey = keyNeedsVersioning
      ? uniqueAttachmentObjectKey(prepared.objectKey)
      : prepared.objectKey

    await putAttachmentObject(env, prepared.storage, objectKey, input.bytes, {
      userId: input.userId,
      objectId: input.id,
      kind: 'attachment',
      filename: prepared.filename,
      mime: prepared.encryption === 'note-lock-v1' ? 'application/octet-stream' : prepared.mime,
      sha256: prepared.sha256,
    })

    try {
      const replaced = await store.replaceBytes(previous, {
        filename: prepared.filename,
        mime: prepared.mime,
        size: prepared.size,
        sha256: prepared.sha256,
        object_key: objectKey,
        width: prepared.width,
        height: prepared.height,
        storage: prepared.storage,
        encryption: prepared.encryption,
        plaintext_size: prepared.plaintextSize,
      }, input.expectedSha256)
      if (!replaced) throw ApiError.conflict('The attachment changed while it was being replaced')
    } catch (error) {
      await discardStoredAttachment(
        env,
        prepared.storage,
        objectKey,
        input.userId,
        'Attachment replacement rollback',
      )
      throw error
    }

    return {
      id: input.id,
      userId: input.userId,
      scope: 'notes',
      noteId: previous.note_id,
      filename: prepared.filename,
      mime: prepared.mime,
      size: prepared.size,
      sha256: prepared.sha256,
      width: prepared.width,
      height: prepared.height,
      storage: prepared.storage,
      encryption: prepared.encryption,
      plaintextSize: prepared.plaintextSize,
      objectKey,
      createdAt: previous.created_at,
    }
  })
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


interface PreparedAttachment {
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  storage: AttachmentObjectStorage
  encryption: NoteAttachmentEncryption
  plaintextSize: number | null
  sha256: string
  objectKey: string
}

/** The validation and metadata rules shared by first uploads and byte replacements. */
async function prepareAttachment(
  env: Env,
  input: Omit<PersistAttachmentInput, 'createdAt'>,
): Promise<PreparedAttachment> {
  const encryption = input.encryption ?? 'none'
  if (encryption !== 'none' && encryption !== 'note-lock-v1') throw ApiError.badRequest('Unsupported attachment encryption')
  const byteCeiling = LIMITS.attachmentMaxBytes + (encryption === 'note-lock-v1' ? LIMITS.noteAttachmentEnvelopeOverheadBytes : 0)
  if (input.bytes.byteLength > byteCeiling) {
    throw ApiError.tooLarge('The file exceeds the 25 MB limit')
  }
  let noteEncrypted = false
  if (input.noteId) {
    const note = await env.DB.prepare(
      `SELECT is_encrypted FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
    ).bind(input.noteId, input.userId).first<{ is_encrypted: number }>()
    if (!note) throw ApiError.badRequest('The associated note does not exist')
    noteEncrypted = note.is_encrypted === 1
  }
  if (encryption === 'note-lock-v1' && (!input.noteId || !noteEncrypted)) {
    throw ApiError.badRequest('Encrypted attachments require a locked note')
  }
  if (encryption === 'none' && noteEncrypted) {
    throw ApiError.badRequest('Locked notes only accept encrypted attachments')
  }
  if (encryption === 'note-lock-v1') {
    const validMagic = input.bytes.length >= 32 && [73, 75, 65, 49].every((byte, index) => input.bytes[index] === byte)
    const validPlaintextSize = input.plaintextSize !== undefined &&
      Number.isSafeInteger(input.plaintextSize) &&
      input.plaintextSize >= 0 &&
      input.plaintextSize <= LIMITS.attachmentMaxBytes &&
      input.bytes.length === input.plaintextSize + LIMITS.noteAttachmentEnvelopeOverheadBytes
    if (!validMagic || !validPlaintextSize) {
      throw ApiError.badRequest('Invalid encrypted attachment envelope')
    }
  }
  const storage = selectAttachmentStorage(env)
  if (!storage) {
    throw new ApiError(
      503,
      'storage_unavailable',
      'Attachment storage is not configured. Bind R2 or Workers KV before uploading files.',
    )
  }

  const encrypted = encryption === 'note-lock-v1'
  let mime = encrypted ? reportedAttachmentMime(input.reportedMime) : safeAttachmentMime(input.bytes, input.reportedMime)
  let dimensions = encrypted ? null : readImageSize(input.bytes, mime)
  if (!encrypted && !hasReasonableImageDimensions(dimensions)) {
    mime = 'application/octet-stream'
    dimensions = null
  }

  const filename = sanitizeAttachmentFilename(input.filename)
  const sha256 = await sha256Hex(input.bytes)
  const objectKey = input.objectKey ?? (encrypted
    ? `${attachmentScope(input.scope).prefix}/${input.userId}/${input.id}.enc`
    : newAttachmentObjectKey(input.scope, {
      user_id: input.userId,
      id: input.id,
      mime,
      filename,
    }))

  return {
    filename,
    mime,
    size: input.bytes.byteLength,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    storage,
    encryption,
    plaintextSize: encrypted ? input.plaintextSize! : null,
    sha256,
    objectKey,
  }
}

export async function persistAttachment(
  env: Env,
  input: PersistAttachmentInput,
): Promise<PersistedAttachment> {
  const collision = await env.DB.prepare('SELECT 1 FROM attachments WHERE id = ?1').bind(input.id).first()
  if (collision) throw ApiError.conflict('This attachment id is already in use')
  const prepared = await prepareAttachment(env, input)
  const objectKey = prepared.encryption === 'note-lock-v1' && !input.objectKey
    ? uniqueAttachmentObjectKey(prepared.objectKey)
    : prepared.objectKey
  await putAttachmentObject(env, prepared.storage, objectKey, input.bytes, {
    userId: input.userId,
    objectId: input.id,
    kind: 'attachment',
    filename: prepared.filename,
    mime: prepared.encryption === 'note-lock-v1' ? 'application/octet-stream' : prepared.mime,
    sha256: prepared.sha256,
  })

  try {
    await env.DB.prepare(
      `INSERT INTO attachments (id, user_id, scope, note_id, filename, mime, size, sha256, object_key, width, height, storage, encryption, plaintext_size, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
      .bind(
        input.id,
        input.userId,
        input.scope,
        input.noteId,
        prepared.filename,
        prepared.mime,
        prepared.size,
        prepared.sha256,
        objectKey,
        prepared.width,
        prepared.height,
        prepared.storage,
        prepared.encryption,
        prepared.plaintextSize,
        input.createdAt,
      )
      .run()
  } catch (error) {
    await discardStoredAttachment(
      env,
      prepared.storage,
      prepared.objectKey,
      input.userId,
      'Attachment write rollback',
    )
    throw error
  }

  return {
    id: input.id,
    userId: input.userId,
    scope: input.scope,
    noteId: input.noteId,
    filename: prepared.filename,
    mime: prepared.mime,
    size: prepared.size,
    sha256: prepared.sha256,
    width: prepared.width,
    height: prepared.height,
    storage: prepared.storage,
    encryption: prepared.encryption,
    plaintextSize: prepared.plaintextSize,
    objectKey,
    createdAt: input.createdAt,
  }
}

/** Keep a rollback best-effort without hiding either the delete failure or a failed cleanup queue. */
async function discardStoredAttachment(
  env: Env,
  storage: AttachmentObjectStorage,
  objectKey: string,
  userId: string,
  context: string,
): Promise<void> {
  try {
    await deleteAttachmentObjects(env, storage, [objectKey])
  } catch (cleanupError) {
    console.warn(`[inkstone] ${context} object cleanup will retry later:`, cleanupError)
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
         VALUES (?1, ?2, ?3)`,
      )
        .bind(attachmentCleanupTarget(storage, objectKey), userId, Date.now())
        .run()
    } catch (queueError) {
      console.error(`[inkstone] ${context} cleanup could not be queued:`, queueError)
    }
  }
}

/**
 * A same-layout replacement cannot overwrite the only good copy before D1 commits, and a key still
 * queued for cleanup may disappear after the write. Keeping the id before the first dot also lets
 * cleanup/transfer code continue to recognize which attachment it was.
 */
function uniqueAttachmentObjectKey(objectKey: string): string {
  const slash = objectKey.lastIndexOf('/')
  const dot = objectKey.indexOf('.', slash + 1)
  if (dot < 0) return `${objectKey}.${newId()}`
  return `${objectKey.slice(0, dot + 1)}${newId()}${objectKey.slice(dot)}`
}

function reportedAttachmentMime(value: string): string {
  return value.length <= 128 && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value)
    ? value
    : 'application/octet-stream'
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
