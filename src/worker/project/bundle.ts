/**
 * The board read. Interactive clients ask for a bounded card page and fetch older pages on demand;
 * internal exports and duplication pass the full card limit. The cursor is sampled before the rows so
 * a concurrent write can only make the response newer than its cursor, never the other way around.
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
import { evaluateProjectFormulaResult, projectFormulaDependencyOrder, projectFormulaReferenceValue } from '@shared/project/formula'
import { evaluateProjectRollup, projectRollupCycleIds, projectRollupOrder } from '@shared/project/rollup'
import { projectMultiValueIds, projectRoleAtLeast } from '@shared/project/model'
import { PROJECT_LIMITS, isProjectId } from '@shared/project/limits'
import { ApiError } from '../lib/errors'
import { parseProjectRecurrence } from '@shared/project/recurrence'
import { getProjectBoardRow, readBoardProperties, readProjectPropertyRevision } from './boards'
import { listProjectMembers, listProjectPeople } from './members'
import { projectCardForRole, projectPropertiesForRole, projectRoleForBoard } from './visibility'

export interface CardRow {
  id: string
  board_id: string
  parent_id: string
  title: string
  icon: string
  is_template: number
  content_order: string
  content_order_revision: number
  recurrence: string | null
  recurrence_source_id: string | null
  completed_at: number | null
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
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
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

export interface ProjectCardPageOptions {
  cursor?: string
  limit?: number
  cardId?: string
}

interface ProjectBundleContext {
  computed: Map<string, ProjectCard>
  loading: Set<string>
}

interface ProjectCardCursor {
  createAt: number
  id: string
}

function encodeCardCursor(row: CardRow): string {
  return btoa(JSON.stringify({ createAt: row.create_at, id: row.id }))
}

function decodeCardCursor(cursor: string | undefined): ProjectCardCursor | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(atob(cursor)) as Partial<ProjectCardCursor>
    if (typeof parsed.createAt !== 'number' || !Number.isFinite(parsed.createAt)
      || typeof parsed.id !== 'string' || !isProjectId(parsed.id)) throw new Error('invalid cursor')
    return { createAt: parsed.createAt, id: parsed.id }
  } catch {
    throw ApiError.badRequest('invalid card cursor')
  }
}

export async function readProjectBoardBundle(
  db: D1Database,
  board: ProjectBoard,
  role: ProjectRole,
  viewerId?: string,
  options: ProjectCardPageOptions = {},
  context: ProjectBundleContext = { computed: new Map(), loading: new Set() },
): Promise<ProjectBoardBundle> {
  const cursor = await projectBoardCursor(db, board)
  const cardCursor = decodeCardCursor(options.cursor)
  if (options.cardId && !isProjectId(options.cardId)) throw ApiError.badRequest('invalid card id')
  const limit = options.cardId ? 1 : Math.min(PROJECT_LIMITS.cardsPerBoard, Math.max(1, Math.floor(options.limit ?? PROJECT_LIMITS.cardsPerBoard)))
  const pageClause = options.cardId
    ? 'AND id = ?2'
    : cardCursor ? 'AND (create_at > ?2 OR (create_at = ?2 AND id > ?3))' : ''
  const cardParams: (string | number)[] = options.cardId
    ? [board.id, options.cardId]
    : [board.id, ...(cardCursor ? [cardCursor.createAt, cardCursor.id] : [])]
  const [properties, members, propertyRevision, cardRows, viewRows, countRow] = await Promise.all([
    readBoardProperties(db, board.id),
    listProjectMembers(db, board.id),
    readProjectPropertyRevision(db, board.id),
    db.prepare(`SELECT * FROM project_cards WHERE board_id = ?1 AND delete_at = 0 ${pageClause} ORDER BY create_at, id LIMIT ?${cardParams.length + 1}`)
      .bind(...cardParams, limit + 1).all<CardRow>(),
    db.prepare('SELECT * FROM project_views WHERE board_id = ?1 AND delete_at = 0 ORDER BY position, id')
      .bind(board.id).all<ViewRow>(),
    db.prepare('SELECT COUNT(*) AS count FROM project_cards WHERE board_id = ?1 AND delete_at = 0')
      .bind(board.id).first<{ count: number }>(),
  ])
  const cardsHasMore = cardRows.results.length > limit
  const pageRows = cardRows.results.slice(0, limit)
  const valueRows: ValueRow[] = []
  const contentRows: ContentRow[] = []
  const commentRows: CommentRow[] = []
  for (let at = 0; at < pageRows.length; at += 90) {
    const chunk = pageRows.slice(at, at + 90)
    const marks = chunk.map((_, index) => `?${index + 1}`).join(', ')
    const [values, contents, comments] = await Promise.all([
      db.prepare(`SELECT card_id, property_id, value FROM project_card_values WHERE card_id IN (${marks})`)
        .bind(...chunk.map((row) => row.id)).all<ValueRow>(),
      db.prepare(`SELECT * FROM project_card_contents WHERE card_id IN (${marks}) AND delete_at = 0 ORDER BY position, id`)
        .bind(...chunk.map((row) => row.id)).all<ContentRow>(),
      db.prepare(`SELECT * FROM project_comments WHERE card_id IN (${marks}) AND delete_at = 0 ORDER BY create_at, id`)
        .bind(...chunk.map((row) => row.id)).all<CommentRow>(),
    ])
    valueRows.push(...values.results)
    contentRows.push(...contents.results)
    commentRows.push(...comments.results)
  }
  contentRows.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
  commentRows.sort((left, right) => left.create_at - right.create_at || left.id.localeCompare(right.id))
  const contentPage = contentRows.slice(0, PROJECT_LIMITS.bundleContents + 1)
  const commentPage = commentRows.slice(0, PROJECT_LIMITS.bundleComments + 1)

  const valuesByCard = new Map<string, Record<string, string>>()
  for (const row of valueRows) {
    let values = valuesByCard.get(row.card_id)
    if (!values) {
      values = {}
      valuesByCard.set(row.card_id, values)
    }
    values[row.property_id] = row.value
  }
  const visibleProperties = projectPropertiesForRole(properties, role)
  const cards = pageRows.map((row) => projectCardForRole(
    rowToCard(row, valuesByCard.get(row.id) ?? {}),
    properties,
    role,
  ))
  for (const card of cards) context.computed.set(card.id, card)
  const relationProperties = visibleProperties.filter(
    (property) => property.type === 'relation' && property.config?.targetBoardId,
  )
  if (relationProperties.length) {
    const relationIds = new Set(relationProperties.map((property) => property.id))
    const { results: relationRows } = await db.prepare(
      `SELECT r.from_card_id, r.property_id, r.to_card_id FROM project_card_relations r
       JOIN project_cards c ON c.id = r.to_card_id AND c.delete_at = 0
       WHERE r.board_id = ?1
         AND r.from_card_id IN (SELECT id FROM project_cards WHERE board_id = ?1 AND delete_at = 0 ${pageClause})`,
    ).bind(...cardParams).all<{ from_card_id: string, property_id: string, to_card_id: string }>()
    const edges = new Map<string, string[]>()
    for (const row of relationRows) {
      if (!relationIds.has(row.property_id)) continue
      const key = `${row.from_card_id}|${row.property_id}`
      const list = edges.get(key) ?? []
      list.push(row.to_card_id)
      edges.set(key, list)
    }
    for (const card of cards) {
      for (const property of relationProperties) {
        const ids = edges.get(`${card.id}|${property.id}`) ?? []
        card.values[property.id] = ids.length ? JSON.stringify(ids) : ''
      }
    }
  }
  const formulaProperties = visibleProperties.filter((property) => property.type === 'formula' && property.config?.expression)
  if (formulaProperties.length > 0) {
    const { order, cycles, dependencies } = projectFormulaDependencyOrder(visibleProperties)
    const byId = new Map(visibleProperties.map((property) => [property.id, property]))
    for (const card of cards) {
      const errors = (card.valueErrors ??= {})
      const byName = new Map<string, string>()
      for (const property of visibleProperties) {
        if (property.type === 'formula') continue
        const value = projectFormulaReferenceValue(card, property)
        byName.set(property.name.trim().toLowerCase(), value)
        byName.set(property.id.toLowerCase(), value)
      }
      for (const propertyId of cycles) {
        card.values[propertyId] = ''
        errors[propertyId] = 'formula cycle'
      }
      for (const propertyId of order) {
        const property = byId.get(propertyId)!
        const failedDependency = (dependencies.get(propertyId) ?? []).find((id) => card.valueErrors?.[id])
        if (failedDependency) {
          card.values[propertyId] = ''
          errors[propertyId] = 'formula dependency failed'
          continue
        }
        const result = evaluateProjectFormulaResult(property.config!.expression!, byName)
        card.values[propertyId] = result.value
        if (result.error) errors[propertyId] = result.error
        byName.set(property.name.trim().toLowerCase(), result.value)
        byName.set(property.id.toLowerCase(), result.value)
      }
    }
  }
  for (const card of cards) context.computed.set(card.id, card)
  const rollupProperties = visibleProperties.filter((property) => property.type === 'rollup' && property.config?.rollup)
  if (rollupProperties.length) {
    const cycles = projectRollupCycleIds(visibleProperties)
    const order = projectRollupOrder(visibleProperties)
    const byId = new Map(visibleProperties.map((property) => [property.id, property]))
    const { results: rollupEdges } = await db.prepare(
      `SELECT r.from_card_id, r.property_id, r.to_card_id FROM project_card_relations r
       JOIN project_cards c ON c.id = r.to_card_id AND c.delete_at = 0
       WHERE r.board_id = ?1
         AND r.from_card_id IN (SELECT id FROM project_cards WHERE board_id = ?1 AND delete_at = 0 ${pageClause})`,
    ).bind(...cardParams).all<{ from_card_id: string, property_id: string, to_card_id: string }>()
    const edgesByKey = new Map<string, string[]>()
    const targetIds = new Set<string>()
    for (const edge of rollupEdges) {
      const key = `${edge.from_card_id}|${edge.property_id}`
      const list = edgesByKey.get(key) ?? []
      list.push(edge.to_card_id)
      edgesByKey.set(key, list)
      targetIds.add(edge.to_card_id)
    }
    const valuesByCardId = new Map<string, Record<string, string>>()
    for (const card of cards) valuesByCardId.set(card.id, { ...card.values })
    for (const targetId of targetIds) {
      if (valuesByCardId.has(targetId) || context.loading.has(targetId)) continue
      const targetCardRow = await db.prepare('SELECT board_id FROM project_cards WHERE id = ?1 AND delete_at = 0')
        .bind(targetId).first<{ board_id: string }>()
      if (!targetCardRow) continue
      const targetBoard = await getProjectBoardRow(db, targetCardRow.board_id)
      if (!targetBoard) continue
      const targetRole = targetBoard.id === board.id ? role : await projectRoleForBoard(db, targetBoard.id, viewerId ?? '')
      if (!targetRole) continue
      context.loading.add(targetId)
      try {
        const targetBundle = await readProjectBoardBundle(db, targetBoard, targetRole, viewerId, { cardId: targetId }, context)
        const targetCard = targetBundle.cards[0]
        if (targetCard) valuesByCardId.set(targetId, { ...targetCard.values })
      } finally {
        context.loading.delete(targetId)
      }
    }
    const computed = new Map<string, string>()
    for (const card of cards) {
      const errors = (card.valueErrors ??= {})
      for (const property of rollupProperties) {
        if (cycles.has(property.id)) {
          card.values[property.id] = ''
          errors[property.id] = 'rollup cycle'
        }
      }
    }
    for (const propertyId of order) {
      const property = byId.get(propertyId)
      if (!property?.config?.rollup) continue
      const config = property.config.rollup
      const relation = byId.get(config.relationPropertyId)
      const usable = relation?.type === 'relation'
      for (const card of cards) {
        const toIds = usable ? (edgesByKey.get(`${card.id}|${config.relationPropertyId}`) ?? []) : []
        const targetValues = toIds.map((toId) => {
          const stored = valuesByCardId.get(toId)?.[config.targetPropertyId]
          if (stored !== undefined) return stored
          return computed.get(`${toId}|${config.targetPropertyId}`) ?? ''
        })
        const result = evaluateProjectRollup(targetValues, config.aggregation)
        computed.set(`${card.id}|${propertyId}`, result)
        card.values[propertyId] = result
      }
    }
  }
  for (const card of cards) context.computed.set(card.id, card)
  const allViews = viewRows.results.map(rowToView)
  const views = allViews.filter((view) => !view.fields.minimumRole || projectRoleAtLeast(role, view.fields.minimumRole))
  const contentsTruncated = contentPage.length > PROJECT_LIMITS.bundleContents
  const commentsTruncated = commentPage.length > PROJECT_LIMITS.bundleComments
  const contents = contentPage.slice(0, PROJECT_LIMITS.bundleContents).map(rowToContent)
  const comments = commentPage.slice(0, PROJECT_LIMITS.bundleComments).map(rowToComment)

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

  const nextCursor = cardsHasMore && pageRows.length ? encodeCardCursor(pageRows[pageRows.length - 1]!) : undefined

  return {
    board, properties: visibleProperties, views, cards, contents, comments, members, people, role, cursor, propertyRevision,
    cardCount: countRow?.count ?? pageRows.length,
    cardsHasMore,
    ...(nextCursor ? { cardsNextCursor: nextCursor } : {}),
    ...(contentsTruncated ? { contentsTruncated } : {}),
    ...(commentsTruncated ? { commentsTruncated } : {}),
  }
}
/** Advances the board's own stamp; the cursor poll and the sidebar's recency both read it. */
export async function touchProjectBoard(db: D1Database, boardId: string, now: number): Promise<void> {
  await db.prepare('UPDATE project_boards SET update_at = ?1 WHERE id = ?2 AND update_at < ?1').bind(now, boardId).run()
}

/**
 * The newest stamp across everything the board carries, without reading any of it. A bundle samples
 * this before its rows; an unchanged answer means the copy the reader holds is still current.
 */
export async function projectBoardCursor(db: D1Database, board: ProjectBoard): Promise<number> {
  // One SELECT with scalar subqueries rather than a UNION of six: the local D1 runtime caps a
  // compound SELECT at five terms, and a 500 here made every 30-second convergence poll fail
  // silently because the caller treats a cursor error as best-effort.
  const row = await db.prepare(
    `SELECT MAX(
       COALESCE((SELECT MAX(update_at) FROM project_cards WHERE board_id = ?1 AND delete_at = 0), 0),
       COALESCE((SELECT MAX(update_at) FROM project_views WHERE board_id = ?1 AND delete_at = 0), 0),
       COALESCE((SELECT MAX(update_at) FROM project_card_contents WHERE board_id = ?1 AND delete_at = 0), 0),
       COALESCE((SELECT MAX(update_at) FROM project_comments WHERE board_id = ?1 AND delete_at = 0), 0),
       COALESCE((SELECT MAX(updated_at) FROM project_board_members WHERE board_id = ?1), 0),
       COALESCE((SELECT MAX(updated_at) FROM project_properties WHERE board_id = ?1), 0)
     ) AS at`,
  ).bind(board.id).first<{ at: number | null }>()
  return Math.max(board.updateAt, row?.at ?? 0)
}
