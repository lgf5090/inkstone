import type { ProjectCard, ProjectProperty, ProjectRole } from '@shared/project/model'
import { effectiveProjectRole } from '@shared/project/model'
import { projectPropertyVisibleTo } from '@shared/project/property-config'
import { rowToBoard, type ProjectBoardRow } from './permissions'

export function projectPropertiesForRole(properties: readonly ProjectProperty[], role: ProjectRole): ProjectProperty[] {
  return properties.filter((property) => projectPropertyVisibleTo(property, role))
}

export function projectCardForRole(card: ProjectCard, properties: readonly ProjectProperty[], role: ProjectRole): ProjectCard {
  const visible = new Set(projectPropertiesForRole(properties, role).map((property) => property.id))
  const values: Record<string, string> = {}
  for (const [propertyId, value] of Object.entries(card.values)) {
    if (visible.has(propertyId)) values[propertyId] = value
  }
  return { ...card, values }
}

export async function projectRoleForBoard(db: D1Database, boardId: string, userId: string): Promise<ProjectRole | null> {
  const [row, membership] = await Promise.all([
    db.prepare('SELECT * FROM project_boards WHERE id = ?1 AND delete_at = 0').bind(boardId).first<ProjectBoardRow>(),
    db.prepare('SELECT role FROM project_board_members WHERE board_id = ?1 AND user_id = ?2').bind(boardId, userId).first<{ role: string }>(),
  ])
  if (!row) return null
  const board = rowToBoard(row)
  return effectiveProjectRole({
    ownerId: board.ownerId,
    userId,
    boardType: board.type,
    minimumRole: board.minimumRole,
    memberRole: (membership?.role as ProjectRole | undefined) ?? null,
  })
}
