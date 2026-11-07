/**
 * The whole-board read. The reference made the client page through blocks and stitch them together;
 * every screen that opens a board needs all of it, so this gathers board, properties, views, cards,
 * values, contents, comments and members in one round trip. The cursor is the newest update stamp
 * across them all, which is what a realtime `changed` notification carries so a client knows whether
 * its copy is stale.
 */
import type {
  ProjectBoard,
  ProjectBoardBundle,
  ProjectCard,
  ProjectComment,
  ProjectContent,
  ProjectRole,
  ProjectView,
} from '@shared/project/model'
import { readBoardProperties } from './boards'
import { listProjectMembers } from './members'

export interface CardRow {
  id: string
  board_id: string
  parent_id: string
  title: string
  icon: string
  is_template: number
  content_order: string
  created_by: string
  modified_by: string
  create_at: number
  update_at: number
  delete_at: number
}

export interface ValueRow {
  card_id: string
  property_id: string
  value: string
}

export interface ViewRow {
  id: string
  board_id: string
  title: string
  view_type: string
  fields: string
  position: number
  created_by: string
  modified_by: string
  create_at: number
  update_at: number
  delete_at: number
}

interface ContentRow {
  id: string
  card_id: string
  board_id: string
  type: string
  title: string
  fields: string
  position: number
  created_by: string
  modified_by: string
  create_at: number
  update_at: number
  delete_at: number
}

interface CommentRow {
  id: string
  card_id: string
  board_id: string
  author_id: string
  body: string
  create_at: number
  update_at: number
  delete_at: number
}

export function rowToCard(row: CardRow, values: Record<string, string>): ProjectCard {
  return {
    id: row.id,
    boardId: row.board_id,
    parentId: row.parent_id,
    title: row.title,
    icon: row.icon,
    isTemplate: row.is_template === 1,
    contentOrder: JSON.parse(row.content_order) as ProjectCard['contentOrder'],
    values,
    createdBy: row.created_by,
    modifiedBy: row.modified_by,
    createAt: row.create_at,
    updateAt: row.update_at,
    deleteAt: row.delete_at,
  }
}

export function rowToView(row: ViewRow): ProjectView {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    viewType: row.view_type as ProjectView['viewType'],
    fields: JSON.parse(row.fields) as ProjectView['fields'],
    position: row.position,
    createdBy: row.created_by,
    modifiedBy: row.modified_by,
    createAt: row.create_at,
    updateAt: row.update_at,
    deleteAt: row.delete_at,
  }
}

function rowToContent(row: ContentRow): ProjectContent {
  return {
    id: row.id,
    cardId: row.card_id,
    boardId: row.board_id,
    type: row.type as ProjectContent['type'],
    title: row.title,
    fields: JSON.parse(row.fields) as ProjectContent['fields'],
    position: row.position,
    createdBy: row.created_by,
    modifiedBy: row.modified_by,
    createAt: row.create_at,
    updateAt: row.update_at,
    deleteAt: row.delete_at,
  }
}

function rowToComment(row: CommentRow): ProjectComment {
  return {
    id: row.id,
    cardId: row.card_id,
    boardId: row.board_id,
    authorId: row.author_id,
    body: row.body,
    createAt: row.create_at,
    updateAt: row.update_at,
    deleteAt: row.delete_at,
  }
}

export async function readProjectBoardBundle(
  db: D1Database,
  board: ProjectBoard,
  role: ProjectRole,
): Promise<ProjectBoardBundle> {
  const [properties, members, cardRows, valueRows, viewRows, contentRows, commentRows] = await Promise.all([
    readBoardProperties(db, board.id),
    listProjectMembers(db, board.id),
    db.prepare('SELECT * FROM project_cards WHERE board_id = ?1 AND delete_at = 0 ORDER BY create_at, id')
      .bind(board.id).all<CardRow>(),
    // Values are keyed to a card, so a deleted card's values drop out with it rather than lingering.
    db.prepare(
      `SELECT card_id, property_id, value FROM project_card_values
       WHERE card_id IN (SELECT id FROM project_cards WHERE board_id = ?1 AND delete_at = 0)`,
    ).bind(board.id).all<ValueRow>(),
    db.prepare('SELECT * FROM project_views WHERE board_id = ?1 AND delete_at = 0 ORDER BY position, id')
      .bind(board.id).all<ViewRow>(),
    db.prepare('SELECT * FROM project_card_contents WHERE board_id = ?1 AND delete_at = 0 ORDER BY position, id')
      .bind(board.id).all<ContentRow>(),
    db.prepare('SELECT * FROM project_comments WHERE board_id = ?1 AND delete_at = 0 ORDER BY create_at, id')
      .bind(board.id).all<CommentRow>(),
  ])

  const valuesByCard = new Map<string, Record<string, string>>()
  for (const row of valueRows.results) {
    let values = valuesByCard.get(row.card_id)
    if (!values) {
      values = {}
      valuesByCard.set(row.card_id, values)
    }
    values[row.property_id] = row.value
  }
  const cards = cardRows.results.map((row) => rowToCard(row, valuesByCard.get(row.id) ?? {}))
  const views = viewRows.results.map(rowToView)
  const contents = contentRows.results.map(rowToContent)
  const comments = commentRows.results.map(rowToComment)

  let cursor = board.updateAt
  for (const card of cards) cursor = Math.max(cursor, card.updateAt)
  for (const view of views) cursor = Math.max(cursor, view.updateAt)
  for (const content of contents) cursor = Math.max(cursor, content.updateAt)
  for (const comment of comments) cursor = Math.max(cursor, comment.updateAt)
  for (const member of members) cursor = Math.max(cursor, member.updatedAt)

  return { board, properties, views, cards, contents, comments, members, role, cursor }
}