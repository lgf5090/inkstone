/**
 * Moving a card (and its subtasks) to another board.
 *
 * A card's values key on the source board's property and option ids, which mean nothing on the target.
 * Each used property is matched to the target by name and type; a match reuses the target's property
 * and maps options by their label, while a property the target lacks is created there carrying its
 * options over. Contents and comments travel with the card; the moved root detaches from any parent
 * left behind, and subtasks keep their place under it.
 */
import type { ProjectCard, ProjectProperty, ProjectPropertyType } from '@shared/project/model'
import { projectMultiValueIds } from '@shared/project/model'
import { PROJECT_LIMITS, newProjectId } from '@shared/project/limits'
import { ApiError } from '../lib/errors'
import { readBoardProperties } from './boards'
import { getProjectCard } from './cards'

const MOVE_BATCH_SIZE = 500
const OPTION_TYPES = new Set<ProjectPropertyType>(['select', 'multiSelect'])

interface MovePlan {
  propertyIds: Map<string, string>
  optionIds: Map<string, Map<string, string>>
  newProperties: ProjectProperty[]
  optionUpdates: { id: string, options: ProjectProperty['options'] }[]
}

function propertyKey(property: ProjectProperty): string {
  return property.type + '::' + property.name
}

function planProperties(used: ProjectProperty[], target: ProjectProperty[]): MovePlan {
  const plan: MovePlan = { propertyIds: new Map(), optionIds: new Map(), newProperties: [], optionUpdates: [] }
  const targetByKey = new Map(target.map((property) => [propertyKey(property), property]))
  for (const source of used) {
    const match = targetByKey.get(propertyKey(source))
    if (!match) {
      const created: ProjectProperty = { id: newProjectId('property'), name: source.name, type: source.type, options: source.options.map((option) => ({ ...option })) }
      plan.newProperties.push(created)
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

function remapValue(source: ProjectProperty, value: string, plan: MovePlan): string {
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
  for (let index = 0; index < movedIds.length; index += 1) {
    for (const child of childrenOf.get(movedIds[index]!) ?? []) movedIds.push(child)
  }

  const placeholders = movedIds.map((_, at) => `?${at + 1}`).join(', ')
  const valueRows = await db
    .prepare(`SELECT card_id, property_id, value FROM project_card_values WHERE card_id IN (${placeholders})`)
    .bind(...movedIds)
    .all<{ card_id: string, property_id: string, value: string }>()
  const valuesByCard = new Map<string, Record<string, string>>()
  for (const row of valueRows.results) {
    const values = valuesByCard.get(row.card_id) ?? {}
    values[row.property_id] = row.value
    valuesByCard.set(row.card_id, values)
  }

  const sourceProperties = await readBoardProperties(db, card.boardId)
  const targetProperties = await readBoardProperties(db, targetBoardId)
  const usedIds = new Set(valueRows.results.map((row) => row.property_id))
  const used = sourceProperties.filter((property) => usedIds.has(property.id))
  const plan = planProperties(used, targetProperties)
  const sourceById = new Map(sourceProperties.map((property) => [property.id, property]))

  const statements: D1PreparedStatement[] = []
  plan.newProperties.forEach((property, index) => {
    statements.push(db.prepare(
      `INSERT INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    ).bind(targetBoardId, property.id, property.name, property.type, JSON.stringify(property.options), targetProperties.length + index, now))
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
    for (const [propertyId, value] of Object.entries(valuesByCard.get(id) ?? {})) {
      const source = sourceById.get(propertyId)
      const targetId = plan.propertyIds.get(propertyId)
      if (!source || !targetId) continue
      statements.push(db.prepare('INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(id, targetId, remapValue(source, value, plan), now))
    }
  }

  const inClause = movedIds.map((_, at) => `?${at + 3}`).join(', ')
  const pairClause = movedIds.map((_, at) => `?${at + 2}`).join(', ')
  statements.push(db.prepare(`UPDATE project_card_contents SET board_id = ?1, update_at = ?2 WHERE card_id IN (${inClause}) AND delete_at = 0`).bind(targetBoardId, now, ...movedIds))
  statements.push(db.prepare(`UPDATE project_comments SET board_id = ?1, update_at = ?2 WHERE card_id IN (${inClause}) AND delete_at = 0`).bind(targetBoardId, now, ...movedIds))
  statements.push(db.prepare(`UPDATE project_attachments SET board_id = ?1 WHERE card_id IN (${pairClause})`).bind(targetBoardId, ...movedIds))
  statements.push(db.prepare(
    `DELETE FROM project_card_links
     WHERE board_id = ?1
       AND (from_card_id IN (${pairClause}) OR to_card_id IN (${pairClause}))
       AND NOT (from_card_id IN (${pairClause}) AND to_card_id IN (${pairClause}))`,
  ).bind(card.boardId, ...movedIds))
  statements.push(db.prepare(
    `UPDATE project_card_links SET board_id = ?1
     WHERE board_id = ?2 AND (from_card_id IN (${inClause}) OR to_card_id IN (${inClause}))`,
  ).bind(targetBoardId, card.boardId, ...movedIds))

  for (let index = 0; index < statements.length; index += MOVE_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + MOVE_BATCH_SIZE))
  }
  return (await getProjectCard(db, card.id))!
}