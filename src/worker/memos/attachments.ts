import {
  MEMO_ATTACHMENT_MAX_BYTES,
  MEMO_ATTACHMENT_QUOTA_BYTES,
  MEMO_ATTACHMENT_SCOPES,
  type MemoAttachmentScope,
} from '@shared/memos/constants'
import type {
  MemoApiErrorCode,
  MemoAttachment,
  MemoMediaMetadata,
  MemoMotion,
  MemoMotionRole,
  MemoState,
  MemoVisibility,
} from '@shared/memos/types'
import type { Env } from '../env'
import {
  attachmentCleanupTarget,
  deleteAttachmentObjects,
  drainAttachmentCleanup,
  memoAttachmentObjectKey,
  memoThumbnailObjectKey,
  putAttachmentObject,
  sanitizeAttachmentFilename,
  selectAttachmentStorage,
  withAttachmentQuotaLease,
  type AttachmentObjectStorage,
} from '../attachments'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import {
  hasReasonableImageDimensions,
  isInlineSafe,
  readImageSize,
} from '../lib/image'
import { parseMemoMediaMetadata, safeMemoMime } from './media'

export const MEMO_FILE_URL_PREFIX = '/api/memos/files/'

export { MEMO_ATTACHMENT_SCOPES, type MemoAttachmentScope }

const MEMO_REFERENCE_LOOKUP_LIMIT = 20
const MEMO_REFERENCE_WINDOW_CHARS = 300
const BATCH_ID_CHUNK = 90
const DELETE_STATEMENT_LIMIT = 100
const PRUNE_BATCH_SIZE = 100

type MemoAttachmentErrorCode =
  | Extract<MemoApiErrorCode, 'memo_attachment_too_large' | 'memo_attachment_quota' | 'memo_attachment_in_use'>
  | 'storage_unavailable'

export class MemoAttachmentError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 503,
    readonly code: MemoAttachmentErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'MemoAttachmentError'
  }
}

export interface MemoAttachmentRow {
  id: string
  user_id: string
  memo_id: string | null
  filename: string
  mime: string
  size: number
  storage: AttachmentObjectStorage
  storage_key: string
  width: number | null
  height: number | null
  thumbnail_key: string | null
  media_metadata: string | null
  motion_group_id: string | null
  motion_role: string | null
  created_at: number
  updated_at: number
}

export interface MemoAttachmentListRow extends MemoAttachmentRow {
  memo_title: string | null
  memo_snippet: string | null
}

export interface MemoAttachmentFileRow extends MemoAttachmentRow {
  memo_visibility: MemoVisibility | null
  memo_state: MemoState | null
}

export interface MemoAttachmentMemoSummary {
  id: string
  title: string
  snippet: string
}

export interface MemoAttachmentView extends MemoAttachment {
  memoId: string | null
  memo: MemoAttachmentMemoSummary | null
}

export interface MemoThumbnailInput {
  filename: string
  reportedMime: string
  bytes: Uint8Array
}

export interface SaveMemoAttachmentInput {
  id: string
  userId: string
  memoId: string | null
  filename: string
  reportedMime: string
  bytes: Uint8Array
  thumbnail: MemoThumbnailInput | null
  mediaMetadata: MemoMediaMetadata | null
  motionGroupId: string | null
  motionRole: MemoMotionRole | null
  createdAt: number
}

export interface MemoAttachmentDeleteResult {
  deleted: number
  freedBytes: number
}

export interface MemoAttachmentListOptions {
  scope: MemoAttachmentScope
  spaceId: string | null
  memoId: string | null
  offset: number
  limit: number
}

export interface MemoAttachmentListPage {
  rows: MemoAttachmentListRow[]
  nextOffset: number | null
}

const ATTACHMENT_COLUMNS = `a.id, a.user_id, a.memo_id, a.filename, a.mime, a.size, a.storage,
  a.storage_key, a.width, a.height, a.thumbnail_key, a.media_metadata, a.motion_group_id,
  a.motion_role, a.created_at, a.updated_at`

const ATTACHMENT_LIST_COLUMNS = `${ATTACHMENT_COLUMNS}, m.title AS memo_title,
  m.snippet AS memo_snippet`

export async function saveMemoAttachment(
  env: Env,
  input: SaveMemoAttachmentInput,
): Promise<MemoAttachmentRow> {
  if (input.bytes.byteLength > MEMO_ATTACHMENT_MAX_BYTES) {
    throw new MemoAttachmentError(
      413,
      'memo_attachment_too_large',
      `The file exceeds the ${MEMO_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB limit`,
    )
  }
  if (input.thumbnail && input.thumbnail.bytes.byteLength > MEMO_ATTACHMENT_MAX_BYTES) {
    throw new MemoAttachmentError(
      413,
      'memo_attachment_too_large',
      `The thumbnail exceeds the ${MEMO_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB limit`,
    )
  }

  const storage = selectAttachmentStorage(env)
  if (!storage) {
    throw new MemoAttachmentError(
      503,
      'storage_unavailable',
      'Attachment storage is not configured. Bind R2 or Workers KV before uploading files.',
    )
  }
  if (input.memoId && !(await memoBelongsToUser(env.DB, input.userId, input.memoId))) {
    throw ApiError.badRequest('The associated memo does not exist')
  }

  let mime = safeMemoMime(input.bytes, input.reportedMime)
  let dimensions = readImageSize(input.bytes, mime)
  if (!hasReasonableImageDimensions(dimensions)) {
    mime = 'application/octet-stream'
    dimensions = null
  }
  const filename = sanitizeAttachmentFilename(input.filename)

  let thumbnail: { key: string; filename: string; mime: string; bytes: Uint8Array } | null = null
  if (input.thumbnail) {
    const thumbnailMime = safeMemoMime(input.thumbnail.bytes, input.thumbnail.reportedMime)
    if (!isInlineSafe(thumbnailMime)) {
      throw ApiError.badRequest('The thumbnail must be an image')
    }
    const thumbnailFilename = sanitizeAttachmentFilename(input.thumbnail.filename)
    thumbnail = {
      key: memoThumbnailObjectKey({
        user_id: input.userId,
        id: input.id,
        mime: thumbnailMime,
        filename: thumbnailFilename,
      }),
      filename: thumbnailFilename,
      mime: thumbnailMime,
      bytes: input.thumbnail.bytes,
    }
  }

  const storageKey = memoAttachmentObjectKey({
    user_id: input.userId,
    id: input.id,
    mime,
    filename,
  })
  const mediaMetadata = input.mediaMetadata ? JSON.stringify(input.mediaMetadata) : null

  return withAttachmentQuotaLease(env, input.userId, async (usedBytes) => {
    if (usedBytes + input.bytes.byteLength > MEMO_ATTACHMENT_QUOTA_BYTES) {
      throw new MemoAttachmentError(
        413,
        'memo_attachment_quota',
        'The account attachment quota has been reached',
      )
    }

    const sha256 = await sha256Hex(input.bytes)
    const storedKeys: string[] = []
    try {
      await putAttachmentObject(env, storage, storageKey, input.bytes, {
        userId: input.userId,
        objectId: input.id,
        kind: 'memo',
        filename,
        mime,
        sha256,
      })
      storedKeys.push(storageKey)
      if (thumbnail) {
        await putAttachmentObject(env, storage, thumbnail.key, thumbnail.bytes, {
          userId: input.userId,
          objectId: input.id,
          kind: 'memo',
          filename: thumbnail.filename,
          mime: thumbnail.mime,
          sha256: await sha256Hex(thumbnail.bytes),
        })
        storedKeys.push(thumbnail.key)
      }
    } catch (error) {
      await discardStoredObjects(env, input.userId, storage, storedKeys)
      throw error
    }

    try {
      await env.DB.prepare(
        `INSERT INTO memos_attachments (
           id, user_id, memo_id, filename, mime, size, storage, storage_key, width, height,
           thumbnail_key, media_metadata, motion_group_id, motion_role, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
      )
        .bind(
          input.id,
          input.userId,
          input.memoId,
          filename,
          mime,
          input.bytes.byteLength,
          storage,
          storageKey,
          dimensions?.width ?? null,
          dimensions?.height ?? null,
          thumbnail?.key ?? null,
          mediaMetadata,
          input.motionGroupId,
          input.motionRole,
          input.createdAt,
          input.createdAt,
        )
        .run()
    } catch (error) {
      await discardStoredObjects(env, input.userId, storage, storedKeys)
      throw error
    }

    return {
      id: input.id,
      user_id: input.userId,
      memo_id: input.memoId,
      filename,
      mime,
      size: input.bytes.byteLength,
      storage,
      storage_key: storageKey,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      thumbnail_key: thumbnail?.key ?? null,
      media_metadata: mediaMetadata,
      motion_group_id: input.motionGroupId,
      motion_role: input.motionRole,
      created_at: input.createdAt,
      updated_at: input.createdAt,
    }
  })
}

export async function listMemoAttachments(
  db: D1Database,
  userId: string,
  options: MemoAttachmentListOptions,
): Promise<MemoAttachmentListPage> {
  const clauses = ['a.user_id = ?1']
  const values: Array<string | number> = [userId]
  if (options.scope === 'media') {
    clauses.push(`(a.mime LIKE 'image/%' OR a.mime LIKE 'video/%')`)
  } else if (options.scope === 'audio') {
    clauses.push(`a.mime LIKE 'audio/%'`)
  } else if (options.scope === 'documents') {
    clauses.push(`a.mime NOT LIKE 'image/%' AND a.mime NOT LIKE 'video/%' AND a.mime NOT LIKE 'audio/%'`)
  } else if (options.scope === 'unused') {
    clauses.push('a.memo_id IS NULL')
  }
  if (options.spaceId) {
    values.push(options.spaceId)
    clauses.push(`m.space_id = ?${values.length}`)
  }
  if (options.memoId) {
    values.push(options.memoId)
    clauses.push(`a.memo_id = ?${values.length}`)
  }
  const limitIndex = values.length + 1
  values.push(options.limit + 1)
  const offsetIndex = values.length + 1
  values.push(options.offset)

  const { results } = await db.prepare(
    `SELECT ${ATTACHMENT_LIST_COLUMNS}
       FROM memos_attachments a
       LEFT JOIN memos_items m ON m.id = a.memo_id AND m.user_id = a.user_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?${limitIndex} OFFSET ?${offsetIndex}`,
  )
    .bind(...values)
    .all<MemoAttachmentListRow>()

  const rows = results.slice(0, options.limit)
  return {
    rows,
    nextOffset: results.length > options.limit ? options.offset + rows.length : null,
  }
}

export async function getMemoAttachment(
  db: D1Database,
  userId: string,
  id: string,
): Promise<MemoAttachmentListRow | null> {
  return db.prepare(
    `SELECT ${ATTACHMENT_LIST_COLUMNS}
       FROM memos_attachments a
       LEFT JOIN memos_items m ON m.id = a.memo_id AND m.user_id = a.user_id
      WHERE a.id = ?1 AND a.user_id = ?2`,
  )
    .bind(id, userId)
    .first<MemoAttachmentListRow>()
}

export async function deleteMemoAttachments(
  env: Env,
  userId: string,
  ids: readonly string[],
): Promise<MemoAttachmentDeleteResult> {
  const rows = await attachmentsByIds(env.DB, userId, ids)
  if (!rows.length) return { deleted: 0, freedBytes: 0 }
  const expanded = await expandMotionGroups(env.DB, userId, rows)
  await assertAttachmentsUnreferenced(env.DB, userId, expanded)
  const result = await deleteAttachmentRows(env, userId, expanded, false)
  await drainCleanupBestEffort(env, userId)
  return result
}

export async function pruneUnusedMemoAttachments(
  env: Env,
  userId: string,
): Promise<MemoAttachmentDeleteResult> {
  const boundary = await env.DB.prepare(
    `SELECT created_at, id FROM memos_attachments
      WHERE user_id = ?1 AND memo_id IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(userId)
    .first<{ created_at: number; id: string }>()
  if (!boundary) return { deleted: 0, freedBytes: 0 }

  let deleted = 0
  let freedBytes = 0
  for (;;) {
    const { results: rows } = await env.DB.prepare(
      `SELECT ${ATTACHMENT_COLUMNS}
         FROM memos_attachments a
        WHERE a.user_id = ?1 AND a.memo_id IS NULL
          AND (a.created_at < ?2 OR (a.created_at = ?2 AND a.id <= ?3))
        ORDER BY a.created_at ASC, a.id ASC
        LIMIT ?4`,
    )
      .bind(userId, boundary.created_at, boundary.id, PRUNE_BATCH_SIZE)
      .all<MemoAttachmentRow>()
    if (!rows.length) break
    const result = await deleteAttachmentRows(env, userId, rows, true)
    deleted += result.deleted
    freedBytes += result.freedBytes
    if (result.deleted === 0) break
  }
  await drainCleanupBestEffort(env, userId)
  return { deleted, freedBytes }
}

export async function memoAttachmentForFile(
  db: D1Database,
  id: string,
): Promise<MemoAttachmentFileRow | null> {
  return db.prepare(
    `SELECT ${ATTACHMENT_COLUMNS}, m.visibility AS memo_visibility, m.state AS memo_state
       FROM memos_attachments a
       LEFT JOIN memos_items m ON m.id = a.memo_id AND m.user_id = a.user_id
      WHERE a.id = ?1`,
  )
    .bind(id)
    .first<MemoAttachmentFileRow>()
}

export async function motionVideoForAttachment(
  db: D1Database,
  row: MemoAttachmentRow,
): Promise<MemoAttachmentRow | null> {
  if (!row.motion_group_id) return null
  return db.prepare(
    `SELECT ${ATTACHMENT_COLUMNS}
       FROM memos_attachments a
      WHERE a.user_id = ?1 AND a.motion_group_id = ?2 AND a.motion_role = 'video'
      ORDER BY CASE WHEN a.id = ?3 THEN 0 ELSE 1 END, a.created_at ASC, a.id ASC
      LIMIT 1`,
  )
    .bind(row.user_id, row.motion_group_id, row.id)
    .first<MemoAttachmentRow>()
}

export async function shareVouchesForAttachment(
  db: D1Database,
  tokenHash: string,
  userId: string,
  memoId: string,
  now: number,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS ok FROM memos_shares
      WHERE token_hash = ?1 AND user_id = ?2 AND memo_id = ?3
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?4)
      LIMIT 1`,
  )
    .bind(tokenHash, userId, memoId, now)
    .first<{ ok: number }>()
  return Boolean(row)
}

export function toMemoAttachmentView(
  row: MemoAttachmentRow | MemoAttachmentListRow,
): MemoAttachmentView {
  const url = `${MEMO_FILE_URL_PREFIX}${row.id}`
  const memoTitle = 'memo_title' in row ? row.memo_title : null
  const memoSnippet = 'memo_snippet' in row ? row.memo_snippet : null
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    url,
    thumbnailUrl: row.thumbnail_key ? `${url}?thumb=1` : null,
    motion: motionFromRow(row),
    mediaMetadata: row.media_metadata ? parseMemoMediaMetadata(row.media_metadata) : null,
    createdAt: row.created_at,
    memoId: row.memo_id,
    memo: row.memo_id && memoTitle !== null
      ? { id: row.memo_id, title: memoTitle, snippet: memoSnippet ?? '' }
      : null,
  }
}

async function memoBelongsToUser(db: D1Database, userId: string, memoId: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT id FROM memos_items WHERE id = ?1 AND user_id = ?2',
  )
    .bind(memoId, userId)
    .first<{ id: string }>()
  return Boolean(row)
}

async function attachmentsByIds(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<MemoAttachmentRow[]> {
  const unique = [...new Set(ids)]
  const rows: MemoAttachmentRow[] = []
  for (let offset = 0; offset < unique.length; offset += BATCH_ID_CHUNK) {
    const chunk = unique.slice(offset, offset + BATCH_ID_CHUNK)
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    const { results } = await db.prepare(
      `SELECT ${ATTACHMENT_COLUMNS}
         FROM memos_attachments a
        WHERE a.user_id = ?1 AND a.id IN (${placeholders})`,
    )
      .bind(userId, ...chunk)
      .all<MemoAttachmentRow>()
    rows.push(...results)
  }
  return rows
}

async function expandMotionGroups(
  db: D1Database,
  userId: string,
  rows: readonly MemoAttachmentRow[],
): Promise<MemoAttachmentRow[]> {
  const groups = [...new Set(
    rows.map((row) => row.motion_group_id).filter((group): group is string => Boolean(group)),
  )]
  if (!groups.length) return [...rows]

  const byId = new Map(rows.map((row) => [row.id, row]))
  for (let offset = 0; offset < groups.length; offset += BATCH_ID_CHUNK) {
    const chunk = groups.slice(offset, offset + BATCH_ID_CHUNK)
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    const { results } = await db.prepare(
      `SELECT ${ATTACHMENT_COLUMNS}
         FROM memos_attachments a
        WHERE a.user_id = ?1 AND a.motion_group_id IN (${placeholders})`,
    )
      .bind(userId, ...chunk)
      .all<MemoAttachmentRow>()
    for (const row of results) byId.set(row.id, row)
  }
  return [...byId.values()]
}

async function assertAttachmentsUnreferenced(
  db: D1Database,
  userId: string,
  rows: readonly MemoAttachmentRow[],
): Promise<void> {
  for (const row of rows) {
    const memoId = await referencingMemoId(db, userId, row.id)
    if (memoId) {
      throw new MemoAttachmentError(
        409,
        'memo_attachment_in_use',
        `Attachment ${row.id} is still used by memo ${memoId}`,
        { attachmentId: row.id, memoId },
      )
    }
  }
}

async function referencingMemoId(
  db: D1Database,
  userId: string,
  attachmentId: string,
): Promise<string | null> {
  const marker = `${MEMO_FILE_URL_PREFIX}${attachmentId}`
  const { results } = await db.prepare(
    `SELECT id,
            substr(content, max(1, instr(content, ?2) - ?3), length(?2) + ?3 + 1) AS window
       FROM memos_items
      WHERE user_id = ?1 AND instr(content, ?2) > 0
      LIMIT ?4`,
  )
    .bind(userId, marker, MEMO_REFERENCE_WINDOW_CHARS, MEMO_REFERENCE_LOOKUP_LIMIT)
    .all<{ id: string; window: string }>()
  if (!results.length) return null
  const pattern = memoReferencePattern(attachmentId)
  return results.find((row) => pattern.test(row.window))?.id ?? null
}

function memoReferencePattern(attachmentId: string): RegExp {
  const escaped = attachmentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `(?:^|[\\s(<"'=])(?:https?://[^/\\s<>"']+)?${MEMO_FILE_URL_PREFIX}${escaped}(?=$|[\\s>)\\]"'?#])`,
  )
}

async function deleteAttachmentRows(
  env: Env,
  userId: string,
  rows: readonly MemoAttachmentRow[],
  unusedOnly: boolean,
): Promise<MemoAttachmentDeleteResult> {
  let statements: D1PreparedStatement[] = []
  let deleteIndexes: Array<{ index: number; row: MemoAttachmentRow }> = []
  let deleted = 0
  let freedBytes = 0

  const flush = async () => {
    if (!statements.length) return
    const results = await env.DB.batch(statements)
    for (const { index, row } of deleteIndexes) {
      if (results[index]?.meta.changes) {
        deleted += 1
        freedBytes += row.size
      }
    }
    statements = []
    deleteIndexes = []
  }

  for (const row of rows) {
    const keys = [row.storage_key, ...(row.thumbnail_key ? [row.thumbnail_key] : [])]
    if (statements.length + keys.length + 1 > DELETE_STATEMENT_LIMIT) await flush()
    for (const key of keys) {
      const sql = unusedOnly
        ? `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
           SELECT ?1, user_id, ?2 FROM memos_attachments
            WHERE id = ?3 AND user_id = ?4 AND memo_id IS NULL`
        : `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
           SELECT ?1, user_id, ?2 FROM memos_attachments
            WHERE id = ?3 AND user_id = ?4`
      statements.push(
        env.DB.prepare(sql).bind(
          attachmentCleanupTarget(row.storage, key),
          Date.now(),
          row.id,
          userId,
        ),
      )
    }
    const deleteSql = unusedOnly
      ? 'DELETE FROM memos_attachments WHERE id = ?1 AND user_id = ?2 AND memo_id IS NULL'
      : 'DELETE FROM memos_attachments WHERE id = ?1 AND user_id = ?2'
    deleteIndexes.push({ index: statements.length, row })
    statements.push(env.DB.prepare(deleteSql).bind(row.id, userId))
  }
  await flush()
  return { deleted, freedBytes }
}

async function drainCleanupBestEffort(env: Env, userId: string): Promise<void> {
  try {
    await drainAttachmentCleanup(env, userId)
  } catch (error) {
    console.warn('[inkstone] Memo attachment cleanup will retry later:', error)
  }
}

async function discardStoredObjects(
  env: Env,
  userId: string,
  storage: AttachmentObjectStorage,
  keys: readonly string[],
): Promise<void> {
  if (!keys.length) return
  try {
    await deleteAttachmentObjects(env, storage, keys)
  } catch (error) {
    await queueObjectCleanup(env, userId, storage, keys)
    console.warn('[inkstone] Memo attachment object cleanup will retry later:', error)
  }
}

async function queueObjectCleanup(
  env: Env,
  userId: string,
  storage: AttachmentObjectStorage,
  keys: readonly string[],
): Promise<void> {
  try {
    await env.DB.batch(keys.map((key) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
         VALUES (?1, ?2, ?3)`,
      ).bind(attachmentCleanupTarget(storage, key), userId, Date.now()),
    ))
  } catch (error) {
    console.warn('[inkstone] Memo attachment cleanup could not be queued:', error)
  }
}

function motionFromRow(row: MemoAttachmentRow): MemoMotion | null {
  const role = row.motion_role
  if (
    !row.motion_group_id
    || (role !== 'still' && role !== 'video' && role !== 'container')
  ) {
    return null
  }
  return { groupId: row.motion_group_id, role }
}

