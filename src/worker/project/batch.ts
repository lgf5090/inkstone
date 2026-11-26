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
import { assertProjectParent, cardPatchStatements, getProjectCard, getProjectCardRow } from './cards'
import { cardOrderStatement, contentPatchStatements, getProjectContent } from './contents'
import { applyCardValueEffects } from './enhance'
import { assertProjectRelationValues, projectRelationTargets } from './relations'
import { getProjectView, viewPatchStatements } from './views'
import { assertProjectBatchStatementLimit, projectIdChunks, projectPlaceholders } from './d1'
import { assertProjectValuesWritable } from './property-access'
import { projectParentMapHasCycle } from '@shared/project/hierarchy'

type ProjectBatchInput = z.infer<typeof ProjectBatchSchema>
type ProjectBatchDeleteInput = z.infer<typeof ProjectBatchDeleteSchema>

async function commit(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  assertProjectBatchStatementLimit(statements.length)
  if (statements.length) return db.batch(statements)
  return []
}

async function readCardsByIds(db: D1Database, ids: readonly string[]): Promise<Map<string, ProjectCard>> {
  const map = new Map<string, ProjectCard>()
  const valuesByCard = new Map<string, Record<string, string>>()
  for (const chunk of projectIdChunks(ids)) {
    const marks = projectPlaceholders(chunk.length)
    const [{ results: rows }, { results: valueRows }] = await Promise.all([
      db.prepare(`SELECT * FROM project_cards WHERE id IN (${marks})`).bind(...chunk).all<CardRow>(),
      db.prepare(`SELECT card_id, property_id, value FROM project_card_values WHERE card_id IN (${marks})`).bind(...chunk).all<ValueRow>(),
    ])
    for (const row of valueRows) {
      let values = valuesByCard.get(row.card_id)
      if (!values) { values = {}; valuesByCard.set(row.card_id, values) }
      values[row.property_id] = row.value
    }
    for (const row of rows) map.set(row.id, rowToCard(row, valuesByCard.get(row.id) ?? {}))
  }
  return map
}

async function readContentsByIds(db: D1Database, ids: readonly string[]): Promise<Map<string, ProjectContent>> {
  const map = new Map<string, ProjectContent>()
  for (const chunk of projectIdChunks(ids)) {
    const { results } = await db.prepare(`SELECT * FROM project_card_contents WHERE id IN (${projectPlaceholders(chunk.length)})`).bind(...chunk).all<ContentRow>()
    for (const row of results) map.set(row.id, rowToContent(row))
  }
  return map
}

async function readViewsByIds(db: D1Database, ids: readonly string[]): Promise<Map<string, ProjectView>> {
  const map = new Map<string, ProjectView>()
  for (const chunk of projectIdChunks(ids)) {
    const { results } = await db.prepare(`SELECT * FROM project_views WHERE id IN (${projectPlaceholders(chunk.length)})`).bind(...chunk).all<ViewRow>()
    for (const row of results) map.set(row.id, rowToView(row))
  }
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
  assertProjectBatchStatementLimit(statementCount)
  const properties = await readBoardProperties(db, board.id)
  const relationTargets = projectRelationTargets(properties)
  for (const { patch } of cards) {
    await assertProjectValuesWritable(db, board.id, role, patch.values)
    await assertProjectRelationValues(db, properties, patch.values, userId)
  }
  const cardsById = await readCardsByIds(db, cards.map((entry) => entry.id))
  const contentsById = await readContentsByIds(db, contents.map((entry) => entry.id))
  const viewsById = await readViewsByIds(db, views.map((entry) => entry.id))
  const { results: parentRows } = await db.prepare(
    'SELECT id, parent_id FROM project_cards WHERE board_id = ?1 AND delete_at = 0',
  ).bind(board.id).all<{ id: string, parent_id: string }>()
  const parents = new Map(parentRows.map((row) => [row.id, row.parent_id]))
  for (const { id, patch } of cards) {
    const card = cardsById.get(id)
    if (!card || card.boardId !== board.id || card.deleteAt !== 0) throw ApiError.notFound('Card not found')
    if (patch.parentId !== undefined) {
      await assertProjectParent(db, card, patch.parentId)
      parents.set(id, patch.parentId)
    }
  }
  if (projectParentMapHasCycle([...parents].map(([id, parentId]) => ({ id, parentId })))) {
    throw ApiError.badRequest('Cyclic parent relationship is not allowed')
  }
  const statements: D1PreparedStatement[] = []
  const valueCards: ProjectCard[] = []
  for (const { id, patch } of cards) {
    const card = cardsById.get(id)
    if (!card || card.boardId !== board.id || card.deleteAt !== 0) throw ApiError.notFound('Card not found')
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
  const seen = new Set<string>()
  for (const before of valueCards) {
    const after = afterById.get(before.id)
    if (!after) continue
    await applyCardValueEffects(db, env, board, before, after, properties, userId, now, seen)
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
  }
  for (const viewId of input.viewIds) {
    const view = await getProjectView(db, viewId)
    if (!view || view.boardId !== board.id || view.deleteAt !== 0) throw ApiError.notFound('View not found')
    if (view.fields.minimumRole && !projectRoleAtLeast(role, view.fields.minimumRole)) throw ApiError.notFound('View not found')
    statements.push(db.prepare('UPDATE project_views SET delete_at = ?1, modified_by = ?2, update_at = ?1 WHERE id = ?3')
      .bind(now, userId, viewId))
  }
  const contentIdsByCard = new Map<string, string[]>()
  for (const contentId of input.contentIds) {
    const content = await getProjectContent(db, contentId)
    if (!content || content.boardId !== board.id || content.deleteAt !== 0) throw ApiError.notFound('Content not found')
    statements.push(db.prepare('UPDATE project_card_contents SET delete_at = ?1, modified_by = ?2, update_at = ?1 WHERE id = ?3')
      .bind(now, userId, contentId))
    const ids = contentIdsByCard.get(content.cardId) ?? []
    ids.push(contentId)
    contentIdsByCard.set(content.cardId, ids)
  }
  const baseStatementCount = statements.length
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const orderResultIndexes: number[] = []
    for (const [cardId, contentIds] of contentIdsByCard) {
      const row = await getProjectCardRow(db, cardId)
      if (!row) throw ApiError.notFound('Card not found')
      let order = JSON.parse(row.content_order) as ProjectContentOrder
      for (const contentId of contentIds) order = removeContentOrder(order, contentId)
      orderResultIndexes.push(statements.length)
      statements.push(cardOrderStatement(db, cardId, order, userId, now, row.content_order_revision))
    }
    const results = await commit(db, statements)
    if (orderResultIndexes.every((index) => (results[index]?.meta.changes ?? 0) > 0)) return
    statements.splice(baseStatementCount)
  }
  throw ApiError.conflict('Card content order changed concurrently; retry the edit')
}
