/**
 * Atomic multi-entity writes (§6.3). A drag that moves three cards across a column, or a multi-select
 * delete, must land as one transaction so a half-applied gesture cannot survive. Every target is read
 * and checked for board membership before any statement runs, then all statements commit in a single
 * D1 batch; the statement count is bounded because D1 caps a batch.
 */
import { z } from 'zod'
import type { ProjectBoard } from '@shared/project/model'
import { removeContentOrder, type ProjectContentOrder } from '@shared/project/content-order'
import { ProjectBatchDeleteSchema, ProjectBatchSchema } from '@shared/project/validation'
import { ApiError } from '../lib/errors'
import { assertProjectParent, cardPatchStatements, getProjectCard } from './cards'
import { cardOrderStatement, contentPatchStatements, getProjectContent, readCardOrder } from './contents'
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

export async function batchPatchProjectBoard(
  db: D1Database,
  board: ProjectBoard,
  input: ProjectBatchInput,
  userId: string,
  now: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = []
  for (const { id, patch } of input.cards ?? []) {
    const card = await getProjectCard(db, id)
    if (!card || card.boardId !== board.id || card.deleteAt !== 0) throw ApiError.notFound('Card not found')
    if (patch.parentId) await assertProjectParent(db, card, patch.parentId)
    statements.push(...cardPatchStatements(db, card, patch, userId, now))
  }
  for (const { id, patch } of input.contents ?? []) {
    const content = await getProjectContent(db, id)
    if (!content || content.boardId !== board.id || content.deleteAt !== 0) throw ApiError.notFound('Content not found')
    statements.push(...contentPatchStatements(db, content, patch, userId, now))
  }
  for (const { id, patch } of input.views ?? []) {
    const view = await getProjectView(db, id)
    if (!view || view.boardId !== board.id || view.deleteAt !== 0) throw ApiError.notFound('View not found')
    statements.push(...viewPatchStatements(db, view, patch, userId, now))
  }
  await commit(db, statements)
}

export async function batchDeleteProjectBoard(
  db: D1Database,
  board: ProjectBoard,
  input: ProjectBatchDeleteInput,
  userId: string,
  now: number,
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