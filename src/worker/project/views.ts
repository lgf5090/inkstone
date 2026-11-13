/**
 * Views: the saved ways of looking at one board's cards. A view's fields arrive partial and are
 * merged over the empty defaults on create and over the stored fields on patch, so a client that
 * only changes the sort never has to resend the column widths. Order is a real column the client
 * drags, and a new view without an explicit position lands after the last one.
 */
import type { ProjectView, ProjectViewFields } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { newProjectId, PROJECT_LIMITS } from '@shared/project/limits'
import type { ProjectViewCreateInput, ProjectViewPatchInput } from '@shared/project/validation'
import { ApiError } from '../lib/errors'
import { rowToView, type ViewRow } from './bundle'

export async function getProjectViewRow(db: D1Database, viewId: string): Promise<ViewRow | null> {
  return db.prepare('SELECT * FROM project_views WHERE id = ?1').bind(viewId).first<ViewRow>()
}

export async function getProjectView(db: D1Database, viewId: string): Promise<ProjectView | null> {
  const row = await getProjectViewRow(db, viewId)
  return row ? rowToView(row) : null
}

async function nextViewPosition(db: D1Database, boardId: string): Promise<number> {
  const row = await db
    .prepare('SELECT MAX(position) AS max FROM project_views WHERE board_id = ?1 AND delete_at = 0')
    .bind(boardId)
    .first<{ max: number | null }>()
  return (row?.max ?? -1) + 1
}

export async function createProjectView(
  db: D1Database,
  boardId: string,
  userId: string,
  input: ProjectViewCreateInput,
  now: number,
): Promise<ProjectView> {
  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM project_views WHERE board_id = ?1 AND delete_at = 0')
    .bind(boardId)
    .first<{ n: number }>()
  if ((count?.n ?? 0) >= PROJECT_LIMITS.viewsPerBoard) throw ApiError.conflict('PROJECT_MAX_VIEWS_PER_BOARD')
  const id = input.id ?? newProjectId('view')
  const position = input.position ?? await nextViewPosition(db, boardId)
  const fields = { ...emptyProjectViewFields(), ...input.fields }
  await db.prepare(
    `INSERT INTO project_views
       (id, board_id, title, view_type, fields, position, created_by, modified_by, create_at, update_at, delete_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?8, 0)`,
  ).bind(id, boardId, input.title, input.viewType, JSON.stringify(fields), position, userId, now).run()
  return {
    id, boardId, title: input.title, viewType: input.viewType, fields, position,
    createdBy: userId, modifiedBy: userId, createAt: now, updateAt: now, deleteAt: 0,
  }
}

export function mergeProjectViewFields(base: ProjectViewFields, patch: Partial<ProjectViewFields>): ProjectViewFields {
  const merged = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const target = merged as Record<string, unknown>
    if (value === undefined) delete target[key]
    else target[key] = value
  }
  return merged
}

export function viewPatchStatements(
  db: D1Database,
  view: ProjectView,
  patch: ProjectViewPatchInput,
  userId: string,
  now: number,
): D1PreparedStatement[] {
  const sets: string[] = ['modified_by = ?', 'update_at = ?']
  const values: (string | number)[] = [userId, now]
  if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title) }
  if (patch.viewType !== undefined) { sets.push('view_type = ?'); values.push(patch.viewType) }
  if (patch.position !== undefined) { sets.push('position = ?'); values.push(patch.position) }
  if (patch.fields !== undefined) {
    sets.push('fields = ?')
    values.push(JSON.stringify(mergeProjectViewFields(view.fields, patch.fields)))
  }
  values.push(view.id)
  return [db.prepare(`UPDATE project_views SET ${sets.join(', ')} WHERE id = ?`).bind(...values)]
}

export async function patchProjectView(
  db: D1Database,
  view: ProjectView,
  patch: ProjectViewPatchInput,
  userId: string,
  now: number,
): Promise<ProjectView> {
  await db.batch(viewPatchStatements(db, view, patch, userId, now))
  return (await getProjectView(db, view.id))!
}

export async function softDeleteProjectView(db: D1Database, viewId: string, userId: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE project_views SET delete_at = ?1, modified_by = ?2, update_at = ?1 WHERE id = ?3 AND delete_at = 0')
    .bind(now, userId, viewId)
    .run()
}

export async function undeleteProjectView(db: D1Database, viewId: string, userId: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE project_views SET delete_at = 0, modified_by = ?1, update_at = ?2 WHERE id = ?3')
    .bind(userId, now, viewId)
    .run()
}

/** A copy keeps the fields and type but gets a fresh id and the next position; the title is suffixed. */
export async function duplicateProjectView(
  db: D1Database,
  view: ProjectView,
  userId: string,
  now: number,
): Promise<ProjectView> {
  return createProjectView(db, view.boardId, userId, {
    title: `${view.title} copy`,
    viewType: view.viewType,
    fields: view.fields,
  }, now)
}