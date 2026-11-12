/**
 * Cards and their property values. A card is a row plus a bag of values keyed by property id; the
 * value bag lives in its own table so changing one property never rewrites the whole card. Writes
 * land in one D1 batch, and a delete is a stamp so a card can come back with its values intact.
 */
import type { ProjectBoard, ProjectCard, ProjectProperty } from '@shared/project/model'
import { projectDonePatch } from '@shared/project/model'
import { newProjectId, PROJECT_LIMITS } from '@shared/project/limits'
import type { ProjectCardCreateInput, ProjectCardPatchInput } from '@shared/project/validation'
import { advanceProjectDay, serializeProjectRecurrence } from '@shared/project/recurrence'
import { moveProjectDateValue, parseProjectDateValue, projectDayToStamp, projectStampToDay } from '@shared/project/date'
import { ApiError } from '../lib/errors'
import { rowToCard, type CardRow, type ValueRow } from './bundle'

export async function readCardValues(db: D1Database, cardId: string): Promise<Record<string, string>> {
  const { results } = await db
    .prepare('SELECT property_id, value FROM project_card_values WHERE card_id = ?1')
    .bind(cardId)
    .all<ValueRow>()
  const values: Record<string, string> = {}
  for (const row of results) values[row.property_id] = row.value
  return values
}

export async function getProjectCardRow(db: D1Database, cardId: string): Promise<CardRow | null> {
  return db.prepare('SELECT * FROM project_cards WHERE id = ?1').bind(cardId).first<CardRow>()
}

export async function getProjectCard(db: D1Database, cardId: string): Promise<ProjectCard | null> {
  const row = await getProjectCardRow(db, cardId)
  if (!row) return null
  return rowToCard(row, await readCardValues(db, cardId))
}

function valueStatements(
  db: D1Database,
  cardId: string,
  values: Record<string, string>,
  now: number,
): D1PreparedStatement[] {
  return Object.entries(values).map(([propertyId, value]) => db
    .prepare(
      `INSERT INTO project_card_values (card_id, property_id, value, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(card_id, property_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(cardId, propertyId, value, now))
}

/**
 * A new card counts against the board's ceiling before it is written. The count is a guard against a
 * client flooding creates, not a serialization point: two concurrent creates can both pass it, which
 * is acceptable for a soft DoS ceiling rather than a billed quota.
 */
export async function createProjectCard(
  db: D1Database,
  board: ProjectBoard,
  userId: string,
  input: ProjectCardCreateInput,
  now: number,
): Promise<ProjectCard> {
  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM project_cards WHERE board_id = ?1 AND delete_at = 0')
    .bind(board.id)
    .first<{ n: number }>()
  if ((count?.n ?? 0) >= PROJECT_LIMITS.cardsPerBoard) throw ApiError.conflict('PROJECT_MAX_CARDS_PER_BOARD')
  if (input.parentId) {
    if (input.id && input.parentId === input.id) throw ApiError.badRequest('A card cannot be its own parent')
    const parent = await getProjectCardRow(db, input.parentId)
    if (!parent || parent.board_id !== board.id || parent.delete_at !== 0) {
      throw ApiError.badRequest('Parent card does not exist on this board')
    }
  }
  const id = input.id ?? newProjectId('card')
  await db.batch([
    db.prepare(
      `INSERT INTO project_cards
         (id, board_id, parent_id, title, icon, is_template, content_order, recurrence, created_by, modified_by,
          create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', ?7, ?8, ?8, ?9, ?9, 0)`,
    ).bind(id, board.id, input.parentId, input.title, input.icon, input.isTemplate ? 1 : 0, input.recurrence ? serializeProjectRecurrence(input.recurrence) : null, userId, now),
    ...valueStatements(db, id, input.values, now),
  ])
  return {
    id,
    boardId: board.id,
    parentId: input.parentId,
    title: input.title,
    icon: input.icon,
    isTemplate: input.isTemplate,
    contentOrder: [],
    values: input.values,
    recurrence: input.recurrence ?? null,
    createdBy: userId,
    modifiedBy: userId,
    createAt: now,
    updateAt: now,
    deleteAt: 0,
  }
}

/**
 * A card patch. A null value deletes that one property's row; a string upserts it. The card's own
 * fields are a sparse update, and the whole thing lands in one batch so a half-applied edit cannot
 * survive. The caller passes the card it already read so the board id need not be looked up again.
 */
export function cardPatchStatements(
  db: D1Database,
  card: ProjectCard,
  patch: ProjectCardPatchInput,
  userId: string,
  now: number,
): D1PreparedStatement[] {
  const sets: string[] = ['modified_by = ?', 'update_at = ?']
  const values: (string | number | null)[] = [userId, now]
  if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title) }
  if (patch.icon !== undefined) { sets.push('icon = ?'); values.push(patch.icon) }
  if (patch.parentId !== undefined) { sets.push('parent_id = ?'); values.push(patch.parentId) }
  if (patch.contentOrder !== undefined) { sets.push('content_order = ?'); values.push(JSON.stringify(patch.contentOrder)) }
  if (patch.recurrence !== undefined) { sets.push('recurrence = ?'); values.push(patch.recurrence ? serializeProjectRecurrence(patch.recurrence) : null) }
  values.push(card.id)
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE project_cards SET ${sets.join(', ')} WHERE id = ?`).bind(...values),
  ]
  for (const [propertyId, value] of Object.entries(patch.values ?? {})) {
    if (value === null) {
      statements.push(db.prepare('DELETE FROM project_card_values WHERE card_id = ?1 AND property_id = ?2').bind(card.id, propertyId))
    } else {
      statements.push(...valueStatements(db, card.id, { [propertyId]: value }, now))
    }
  }
  return statements
}

/**
 * A parent must be a live card on the same board and must not already sit below this card. Every
 * writer of `parentId` crosses this, including the batch route, so a bulk patch cannot build the
 * cross-board link or the cycle the single-card route refuses.
 */
export async function assertProjectParent(
  db: D1Database,
  card: Pick<ProjectCard, 'id' | 'boardId'>,
  parentId: string,
): Promise<void> {
  if (!parentId) return
  if (parentId === card.id) throw ApiError.badRequest('A card cannot be its own parent')
  const parent = await getProjectCardRow(db, parentId)
  if (!parent || parent.board_id !== card.boardId || parent.delete_at !== 0) {
    throw ApiError.badRequest('Parent card does not exist on this board')
  }
  let currentAncestorId: string | null = parent.parent_id
  const visited = new Set<string>([card.id, parentId])
  while (currentAncestorId) {
    if (currentAncestorId === card.id) {
      throw ApiError.badRequest('Cyclic parent relationship is not allowed')
    }
    if (visited.has(currentAncestorId)) break
    visited.add(currentAncestorId)
    const ancestor = await getProjectCardRow(db, currentAncestorId)
    currentAncestorId = ancestor?.parent_id ?? null
  }
}

export async function patchProjectCard(
  db: D1Database,
  card: ProjectCard,
  patch: ProjectCardPatchInput,
  userId: string,
  now: number,
): Promise<ProjectCard> {
  if (patch.parentId) await assertProjectParent(db, card, patch.parentId)
  await db.batch(cardPatchStatements(db, card, patch, userId, now))
  return (await getProjectCard(db, card.id))!
}

/**
 * The next instance of a repeating card, spawned when the current one is completed. The date advances
 * by the rule (from the card's own date, or today when it has none), the tick is reset to open, and
 * the rule travels with the new card so the chain continues. A board with no date property still
 * repeats — the instance simply carries no date.
 */
export async function spawnRecurringCard(
  db: D1Database,
  board: ProjectBoard,
  card: ProjectCard,
  properties: readonly ProjectProperty[],
  userId: string,
  now: number,
): Promise<ProjectCard | null> {
  if (!card.recurrence) return null
  const values = { ...card.values }
  const dateProperty = properties.find((property) => property.type === 'date')
  if (dateProperty) {
    const current = parseProjectDateValue(values[dateProperty.id] ?? '')
    const includeTime = current?.includeTime === true
    const baseDay = current?.from !== undefined ? projectStampToDay(current.from, includeTime) : projectStampToDay(now)
    const nextStamp = projectDayToStamp(advanceProjectDay(baseDay, card.recurrence), includeTime)
    values[dateProperty.id] = JSON.stringify(moveProjectDateValue(current ?? {}, nextStamp))
  }
  const open = projectDonePatch(properties, false)
  if (open) Object.assign(values, open)
  return createProjectCard(db, board, userId, {
    parentId: '',
    title: card.title,
    icon: card.icon,
    isTemplate: false,
    values,
    recurrence: card.recurrence,
  }, now)
}

export async function softDeleteProjectCard(db: D1Database, cardId: string, userId: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE project_cards SET delete_at = ?1, modified_by = ?2, update_at = ?1 WHERE id = ?3 AND delete_at = 0')
    .bind(now, userId, cardId)
    .run()
}

export async function undeleteProjectCard(db: D1Database, cardId: string, userId: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE project_cards SET delete_at = 0, modified_by = ?1, update_at = ?2 WHERE id = ?3')
    .bind(userId, now, cardId)
    .run()
}