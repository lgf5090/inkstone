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
import { projectPropertyVisibleTo } from '@shared/project/property-config'
import { evaluateProjectFormula } from '@shared/project/formula'
import { projectMultiValueIds, projectRoleAtLeast } from '@shared/project/model'
import { PROJECT_LIMITS } from '@shared/project/limits'
import { parseProjectRecurrence } from '@shared/project/recurrence'
import { readBoardProperties } from './boards'
import { listProjectMembers, listProjectPeople } from './members'

export interface CardRow {
  id: string
  board_id: string
  parent_id: string
  title: string
  icon: string
  is_template: number
  content_order: string
  recurrence: string | null
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

export interface ContentRow {
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

export interface CommentRow {
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
    recurrence: parseProjectRecurrence(row.recurrence),
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

export function rowToContent(row: ContentRow): ProjectContent {
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

export function rowToComment(row: CommentRow): ProjectComment {
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
    db.prepare(
      `SELECT * FROM project_card_contents
       WHERE board_id = ?1 AND delete_at = 0
         AND card_id IN (SELECT id FROM project_cards WHERE board_id = ?1 AND delete_at = 0)
       ORDER BY position, id LIMIT ?2`,
    ).bind(board.id, PROJECT_LIMITS.bundleContents + 1).all<ContentRow>(),
    db.prepare(
      `SELECT * FROM project_comments
       WHERE board_id = ?1 AND delete_at = 0
         AND card_id IN (SELECT id FROM project_cards WHERE board_id = ?1 AND delete_at = 0)
       ORDER BY create_at, id LIMIT ?2`,
    ).bind(board.id, PROJECT_LIMITS.bundleComments + 1).all<CommentRow>(),
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
  const visibleProperties = properties.filter((property) => projectPropertyVisibleTo(property, role))
  const visiblePropertyIds = new Set(visibleProperties.map((property) => property.id))
  const cards = cardRows.results.map((row) => {
    const values = valuesByCard.get(row.id) ?? {}
    const kept: Record<string, string> = {}
    for (const [propertyId, value] of Object.entries(values)) {
      if (visiblePropertyIds.has(propertyId)) kept[propertyId] = value
    }
    return rowToCard(row, kept)
  })
  const formulaProperties = visibleProperties.filter((property) => property.type === 'formula' && property.config?.expression)
  if (formulaProperties.length > 0) {
    for (const card of cards) {
      const byName = new Map<string, string>()
      for (const property of visibleProperties) {
        if (property.type === 'formula') continue
        const value = card.values[property.id] ?? ''
        byName.set(property.name.trim().toLowerCase(), value)
        byName.set(property.id.toLowerCase(), value)
      }
      for (const property of formulaProperties) {
        const result = evaluateProjectFormula(property.config!.expression!, byName)
        card.values[property.id] = result
        byName.set(property.name.trim().toLowerCase(), result)
        byName.set(property.id.toLowerCase(), result)
      }
    }
  }
  const allViews = viewRows.results.map(rowToView)
  const views = allViews.filter((view) => !view.fields.minimumRole || projectRoleAtLeast(role, view.fields.minimumRole))
  const contentsTruncated = contentRows.results.length > PROJECT_LIMITS.bundleContents
  const commentsTruncated = commentRows.results.length > PROJECT_LIMITS.bundleComments
  const contents = contentRows.results.slice(0, PROJECT_LIMITS.bundleContents).map(rowToContent)
  const comments = commentRows.results.slice(0, PROJECT_LIMITS.bundleComments).map(rowToComment)

  const personProperties = new Set(visibleProperties.filter((property) => property.type === 'person' || property.type === 'multiPerson').map((property) => property.id))
  const userIds = new Set<string>([board.ownerId])
  for (const member of members) userIds.add(member.userId)
  for (const card of cards) {
    userIds.add(card.createdBy)
    userIds.add(card.modifiedBy)
    for (const [propertyId, value] of Object.entries(card.values)) {
      if (!personProperties.has(propertyId)) continue
      for (const id of projectMultiValueIds(value)) userIds.add(id)
    }
  }
  for (const comment of comments) userIds.add(comment.authorId)
  const people = await listProjectPeople(db, [...userIds])

  let cursor = board.updateAt
  for (const card of cards) cursor = Math.max(cursor, card.updateAt)
  for (const view of allViews) cursor = Math.max(cursor, view.updateAt)
  for (const content of contents) cursor = Math.max(cursor, content.updateAt)
  for (const comment of comments) cursor = Math.max(cursor, comment.updateAt)
  for (const member of members) cursor = Math.max(cursor, member.updatedAt)

  return {
    board, properties: visibleProperties, views, cards, contents, comments, members, people, role, cursor,
    ...(contentsTruncated ? { contentsTruncated } : {}),
    ...(commentsTruncated ? { commentsTruncated } : {}),
  }
}
/** Advances the board's own stamp; the cursor poll and the sidebar's recency both read it. */
export async function touchProjectBoard(db: D1Database, boardId: string, now: number): Promise<void> {
  await db.prepare('UPDATE project_boards SET update_at = ?1 WHERE id = ?2 AND update_at < ?1').bind(now, boardId).run()
}

/**
 * The newest stamp across everything the bundle carries, without reading any of it.
 *
 * The bundle's own cursor is computed from rows it already fetched; a poller only needs the number,
 * so this asks each table for its MAX instead. An unchanged answer means the copy the reader holds
 * is still current and the whole-board read can be skipped.
 */
export async function projectBoardCursor(db: D1Database, board: ProjectBoard): Promise<number> {
  const row = await db.prepare(
    `SELECT MAX(at) AS at FROM (
       SELECT MAX(update_at) AS at FROM project_cards WHERE board_id = ?1 AND delete_at = 0
       UNION ALL SELECT MAX(update_at) FROM project_views WHERE board_id = ?1 AND delete_at = 0
       UNION ALL SELECT MAX(update_at) FROM project_card_contents WHERE board_id = ?1 AND delete_at = 0
       UNION ALL SELECT MAX(update_at) FROM project_comments WHERE board_id = ?1 AND delete_at = 0
       UNION ALL SELECT MAX(updated_at) FROM project_board_members WHERE board_id = ?1
       UNION ALL SELECT MAX(updated_at) FROM project_properties WHERE board_id = ?1
     )`,
  ).bind(board.id).first<{ at: number | null }>()
  return Math.max(board.updateAt, row?.at ?? 0)
}
