/**
 * The sidebar's furniture: categories and the boards filed under them. These rows belong to the
 * account, not the board, so two people can file the same shared board differently. A board lives in
 * one category at a time — adding it to a new one moves it out of the old — and hiding is a flag on
 * that filing, not on the board itself.
 */
import type { ProjectCategory, ProjectCategoryBoard } from '@shared/project/model'
import { newProjectId } from '@shared/project/limits'
import type { ProjectCategoryCreateInput, ProjectCategoryPatchInput } from '@shared/project/validation'
import { ApiError } from '../lib/errors'

// The reorder endpoint caps its id list at 200; creation shares that ceiling so the two cannot disagree.
const MAX_CATEGORIES = 200

interface CategoryRow {
  user_id: string
  id: string
  name: string
  type: string
  collapsed: number
  sort_order: number
  create_at: number
  update_at: number
  delete_at: number
}

interface CategoryBoardRow {
  user_id: string
  category_id: string
  board_id: string
  hidden: number
  position: number
  updated_at: number
}

function rowToCategory(row: CategoryRow): ProjectCategory {
  return {
    id: row.id, userId: row.user_id, name: row.name, type: row.type as ProjectCategory['type'],
    collapsed: row.collapsed === 1, sortOrder: row.sort_order,
    createAt: row.create_at, updateAt: row.update_at, deleteAt: row.delete_at,
  }
}

function rowToCategoryBoard(row: CategoryBoardRow): ProjectCategoryBoard {
  return { categoryId: row.category_id, boardId: row.board_id, hidden: row.hidden === 1, position: row.position }
}

export async function listProjectCategories(db: D1Database, userId: string): Promise<ProjectCategory[]> {
  const { results } = await db
    .prepare('SELECT * FROM project_categories WHERE user_id = ?1 AND delete_at = 0 ORDER BY sort_order, create_at, id')
    .bind(userId)
    .all<CategoryRow>()
  return results.map(rowToCategory)
}

export async function listProjectCategoryBoards(db: D1Database, userId: string): Promise<ProjectCategoryBoard[]> {
  const { results } = await db
    .prepare('SELECT * FROM project_category_boards WHERE user_id = ?1 ORDER BY category_id, position, board_id')
    .bind(userId)
    .all<CategoryBoardRow>()
  return results.map(rowToCategoryBoard)
}

async function getCategoryRow(db: D1Database, userId: string, categoryId: string): Promise<CategoryRow> {
  const row = await db
    .prepare('SELECT * FROM project_categories WHERE user_id = ?1 AND id = ?2 AND delete_at = 0')
    .bind(userId, categoryId)
    .first<CategoryRow>()
  if (!row) throw ApiError.notFound('Category not found')
  return row
}

export async function createProjectCategory(
  db: D1Database,
  userId: string,
  input: ProjectCategoryCreateInput,
  now: number,
): Promise<ProjectCategory> {
  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM project_categories WHERE user_id = ?1 AND delete_at = 0')
    .bind(userId)
    .first<{ n: number }>()
  if ((count?.n ?? 0) >= MAX_CATEGORIES) throw ApiError.conflict('PROJECT_MAX_CATEGORIES')
  const max = await db
    .prepare('SELECT MAX(sort_order) AS max FROM project_categories WHERE user_id = ?1 AND delete_at = 0')
    .bind(userId)
    .first<{ max: number | null }>()
  const id = input.id ?? newProjectId('category')
  const sortOrder = (max?.max ?? -1) + 1
  await db.prepare(
    `INSERT INTO project_categories (user_id, id, name, type, collapsed, sort_order, create_at, update_at, delete_at)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?6, 0)`,
  ).bind(userId, id, input.name, input.type, sortOrder, now).run()
  return {
    id, userId, name: input.name, type: input.type, collapsed: false, sortOrder,
    createAt: now, updateAt: now, deleteAt: 0,
  }
}

export async function patchProjectCategory(
  db: D1Database,
  userId: string,
  categoryId: string,
  patch: ProjectCategoryPatchInput,
  now: number,
): Promise<ProjectCategory> {
  const row = await getCategoryRow(db, userId, categoryId)
  if (row.type === 'system' && patch.name !== undefined) throw ApiError.conflict('system_category_immutable')
  const sets: string[] = ['update_at = ?']
  const values: (string | number)[] = [now]
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name) }
  if (patch.collapsed !== undefined) { sets.push('collapsed = ?'); values.push(patch.collapsed ? 1 : 0) }
  if (patch.sortOrder !== undefined) { sets.push('sort_order = ?'); values.push(patch.sortOrder) }
  values.push(userId, categoryId)
  await db.prepare(`UPDATE project_categories SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`).bind(...values).run()
  return rowToCategory((await getCategoryRow(db, userId, categoryId)))
}

export async function deleteProjectCategory(db: D1Database, userId: string, categoryId: string, now: number): Promise<void> {
  const row = await getCategoryRow(db, userId, categoryId)
  if (row.type === 'system') throw ApiError.conflict('system_category_immutable')
  await db.batch([
    db.prepare('UPDATE project_categories SET delete_at = ?1, update_at = ?1 WHERE user_id = ?2 AND id = ?3').bind(now, userId, categoryId),
    db.prepare('DELETE FROM project_category_boards WHERE user_id = ?1 AND category_id = ?2').bind(userId, categoryId),
  ])
}

export async function reorderProjectCategories(db: D1Database, userId: string, categoryIds: readonly string[], now: number): Promise<void> {
  const statements = categoryIds.map((id, index) => db
    .prepare('UPDATE project_categories SET sort_order = ?1, update_at = ?2 WHERE user_id = ?3 AND id = ?4 AND delete_at = 0')
    .bind(index, now, userId, id))
  if (statements.length) await db.batch(statements)
}

/**
 * File a board under a category, moving it out of any other category first: the sidebar shows a board
 * once, so a second filing would duplicate it. The position lands after the category's last board.
 */
export async function addBoardToCategory(
  db: D1Database,
  userId: string,
  categoryId: string,
  boardId: string,
  now: number,
): Promise<ProjectCategoryBoard> {
  await getCategoryRow(db, userId, categoryId)
  const max = await db
    .prepare('SELECT MAX(position) AS max FROM project_category_boards WHERE user_id = ?1 AND category_id = ?2')
    .bind(userId, categoryId)
    .first<{ max: number | null }>()
  const position = (max?.max ?? -1) + 1
  await db.batch([
    db.prepare('DELETE FROM project_category_boards WHERE user_id = ?1 AND board_id = ?2').bind(userId, boardId),
    db.prepare(
      `INSERT INTO project_category_boards (user_id, category_id, board_id, hidden, position, updated_at)
       VALUES (?1, ?2, ?3, 0, ?4, ?5)
       ON CONFLICT(user_id, category_id, board_id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
    ).bind(userId, categoryId, boardId, position, now),
  ])
  return { categoryId, boardId, hidden: false, position }
}

export async function reorderCategoryBoards(
  db: D1Database,
  userId: string,
  categoryId: string,
  boardIds: readonly string[],
  now: number,
): Promise<void> {
  await getCategoryRow(db, userId, categoryId)
  const statements = boardIds.map((boardId, index) => db
    .prepare('UPDATE project_category_boards SET position = ?1, updated_at = ?2 WHERE user_id = ?3 AND category_id = ?4 AND board_id = ?5')
    .bind(index, now, userId, categoryId, boardId))
  if (statements.length) await db.batch(statements)
}

export async function setCategoryBoardHidden(
  db: D1Database,
  userId: string,
  categoryId: string,
  boardId: string,
  hidden: boolean,
  now: number,
): Promise<ProjectCategoryBoard> {
  await getCategoryRow(db, userId, categoryId)
  const max = await db
    .prepare('SELECT MAX(position) AS max FROM project_category_boards WHERE user_id = ?1 AND category_id = ?2')
    .bind(userId, categoryId)
    .first<{ max: number | null }>()
  const position = (max?.max ?? -1) + 1
  await db.prepare(
    `INSERT INTO project_category_boards (user_id, category_id, board_id, hidden, position, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id, category_id, board_id) DO UPDATE SET hidden = excluded.hidden, updated_at = excluded.updated_at`,
  ).bind(userId, categoryId, boardId, hidden ? 1 : 0, position, now).run()
  const row = await db
    .prepare('SELECT * FROM project_category_boards WHERE user_id = ?1 AND category_id = ?2 AND board_id = ?3')
    .bind(userId, categoryId, boardId)
    .first<CategoryBoardRow>()
  return rowToCategoryBoard(row!)
}