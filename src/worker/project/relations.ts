import type {
  ProjectBoardBundle,
  ProjectCard,
  ProjectCardRelation,
  ProjectMinimumRole,
  ProjectProperty,
  ProjectRole,
} from '@shared/project/model'
import { effectiveProjectRole, projectMultiValueIds } from '@shared/project/model'
import { isProjectId, PROJECT_LIMITS } from '@shared/project/limits'
import type { ProjectRelationBackReference, ProjectRelationOption } from '@shared/project/relation'
import { parseProjectRelationIds } from '@shared/project/relation'
import { ApiError } from '../lib/errors'

interface BoardVisibilityRow {
  owner_id: string
  type: string
  minimum_role: string
  delete_at: number
}

export function projectRelationTargets(properties: readonly ProjectProperty[]): Map<string, string> {
  const targets = new Map<string, string>()
  for (const property of properties) {
    if (property.type === 'relation' && property.config?.targetBoardId) {
      targets.set(property.id, property.config.targetBoardId)
    }
  }
  return targets
}

export async function projectBoardVisibleTo(
  db: D1Database,
  boardId: string,
  viewerId: string | undefined,
): Promise<boolean> {
  if (!viewerId) return false
  const row = await db.prepare('SELECT owner_id, type, minimum_role, delete_at FROM project_boards WHERE id = ?1')
    .bind(boardId).first<BoardVisibilityRow>()
  if (!row || row.delete_at !== 0) return false
  const membership = await db.prepare('SELECT role FROM project_board_members WHERE board_id = ?1 AND user_id = ?2')
    .bind(boardId, viewerId).first<{ role: string }>()
  const minimumRole = (['viewer', 'commenter', 'editor', 'admin'].includes(row.minimum_role)
    ? row.minimum_role
    : '') as ProjectMinimumRole
  const role = effectiveProjectRole({
    ownerId: row.owner_id,
    userId: viewerId,
    boardType: row.type === 'O' ? 'O' : 'P',
    minimumRole,
    memberRole: (membership?.role as ProjectRole | undefined) ?? null,
  })
  return role !== null
}

function insertRelationStatement(
  db: D1Database,
  boardId: string,
  fromCardId: string,
  propertyId: string,
  targetBoardId: string,
  toId: string,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO project_card_relations (board_id, from_card_id, to_card_id, property_id, created_at)
     SELECT ?1, ?2, c.id, ?3, ?4 FROM project_cards c
     WHERE c.id = ?5 AND c.board_id = ?6 AND c.delete_at = 0`,
  ).bind(boardId, fromCardId, propertyId, now, toId, targetBoardId)
}

export function relationEdgeStatements(
  db: D1Database,
  boardId: string,
  fromCardId: string,
  propertyId: string,
  targetBoardId: string,
  rawValue: string,
  now: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM project_card_relations WHERE from_card_id = ?1 AND property_id = ?2')
      .bind(fromCardId, propertyId),
  ]
  for (const toId of parseProjectRelationIds(rawValue)) {
    statements.push(insertRelationStatement(db, boardId, fromCardId, propertyId, targetBoardId, toId, now))
  }
  return statements
}

export async function syncCardRelationsForCard(
  db: D1Database,
  card: ProjectCard,
  properties: readonly ProjectProperty[],
  now: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = []
  for (const [propertyId, targetBoardId] of projectRelationTargets(properties)) {
    statements.push(...relationEdgeStatements(
      db, card.boardId, card.id, propertyId, targetBoardId, card.values[propertyId] ?? '', now,
    ))
  }
  if (statements.length) await db.batch(statements)
}

export async function rebuildBoardRelations(
  db: D1Database,
  boardId: string,
  properties: readonly ProjectProperty[],
  now: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM project_card_relations WHERE board_id = ?1').bind(boardId),
  ]
  for (const [propertyId, targetBoardId] of projectRelationTargets(properties)) {
    const { results } = await db.prepare(
      `SELECT v.card_id, v.value FROM project_card_values v
       JOIN project_cards c ON c.id = v.card_id AND c.board_id = ?1 AND c.delete_at = 0
       WHERE v.property_id = ?2`,
    ).bind(boardId, propertyId).all<{ card_id: string, value: string }>()
    for (const row of results) {
      statements.push(...relationEdgeStatements(db, boardId, row.card_id, propertyId, targetBoardId, row.value, now))
    }
  }
  for (let at = 0; at < statements.length; at += 500) {
    await db.batch(statements.slice(at, at + 500))
  }
}

export async function listRelationOptions(
  db: D1Database,
  targetBoardId: string,
  viewerId: string | undefined,
  limit = 200,
): Promise<ProjectRelationOption[] | null> {
  if (!await projectBoardVisibleTo(db, targetBoardId, viewerId)) return null
  const capped = Math.min(Math.max(limit, 1), PROJECT_LIMITS.cardsPerBoard)
  const { results } = await db.prepare(
    'SELECT id, title FROM project_cards WHERE board_id = ?1 AND delete_at = 0 ORDER BY create_at, id LIMIT ?2',
  ).bind(targetBoardId, capped).all<{ id: string, title: string }>()
  return results.map((row) => ({ id: row.id, title: row.title }))
}

export async function listBackReferences(
  db: D1Database,
  toCardId: string,
  viewerId: string | undefined,
): Promise<ProjectRelationBackReference[]> {
  const { results } = await db.prepare(
    'SELECT board_id, from_card_id, property_id FROM project_card_relations WHERE to_card_id = ?1 ORDER BY board_id, from_card_id, property_id',
  ).bind(toCardId).all<{ board_id: string, from_card_id: string, property_id: string }>()
  const references: ProjectRelationBackReference[] = []
  for (const row of results) {
    const visible = await projectBoardVisibleTo(db, row.board_id, viewerId)
    const card = visible
      ? await db.prepare('SELECT title FROM project_cards WHERE id = ?1 AND delete_at = 0')
        .bind(row.from_card_id).first<{ title: string }>()
      : null
    references.push({
      boardId: row.board_id,
      fromCardId: row.from_card_id,
      propertyId: row.property_id,
      title: card?.title ?? null,
      visible,
    })
  }
  return references
}

export async function assertProjectRelationValues(
  db: D1Database,
  properties: readonly ProjectProperty[],
  values: Record<string, unknown> | undefined,
  viewerId: string,
): Promise<void> {
  if (!values) return
  const byId = new Map(properties.map((property) => [property.id, property]))
  for (const [propertyId, raw] of Object.entries(values)) {
    const property = byId.get(propertyId)
    if (!property || property.type !== 'relation' || raw === null) continue
    const targetBoardId = property.config?.targetBoardId
    if (!targetBoardId) throw ApiError.badRequest('relation property has no target board')
    if (!await projectBoardVisibleTo(db, targetBoardId, viewerId)) {
      throw ApiError.badRequest('relation target board is not visible')
    }
    const ids = projectMultiValueIds(String(raw))
    if (property.config?.multiple !== true && ids.length > 1) {
      throw ApiError.badRequest('relation property is single-valued')
    }
    for (const id of ids) {
      if (!isProjectId(id)) throw ApiError.badRequest('invalid relation target id')
      const target = await db.prepare(
        'SELECT 1 FROM project_cards WHERE id = ?1 AND board_id = ?2 AND delete_at = 0',
      ).bind(id, targetBoardId).first()
      if (!target) throw ApiError.badRequest('relation target card does not exist')
    }
  }
}

export async function redactHiddenRelations(
  db: D1Database,
  bundle: ProjectBoardBundle,
  viewerId: string | undefined,
): Promise<void> {
  const relationProperties = bundle.properties.filter(
    (property) => property.type === 'relation' && property.config?.targetBoardId,
  )
  if (!relationProperties.length) return
  const hidden = new Set<string>()
  for (const property of relationProperties) {
    const target = property.config!.targetBoardId!
    if (target === bundle.board.id) continue
    if (!await projectBoardVisibleTo(db, target, viewerId)) hidden.add(property.id)
  }
  if (!hidden.size) return
  for (const card of bundle.cards) {
    for (const propertyId of hidden) card.values[propertyId] = ''
  }
}

export async function deleteCardRelationsForCard(db: D1Database, cardId: string): Promise<void> {
  await db.prepare('DELETE FROM project_card_relations WHERE from_card_id = ?1 OR to_card_id = ?1').bind(cardId).run()
}

export async function deleteCardRelationsForProperty(db: D1Database, propertyId: string): Promise<void> {
  await db.prepare('DELETE FROM project_card_relations WHERE property_id = ?1').bind(propertyId).run()
}

export async function listBoardRelations(db: D1Database, boardId: string): Promise<ProjectCardRelation[]> {
  const { results } = await db.prepare(
    'SELECT board_id, from_card_id, to_card_id, property_id, created_at FROM project_card_relations WHERE board_id = ?1 ORDER BY from_card_id, to_card_id',
  ).bind(boardId).all<{ board_id: string, from_card_id: string, to_card_id: string, property_id: string, created_at: number }>()
  return results.map((row) => ({
    boardId: row.board_id,
    fromCardId: row.from_card_id,
    toCardId: row.to_card_id,
    propertyId: row.property_id,
    createdAt: row.created_at,
  }))
}
