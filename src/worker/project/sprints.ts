/**
 * Iterations are board-owned, but a card's membership is an edge: moving a card between sprints is
 * one upsert, and deleting a sprint leaves its cards on the board rather than deleting work.
 */
import { newProjectId } from '@shared/project/limits'
import type { ProjectBoard, ProjectCard, ProjectRole } from '@shared/project/model'
import type { ProjectSprint, ProjectSprintBurndown, ProjectSprintStatus } from '@shared/project/stats'
import { projectSprintBurndown } from '@shared/project/stats'
import type { ProjectSprintCreateInput, ProjectSprintPatchInput } from '@shared/project/validation'
import { ApiError } from '../lib/errors'
import { readProjectBoardBundle } from './bundle'

interface SprintRow {
  id: string
  board_id: string
  name: string
  goal: string
  start_at: number
  end_at: number
  status: string
  created_by: string
  created_at: number
  updated_at: number
}

const SPRINT_COLUMNS = 'id, board_id, name, goal, start_at, end_at, status, created_by, created_at, updated_at'

function rowToSprint(row: SprintRow): ProjectSprint {
  return {
    id: row.id,
    boardId: row.board_id,
    name: row.name,
    goal: row.goal,
    startAt: row.start_at,
    endAt: row.end_at,
    status: (['planned', 'active', 'completed'] as const).includes(row.status as ProjectSprintStatus)
      ? row.status as ProjectSprintStatus : 'planned',
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listProjectSprints(db: D1Database, boardId: string): Promise<ProjectSprint[]> {
  const { results } = await db.prepare(
    `SELECT ${SPRINT_COLUMNS} FROM project_sprints WHERE board_id = ?1 AND delete_at = 0 ORDER BY start_at DESC, id`,
  ).bind(boardId).all<SprintRow>()
  return results.map(rowToSprint)
}

export async function getProjectSprint(db: D1Database, boardId: string, id: string): Promise<ProjectSprint | null> {
  const row = await db.prepare(`SELECT ${SPRINT_COLUMNS} FROM project_sprints WHERE board_id = ?1 AND id = ?2 AND delete_at = 0`)
    .bind(boardId, id).first<SprintRow>()
  return row ? rowToSprint(row) : null
}

export async function createProjectSprint(
  db: D1Database, boardId: string, userId: string, input: ProjectSprintCreateInput, now: number,
): Promise<ProjectSprint> {
  const { results } = await db.prepare('SELECT COUNT(*) AS count FROM project_sprints WHERE board_id = ?1 AND delete_at = 0')
    .bind(boardId).all<{ count: number }>()
  if ((results[0]?.count ?? 0) >= 100) throw ApiError.badRequest('Sprint limit reached')
  const id = newProjectId('sprint')
  await db.prepare(
    `INSERT INTO project_sprints (id, board_id, name, goal, start_at, end_at, status, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  ).bind(
    id, boardId, input.name, input.goal ?? '', input.startAt, input.endAt,
    input.status ?? 'planned', userId, now,
  ).run()
  return (await getProjectSprint(db, boardId, id))!
}

export async function patchProjectSprint(
  db: D1Database, boardId: string, id: string, patch: ProjectSprintPatchInput, now: number,
): Promise<ProjectSprint | null> {
  const current = await getProjectSprint(db, boardId, id)
  if (!current) return null
  const next = {
    name: patch.name ?? current.name,
    goal: patch.goal ?? current.goal,
    startAt: patch.startAt ?? current.startAt,
    endAt: patch.endAt ?? current.endAt,
    status: patch.status ?? current.status,
  }
  if (next.endAt < next.startAt) throw ApiError.badRequest('endAt must not precede startAt')
  await db.prepare(
    `UPDATE project_sprints SET name = ?1, goal = ?2, start_at = ?3, end_at = ?4, status = ?5, updated_at = ?6
     WHERE board_id = ?7 AND id = ?8`,
  ).bind(next.name, next.goal, next.startAt, next.endAt, next.status, now, boardId, id).run()
  return (await getProjectSprint(db, boardId, id))!
}

export async function deleteProjectSprint(db: D1Database, boardId: string, id: string, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM project_sprint_cards WHERE board_id = ?1 AND sprint_id = ?2').bind(boardId, id),
    db.prepare('UPDATE project_sprints SET delete_at = ?1, updated_at = ?1 WHERE board_id = ?2 AND id = ?3')
      .bind(now, boardId, id),
  ])
}

export async function setCardSprint(
  db: D1Database, boardId: string, cardId: string, sprintId: string | null, now: number,
): Promise<void> {
  if (sprintId === null) {
    await db.prepare('DELETE FROM project_sprint_cards WHERE board_id = ?1 AND card_id = ?2').bind(boardId, cardId).run()
    return
  }
  await db.prepare(
    `INSERT INTO project_sprint_cards (card_id, sprint_id, board_id, added_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(card_id) DO UPDATE SET sprint_id = excluded.sprint_id, board_id = excluded.board_id, added_at = excluded.added_at`,
  ).bind(cardId, sprintId, boardId, now).run()
}

export interface ProjectSprintDetail {
  sprint: ProjectSprint
  cards: ProjectCard[]
  burndown: ProjectSprintBurndown
}

/** Scope and both burndown lines come from the same bundle the other views were handed. */
export async function readSprintDetail(
  db: D1Database, board: ProjectBoard, role: ProjectRole, sprintId: string, now: number,
): Promise<ProjectSprintDetail | null> {
  const sprint = await getProjectSprint(db, board.id, sprintId)
  if (!sprint) return null
  const { results } = await db.prepare(
    'SELECT card_id FROM project_sprint_cards WHERE board_id = ?1 AND sprint_id = ?2',
  ).bind(board.id, sprintId).all<{ card_id: string }>()
  const ids = new Set(results.map((row) => row.card_id))
  const bundle = await readProjectBoardBundle(db, board, role)
  const cards = bundle.cards.filter((card) => ids.has(card.id))
  return { sprint, cards, burndown: projectSprintBurndown(cards, bundle.properties, sprint, now) }
}
