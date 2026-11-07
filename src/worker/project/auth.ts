import type { Context } from 'hono'
import type { ZodType } from 'zod'
import type { ProjectBoard, ProjectCard, ProjectRole } from '@shared/project/model'
import { effectiveProjectRole, projectRoleAtLeast } from '@shared/project/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { rowToCard } from './bundle'
import { getProjectCardRow, readCardValues } from './cards'
import { rowToBoard, type ProjectBoardRow } from './permissions'

export function projectUserId(c: Context<AppBindings>): string {
  const id = c.get('userId') ?? c.get('user')?.id
  if (!id) throw ApiError.unauthenticated()
  return id
}

/** Every project write parses through this, so a rejected field reads the same on every route. */
export async function projectBody<T>(
  c: Context<AppBindings>,
  schema: ZodType<T>,
  maxBytes: number = JSON_BODY_LIMITS.project,
): Promise<T> {
  const raw = await readJson<unknown>(c, maxBytes)
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.map(String).join('.') ?? ''
    throw ApiError.badRequest(issue ? `${path}: ${issue.message}` : 'Validation failed')
  }
  return result.data
}

export interface ProjectBoardAccess {
  board: ProjectBoard
  role: ProjectRole
  userId: string
}

/**
 * The trust boundary every board-scoped route crosses. A board the caller cannot see at all answers
 * 404 rather than 403, so a private board's existence never leaks; one they can see but lack the role
 * for answers 403. The effective role folds the owner rule and the open-board minimum in one place.
 */
export async function requireBoard(
  c: Context<AppBindings>,
  boardId: string,
  required: ProjectRole,
  options: { allowDeleted?: boolean } = {},
): Promise<ProjectBoardAccess> {
  const userId = projectUserId(c)
  const row = await c.env.DB
    .prepare('SELECT * FROM project_boards WHERE id = ?1')
    .bind(boardId)
    .first<ProjectBoardRow>()
  if (!row || (!options.allowDeleted && row.delete_at !== 0)) throw ApiError.notFound('Board not found')
  const membership = await c.env.DB
    .prepare('SELECT role FROM project_board_members WHERE board_id = ?1 AND user_id = ?2')
    .bind(boardId, userId)
    .first<{ role: string }>()
  const board = rowToBoard(row)
  const role = effectiveProjectRole({
    ownerId: board.ownerId,
    userId,
    boardType: board.type,
    minimumRole: board.minimumRole,
    memberRole: (membership?.role as ProjectRole | undefined) ?? null,
  })
  if (!role) throw ApiError.notFound('Board not found')
  if (!projectRoleAtLeast(role, required)) throw ApiError.forbidden()
  return { board, role, userId }
}

export interface ProjectCardAccess extends ProjectBoardAccess {
  card: ProjectCard
}

/**
 * A card-scoped route resolves the board from the card row, then crosses the same board boundary. A
 * card on a board the caller cannot see answers 404, never 403, so the card's existence stays private
 * too. The board itself must be alive even when undeleting a card: a card cannot outlive its board.
 */
export async function requireCard(
  c: Context<AppBindings>,
  cardId: string,
  required: ProjectRole,
  options: { allowDeleted?: boolean } = {},
): Promise<ProjectCardAccess> {
  const row = await getProjectCardRow(c.env.DB, cardId)
  if (!row || (!options.allowDeleted && row.delete_at !== 0)) throw ApiError.notFound('Card not found')
  const access = await requireBoard(c, row.board_id, required)
  const card = rowToCard(row, await readCardValues(c.env.DB, cardId))
  return { ...access, card }
}