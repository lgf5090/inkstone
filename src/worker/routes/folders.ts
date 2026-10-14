import { Hono } from 'hono'
import type { Context } from 'hono'
import { LIMITS } from '@shared/constants'
import { normalizeOrganizerIcon, organizerColorOrNull } from '@shared/organizer-colors'
import type { Folder } from '@shared/types'
import type { AppBindings } from '../env'
import { toFolder } from '../db/rows'
import { assertOrganizerQuota } from '../db/quota'
import { FTS_QUEUE_CONFLICT_SQL } from '../db/writes'
import { FoldersStore, type FolderGraph, type FolderOrderRow, type FolderPatchColumns } from '../folders/store'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { broadcastCursor } from '../lib/notify'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { aiDeleteNeededSql } from '../mcp/ai-search'

/**
 * The persistence layer for these routes, bound to the account the request authenticated as.
 *
 * Same shape as `routes/notes.ts`: the route parses and validates, asks the store for a record, and
 * turns that record into a response; no statement is built here.
 */
function store(c: Context<AppBindings>): FoldersStore {
  return new FoldersStore(c.env.DB, c.get('userId'))
}

export const foldersRoutes = new Hono<AppBindings>()

foldersRoutes.use('*', requireAuth)

foldersRoutes.get('/', async (c) => {
  const rows = await store(c).listFolders()
  return c.json({ folders: rows.map(toFolder) })
})

foldersRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{
    id?: string
    name?: string
    parentId?: string | null
    icon?: string | null
    color?: string | null
  }>(c, JSON_BODY_LIMITS.small)

  if (body.name !== undefined && typeof body.name !== 'string') {
    throw ApiError.badRequest('name must be a string')
  }
  if (body.parentId !== undefined && body.parentId !== null && typeof body.parentId !== 'string') {
    throw ApiError.badRequest('parentId must be a string or null')
  }
  if (body.icon !== undefined && body.icon !== null && typeof body.icon !== 'string') {
    throw ApiError.badRequest('icon must be a string or null')
  }
  if (body.color !== undefined && body.color !== null && !organizerColorOrNull(body.color)) {
    throw ApiError.badRequest('Folder color is not supported')
  }
  if (body.id !== undefined && !isValidId(body.id)) {
    throw ApiError.badRequest('id must be a valid folder id')
  }
  const id = body.id ?? newId()
  const s = store(c)
  if (body.id) {
    const existing = await s.liveFolderRow(id)
    if (existing) return c.json(toFolder(existing))
    if (await s.idTakenByAnyone(id)) throw ApiError.conflict('This folder id is already in use')
  }
  const graph = await s.graph()
  const parentId = validateParent(graph, body.parentId ?? null)
  const requestedName = (body.name ?? '').trim()
  const name = requestedName || availableFolderName(graph, parentId, "New folder")
  if (name.length > LIMITS.folderNameMaxLength) throw ApiError.badRequest('Folder name is too long')
  if (parentId && folderDepth(graph, parentId) >= LIMITS.folderDepthMax) {
    throw ApiError.badRequest(`Folder depth cannot exceed ${LIMITS.folderDepthMax} levels`)
  }

  await assertOrganizerQuota(c.env.DB, userId, 'folder')
  const now = Date.now()
  const { applied, changeSeq, row } = await s.createFolder({
    id,
    parentId,
    name,
    icon: normalizeOrganizerIcon(body.icon),
    color: organizerColorOrNull(body.color),
    now,
  })
  if (!applied) throw ApiError.conflict('The parent folder changed or a sibling already uses this name')
  await broadcastCursor(c, changeSeq)
  return c.json(toFolder(row!), 201)
})

foldersRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const s = store(c)
  const body = await readJson<{
    name?: string
    parentId?: string | null
    beforeId?: string | null
    icon?: string | null
    color?: string | null
  }>(c, JSON_BODY_LIMITS.small)

  const existing = await s.folderState(id)
  if (!existing) throw ApiError.notFound('Folder not found')

  // The columns are named in the order the update writes them, which is the order the guard
  // placeholders are counted against; `updated_at` is appended by the store.
  const columns: FolderPatchColumns = {}

  if (body.name !== undefined && typeof body.name !== 'string') {
    throw ApiError.badRequest('name must be a string')
  }
  if (body.parentId !== undefined && body.parentId !== null && typeof body.parentId !== 'string') {
    throw ApiError.badRequest('parentId must be a string or null')
  }
  if (body.beforeId !== undefined && body.beforeId !== null && typeof body.beforeId !== 'string') {
    throw ApiError.badRequest('beforeId must be a string or null')
  }
  if (body.beforeId !== undefined && body.parentId === undefined) {
    throw ApiError.badRequest('parentId is required when reordering a folder')
  }
  if (body.beforeId === id) throw ApiError.badRequest('A folder cannot be placed before itself')
  if (body.icon !== undefined && body.icon !== null && typeof body.icon !== 'string') {
    throw ApiError.badRequest('icon must be a string or null')
  }
  if (typeof body.name === 'string') {
    const name = body.name.trim()
    if (!name) throw ApiError.badRequest('Folder name cannot be empty')
    if (name.length > LIMITS.folderNameMaxLength) throw ApiError.badRequest('Folder name is too long')
    columns.name = name
  }
  if (body.icon !== undefined) {
    columns.icon = normalizeOrganizerIcon(body.icon)
  }
  if (body.color !== undefined) {
    if (body.color !== null && !organizerColorOrNull(body.color)) {
      throw ApiError.badRequest('Folder color is not supported')
    }
    columns.color = organizerColorOrNull(body.color)
  }
  const graph = await s.graph()
  let parentId = existing.parent_id
  if (body.parentId !== undefined) {
    parentId = validateParent(graph, body.parentId, id)
    const nextDepth = (parentId ? folderDepth(graph, parentId) : 0) + subtreeHeight(graph, id)
    if (nextDepth > LIMITS.folderDepthMax) {
      throw ApiError.badRequest(`Folder depth cannot exceed ${LIMITS.folderDepthMax} levels`)
    }
    if (parentId !== existing.parent_id) {
      columns.parent_id = parentId
    }
  }
  const parentChanged = parentId !== existing.parent_id
  const shouldPlace = body.beforeId !== undefined || parentChanged
  if (shouldPlace) {
    const position = await resolveFolderPosition(
      s,
      id,
      existing.parent_id,
      parentId,
      body.beforeId ?? null,
    )
    if (position !== null) {
      columns.position = position
    }
  }
  if (!Object.keys(columns).length) return c.json(await loadFolder(s, id))

  const updatedAt = Math.max(Date.now(), existing.updated_at + 1)
  const { applied, changeSeq, row } = await s.patchFolder({
    id,
    current: existing,
    parentId,
    columns,
    updatedAt,
    beforeId: body.beforeId ?? null,
  })
  if (!applied) throw ApiError.conflict('The folder changed elsewhere or a sibling already uses this name')
  await broadcastCursor(c, changeSeq)
  return c.json(toFolder(row!))
})

foldersRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const strategy = parseFolderDeleteStrategy(c.req.query('strategy'))
  const { ftsEnabled } = c.get('database')
  const now = Date.now()

  const row = await c.env.DB.prepare(
    `SELECT id, parent_id, position, updated_at FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
  )
    .bind(id, userId)
    .first<{ id: string; parent_id: string | null; position: number; updated_at: number }>()
  if (!row) throw ApiError.notFound('Folder not found')

  if (strategy === 'move-up') {
    const promotionOrder = await folderPromotionOrder(c.env.DB, userId, row)
    const promotionJson = JSON.stringify(promotionOrder)
    const guard = `EXISTS (SELECT 1 FROM folders
      WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3 AND deleted_at IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM folders child
        JOIN folders sibling
          ON sibling.user_id = child.user_id
         AND sibling.parent_id IS (
           SELECT parent_id FROM folders WHERE id = ?1 AND user_id = ?2
         )
         AND lower(sibling.name) = lower(child.name)
         AND sibling.deleted_at IS NULL
         AND sibling.id != ?1
         AND sibling.id != child.id
       WHERE child.parent_id = ?1 AND child.user_id = ?2 AND child.deleted_at IS NULL
      )`
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'folder', json_extract(item.value, '$.id'), 'upsert', ?4
           FROM json_each(?5) item WHERE ${guard}`,
      ).bind(id, userId, row.updated_at, now, promotionJson),
      c.env.DB.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'note', id, 'upsert', ?4 FROM notes
          WHERE folder_id = ?1 AND user_id = ?2 AND ${guard}`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'folder', ?1, 'delete', ?4 WHERE ${guard}`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `UPDATE folders SET deleted_at = ?4
          WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3
            AND deleted_at IS NULL AND ${guard}`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `UPDATE folders SET
           parent_id = CASE WHEN parent_id = ?1 THEN ?4 ELSE parent_id END,
           position = COALESCE((
             SELECT json_extract(item.value, '$.position') FROM json_each(?6) item
              WHERE json_extract(item.value, '$.id') = folders.id
           ), position),
           updated_at = MAX(updated_at + 1, ?5)
          WHERE id IN (SELECT json_extract(item.value, '$.id') FROM json_each(?6) item)
            AND user_id = ?2 AND deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM folders
              WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3 AND deleted_at = ?5)`,
      ).bind(id, userId, row.updated_at, row.parent_id, now, promotionJson),
      c.env.DB.prepare(
        `UPDATE notes SET folder_id = ?4, updated_at = MAX(updated_at + 1, ?5), rev = rev + 1
          WHERE folder_id = ?1 AND user_id = ?2
            AND EXISTS (SELECT 1 FROM folders
              WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3 AND deleted_at = ?5)`,
      ).bind(id, userId, row.updated_at, row.parent_id, now),
      c.env.DB.prepare(
        `DELETE FROM folders WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3
          AND deleted_at = ?4`,
      ).bind(id, userId, row.updated_at, now),
    ]
    const results = await c.env.DB.batch(statements)
    if (!results.at(-1)?.meta.changes) throw ApiError.conflict('The folder changed elsewhere. Refresh and try again')
  } else {
    const tree = subtreeCteWithRevision()
    const noteIds = `SELECT n.id FROM notes n WHERE n.user_id = ?2 AND n.folder_id IN (SELECT id FROM subtree)`
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `${tree} INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'folder', id, 'delete', ?4 FROM subtree`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `${tree} INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'note', id, 'upsert', ?4 FROM notes
          WHERE user_id = ?2 AND folder_id IN (SELECT id FROM subtree)`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `${tree} INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
         SELECT ?2, id, 'delete', ?4 FROM notes
          WHERE user_id = ?2 AND folder_id IN (SELECT id FROM subtree)
            AND ${aiDeleteNeededSql('?2', 'notes.id')}`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(`${tree} DELETE FROM links WHERE source_note_id IN (${noteIds})`)
        .bind(id, userId, row.updated_at),
      c.env.DB.prepare(
        `${tree} UPDATE links SET target_note_id = (
           SELECT candidate.id FROM notes candidate
            WHERE candidate.user_id = links.user_id AND candidate.deleted_at IS NULL
              AND candidate.title_key = links.target_key
              AND candidate.id NOT IN (${noteIds})
            ORDER BY candidate.created_at ASC, candidate.id ASC LIMIT 1
         ) WHERE user_id = ?2 AND target_note_id IN (${noteIds})`,
      ).bind(id, userId, row.updated_at),
    ]
    if (ftsEnabled) {
      statements.push(
        c.env.DB.prepare(`${tree}
          INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
          SELECT ?2, id, 'delete', ?4 FROM notes WHERE id IN (${noteIds})
          ${FTS_QUEUE_CONFLICT_SQL}`)
          .bind(id, userId, row.updated_at, now),
      )
    }
    statements.push(
      c.env.DB.prepare(
        `${tree} UPDATE notes SET folder_id = NULL, deleted_at = COALESCE(deleted_at, ?4),
          updated_at = MAX(updated_at + 1, ?4), rev = rev + 1
          WHERE user_id = ?2 AND folder_id IN (SELECT id FROM subtree)`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `${tree} DELETE FROM folders WHERE user_id = ?2 AND id IN (SELECT id FROM subtree)`,
      ).bind(id, userId, row.updated_at),
    )
    const results = await c.env.DB.batch(statements)
    if (!results.at(-1)?.meta.changes) throw ApiError.conflict('The folder changed elsewhere. Refresh and try again')
  }

  await broadcastCursor(c)
  return c.json({ ok: true })
})


async function loadFolder(s: FoldersStore, id: string): Promise<Folder> {
  const row = await s.folderRow(id)
  if (!row) throw ApiError.notFound('Folder not found')
  return toFolder(row)
}

function availableFolderName(graph: FolderGraph, parentId: string | null, base: string): string {
  const names = graph.siblingNames.get(parentId ?? '') ?? new Set<string>()
  if (!names.has(base.toLocaleLowerCase())) return base
  let suffix = 2
  while (names.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix++
  return `${base} ${suffix}`
}

async function resolveFolderPosition(
  s: FoldersStore,
  id: string,
  currentParentId: string | null,
  parentId: string | null,
  beforeId: string | null,
): Promise<number | null> {
  let rows = await s.siblingOrder(parentId)
  const currentOrder = rows.map((row) => row.id)
  let siblings = rows.filter((row) => row.id !== id)
  let index = beforeId === null ? siblings.length : siblings.findIndex((row) => row.id === beforeId)
  if (index < 0) throw ApiError.badRequest('The target folder is not in the destination')

  const desiredOrder = siblings.map((row) => row.id)
  desiredOrder.splice(index, 0, id)
  if (
    currentParentId === parentId &&
    currentOrder.length === desiredOrder.length &&
    currentOrder.every((folderId, orderIndex) => folderId === desiredOrder[orderIndex])
  ) {
    return null
  }

  let position = insertionPosition(siblings[index - 1]?.position, siblings[index]?.position)
  if (position !== null) return position

  await s.normalizeSiblings(siblings)
  rows = await s.siblingOrder(parentId)
  siblings = rows.filter((row) => row.id !== id)
  index = beforeId === null ? siblings.length : siblings.findIndex((row) => row.id === beforeId)
  if (index < 0) throw ApiError.conflict('The destination folder order changed. Try again')
  position = insertionPosition(siblings[index - 1]?.position, siblings[index]?.position)
  if (position === null) throw ApiError.conflict('The folder order changed. Try again')
  return position
}

function insertionPosition(previous: number | undefined, next: number | undefined): number | null {
  if (previous === undefined && next === undefined) return 1000
  if (previous === undefined) return next! - 1000
  if (next === undefined) return previous + 1000
  const position = previous + (next - previous) / 2
  return Number.isFinite(position) && position > previous && position < next ? position : null
}

export async function folderPromotionOrder(
  db: D1Database,
  userId: string,
  folder: { id: string; parent_id: string | null; position: number },
): Promise<Array<{ id: string; position: number }>> {
  const results = await new FoldersStore(db, userId).promotionRows(folder)
  const compare = (left: FolderOrderRow, right: FolderOrderRow) =>
    left.position - right.position || left.created_at - right.created_at || left.id.localeCompare(right.id)
  const siblings = results.filter((row) => row.parent_id === folder.parent_id).sort(compare)
  const children = results.filter((row) => row.parent_id === folder.id).sort(compare)
  if (!children.length) return []

  const folderIndex = siblings.findIndex((row) => row.id === folder.id)
  if (folderIndex < 0) throw ApiError.conflict('The folder hierarchy changed. Refresh and try again')
  const previous = siblings[folderIndex - 1]?.position
  const next = siblings[folderIndex + 1]?.position
  const positions = positionsBetween(previous, next, children.length)
  if (positions) {
    return children.map((child, index) => ({ id: child.id, position: positions[index]! }))
  }

  const desired = [...siblings]
  desired.splice(folderIndex, 1, ...children)
  return desired.flatMap((row, index) => {
    const position = (index + 1) * 1000
    return row.parent_id === folder.id || row.position !== position ? [{ id: row.id, position }] : []
  })
}

function positionsBetween(
  previous: number | undefined,
  next: number | undefined,
  count: number,
): number[] | null {
  if (!count) return []
  if (previous === undefined && next === undefined) {
    return Array.from({ length: count }, (_, index) => (index + 1) * 1000)
  }
  if (previous === undefined) {
    return Array.from({ length: count }, (_, index) => next! - (count - index) * 1000)
  }
  if (next === undefined) {
    return Array.from({ length: count }, (_, index) => previous + (index + 1) * 1000)
  }
  const step = (next - previous) / (count + 1)
  if (!Number.isFinite(step) || step <= 0) return null
  const positions = Array.from({ length: count }, (_, index) => previous + step * (index + 1))
  return positions.every((position, index) =>
    Number.isFinite(position) &&
    position > (index === 0 ? previous : positions[index - 1]!) &&
    position < next,
  ) ? positions : null
}

function validateParent(
  graph: FolderGraph,
  parentId: string | null | undefined,
  selfId?: string,
): string | null {
  if (!parentId) return null
  if (!graph.parents.has(parentId)) throw ApiError.badRequest('The parent folder does not exist')

  const visited = new Set<string>()
  let cursor: string | null = parentId
  while (cursor) {
    if (cursor === selfId) throw ApiError.badRequest('A folder cannot be moved into its own descendant')
    if (visited.has(cursor)) throw ApiError.badRequest('The folder hierarchy contains a cycle')
    visited.add(cursor)
    cursor = graph.parents.get(cursor) ?? null
  }
  return parentId
}

function subtreeCteWithRevision(): string {
  return `WITH RECURSIVE subtree(id) AS (
    SELECT id FROM folders
     WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3 AND deleted_at IS NULL
    UNION
    SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
     WHERE f.user_id = ?2 AND f.deleted_at IS NULL
  )`
}

export function parseFolderDeleteStrategy(value: unknown): 'move-up' | 'delete' {
  if (value === undefined || value === null || value === '') return 'move-up'
  if (value === 'move-up' || value === 'delete') return value
  throw ApiError.badRequest('strategy must be move-up or delete')
}

function folderDepth(graph: FolderGraph, id: string): number {
  let depth = 1
  let cursor = graph.parents.get(id) ?? null
  const guard = new Set<string>([id])
  while (cursor && !guard.has(cursor) && depth < 64) {
    guard.add(cursor)
    cursor = graph.parents.get(cursor) ?? null
    depth++
  }
  return depth
}

function subtreeHeight(graph: FolderGraph, rootId: string): number {
  let height = 1
  const visited = new Set<string>()
  const stack: Array<[string, number]> = [[rootId, 1]]
  while (stack.length) {
    const [id, depth] = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    height = Math.max(height, depth)
    for (const child of graph.children.get(id) ?? []) stack.push([child, depth + 1])
  }
  return height
}
