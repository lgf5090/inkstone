import { validateMemoFilter } from '@shared/memos/filter'
import type { MemoView, MemoViewValidation } from '@shared/memos/types'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'

export const MEMO_VIEW_TITLE_MAX_LENGTH = 120
export const MEMO_VIEW_ICON_MAX_LENGTH = 64

const MAX_VIEW_ID_ATTEMPTS = 5

const VIEW_COLUMNS = 'id, title, filter, icon, created_at, updated_at'

export interface MemoViewFields {
  title?: unknown
  filter?: unknown
  icon?: unknown
}

interface ViewRow {
  id: string
  title: string
  filter: string
  icon: string
  created_at: number
  updated_at: number
}

function toView(row: ViewRow): MemoView {
  return {
    id: row.id,
    title: row.title,
    filter: row.filter,
    icon: row.icon,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function viewTitle(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('View title must be a string')
  const title = value.trim()
  if (!title) throw ApiError.badRequest('View title cannot be empty')
  if (title.length > MEMO_VIEW_TITLE_MAX_LENGTH) {
    throw ApiError.badRequest(`View title cannot exceed ${MEMO_VIEW_TITLE_MAX_LENGTH} characters`)
  }
  return title
}

function viewIcon(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('View icon must be a string')
  const icon = value.trim()
  if (icon.length > MEMO_VIEW_ICON_MAX_LENGTH) {
    throw ApiError.badRequest(`View icon cannot exceed ${MEMO_VIEW_ICON_MAX_LENGTH} characters`)
  }
  return icon
}

export function validateViewFilter(expression: unknown): MemoViewValidation {
  if (expression === undefined || expression === null) {
    return { ok: false, error: { message: 'View filter is required', position: null } }
  }
  if (typeof expression !== 'string') {
    return { ok: false, error: { message: 'View filter must be a string', position: null } }
  }
  if (!expression.trim()) {
    return { ok: false, error: { message: 'View filter is required', position: null } }
  }
  return validateMemoFilter(expression)
}

function viewFilter(value: unknown): string {
  if (typeof value !== 'string') {
    const message = value === undefined || value === null ? 'View filter is required' : 'View filter must be a string'
    throw ApiError.badRequest(message)
  }
  const validation = validateViewFilter(value)
  if (!validation.ok) {
    const detail = validation.error ?? { message: 'Invalid view filter', position: null }
    throw ApiError.badRequest(detail.message, { position: detail.position })
  }
  return value
}

export async function listViews(db: D1Database, userId: string): Promise<MemoView[]> {
  const { results } = await db
    .prepare(
      `SELECT ${VIEW_COLUMNS}
         FROM memos_views
        WHERE user_id = ?1
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(userId)
    .all<ViewRow>()
  return results.map(toView)
}

export async function createView(
  db: D1Database,
  userId: string,
  input: MemoViewFields,
): Promise<MemoView> {
  if (input.title === undefined || input.title === null) {
    throw ApiError.badRequest('View title is required')
  }
  const title = viewTitle(input.title)
  const filter = viewFilter(input.filter)
  const icon = input.icon === undefined ? '' : viewIcon(input.icon)
  const now = nowSeconds()

  for (let attempt = 0; attempt < MAX_VIEW_ID_ATTEMPTS; attempt++) {
    const id = newId()
    const { meta } = await db
      .prepare(
        `INSERT OR IGNORE INTO memos_views (id, user_id, title, filter, icon, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(id, userId, title, filter, icon, now)
      .run()
    if (meta.changes > 0) {
      return { id, title, filter, icon, createdAt: now, updatedAt: now }
    }
  }
  throw ApiError.conflict('Could not allocate a view id. Try again')
}

export async function patchView(
  db: D1Database,
  userId: string,
  id: string,
  input: MemoViewFields,
): Promise<MemoView | null> {
  const current = await db
    .prepare(`SELECT ${VIEW_COLUMNS} FROM memos_views WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<ViewRow>()
  if (!current) return null

  if (input.title === undefined && input.filter === undefined && input.icon === undefined) {
    return toView(current)
  }

  const title = input.title === undefined ? current.title : viewTitle(input.title)
  const filter = input.filter === undefined ? current.filter : viewFilter(input.filter)
  const icon = input.icon === undefined ? current.icon : viewIcon(input.icon)

  const { results } = await db
    .prepare(
      `UPDATE memos_views
          SET title = ?3, filter = ?4, icon = ?5, updated_at = MAX(?6, updated_at + 1)
        WHERE id = ?1 AND user_id = ?2
        RETURNING id, title, filter, icon, created_at, updated_at`,
    )
    .bind(id, userId, title, filter, icon, nowSeconds())
    .all<ViewRow>()

  const row = results[0]
  return row ? toView(row) : null
}

export async function deleteView(db: D1Database, userId: string, id: string): Promise<boolean> {
  const { meta } = await db
    .prepare(`DELETE FROM memos_views WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .run()
  return meta.changes > 0
}
