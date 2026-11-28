/**
 * The ordered blocks that make up a card's body. The position column keeps the bundle's contents in
 * a stable order, but the card's contentOrder array is the reading order the client draws (it also
 * threads comments), so every create, delete and move here keeps the two in step in one batch.
 */
import type { ProjectCard, ProjectContent } from '@shared/project/model'
import {
  appendContentOrder,
  moveContentOrder,
  removeContentOrder,
  type ProjectContentOrder,
} from '@shared/project/content-order'
import { newProjectId, PROJECT_LIMITS } from '@shared/project/limits'
import type { ProjectContentCreateInput, ProjectContentPatchInput } from '@shared/project/validation'
import { ApiError } from '../lib/errors'
import { rowToContent, type ContentRow } from './bundle'
import { getProjectCardRow } from './cards'
import { getProjectBoardRow } from './boards'

export async function getProjectContentRow(db: D1Database, contentId: string): Promise<ContentRow | null> {
  return db.prepare('SELECT * FROM project_card_contents WHERE id = ?1').bind(contentId).first<ContentRow>()
}

export async function getProjectContent(db: D1Database, contentId: string): Promise<ProjectContent | null> {
  const row = await getProjectContentRow(db, contentId)
  return row ? rowToContent(row) : null
}

export async function readCardOrder(db: D1Database, cardId: string): Promise<ProjectContentOrder> {
  const row = await getProjectCardRow(db, cardId)
  return row ? (JSON.parse(row.content_order) as ProjectContentOrder) : []
}

export function cardOrderStatement(
  db: D1Database,
  cardId: string,
  order: ProjectContentOrder,
  userId: string,
  now: number,
  expectedRevision?: number,
): D1PreparedStatement {
  const statement = db
    .prepare(`UPDATE project_cards SET content_order = ?1, content_order_revision = content_order_revision + 1,
      modified_by = ?2, update_at = ?3 WHERE id = ?4${expectedRevision === undefined ? '' : ' AND content_order_revision = ?5'}`)
    .bind(JSON.stringify(order), userId, now, cardId, ...(expectedRevision === undefined ? [] : [expectedRevision]))
  return statement
}

export async function mutateProjectCardOrder(
  db: D1Database,
  cardId: string,
  userId: string,
  now: number,
  mutate: (order: ProjectContentOrder) => ProjectContentOrder,
  extraStatements: readonly D1PreparedStatement[] = [],
  statementsForOrder?: (order: ProjectContentOrder) => readonly D1PreparedStatement[] | Promise<readonly D1PreparedStatement[]>,
): Promise<ProjectContentOrder> {
  let includeExtras = true
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await getProjectCardRow(db, cardId)
    if (!row) throw ApiError.notFound('Card not found')
    const order = mutate(JSON.parse(row.content_order) as ProjectContentOrder)
    const positioned = statementsForOrder ? await statementsForOrder(order) : []
    const results = await db.batch([
      ...(includeExtras ? extraStatements : []),
      ...positioned,
      cardOrderStatement(db, cardId, order, userId, now, row.content_order_revision),
    ])
    includeExtras = false
    if ((results.at(-1)?.meta.changes ?? 0) > 0) return order
  }
  throw ApiError.conflict('Card content order changed concurrently; retry the edit')
}

export async function assertProjectContentFields(db: D1Database, content: { boardId: string, type: ProjectContent['type'] }, fields: ProjectContent['fields'] | undefined): Promise<void> {
  if (fields?.assigneeId === undefined && fields?.dueAt === undefined) return
  if (content.type !== 'checkbox') throw ApiError.badRequest('checklist fields require a checkbox block')
  const assigneeId = fields.assigneeId
  if (!assigneeId) return
  const board = await getProjectBoardRow(db, content.boardId)
  const member = await db.prepare('SELECT 1 FROM project_board_members WHERE board_id = ?1 AND user_id = ?2')
    .bind(content.boardId, assigneeId).first()
  if (board?.ownerId !== assigneeId && !member) throw ApiError.badRequest('checklist assignee is not a board member')
}

export async function createProjectContent(
  db: D1Database,
  card: ProjectCard,
  userId: string,
  input: ProjectContentCreateInput,
  now: number,
): Promise<ProjectContent> {
  await assertProjectContentFields(db, { boardId: card.boardId, type: input.type }, input.fields)
  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM project_card_contents WHERE card_id = ?1 AND delete_at = 0')
    .bind(card.id)
    .first<{ n: number }>()
  if ((count?.n ?? 0) >= PROJECT_LIMITS.contentsPerCard) throw ApiError.conflict('PROJECT_MAX_CONTENTS_PER_CARD')
  const id = input.id ?? newProjectId('content')
  const max = await db
    .prepare('SELECT MAX(position) AS max FROM project_card_contents WHERE card_id = ?1 AND delete_at = 0')
    .bind(card.id)
    .first<{ max: number | null }>()
  const position = input.position ?? (max?.max ?? -1) + 1
  await mutateProjectCardOrder(db, card.id, userId, now, (order) => appendContentOrder(order, id), [
    db.prepare(
      `INSERT INTO project_card_contents
         (id, card_id, board_id, type, title, fields, position, created_by, modified_by, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?9, 0)`,
    ).bind(id, card.id, card.boardId, input.type, input.title, JSON.stringify(input.fields), position, userId, now),
  ])
  return {
    id, cardId: card.id, boardId: card.boardId, type: input.type, title: input.title, fields: input.fields,
    position, createdBy: userId, modifiedBy: userId, createAt: now, updateAt: now, deleteAt: 0,
  }
}

export function contentPatchStatements(
  db: D1Database,
  content: ProjectContent,
  patch: ProjectContentPatchInput,
  userId: string,
  now: number,
): D1PreparedStatement[] {
  const sets: string[] = ['modified_by = ?', 'update_at = ?']
  const values: (string | number)[] = [userId, now]
  if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title) }
  if (patch.position !== undefined) { sets.push('position = ?'); values.push(patch.position) }
  if (patch.fields !== undefined) { sets.push('fields = ?'); values.push(JSON.stringify(patch.fields)) }
  values.push(content.id)
  return [db.prepare(`UPDATE project_card_contents SET ${sets.join(', ')} WHERE id = ?`).bind(...values)]
}

export async function patchProjectContent(
  db: D1Database,
  content: ProjectContent,
  patch: ProjectContentPatchInput,
  userId: string,
  now: number,
): Promise<ProjectContent> {
  await assertProjectContentFields(db, content, patch.fields)
  await db.batch(contentPatchStatements(db, content, patch, userId, now))
  return (await getProjectContent(db, content.id))!
}

export async function softDeleteProjectContent(
  db: D1Database,
  content: ProjectContent,
  userId: string,
  now: number,
): Promise<void> {
  await mutateProjectCardOrder(db, content.cardId, userId, now, (order) => removeContentOrder(order, content.id), [
    db.prepare('UPDATE project_card_contents SET delete_at = ?1, modified_by = ?2, update_at = ?1 WHERE id = ?3 AND delete_at = 0')
      .bind(now, userId, content.id),
  ])
}

export async function undeleteProjectContent(
  db: D1Database,
  content: ProjectContent,
  userId: string,
  now: number,
): Promise<void> {
  await mutateProjectCardOrder(db, content.cardId, userId, now, (order) => appendContentOrder(order, content.id), [
    db.prepare('UPDATE project_card_contents SET delete_at = 0, modified_by = ?1, update_at = ?2 WHERE id = ?3')
      .bind(userId, now, content.id),
  ])
}

/**
 * Move reorders the card's reading order, then reindexes the position of every top-level content
 * block to match it, so the bundle's position order and the drawn contentOrder cannot drift apart.
 * Comment ids in the order are skipped: they have no position column.
 */
export async function moveProjectContent(
  db: D1Database,
  content: ProjectContent,
  targetId: string,
  where: 'before' | 'after',
  userId: string,
  now: number,
): Promise<ProjectContent> {
  await mutateProjectCardOrder(db, content.cardId, userId, now,
    (order) => moveContentOrder(order, content.id, targetId, where),
    [],
    async (order) => {
      const { results } = await db
        .prepare('SELECT id FROM project_card_contents WHERE card_id = ?1 AND delete_at = 0')
        .bind(content.cardId)
        .all<{ id: string }>()
      const contentIds = new Set(results.map((row) => row.id))
      const statements: D1PreparedStatement[] = []
      let position = 0
      for (const entry of order) {
        if (typeof entry === 'string' && contentIds.has(entry)) {
          statements.push(
            db.prepare('UPDATE project_card_contents SET position = ?1, modified_by = ?2, update_at = ?3 WHERE id = ?4')
              .bind(position, userId, now, entry),
          )
          position += 1
        }
      }
      return statements
    })
  return (await getProjectContent(db, content.id))!
}