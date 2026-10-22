import type { MemoSpace } from '@shared/memos/types'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { spaceBelongsToUser } from './space-access'
import { MemosStore, type MemoAttachmentObjectRef } from './store'

export { spaceBelongsToUser }

export const MEMO_SPACE_TITLE_MAX_LENGTH = 120
export const MEMO_SPACE_DESCRIPTION_MAX_LENGTH = 1024
export const MEMO_SPACE_ICON_MAX_LENGTH = 64

const MAX_SPACE_ID_ATTEMPTS = 5

const SPACE_COLUMNS = `s.id, s.title, s.description, s.icon, s.created_at, s.updated_at`

const MEMO_COUNT_SQL = `(SELECT COUNT(*) FROM memos_items i
    WHERE i.user_id = s.user_id AND i.space_id = s.id AND i.parent_id IS NULL) AS memo_count`

export type MemoSpaceDeleteMode = 'unfile' | 'delete'

export interface MemoSpaceFields {
  title?: unknown
  description?: unknown
  icon?: unknown
}

interface SpaceRow {
  id: string
  title: string
  description: string
  icon: string
  created_at: number
  updated_at: number
  memo_count: number
}

function toSpace(row: SpaceRow): MemoSpace {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    icon: row.icon,
    memoCount: row.memo_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function spaceTitle(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('Space title must be a string')
  const title = value.trim()
  if (!title) throw ApiError.badRequest('Space title cannot be empty')
  if (title.length > MEMO_SPACE_TITLE_MAX_LENGTH) {
    throw ApiError.badRequest(`Space title cannot exceed ${MEMO_SPACE_TITLE_MAX_LENGTH} characters`)
  }
  return title
}

function spaceText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw ApiError.badRequest(`Space ${field} must be a string`)
  const text = value.trim()
  if (text.length > max) {
    throw ApiError.badRequest(`Space ${field} cannot exceed ${max} characters`)
  }
  return text
}

function spaceDescription(value: unknown): string {
  return spaceText(value, 'description', MEMO_SPACE_DESCRIPTION_MAX_LENGTH)
}

function spaceIcon(value: unknown): string {
  return spaceText(value, 'icon', MEMO_SPACE_ICON_MAX_LENGTH)
}

export async function listSpaces(db: D1Database, userId: string): Promise<MemoSpace[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SPACE_COLUMNS}, ${MEMO_COUNT_SQL}
         FROM memos_spaces s
        WHERE s.user_id = ?1
        ORDER BY s.created_at ASC, s.id ASC`,
    )
    .bind(userId)
    .all<SpaceRow>()
  return results.map(toSpace)
}

export async function createSpace(
  db: D1Database,
  userId: string,
  input: MemoSpaceFields,
): Promise<MemoSpace> {
  if (input.title === undefined || input.title === null) {
    throw ApiError.badRequest('Space title is required')
  }
  const title = spaceTitle(input.title)
  const description = input.description === undefined ? '' : spaceDescription(input.description)
  const icon = input.icon === undefined ? '' : spaceIcon(input.icon)
  const now = nowSeconds()

  for (let attempt = 0; attempt < MAX_SPACE_ID_ATTEMPTS; attempt++) {
    const id = newId()
    const { meta } = await db
      .prepare(
        `INSERT OR IGNORE INTO memos_spaces (id, user_id, title, description, icon, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(id, userId, title, description, icon, now)
      .run()
    if (meta.changes > 0) {
      return { id, title, description, icon, memoCount: 0, createdAt: now, updatedAt: now }
    }
  }
  throw ApiError.conflict('Could not allocate a space id. Try again')
}

export async function patchSpace(
  db: D1Database,
  userId: string,
  id: string,
  input: MemoSpaceFields,
): Promise<MemoSpace | null> {
  const current = await db
    .prepare(
      `SELECT ${SPACE_COLUMNS}, ${MEMO_COUNT_SQL}
         FROM memos_spaces s
        WHERE s.id = ?1 AND s.user_id = ?2`,
    )
    .bind(id, userId)
    .first<SpaceRow>()
  if (!current) return null

  if (input.title === undefined && input.description === undefined && input.icon === undefined) {
    return toSpace(current)
  }

  const title = input.title === undefined ? current.title : spaceTitle(input.title)
  const description = input.description === undefined ? current.description : spaceDescription(input.description)
  const icon = input.icon === undefined ? current.icon : spaceIcon(input.icon)

  const { results } = await db
    .prepare(
      `UPDATE memos_spaces
          SET title = ?3, description = ?4, icon = ?5, updated_at = MAX(?6, updated_at + 1)
        WHERE id = ?1 AND user_id = ?2
        RETURNING id, title, description, icon, created_at, updated_at`,
    )
    .bind(id, userId, title, description, icon, nowSeconds())
    .all<SpaceRow>()

  const row = results[0]
  if (!row) return null
  return toSpace({ ...row, memo_count: current.memo_count })
}

export interface MemoSpaceDeleteResult {
  deleted: boolean
  attachmentObjects: MemoAttachmentObjectRef[]
}

export async function deleteSpace(
  db: D1Database,
  userId: string,
  id: string,
  mode: MemoSpaceDeleteMode,
): Promise<MemoSpaceDeleteResult> {
  if (!(await spaceBelongsToUser(db, userId, id))) {
    return { deleted: false, attachmentObjects: [] }
  }

  if (mode === 'delete') {
    const { results } = await db
      .prepare(
        `SELECT id FROM memos_items
          WHERE user_id = ?1 AND space_id = ?2 AND parent_id IS NULL`,
      )
      .bind(userId, id)
      .all<{ id: string }>()
    const attachmentObjects: MemoAttachmentObjectRef[] = []
    const store = new MemosStore(db, userId)
    for (const memo of results) {
      const result = await store.delete(memo.id)
      if (result) attachmentObjects.push(...result.attachmentObjects)
    }
    const { meta } = await db
      .prepare(`DELETE FROM memos_spaces WHERE id = ?2 AND user_id = ?1`)
      .bind(userId, id)
      .run()
    return { deleted: meta.changes > 0, attachmentObjects }
  }

  const results = await db.batch([
    db
      .prepare(
        `UPDATE memos_items
            SET space_id = NULL, updated_at = MAX(?3, updated_at + 1)
          WHERE user_id = ?1 AND space_id = ?2`,
      )
      .bind(userId, id, nowSeconds()),
    db.prepare(`DELETE FROM memos_spaces WHERE id = ?2 AND user_id = ?1`).bind(userId, id),
  ])
  return { deleted: (results[1]?.meta.changes ?? 0) > 0, attachmentObjects: [] }
}
