import type { ProjectBoard, ProjectBoardSummary, ProjectBoardType, ProjectMinimumRole, ProjectRole } from '@shared/project/model'
import { effectiveProjectRole } from '@shared/project/model'

export interface ProjectBoardRow {
  id: string
  owner_id: string
  type: string
  minimum_role: string
  title: string
  description: string
  icon: string
  show_description: number
  is_template: number
  template_version: number
  created_by: string
  modified_by: string
  create_at: number
  update_at: number
  delete_at: number
  archived: number
}

export interface ProjectMembershipRow {
  board_id: string
  role: string
}

export function rowToBoard(row: ProjectBoardRow): ProjectBoard {
  return {
    id: row.id,
    ownerId: row.owner_id,
    type: row.type as ProjectBoardType,
    minimumRole: row.minimum_role as ProjectMinimumRole,
    title: row.title,
    description: row.description,
    icon: row.icon,
    showDescription: row.show_description !== 0,
    isTemplate: row.is_template !== 0,
    templateVersion: row.template_version,
    createdBy: row.created_by,
    modifiedBy: row.modified_by,
    createAt: row.create_at,
    updateAt: row.update_at,
    deleteAt: row.delete_at,
    archived: row.archived !== 0,
  }
}

/**
 * Which boards the sidebar lists, and what the caller may do with each.
 *
 * A board reaches its audience two ways — the account owns it, or a membership row names it — so the
 * list is the union of the two, and a board the caller can no longer read is dropped rather than
 * shown greyed out. The role is resolved here so no caller has to remember the open-board rule.
 */
export function visibleProjectBoards(
  rows: readonly ProjectBoardRow[],
  memberships: readonly ProjectMembershipRow[],
  userId: string,
): ProjectBoardSummary[] {
  const byBoard = new Map(memberships.map((entry) => [entry.board_id, entry.role as ProjectRole]))
  const summaries: ProjectBoardSummary[] = []
  for (const row of rows) {
    const board = rowToBoard(row)
    const role = effectiveProjectRole({
      ownerId: board.ownerId,
      userId,
      boardType: board.type,
      minimumRole: board.minimumRole,
      memberRole: byBoard.get(board.id) ?? null,
    })
    if (role) summaries.push({ ...board, role })
  }
  return summaries
}