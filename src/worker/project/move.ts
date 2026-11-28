/**
 * Moving a card (and its subtasks) to another board.
 *
 * A card's values key on the source board's property and option ids, which mean nothing on the target.
 * Each used property is matched to the target by name and type; a match reuses the target's property
 * and maps options by their label, while a property the target lacks is created there carrying its
 * options over. Contents and comments travel with the card; the moved root detaches from any parent
 * left behind, and subtasks keep their place under it.
 */
import type { ProjectCard, ProjectProperty, ProjectPropertyConfig, ProjectPropertyType, ProjectRole } from '@shared/project/model'
import { projectMultiValueIds } from '@shared/project/model'
import { PROJECT_LIMITS, newProjectId } from '@shared/project/limits'
import { projectPropertyVisibleTo, serializeProjectPropertyConfig } from '@shared/project/property-config'
import { ApiError } from '../lib/errors'
import { readBoardProperties } from './boards'
import { getProjectCard } from './cards'
import { relationEdgeStatements } from './relations'
import { touchProjectBoard } from './bundle'
import { assertProjectBatchStatementLimit, projectIdChunks, projectPlaceholders } from './d1'

const OPTION_TYPES = new Set<ProjectPropertyType>(['select', 'multiSelect'])

interface MovePlan {
  propertyIds: Map<string, string>
  optionIds: Map<string, Map<string, string>>
  newProperties: ProjectProperty[]
  newPropertySources: { source: ProjectProperty, target: ProjectProperty }[]
  optionUpdates: { id: string, options: ProjectProperty['options'] }[]
}

function propertyKey(property: ProjectProperty): string {
  return property.type + '::' + property.name
}

function planProperties(used: ProjectProperty[], target: ProjectProperty[]): MovePlan {
  const plan: MovePlan = { propertyIds: new Map(), optionIds: new Map(), newProperties: [], newPropertySources: [], optionUpdates: [] }
  const targetByKey = new Map(target.map((property) => [propertyKey(property), property]))
  for (const source of used) {
    const match = targetByKey.get(propertyKey(source))
    if (!match) {
      const created: ProjectProperty = { id: newProjectId('property'), name: source.name, type: source.type, options: source.options.map((option) => ({ ...option })) }
      plan.newProperties.push(created)
      plan.newPropertySources.push({ source, target: created })
      plan.propertyIds.set(source.id, created.id)
      continue
    }
    plan.propertyIds.set(source.id, match.id)
    if (!OPTION_TYPES.has(source.type)) continue
    const options = [...match.options]
    const byValue = new Map(options.map((option) => [option.value, option]))
    const mapping = new Map<string, string>()
    for (const option of source.options) {
      const existing = byValue.get(option.value)
      if (existing) {
        mapping.set(option.id, existing.id)
      } else {
        const created = { ...option, id: newProjectId('property') }
        options.push(created)
        byValue.set(created.value, created)
        mapping.set(option.id, created.id)
      }
    }
    plan.optionIds.set(source.id, mapping)
    if (options.length !== match.options.length) plan.optionUpdates.push({ id: match.id, options })
  }
  if (target.length + plan.newProperties.length > PROJECT_LIMITS.propertiesPerBoard) {
    throw ApiError.conflict('PROJECT_MAX_BOARD_PROPERTIES')
  }
  return plan
}

function remapConfig(config: ProjectPropertyConfig | undefined, plan: MovePlan, sourceBoardId: string, targetBoardId: string): ProjectPropertyConfig | undefined {
  if (!config) return undefined
  const next: ProjectPropertyConfig = { ...config }
  if (next.expression) {
    next.expression = next.expression.replace(/\{([^}]+)\}/g, (whole, name: string) => {
      const mapped = plan.propertyIds.get(name) ?? plan.propertyIds.get(name.toLowerCase())
      return mapped ? `{${mapped}}` : whole
    })
  }
  if (next.targetBoardId === sourceBoardId) next.targetBoardId = targetBoardId
  if (next.rollup) {
    next.rollup = {
      ...next.rollup,
      relationPropertyId: plan.propertyIds.get(next.rollup.relationPropertyId) ?? next.rollup.relationPropertyId,
      targetPropertyId: plan.propertyIds.get(next.rollup.targetPropertyId) ?? next.rollup.targetPropertyId,
    }
  }
  return next
}

function remapValue(source: ProjectProperty, value: string, plan: MovePlan, sourceBoardId: string, movedIds: ReadonlySet<string>): string {
  if (source.type === 'relation' && source.config?.targetBoardId === sourceBoardId) {
    return JSON.stringify(projectMultiValueIds(value).filter((id) => movedIds.has(id)))
  }
  const mapping = plan.optionIds.get(source.id)
  if (!mapping) return value
  if (source.type === 'select') return mapping.get(value) ?? value
  return JSON.stringify(projectMultiValueIds(value).map((id) => mapping.get(id) ?? id))
}

export async function moveProjectCard(
  db: D1Database,
  card: ProjectCard,
  targetBoardId: string,
  userId: string,
  now: number,
  role: ProjectRole,
): Promise<ProjectCard> {
  if (card.boardId === targetBoardId) throw ApiError.badRequest('The card is already on that board')

  const { results: childRows } = await db
    .prepare('SELECT id, parent_id FROM project_cards WHERE board_id = ?1 AND delete_at = 0')
    .bind(card.boardId)
    .all<{ id: string, parent_id: string }>()
  const childrenOf = new Map<string, string[]>()
  for (const row of childRows) {
    if (!row.parent_id) continue
    const list = childrenOf.get(row.parent_id) ?? []
    list.push(row.id)
    childrenOf.set(row.parent_id, list)
  }
  const movedIds = [card.id]
  const movedSet = new Set<string>([card.id])
  for (let index = 0; index < movedIds.length; index += 1) {
    for (const child of childrenOf.get(movedIds[index]!) ?? []) {
      if (movedSet.has(child)) continue
      movedSet.add(child)
      movedIds.push(child)
    }
  }

  const targetCardCount = await db.prepare('SELECT COUNT(*) AS count FROM project_cards WHERE board_id = ?1 AND delete_at = 0')
    .bind(targetBoardId).first<{ count: number }>()
  if ((targetCardCount?.count ?? 0) + movedIds.length > PROJECT_LIMITS.cardsPerBoard) {
    throw ApiError.conflict('PROJECT_MAX_CARDS_PER_BOARD')
  }
  const targetAttachmentTotals = await db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM project_attachments WHERE board_id = ?1')
    .bind(targetBoardId).first<{ count: number, bytes: number }>()
  let movingAttachmentCount = 0
  let movingAttachmentBytes = 0
  for (const chunk of projectIdChunks(movedIds)) {
    const row = await db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM project_attachments WHERE card_id IN (${projectPlaceholders(chunk.length)})`,
    ).bind(...chunk).first<{ count: number, bytes: number }>()
    movingAttachmentCount += row?.count ?? 0
    movingAttachmentBytes += row?.bytes ?? 0
  }
  if ((targetAttachmentTotals?.count ?? 0) + movingAttachmentCount > PROJECT_LIMITS.attachmentsPerBoard
    || (targetAttachmentTotals?.bytes ?? 0) + movingAttachmentBytes > PROJECT_LIMITS.attachmentBytesPerBoard) {
    throw ApiError.tooLarge('Board attachment quota exceeded')
  }

  const valueRows: { card_id: string, property_id: string, value: string }[] = []
  for (const chunk of projectIdChunks(movedIds)) {
    const { results } = await db.prepare(
      `SELECT card_id, property_id, value FROM project_card_values WHERE card_id IN (${projectPlaceholders(chunk.length)})`,
    ).bind(...chunk).all<{ card_id: string, property_id: string, value: string }>()
    valueRows.push(...results)
  }
  const valuesByCard = new Map<string, Record<string, string>>()
  for (const row of valueRows) {
    const values = valuesByCard.get(row.card_id) ?? {}
    values[row.property_id] = row.value
    valuesByCard.set(row.card_id, values)
  }

  const sourceProperties = await readBoardProperties(db, card.boardId)
  const targetProperties = await readBoardProperties(db, targetBoardId)
  const usedIds = new Set(valueRows.map((row) => row.property_id))
  if (sourceProperties.some((property) => usedIds.has(property.id) && !projectPropertyVisibleTo(property, role))) {
    throw ApiError.forbidden('Cannot move a card with fields this role cannot read')
  }
  const dependencyIds = new Set<string>()
  for (const property of sourceProperties) {
    if (property.type !== 'rollup' || !property.config?.rollup) continue
    dependencyIds.add(property.config.rollup.relationPropertyId)
    dependencyIds.add(property.config.rollup.targetPropertyId)
  }
  const used = sourceProperties.filter((property) => usedIds.has(property.id)
    || (projectPropertyVisibleTo(property, role) && (property.type === 'formula' || property.type === 'rollup' || dependencyIds.has(property.id))))
  const plan = planProperties(used, targetProperties)
  const sourceById = new Map(sourceProperties.map((property) => [property.id, property]))
  const createdProperties = plan.newPropertySources.map(({ source, target }) => ({
    ...target,
    config: remapConfig(source.config, plan, card.boardId, targetBoardId),
  }))
  const effectiveTargetProperties = [...targetProperties, ...createdProperties]
  const targetById = new Map(effectiveTargetProperties.map((property) => [property.id, property]))

  const statements: D1PreparedStatement[] = []
  createdProperties.forEach((property, index) => {
    statements.push(db.prepare(
      `INSERT INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    ).bind(targetBoardId, property.id, property.name, property.type, JSON.stringify(property.options), targetProperties.length + index, now))
    if (property.config) {
      statements.push(db.prepare(
        `INSERT OR REPLACE INTO project_property_configs (board_id, property_id, config, updated_at)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(targetBoardId, property.id, serializeProjectPropertyConfig(property.config), now))
    }
  })
  for (const update of plan.optionUpdates) {
    statements.push(db.prepare('UPDATE project_properties SET options = ?1, updated_at = ?2 WHERE board_id = ?3 AND id = ?4')
      .bind(JSON.stringify(update.options), now, targetBoardId, update.id))
  }

  for (const id of movedIds) {
    statements.push(db.prepare(
      id === card.id
        ? "UPDATE project_cards SET board_id = ?1, parent_id = '', modified_by = ?2, update_at = ?3 WHERE id = ?4"
        : 'UPDATE project_cards SET board_id = ?1, modified_by = ?2, update_at = ?3 WHERE id = ?4',
    ).bind(targetBoardId, userId, now, id))
    statements.push(db.prepare('DELETE FROM project_card_values WHERE card_id = ?1').bind(id))
    statements.push(db.prepare('DELETE FROM project_card_relations WHERE from_card_id = ?1 OR to_card_id = ?1').bind(id))
    statements.push(db.prepare('DELETE FROM project_sprint_cards WHERE card_id = ?1').bind(id))
    for (const [propertyId, value] of Object.entries(valuesByCard.get(id) ?? {})) {
      const source = sourceById.get(propertyId)
      const targetId = plan.propertyIds.get(propertyId)
      if (!source || !targetId) continue
      const targetValue = remapValue(source, value, plan, card.boardId, movedSet)
      statements.push(db.prepare('INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(id, targetId, targetValue, now))
      const targetBoard = targetById.get(targetId)?.config?.targetBoardId
      if (targetBoard) statements.push(...relationEdgeStatements(db, targetBoardId, id, targetId, targetBoard, targetValue, now))
    }
  }

  for (const chunk of projectIdChunks(movedIds)) {
    const marks = projectPlaceholders(chunk.length, 3)
    statements.push(db.prepare(`UPDATE project_card_contents SET board_id = ?1, update_at = ?2 WHERE card_id IN (${marks}) AND delete_at = 0`).bind(targetBoardId, now, ...chunk))
    statements.push(db.prepare(`UPDATE project_comments SET board_id = ?1, update_at = ?2 WHERE card_id IN (${marks}) AND delete_at = 0`).bind(targetBoardId, now, ...chunk))
    statements.push(db.prepare(`UPDATE project_attachments SET board_id = ?1 WHERE card_id IN (${projectPlaceholders(chunk.length, 2)})`).bind(targetBoardId, ...chunk))
    statements.push(db.prepare(`UPDATE project_time_entries SET board_id = ?1 WHERE card_id IN (${projectPlaceholders(chunk.length, 2)})`).bind(targetBoardId, ...chunk))
  }

  const links = new Map<string, { from_card_id: string, to_card_id: string, kind: string }>()
  for (let at = 0; at < movedIds.length; at += 45) {
    const chunk = movedIds.slice(at, at + 45)
    const fromMarks = projectPlaceholders(chunk.length, 2)
    const toMarks = projectPlaceholders(chunk.length, chunk.length + 2)
    const { results } = await db.prepare(
      `SELECT from_card_id, to_card_id, kind FROM project_card_links
       WHERE board_id = ?1 AND (from_card_id IN (${fromMarks}) OR to_card_id IN (${toMarks}))`,
    ).bind(card.boardId, ...chunk, ...chunk).all<{ from_card_id: string, to_card_id: string, kind: string }>()
    for (const row of results) links.set(`${row.from_card_id}|${row.to_card_id}|${row.kind}`, row)
  }
  for (const link of links.values()) {
    const fromMoved = movedSet.has(link.from_card_id)
    const toMoved = movedSet.has(link.to_card_id)
    if (fromMoved && toMoved) {
      statements.push(db.prepare(
        `UPDATE project_card_links SET board_id = ?1
         WHERE board_id = ?2 AND from_card_id = ?3 AND to_card_id = ?4 AND kind = ?5`,
      ).bind(targetBoardId, card.boardId, link.from_card_id, link.to_card_id, link.kind))
    } else {
      statements.push(db.prepare(
        'DELETE FROM project_card_links WHERE board_id = ?1 AND from_card_id = ?2 AND to_card_id = ?3 AND kind = ?4',
      ).bind(card.boardId, link.from_card_id, link.to_card_id, link.kind))
    }
  }

  assertProjectBatchStatementLimit(statements.length)
  await db.batch(statements)
  await touchProjectBoard(db, card.boardId, now)
  return (await getProjectCard(db, card.id))!
}