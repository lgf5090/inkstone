import type {
  ProjectBoard,
  ProjectBoardMetadata,
  ProjectBoardSummary,
  ProjectProperty,
  ProjectPropertyType,
} from '@shared/project/model'
import { newProjectId } from '@shared/project/limits'
import { applyProjectPropertyPatch } from '@shared/project/property-patch'
import { parseProjectPropertyConfig, serializeProjectPropertyConfig } from '@shared/project/property-config'
import type { ProjectBoardCreateInput, ProjectBoardPatchInput } from '@shared/project/validation'
import { rowToBoard, type ProjectBoardRow } from './permissions'

interface PropertyRow {
  board_id: string
  id: string
  name: string
  type: string
  options: string
  position: number
  created_at: number
  updated_at: number
}

function rowToProperty(row: PropertyRow): ProjectProperty {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ProjectPropertyType,
    options: JSON.parse(row.options) as ProjectProperty['options'],
  }
}

export async function readBoardProperties(db: D1Database, boardId: string): Promise<ProjectProperty[]> {
  const [{ results }, configs] = await Promise.all([
    db.prepare('SELECT * FROM project_properties WHERE board_id = ?1 ORDER BY position, id')
      .bind(boardId)
      .all<PropertyRow>(),
    db.prepare('SELECT property_id, config FROM project_property_configs WHERE board_id = ?1')
      .bind(boardId)
      .all<{ property_id: string, config: string }>(),
  ])
  const byProperty = new Map(configs.results.map((row) => [row.property_id, row.config]))
  return results.map((row) => {
    const property = rowToProperty(row)
    const config = parseProjectPropertyConfig(byProperty.get(row.id))
    return config ? { ...property, config } : property
  })
}

function propertyStatements(
  db: D1Database,
  boardId: string,
  properties: readonly ProjectProperty[],
  now: number,
): D1PreparedStatement[] {
  return properties.flatMap((property, index) => [
    db.prepare(
      `INSERT INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT(board_id, id) DO UPDATE SET
         name = excluded.name, type = excluded.type, options = excluded.options,
         position = excluded.position, updated_at = excluded.updated_at`,
    )
      .bind(boardId, property.id, property.name, property.type, JSON.stringify(property.options), index, now),
    db.prepare(
      `INSERT INTO project_property_configs (board_id, property_id, config, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(board_id, property_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    ).bind(boardId, property.id, serializeProjectPropertyConfig(property.config), now),
  ])
}

/**
 * A new board belongs to its creator, who gets an admin membership row so the member picker and the
 * last-admin count both see them. Properties are written in the order given, position = index.
 */
export async function createProjectBoard(
  db: D1Database,
  userId: string,
  input: ProjectBoardCreateInput,
  now: number,
): Promise<ProjectBoardSummary> {
  const id = input.id ?? newProjectId('board')
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO project_boards
         (id, owner_id, type, minimum_role, title, description, icon, show_description, is_template,
          template_version, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?2, ?2, ?10, ?10, 0)`,
    ).bind(
      id, userId, input.type, input.minimumRole, input.title, input.description, input.icon,
      input.showDescription ? 1 : 0, input.isTemplate ? 1 : 0, now,
    ),
    db.prepare(
      'INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
    ).bind(id, userId, 'admin', now),
    ...propertyStatements(db, id, input.cardProperties, now),
  ]
  await db.batch(statements)
  const board: ProjectBoard = {
    id,
    ownerId: userId,
    type: input.type,
    minimumRole: input.minimumRole,
    title: input.title,
    description: input.description,
    icon: input.icon,
    showDescription: input.showDescription,
    isTemplate: input.isTemplate,
    templateVersion: 0,
    createdBy: userId,
    modifiedBy: userId,
    createAt: now,
    updateAt: now,
    deleteAt: 0,
    archived: false,
  }
  return { ...board, role: 'admin' }
}

export async function getProjectBoardRow(db: D1Database, boardId: string): Promise<ProjectBoard | null> {
  const row = await db.prepare('SELECT * FROM project_boards WHERE id = ?1').bind(boardId).first<ProjectBoardRow>()
  return row ? rowToBoard(row) : null
}

/**
 * A board patch. The two property lists run through the shared ordering rule (§6.2); the board's own
 * fields are a sparse update. Everything lands in one D1 batch so a half-applied patch cannot survive.
 */
export async function patchProjectBoard(
  db: D1Database,
  board: ProjectBoard,
  patch: ProjectBoardPatchInput,
  userId: string,
  now: number,
): Promise<{ board: ProjectBoard; properties: ProjectProperty[] }> {
  const sets: string[] = ['modified_by = ?', 'update_at = ?']
  const values: (string | number)[] = [userId, now]
  if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title) }
  if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description) }
  if (patch.icon !== undefined) { sets.push('icon = ?'); values.push(patch.icon) }
  if (patch.showDescription !== undefined) { sets.push('show_description = ?'); values.push(patch.showDescription ? 1 : 0) }
  if (patch.archived !== undefined) { sets.push('archived = ?'); values.push(patch.archived ? 1 : 0) }
  if (patch.type !== undefined) { sets.push('type = ?'); values.push(patch.type) }
  if (patch.minimumRole !== undefined) { sets.push('minimum_role = ?'); values.push(patch.minimumRole) }
  values.push(board.id)
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE project_boards SET ${sets.join(', ')} WHERE id = ?`).bind(...values),
  ]

  const current = await readBoardProperties(db, board.id)
  let properties = current
  const changesProperties = (patch.updatedCardProperties?.length ?? 0) > 0 || (patch.deletedCardProperties?.length ?? 0) > 0
  if (changesProperties) {
    properties = applyProjectPropertyPatch(current, patch.updatedCardProperties ?? [], patch.deletedCardProperties ?? [])
    const kept = new Set(properties.map((property) => property.id))
    for (const property of current) {
      if (kept.has(property.id)) continue
      statements.push(db.prepare('DELETE FROM project_properties WHERE board_id = ?1 AND id = ?2').bind(board.id, property.id))
      statements.push(db.prepare('DELETE FROM project_property_configs WHERE board_id = ?1 AND property_id = ?2').bind(board.id, property.id))
      statements.push(db.prepare(
        'DELETE FROM project_card_values WHERE property_id = ?1 AND card_id IN (SELECT id FROM project_cards WHERE board_id = ?2)',
      ).bind(property.id, board.id))
    }
    statements.push(...propertyStatements(db, board.id, properties, now))
  }
  await db.batch(statements)
  const updated = await getProjectBoardRow(db, board.id)
  return { board: updated!, properties }
}

export async function softDeleteProjectBoard(db: D1Database, boardId: string, userId: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE project_boards SET delete_at = ?1, modified_by = ?2, update_at = ?1 WHERE id = ?3 AND delete_at = 0')
    .bind(now, userId, boardId)
    .run()
}

export async function undeleteProjectBoard(db: D1Database, boardId: string, userId: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE project_boards SET delete_at = 0, modified_by = ?1, update_at = ?2 WHERE id = ?3')
    .bind(userId, now, boardId)
    .run()
}

export async function projectBoardMetadata(db: D1Database, boardId: string): Promise<ProjectBoardMetadata> {
  const [cards, properties, views] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM project_cards WHERE board_id = ?1 AND delete_at = 0').bind(boardId).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM project_properties WHERE board_id = ?1').bind(boardId).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM project_views WHERE board_id = ?1 AND delete_at = 0').bind(boardId).first<{ n: number }>(),
  ])
  return { cardCount: cards?.n ?? 0, propertyCount: properties?.n ?? 0, viewCount: views?.n ?? 0 }
}