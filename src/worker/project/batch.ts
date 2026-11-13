/**
 * Atomic multi-entity writes (§6.3). A drag that moves three cards across a column, or a multi-select
 * delete, must land as one transaction so a half-applied gesture cannot survive. Every target is read
 * and checked for board membership before any statement runs, then all statements commit in a single
 * D1 batch; the statement count is bounded because D1 caps a batch.
 */
import { z } from 'zod'
import type { ProjectBoard, ProjectCard, ProjectContent, ProjectRole, ProjectView } from '@shared/project/model'
import { projectRoleAtLeast } from '@shared/project/model'
import { removeContentOrder, type ProjectContentOrder } from '@shared/project/content-order'
import { ProjectBatchDeleteSchema, ProjectBatchSchema } from '@shared/project/validation'
import { ApiError } from '../lib/errors'
import type { AppBindings } from '../env'
import { readBoardProperties } from './boards'
import { rowToCard, rowToContent, rowToView, type CardRow, type ContentRow, type ValueRow, type ViewRow } from './bundle'
import { assertProjectParent, cardPatchStatements, getProjectCard } from './cards'
import { cardOrderStatement, contentPatchStatements, getProjectContent, readCardOrder } from './contents'
import { applyCardValueEffects } from './enhance'
import { assertProjectRelationValues, projectRelationTargets } from './relations'
import { getProjectView, viewPatchStatements } from './views'

type ProjectBatchInput = z.infer<typeof ProjectBatchSchema>
type ProjectBatchDeleteInput = z.infer<typeof ProjectBatchDeleteSchema>

// D1's per-batch statement ceiling; a batch that would exceed it is rejected rather than split, since
// splitting would surrender the atomicity this endpoint exists to provide.
const BATCH_STATEMENT_LIMIT = 1000

async function commit(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  if (statements.length > BATCH_STATEMENT_LIMIT) throw ApiError.tooLarge('batch has too many operations')
  if (statements.length) await db.batch(statements)
}

function placeholders(ids: readonly string[]): string {
  return ids.map((_, index) => `?${index + 1}`).join(', ')
}

async function readCardsByIds(db: D1Database, ids: readonly string[]): Promise<Map<string, ProjectCard>> {
  const map = new Map<string, ProjectCard>()
  if (!ids.length) return map
  const marks = placeholders(ids)
  const { results: rows } = await db.prepare(`SELECT * FROM project_cards WHERE id IN (${marks})`).bind(...ids).all<CardRow>()
  const { results: valueRows } = await db.prepare(`SELECT card_id, property_id, value FROM project_card_values WHERE card_id IN (${marks})`).bind(...ids).all<ValueRow>()
  const valuesByCard = new Map<string, Record<string, string>>()
  for (const row of valueRows) {
    let values = valuesByCard.get(row.card_id)
    if (!values) { values = {}; valuesByCard.set(row.card_id, values) }
    values[row.property_id] = row.value
  }
  for (const row of rows) map.set(row.id, rowToCard(row, valuesByCard.get(row.id) ?? {}))
  return map
}

async function readContentsByIds(db: D1Database, ids: readonly string[]): Promise<Map<string, ProjectContent>> {
  const map = new Map<string, ProjectContent>()
  if (!ids.length) return map
  const { results } = await db.prepare(`SELECT * FROM project_card_contents WHERE id IN (${placeholders(ids)})`).bind(...ids).all<ContentRow>()
  for (const row of results) map.set(row.id, rowToContent(row))
  return map
}

async function readViewsByIds(db: D1Database, ids: readonly string[]): Promise<Map<string, ProjectView>> {
  const map = new Map<string, ProjectView>()
  if (!ids.length) return map
  const { results } = await db.prepare(`SELECT * FROM project_views WHERE id IN (${placeholders(ids)})`).bind(...ids).all<ViewRow>()
  for (const row of results) map.set(row.id, rowToView(row))
  return map
}

export async function batchPatchProjectBoard(
  db: D1Database,
  board: ProjectBoard,
  input: ProjectBatchInput,
  userId: string,
  now: number,
  role: ProjectRole,
  env: AppBindings['Bindings'],
): Promise<void> {
  const cards = input.cards ?? []
  const contents = input.contents ?? []
  const views = input.views ?? []
  const statementCount = cards.reduce((total, { patch }) => total + 1 + Object.keys(patch.values ?? {}).length, 0)
    + contents.length + views.length
  if (statementCount > BATCH_STATEMENT_LIMIT) throw ApiError.tooLarge('batch has too many operations')
  const properties = await readBoardProperties(db, board.id)
  const relationTargets = projectRelationTargets(properties)
  for (const { patch } of cards) {
    await assertProjectRelationValues(db, properties, patch.values, userId)
  }
  const cardsById = await readCardsByIds(db, cards.map((entry) => entry.id))
  const contentsById = await readContentsByIds(db, contents.map((entry) => entry.id))
  const viewsById = await readViewsByIds(db, views.map((entry) => entry.id))
  const statements: D1PreparedStatement[] = []
  const valueCards: ProjectCard[] = []
  for (const { id, patch } of cards) {
    const card = cardsById.get(id)
    if (!card || card.boardId !== board.id || card.deleteAt !== 0) throw ApiError.notFound('Card not found')
    if (patch.parentId) await assertProjectParent(db, card, patch.parentId)
    if (patch.values !== undefined) valueCards.push(card)
    statements.push(...cardPatchStatements(db, card, patch, userId, now, relationTargets))
  }
  for (const { id, patch } of contents) {
    const content = contentsById.get(id)
    if (!content || content.boardId !== board.id || content.deleteAt !== 0) throw ApiError.notFound('Content not found')
    statements.push(...contentPatchStatements(db, content, patch, userId, now))
  }
  for (const { id, patch } of views) {
    const view = viewsById.get(id)
    if (!view || view.boardId !== board.id || view.deleteAt !== 0) throw ApiError.notFound('View not found')
    if (view.fields.minimumRole && !projectRoleAtLeast(role, view.fields.minimumRole)) throw ApiError.notFound('View not found')
    statements.push(...viewPatchStatements(db, view, patch, userId, now))
  }
  await commit(db, statements)
  if (!valueCards.length) return
  const afterById = await readCardsByIds(db, valueCards.map((card) => card.id))
  for (const before of valueCards) {
    const after = afterById.get(before.id)
    if (!after) continue
    await applyCardValueEffects(db, env, board, before, after, properties, userId, now)
  }
}

export async function batchDeleteProjectBoard(
  db: D1Database,
  board: ProjectBoard,
  input: ProjectBatchDeleteInput,
  userId: string,
  now: number,
  role: ProjectRole,
): Promise<void> {
  const statements: D1PreparedStatement[] = []
  for (const cardId of input.cardIds) {
    const card = await getProjectCard(db, cardId)
    if (!card || card.boardId !== board.id || card.deleteAt !== 0) throw ApiError.notFound('Card not found')
    statements.push(db.prepare('UPDATE project_cards SET delete_at = ?1, modified_by = ?2, update_at = ?1 WHERE id = ?3')
      .bind(now, userId, cardId))
    statements.push(db.prepare('DELETE FROM project_card_relations WHERE from_card_id = ?1 OR to_card_id = ?1').bind(cardId))
  }
  for (const viewId of input.viewIds) {
    const view = await getProjectView(db, viewId)
    if (!view || view.boardId !== board.id || view.deleteAt !== 0) throw ApiError.notFound('View not found')
    if (view.fields.minimumRole && !projectRoleAtLeast(role, view.fields.minimumRole)) throw ApiError.notFound('View not found')
    statements.push(db.prepare('UPDATE project_views SET delete_at = ?1, modified_by = ?2, update_at = ?1 WHERE id = ?3')
      .bind(now, userId, viewId))
  }
  // Contents of one card share a reading order, so scrub them together rather than re-reading per block.
  const orders = new Map<string, ProjectContentOrder>()
  for (const contentId of input.contentIds) {
    const content = await getProjectContent(db, contentId)
    if (!content || content.boardId !== board.id || content.deleteAt !== 0) throw ApiError.notFound('Content not found')
    statements.push(db.prepare('UPDATE project_card_contents SET delete_at = ?1, modified_by = ?2, update_at = ?1 WHERE id = ?3')
      .bind(now, userId, contentId))
    const current = orders.get(content.cardId) ?? await readCardOrder(db, content.cardId)
    orders.set(content.cardId, removeContentOrder(current, contentId))
  }
  for (const [cardId, order] of orders) statements.push(cardOrderStatement(db, cardId, order, userId, now))
  await commit(db, statements)
}
