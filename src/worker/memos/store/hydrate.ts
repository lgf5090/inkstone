import type {
  Memo,
  MemoAttachment,
  MemoLocation,
  MemoReactionSummary,
  MemoRelation,
  MemoState,
  MemoVisibility,
} from '@shared/memos/types'
import { toMemoAttachmentView, type MemoAttachmentRow } from '../attachments'

export const BATCH_ID_CHUNK = 90

export const MEMO_COLUMNS = `i.id, i.user_id, i.space_id, i.parent_id, i.content, i.content_search,
  i.title, i.snippet, i.visibility, i.state, i.pinned, i.has_link, i.has_code, i.has_task_list,
  i.has_incomplete_tasks, i.has_location, i.location_placeholder, i.latitude, i.longitude, i.rev,
  i.created_at, i.updated_at`

const ATTACHMENT_COLUMNS = `a.id, a.user_id, a.memo_id, a.filename, a.mime, a.size, a.storage,
  a.storage_key, a.width, a.height, a.thumbnail_key, a.media_metadata, a.motion_group_id,
  a.motion_role, a.created_at, a.updated_at`

export interface MemoRow {
  id: string
  user_id: string
  space_id: string | null
  parent_id: string | null
  content: string
  content_search: string
  title: string
  snippet: string
  visibility: MemoVisibility
  state: MemoState
  pinned: number
  has_link: number
  has_code: number
  has_task_list: number
  has_incomplete_tasks: number
  has_location: number
  location_placeholder: string | null
  latitude: number | null
  longitude: number | null
  rev: number
  created_at: number
  updated_at: number
}

interface TagRow {
  memo_id: string
  tag: string
}

interface ReactionRow {
  memo_id: string
  type: string
  count: number
  reacted: number
}

export interface RelationRow {
  memo_id: string
  related_memo_id: string
  created_at: number
  related_snippet: string | null
}

interface CommentCountRow {
  parent_id: string
  count: number
}

export function chunkValues<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size))
  }
  return chunks
}

export function locationOf(row: MemoRow): MemoLocation | null {
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

function toMemoAttachment(row: MemoAttachmentRow): MemoAttachment {
  const view = toMemoAttachmentView(row)
  return {
    id: view.id,
    filename: view.filename,
    mime: view.mime,
    size: view.size,
    width: view.width,
    height: view.height,
    url: view.url,
    thumbnailUrl: view.thumbnailUrl,
    motion: view.motion,
    mediaMetadata: view.mediaMetadata,
    createdAt: view.createdAt,
  }
}

export async function loadMemoRow(
  db: D1Database,
  userId: string,
  id: string,
): Promise<MemoRow | null> {
  return db
    .prepare(`SELECT ${MEMO_COLUMNS} FROM memos_items i WHERE i.id = ?1 AND i.user_id = ?2`)
    .bind(id, userId)
    .first<MemoRow>()
}

export async function hydrateMemos(
  db: D1Database,
  userId: string,
  rows: readonly MemoRow[],
): Promise<Memo[]> {
  if (!rows.length) return []
  const chunks = chunkValues(rows.map((row) => row.id), BATCH_ID_CHUNK)
  const statements: D1PreparedStatement[] = []
  for (const chunk of chunks) {
    const tagPlaceholders = chunk.map((_, index) => `?${index + 1}`).join(', ')
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    statements.push(
      db
        .prepare(
          `SELECT memo_id, tag FROM memos_tags
            WHERE memo_id IN (${tagPlaceholders}) ORDER BY memo_id ASC, tag ASC`,
        )
        .bind(...chunk),
      db
        .prepare(
          `SELECT ${ATTACHMENT_COLUMNS} FROM memos_attachments a
            WHERE a.user_id = ?1 AND a.memo_id IN (${placeholders})
            ORDER BY a.created_at ASC, a.id ASC`,
        )
        .bind(userId, ...chunk),
      db
        .prepare(
          `SELECT memo_id, type, COUNT(*) AS count,
                  MAX(CASE WHEN user_id = ?1 THEN 1 ELSE 0 END) AS reacted
             FROM memos_reactions
            WHERE memo_id IN (${placeholders})
            GROUP BY memo_id, type
            ORDER BY memo_id ASC, type ASC`,
        )
        .bind(userId, ...chunk),
      db
        .prepare(
          `SELECT r.memo_id, r.related_memo_id, r.created_at, m.snippet AS related_snippet
             FROM memos_relations r
             JOIN memos_items m ON m.id = r.related_memo_id AND m.user_id = ?1
            WHERE r.memo_id IN (${placeholders})
            ORDER BY r.memo_id ASC, r.created_at ASC, r.related_memo_id ASC`,
        )
        .bind(userId, ...chunk),
      db
        .prepare(
          `SELECT parent_id, COUNT(*) AS count FROM memos_items
            WHERE user_id = ?1 AND state = 'normal' AND parent_id IN (${placeholders})
            GROUP BY parent_id`,
        )
        .bind(userId, ...chunk),
    )
  }

  const results = await db.batch(statements)
  const tagRows: TagRow[] = []
  const attachmentRows: MemoAttachmentRow[] = []
  const reactionRows: ReactionRow[] = []
  const relationRows: RelationRow[] = []
  const commentCountRows: CommentCountRow[] = []
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const base = chunkIndex * 5
    tagRows.push(...((results[base]?.results as TagRow[] | undefined) ?? []))
    attachmentRows.push(...((results[base + 1]?.results as MemoAttachmentRow[] | undefined) ?? []))
    reactionRows.push(...((results[base + 2]?.results as ReactionRow[] | undefined) ?? []))
    relationRows.push(...((results[base + 3]?.results as RelationRow[] | undefined) ?? []))
    commentCountRows.push(...((results[base + 4]?.results as CommentCountRow[] | undefined) ?? []))
  }

  const tags = new Map<string, string[]>()
  for (const row of tagRows) {
    const list = tags.get(row.memo_id)
    if (list) list.push(row.tag)
    else tags.set(row.memo_id, [row.tag])
  }
  const attachments = new Map<string, MemoAttachment[]>()
  for (const row of attachmentRows) {
    const memoId = row.memo_id
    if (!memoId) continue
    const list = attachments.get(memoId)
    if (list) list.push(toMemoAttachment(row))
    else attachments.set(memoId, [toMemoAttachment(row)])
  }
  const reactions = new Map<string, MemoReactionSummary[]>()
  for (const row of reactionRows) {
    const list = reactions.get(row.memo_id)
    const summary: MemoReactionSummary = {
      type: row.type,
      count: Number(row.count),
      reacted: Boolean(row.reacted),
    }
    if (list) list.push(summary)
    else reactions.set(row.memo_id, [summary])
  }
  const relations = new Map<string, MemoRelation[]>()
  for (const row of relationRows) {
    const list = relations.get(row.memo_id)
    const relation: MemoRelation = {
      memoId: row.memo_id,
      relatedMemoId: row.related_memo_id,
      relatedSnippet: row.related_snippet ?? '',
      createdAt: row.created_at,
    }
    if (list) list.push(relation)
    else relations.set(row.memo_id, [relation])
  }
  const commentCounts = new Map<string, number>()
  for (const row of commentCountRows) commentCounts.set(row.parent_id, Number(row.count))

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    title: row.title,
    snippet: row.snippet,
    tags: tags.get(row.id) ?? [],
    visibility: row.visibility,
    state: row.state,
    pinned: Boolean(row.pinned),
    spaceId: row.space_id,
    parentId: row.parent_id,
    location: locationOf(row),
    properties: {
      hasLink: Boolean(row.has_link),
      hasCode: Boolean(row.has_code),
      hasTaskList: Boolean(row.has_task_list),
      hasIncompleteTasks: Boolean(row.has_incomplete_tasks),
      hasLocation: Boolean(row.has_location),
    },
    attachments: attachments.get(row.id) ?? [],
    reactions: reactions.get(row.id) ?? [],
    relations: relations.get(row.id) ?? [],
    commentCount: commentCounts.get(row.id) ?? 0,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export async function readMemo(
  db: D1Database,
  userId: string,
  id: string,
): Promise<Memo | null> {
  const row = await loadMemoRow(db, userId, id)
  if (!row) return null
  const [memo] = await hydrateMemos(db, userId, [row])
  return memo ?? null
}
