/**
 * Comments on a card. Like content blocks they join the card's reading order, so posting appends the
 * comment id and deleting scrubs it (a threaded comment lives in a nested array). Only the author may
 * edit or delete a comment; the route enforces that after the board boundary, since the board role
 * alone says nothing about who wrote a given comment.
 */
import type { ProjectCard, ProjectComment } from '@shared/project/model'
import { appendContentOrder, removeContentOrder } from '@shared/project/content-order'
import { newProjectId } from '@shared/project/limits'
import type { ProjectCommentCreateInput } from '@shared/project/validation'
import { rowToComment, type CommentRow } from './bundle'
import { getProjectCardRow } from './cards'

export async function getProjectCommentRow(db: D1Database, commentId: string): Promise<CommentRow | null> {
  return db.prepare('SELECT * FROM project_comments WHERE id = ?1').bind(commentId).first<CommentRow>()
}

export async function getProjectComment(db: D1Database, commentId: string): Promise<ProjectComment | null> {
  const row = await getProjectCommentRow(db, commentId)
  return row ? rowToComment(row) : null
}

export async function listCardComments(db: D1Database, cardId: string): Promise<ProjectComment[]> {
  const { results } = await db
    .prepare('SELECT * FROM project_comments WHERE card_id = ?1 AND delete_at = 0 ORDER BY create_at, id')
    .bind(cardId)
    .all<CommentRow>()
  return results.map(rowToComment)
}

export async function createProjectComment(
  db: D1Database,
  card: ProjectCard,
  userId: string,
  input: ProjectCommentCreateInput,
  now: number,
): Promise<ProjectComment> {
  const id = input.id ?? newProjectId('comment')
  const cardRow = await getProjectCardRow(db, card.id)
  const order = appendContentOrder(
    cardRow ? (JSON.parse(cardRow.content_order) as (string | string[])[]) : [],
    id,
  )
  await db.batch([
    db.prepare(
      `INSERT INTO project_comments (id, card_id, board_id, author_id, body, create_at, update_at, delete_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0)`,
    ).bind(id, card.id, card.boardId, userId, input.body, now),
    db.prepare('UPDATE project_cards SET content_order = ?1, modified_by = ?2, update_at = ?3 WHERE id = ?4')
      .bind(JSON.stringify(order), userId, now, card.id),
  ])
  return {
    id, cardId: card.id, boardId: card.boardId, authorId: userId, body: input.body,
    createAt: now, updateAt: now, deleteAt: 0,
  }
}

export async function patchProjectComment(
  db: D1Database,
  comment: ProjectComment,
  body: string,
  now: number,
): Promise<ProjectComment> {
  await db.prepare('UPDATE project_comments SET body = ?1, update_at = ?2 WHERE id = ?3').bind(body, now, comment.id).run()
  return (await getProjectComment(db, comment.id))!
}

export async function softDeleteProjectComment(
  db: D1Database,
  comment: ProjectComment,
  userId: string,
  now: number,
): Promise<void> {
  const cardRow = await getProjectCardRow(db, comment.cardId)
  const order = removeContentOrder(
    cardRow ? (JSON.parse(cardRow.content_order) as (string | string[])[]) : [],
    comment.id,
  )
  await db.batch([
    db.prepare('UPDATE project_comments SET delete_at = ?1, update_at = ?1 WHERE id = ?2 AND delete_at = 0').bind(now, comment.id),
    db.prepare('UPDATE project_cards SET content_order = ?1, modified_by = ?2, update_at = ?3 WHERE id = ?4')
      .bind(JSON.stringify(order), userId, now, comment.cardId),
  ])
}