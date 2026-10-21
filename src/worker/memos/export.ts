import { APP_VERSION } from '@shared/constants'
import {
  MEMO_EXPORT_FORMAT,
  MEMO_EXPORT_FORMAT_VERSION,
  MEMO_EXPORT_GENERATOR_NAME,
  MEMO_EXPORT_MANIFEST_ENTRY,
  MEMO_EXPORT_MAX_ENTRIES,
  MEMO_EXPORT_MAX_TOTAL_BYTES,
  memoExportArchiveFilename,
  memoExportAttachmentPath,
  memoExportMemoContentPath,
  memoExportMemoJsonPath,
  memoExportTimestamp,
  isMemoExportMediaType,
  type MemoExportAttachment,
  type MemoExportLocation,
  type MemoExportManifest,
  type MemoExportMemoRecord,
  type MemoExportVisibility,
} from '@shared/memos/export'
import type { MemoState, MemoVisibility } from '@shared/memos/types'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import type { Env } from '../env'
import {
  hasAttachmentStorage,
  readAttachmentObject,
} from '../attachments/backend'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import type { MemoAttachmentRow } from './attachments'

export interface MemoExportOptions {
  now?: number
  maxEntries?: number
  maxTotalBytes?: number
}

export interface MemoExportArchive {
  filename: string
  stream: ReadableStream<Uint8Array>
  manifest: MemoExportManifest
}

interface MemoExportUserRow {
  username: string
  name: string
}

interface MemoRow {
  id: string
  space_id: string | null
  parent_id: string | null
  content: string
  visibility: MemoVisibility
  state: MemoState
  pinned: number
  has_location: number
  location_placeholder: string | null
  latitude: number | null
  longitude: number | null
  created_at: number
  updated_at: number
}

interface MemoAggregateRow {
  memos: number
  content_bytes: number
}

interface AttachmentAggregateRow {
  attachments: number
  attachment_bytes: number
}

interface TagRow {
  memo_id: string
  tag: string
}

interface RelationRow {
  memo_id: string
  related_memo_id: string
}

interface SpaceRow {
  id: string
  title: string
}

const MEMO_COLUMNS = `id, space_id, parent_id, content, visibility, state, pinned, has_location,
  location_placeholder, latitude, longitude, created_at, updated_at`

const ATTACHMENT_COLUMNS = `a.id, a.user_id, a.memo_id, a.filename, a.mime, a.size, a.storage,
  a.storage_key, a.width, a.height, a.thumbnail_key, a.media_metadata, a.motion_group_id,
  a.motion_role, a.created_at, a.updated_at`

const VISIBILITY_BY_MEMO: Record<MemoVisibility, MemoExportVisibility> = {
  private: 'PRIVATE',
  protected: 'PROTECTED',
  public: 'PUBLIC',
}

const EXTENDED_TIMESTAMP_EXTRA_ID = 0x5455
const COMPRESSION_LEVEL = 6

export async function buildMemoExport(
  env: Env,
  userId: string,
  options: MemoExportOptions = {},
): Promise<MemoExportArchive> {
  const maxEntries = resolveLimit(options.maxEntries, MEMO_EXPORT_MAX_ENTRIES)
  const maxTotalBytes = resolveLimit(options.maxTotalBytes, MEMO_EXPORT_MAX_TOTAL_BYTES)

  const user = await env.DB.prepare(
    'SELECT username, name FROM users WHERE id = ?1',
  )
    .bind(userId)
    .first<MemoExportUserRow>()
  if (!user) throw new ApiError(500, 'internal', 'The account for this export no longer exists')

  const aggregate = await env.DB.prepare(
    `SELECT COUNT(*) AS memos,
            COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS content_bytes
       FROM memos_items
      WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<MemoAggregateRow>()
  const attachmentAggregate = await env.DB.prepare(
    `SELECT COUNT(*) AS attachments,
            COALESCE(SUM(a.size), 0) AS attachment_bytes
       FROM memos_attachments a
       JOIN memos_items i ON i.id = a.memo_id AND i.user_id = ?1
      WHERE a.user_id = ?1`,
  )
    .bind(userId)
    .first<AttachmentAggregateRow>()

  const memoCount = Number(aggregate?.memos ?? 0)
  const attachmentCount = Number(attachmentAggregate?.attachments ?? 0)
  const contentBytes = Number(aggregate?.content_bytes ?? 0)
  const attachmentBytes = Number(attachmentAggregate?.attachment_bytes ?? 0)

  const entryCount = 1 + memoCount * 2 + attachmentCount
  if (entryCount > maxEntries) {
    throw new ApiError(
      413,
      'payload_too_large',
      `This export would contain ${entryCount} entries, above the ${maxEntries} entry limit`,
    )
  }
  if (contentBytes + attachmentBytes > maxTotalBytes) {
    throw new ApiError(
      413,
      'payload_too_large',
      `This export would contain ${contentBytes + attachmentBytes} bytes, above the ${maxTotalBytes} byte limit`,
    )
  }

  const memoRows = (await env.DB.prepare(
    `SELECT ${MEMO_COLUMNS}
       FROM memos_items
      WHERE user_id = ?1
      ORDER BY parent_id IS NOT NULL ASC, created_at ASC, id ASC`,
  )
    .bind(userId)
    .all<MemoRow>()).results
  const tagRows = (await env.DB.prepare(
    `SELECT t.memo_id, t.tag
       FROM memos_tags t
       JOIN memos_items i ON i.id = t.memo_id AND i.user_id = ?1
      ORDER BY t.memo_id ASC, t.tag ASC`,
  )
    .bind(userId)
    .all<TagRow>()).results
  const relationRows = (await env.DB.prepare(
    `SELECT r.memo_id, r.related_memo_id
       FROM memos_relations r
       JOIN memos_items source ON source.id = r.memo_id AND source.user_id = ?1
       JOIN memos_items target ON target.id = r.related_memo_id AND target.user_id = ?1
      ORDER BY r.memo_id ASC, r.created_at ASC, r.related_memo_id ASC`,
  )
    .bind(userId)
    .all<RelationRow>()).results
  const spaceRows = (await env.DB.prepare(
    'SELECT id, title FROM memos_spaces WHERE user_id = ?1',
  )
    .bind(userId)
    .all<SpaceRow>()).results
  const attachmentRows = (await env.DB.prepare(
    `SELECT ${ATTACHMENT_COLUMNS}
       FROM memos_attachments a
       JOIN memos_items i ON i.id = a.memo_id AND i.user_id = ?1
      WHERE a.user_id = ?1
      ORDER BY a.created_at ASC, a.id ASC`,
  )
    .bind(userId)
    .all<MemoAttachmentRow>()).results

  const memoIds = new Set(memoRows.map((row) => row.id))
  const spaceTitles = new Map(spaceRows.map((row) => [row.id, row.title]))
  const tagsByMemo = new Map<string, string[]>()
  for (const row of tagRows) {
    const tags = tagsByMemo.get(row.memo_id)
    if (tags) tags.push(row.tag)
    else tagsByMemo.set(row.memo_id, [row.tag])
  }
  const relationsByMemo = new Map<string, string[]>()
  for (const row of relationRows) {
    if (!memoIds.has(row.related_memo_id)) continue
    const relations = relationsByMemo.get(row.memo_id)
    if (relations) relations.push(row.related_memo_id)
    else relationsByMemo.set(row.memo_id, [row.related_memo_id])
  }

  const exportSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  const exportTime = memoExportTimestamp(exportSeconds)
  const exportDate = new Date(exportSeconds * 1000)
  const extendedTimestamp = {
    [EXTENDED_TIMESTAMP_EXTRA_ID]: extendedTimestampExtra(exportSeconds),
  }
  const manifest: MemoExportManifest = {
    format: MEMO_EXPORT_FORMAT,
    formatVersion: MEMO_EXPORT_FORMAT_VERSION,
    generator: { name: MEMO_EXPORT_GENERATOR_NAME, version: APP_VERSION },
    exportTime,
    scope: {
      kind: 'USER',
      user: {
        username: user.username,
        ...(user.name ? { displayName: user.name } : {}),
      },
    },
    counts: {
      memos: memoRows.length,
      attachments: attachmentCount,
    },
  }

  const chunks: Uint8Array[] = []
  const failure: { error: Error | null } = { error: null }
  const zip = new Zip((error, chunk) => {
    if (error) {
      failure.error = error
      return
    }
    if (chunk.byteLength) chunks.push(chunk)
  })
  const entryNames = new Set<string>()
  let writtenBytes = 0
  const addEntry = (path: string, bytes: Uint8Array, compress: boolean): void => {
    if (failure.error) throw failure.error
    if (entryNames.has(path)) throw new Error(`The export contains a duplicate entry: ${path}`)
    if (entryNames.size >= maxEntries) {
      throw new ApiError(
        413,
        'payload_too_large',
        `This export would contain more than ${maxEntries} entries`,
      )
    }
    if (writtenBytes + bytes.byteLength > maxTotalBytes) {
      throw new ApiError(
        413,
        'payload_too_large',
        `This export would contain more than ${maxTotalBytes} bytes`,
      )
    }
    const file = compress
      ? new ZipDeflate(path, { level: COMPRESSION_LEVEL })
      : new ZipPassThrough(path)
    file.mtime = exportDate
    file.extra = extendedTimestamp
    zip.add(file)
    file.push(bytes, true)
    if (failure.error) throw failure.error
    entryNames.add(path)
    writtenBytes += bytes.byteLength
  }

  addEntry(MEMO_EXPORT_MANIFEST_ENTRY, encodeJson(manifest), true)

  const attachmentsByMemo = new Map<string, MemoExportAttachment[]>()
  let preparedAttachments = 0
  for (const row of attachmentRows) {
    const memoId = row.memo_id
    if (!memoId || !memoIds.has(memoId)) continue
    if (!hasAttachmentStorage(env, row.storage)) {
      const backend = row.storage === 'r2' ? 'R2' : 'Workers KV'
      throw new ApiError(
        503,
        'storage_unavailable',
        `${backend} attachment storage is not bound, so this export cannot include attachment ${row.id}`,
      )
    }
    const bytes = await readAttachmentObject(env, row.storage, row.storage_key)
    if (!bytes) {
      throw new ApiError(500, 'internal', `Attachment ${row.id} is missing from storage`)
    }
    if (bytes.byteLength !== row.size) {
      throw new ApiError(500, 'internal', `Attachment ${row.id} does not match its recorded size`)
    }
    const filename = row.filename || 'file'
    const path = memoExportAttachmentPath(row.id, filename)
    const entry: MemoExportAttachment = {
      uid: row.id,
      filename,
      type: isMemoExportMediaType(row.mime) ? row.mime : 'application/octet-stream',
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      path,
      createTime: memoExportTimestamp(row.created_at),
      ...(row.width !== null && row.height !== null
        ? { mediaMetadata: { width: row.width, height: row.height } }
        : {}),
    }
    addEntry(path, bytes, false)
    preparedAttachments += 1
    const entries = attachmentsByMemo.get(memoId)
    if (entries) entries.push(entry)
    else attachmentsByMemo.set(memoId, [entry])
  }
  if (preparedAttachments !== attachmentCount) {
    throw new ApiError(500, 'internal', 'The attachment set changed during the export')
  }

  for (const row of memoRows) {
    const record: MemoExportMemoRecord = {
      uid: row.id,
      creator: user.username,
      createTime: memoExportTimestamp(row.created_at),
      updateTime: memoExportTimestamp(row.updated_at),
      state: row.state === 'archived' ? 'ARCHIVED' : 'NORMAL',
      visibility: VISIBILITY_BY_MEMO[row.visibility] ?? 'PRIVATE',
      pinned: Boolean(row.pinned),
      contentPath: memoExportMemoContentPath(row.id),
    }
    const tags = tagsByMemo.get(row.id)
    if (tags?.length) record.tags = tags
    const location = memoLocation(row)
    if (location) record.location = location
    const spaceTitle = row.space_id === null ? undefined : spaceTitles.get(row.space_id)
    if (row.space_id !== null && spaceTitle !== undefined) {
      record.space = { uid: row.space_id, title: spaceTitle }
    }
    if (row.parent_id !== null && memoIds.has(row.parent_id)) record.parent = row.parent_id
    const relations = relationsByMemo.get(row.id)
    if (relations?.length) {
      record.relations = relations.map((memo) => ({ type: 'REFERENCE', memo }))
    }
    const attachments = attachmentsByMemo.get(row.id)
    if (attachments?.length) record.attachments = attachments

    addEntry(memoExportMemoJsonPath(row.id), encodeJson(record), true)
    addEntry(record.contentPath, encodeText(row.content), true)
  }

  if (failure.error) throw failure.error
  zip.end()
  if (failure.error) throw failure.error
  if (!chunks.length) throw new Error('The export produced no ZIP data')

  return {
    filename: memoExportArchiveFilename(user.username, exportTime),
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    manifest,
  }
}

function resolveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function memoLocation(row: MemoRow): MemoExportLocation | null {
  if (
    !row.has_location
    || row.location_placeholder === null
    || row.latitude === null
    || row.longitude === null
  ) {
    return null
  }
  return {
    placeholder: row.location_placeholder,
    latitude: row.latitude,
    longitude: row.longitude,
  }
}

function encodeJson(value: unknown): Uint8Array {
  return encodeText(JSON.stringify(value))
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function extendedTimestampExtra(unixSeconds: number): Uint8Array {
  const extra = new Uint8Array(5)
  extra[0] = 1
  new DataView(extra.buffer).setUint32(1, Math.min(0xffffffff, Math.max(0, unixSeconds)), true)
  return extra
}
