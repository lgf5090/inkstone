/**
 * The office file/folder/tag surface.
 *
 * This file adapts HTTP: it parses and validates a request, asks `OfficeStore` for rows, and turns
 * them into a response. No statement is built here (`tests/worker-layering.test.ts` enforces that),
 * and every failure is an `ApiError` with a code the client can switch on. Ownership is enforced by
 * the store's `user_id` predicates, so another account's id is a 404, never a 403.
 */
import { Hono, type Context } from 'hono'
import {
  OFFICE_FILE_TYPES,
  OFFICE_LIMITS,
  isOfficeFileType,
  isOfficeFolderName,
  isOfficeTagName,
  normalizeOfficeTitle,
  officeSnapshotKey,
  type OfficeFileType,
} from '@shared/office/constants'
import type { OfficeBatchAction } from '@shared/office/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  OfficeStore,
  toOfficeFileSummary,
  toOfficeFolder,
  toOfficeTag,
  type OfficeFileRow,
  type OfficeFolderGraph,
  type OfficeFolderPatchColumns,
  type OfficeFilePatchColumns,
  type OfficeListFilters,
} from '../office/store'
import { copyOfficeObject, deleteOfficeObjects, discardOfficeObjects, requireOfficeBucket } from '../office/storage'

type Ctx = Context<AppBindings>

/** The six batch actions, named once so the request body and the switch cannot drift apart. */
type OfficeBatchActionName = OfficeBatchAction['action']

const BATCH_ACTIONS = ['move', 'copy', 'tag', 'star', 'pin', 'delete'] as const satisfies readonly OfficeBatchActionName[]

function isBatchAction(value: unknown): value is OfficeBatchActionName {
  return typeof value === 'string' && (BATCH_ACTIONS as readonly string[]).includes(value)
}

/** How many tags one file may carry in a single PATCH. */
const FILE_TAGS_MAX = 100
/** The longest search string the list endpoint accepts. */
const SEARCH_MAX = 200
/** Icon and colour values are palette tokens from the UI, not free text. */
const APPEARANCE_MAX = 40

export const officeRoutes = new Hono<AppBindings>()

officeRoutes.use('*', requireAuth)

function store(c: Ctx): OfficeStore {
  return new OfficeStore(c.env.DB, c.get('userId'))
}

function fileId(c: Ctx): string {
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) throw ApiError.notFound('File not found')
  return id
}

function folderIdParam(c: Ctx): string {
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) throw ApiError.notFound('Folder not found')
  return id
}

function tagIdParam(c: Ctx): string {
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) throw ApiError.notFound('Tag not found')
  return id
}

function flag(value: unknown): boolean {
  return value === '1' || value === 'true'
}

function optionalFolderId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (!isValidId(value)) throw ApiError.badRequest('folderId must be a valid folder id')
  return value
}

function optionalText(value: unknown, field: string, max = APPEARANCE_MAX): string | null {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be a string or null`)
  const text = value.trim()
  if (!text) return null
  if (text.length > max) throw ApiError.badRequest(`${field} is too long`)
  if (/[\u0000-\u001f\u007f]/.test(text)) throw ApiError.badRequest(`${field} contains control characters`)
  return text
}

function bodyFlag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${field} must be a boolean`)
  return value
}

/** A de-duplicated list of ids; `min` 0 clears an association. */
function idList(value: unknown, field: string, max: number, min = 1): string[] {
  if (!Array.isArray(value)) throw ApiError.badRequest(`${field} must be an array of ids`)
  const unique = new Set<string>()
  for (const item of value) {
    if (!isValidId(item)) throw ApiError.badRequest(`${field} contains an invalid id`)
    unique.add(item)
  }
  const ids = [...unique]
  if (ids.length < min) throw ApiError.badRequest(`${field} must name at least ${min} item(s)`)
  if (ids.length > max) throw ApiError.badRequest(`${field} names more than ${max} items`)
  return ids
}

function folderName(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('name must be a string')
  const name = value.trim()
  if (!isOfficeFolderName(name)) {
    throw ApiError.badRequest('Folder name is empty, too long, or contains a path separator')
  }
  return name
}

function tagName(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('name must be a string')
  const name = value.trim().replace(/^#+/, '').trim()
  if (!isOfficeTagName(name)) {
    throw ApiError.badRequest('Tag name is empty, too long, or contains control characters')
  }
  return name
}

function listFilters(search: URLSearchParams): OfficeListFilters {
  const type = search.get('type')
  if (type !== null && type !== '' && !isOfficeFileType(type)) {
    throw ApiError.badRequest(`type must be one of ${OFFICE_FILE_TYPES.join(', ')}`)
  }
  const tagId = search.get('tagId')
  if (tagId !== null && tagId !== '' && !isValidId(tagId)) {
    throw ApiError.badRequest('tagId must be a valid tag id')
  }
  const query = (search.get('q') ?? '').trim()
  if (query.length > SEARCH_MAX) throw ApiError.badRequest('The search query is too long')

  let folderId: string | null | undefined
  if (search.has('folderId')) {
    const raw = search.get('folderId') ?? ''
    folderId = raw === '' || raw === 'root' ? null : optionalFolderId(raw)
  }

  const limitRaw = search.get('limit')
  const limit = limitRaw === null || limitRaw === '' ? undefined : Number(limitRaw)
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw ApiError.badRequest('limit must be a positive number')
  }

  return {
    type: type ? (type as OfficeFileType) : undefined,
    query: query || undefined,
    folderId,
    tagId: tagId || undefined,
    trash: flag(search.get('trash')),
    starred: flag(search.get('starred')),
    recent: flag(search.get('recent')),
    limit,
  }
}

async function requireFolder(s: OfficeStore, folderId: string | null): Promise<void> {
  if (!folderId) return
  if (!(await s.liveFolderRow(folderId))) throw ApiError.badRequest('The folder does not exist')
}

async function fileLimitReached(s: OfficeStore): Promise<boolean> {
  return (await s.countFiles()) >= OFFICE_LIMITS.filesPerUser
}

function fileLimitError(): ApiError {
  return new ApiError(
    400,
    'quota_exceeded',
    `The account can hold at most ${OFFICE_LIMITS.filesPerUser} office files`,
  )
}

function copiedTitle(title: string): string {
  const suffix = ' (copy)'
  return title.length + suffix.length <= OFFICE_LIMITS.titleMax
    ? title + suffix
    : title.slice(0, OFFICE_LIMITS.titleMax - suffix.length) + suffix
}

/** Copy one file's metadata and current snapshot under a fresh id; shared by duplicate and batch. */
async function duplicateFile(c: Ctx, s: OfficeStore, source: OfficeFileRow): Promise<OfficeFileRow> {
  if (await fileLimitReached(s)) throw fileLimitError()
  const userId = c.get('userId')
  const now = Date.now()
  const id = newId()
  let rev = 0
  let snapshotKey = ''
  let size = 0
  let contentHash = ''
  if (source.rev > 0 && source.snapshot_key) {
    const key = officeSnapshotKey(userId, id, 1)
    const copied = await copyOfficeObject(c.env, source.snapshot_key, key)
    if (!copied) throw new ApiError(500, 'internal', 'The source snapshot is missing from storage')
    rev = 1
    snapshotKey = key
    size = source.size
    contentHash = source.content_hash
  }
  try {
    return await s.insertFileCopy({
      id,
      source,
      title: copiedTitle(source.title),
      rev,
      snapshotKey,
      size,
      contentHash,
      now,
    })
  } catch (error) {
    // The row never landed, so the copied bytes have no owner; drop them before reporting.
    await discardOfficeObjects(c.env, snapshotKey ? [snapshotKey] : [])
    throw error
  }
}

officeRoutes.get('/files', async (c) => {
  const filters = listFilters(new URL(c.req.url).searchParams)
  const rows = await store(c).listFiles(filters)
  return c.json({ files: rows.map(toOfficeFileSummary) })
})

officeRoutes.post('/files', async (c) => {
  const body = await readJson<{ type?: unknown; title?: unknown; folderId?: unknown }>(
    c,
    JSON_BODY_LIMITS.small,
  )
  if (!isOfficeFileType(body.type)) {
    throw ApiError.badRequest(`type must be one of ${OFFICE_FILE_TYPES.join(', ')}`)
  }
  const title = normalizeOfficeTitle(body.title)
  if (!title) throw ApiError.badRequest('title must be a non-empty string without control characters')
  const folderId = optionalFolderId(body.folderId)
  const s = store(c)
  await requireFolder(s, folderId)
  if (await fileLimitReached(s)) throw fileLimitError()
  const result = await s.createFile({ id: newId(), type: body.type, title, folderId, now: Date.now() })
  if (!result.applied || !result.row) {
    throw ApiError.conflict('The folder changed while the file was being created')
  }
  return c.json({ file: toOfficeFileSummary(result.row) }, 201)
})

officeRoutes.get('/files/:id', async (c) => {
  const row = await store(c).fileRow(fileId(c))
  if (!row) throw ApiError.notFound('File not found')
  return c.json({ file: toOfficeFileSummary(row) })
})

officeRoutes.patch('/files/:id', async (c) => {
  const id = fileId(c)
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const s = store(c)
  const existing = await s.liveFileRow(id)
  if (!existing) throw ApiError.notFound('File not found')

  const columns: OfficeFilePatchColumns = {}
  if (body.title !== undefined) {
    const title = normalizeOfficeTitle(body.title)
    if (!title) throw ApiError.badRequest('title must be a non-empty string without control characters')
    columns.title = title
  }
  if (body.folderId !== undefined) {
    columns.folder_id = optionalFolderId(body.folderId)
    await requireFolder(s, columns.folder_id)
  }
  if (body.isPinned !== undefined) columns.is_pinned = bodyFlag(body.isPinned, 'isPinned') ? 1 : 0
  if (body.isStarred !== undefined) columns.is_starred = bodyFlag(body.isStarred, 'isStarred') ? 1 : 0

  let tagIds: string[] | undefined
  if (body.tagIds !== undefined) {
    tagIds = idList(body.tagIds, 'tagIds', FILE_TAGS_MAX, 0)
    const owned = await s.tagIdsOwned(tagIds)
    if (owned.length !== tagIds.length) throw ApiError.badRequest('A tag in tagIds does not exist')
  }
  if (!Object.keys(columns).length && tagIds === undefined) {
    return c.json({ file: toOfficeFileSummary(existing) })
  }

  const result = await s.updateFile({ id, columns, tagIds, now: Date.now() })
  if (!result.applied || !result.row) {
    throw ApiError.conflict('The file changed elsewhere. Refresh and try again')
  }
  return c.json({ file: toOfficeFileSummary(result.row) })
})

officeRoutes.post('/files/batch', async (c) => {
  const body = await readJson<{
    ids?: unknown
    action?: unknown
    folderId?: unknown
    tagIds?: unknown
  }>(c, JSON_BODY_LIMITS.attachmentHub)

  const ids = idList(body.ids, 'ids', OFFICE_LIMITS.batchLimit)
  if (!isBatchAction(body.action)) {
    throw ApiError.badRequest(`action must be one of ${BATCH_ACTIONS.join(', ')}`)
  }
  const action = body.action
  const s = store(c)
  const now = Date.now()

  const rows = await s.liveFileRows(ids)
  if (rows.length !== ids.length) {
    const owned = new Set(rows.map((row) => row.id))
    const missing = ids.find((id) => !owned.has(id)) ?? ids[0]
    throw new ApiError(404, 'not_found', 'One or more files no longer exist', { id: missing })
  }

  if (action === 'move') {
    if (body.folderId === undefined) throw ApiError.badRequest('folderId is required for a move (null for the root)')
    const folderId = optionalFolderId(body.folderId)
    await requireFolder(s, folderId)
    const affected = await s.setFileFolder(ids, folderId, now)
    if (affected !== ids.length) throw ApiError.conflict('Some files changed elsewhere. Refresh and try again')
    return c.json({ ok: true, affected })
  }
  if (action === 'tag') {
    const tagIds = idList(body.tagIds, 'tagIds', FILE_TAGS_MAX)
    const owned = await s.tagIdsOwned(tagIds)
    if (owned.length !== tagIds.length) throw ApiError.badRequest('A tag in tagIds does not exist')
    await s.addFileTags(ids, tagIds, now)
    return c.json({ ok: true, affected: ids.length })
  }
  if (action === 'copy') {
    if ((await s.countFiles()) + rows.length > OFFICE_LIMITS.filesPerUser) throw fileLimitError()
    for (const row of rows) await duplicateFile(c, s, row)
    return c.json({ ok: true, affected: rows.length })
  }
  if (action === 'delete') {
    const affected = await s.softDeleteFiles(ids, now)
    if (affected !== ids.length) throw ApiError.conflict('Some files changed elsewhere. Refresh and try again')
    return c.json({ ok: true, affected })
  }
  const affected = await s.setFileFlag(ids, action === 'star' ? 'is_starred' : 'is_pinned', 1, now)
  if (affected !== ids.length) throw ApiError.conflict('Some files changed elsewhere. Refresh and try again')
  return c.json({ ok: true, affected })
})

officeRoutes.post('/files/:id/open', async (c) => {
  const row = await store(c).touchFile(fileId(c), Date.now())
  if (!row) throw ApiError.notFound('File not found')
  return c.json({ file: toOfficeFileSummary(row) })
})

officeRoutes.post('/files/:id/restore', async (c) => {
  const row = await store(c).restoreFile(fileId(c), Date.now())
  if (!row) throw ApiError.notFound('File not found')
  return c.json({ file: toOfficeFileSummary(row) })
})

officeRoutes.post('/files/:id/duplicate', async (c) => {
  const s = store(c)
  const source = await s.liveFileRow(fileId(c))
  if (!source) throw ApiError.notFound('File not found')
  const row = await duplicateFile(c, s, source)
  return c.json({ file: toOfficeFileSummary(row) }, 201)
})

officeRoutes.delete('/files/:id', async (c) => {
  const id = fileId(c)
  const s = store(c)
  const row = await s.fileRow(id)
  if (!row) throw ApiError.notFound('File not found')
  if (flag(c.req.query('purge'))) {
    requireOfficeBucket(c.env)
    const keys = await s.fileObjectKeys(id)
    // Bytes first: if R2 refuses, the rows still name every object and the delete can be retried.
    await deleteOfficeObjects(c.env, keys)
    await s.deleteFileRows(id)
    return c.json({ ok: true })
  }
  await s.softDeleteFiles([id], Date.now())
  return c.json({ ok: true })
})

// -------------------------------------------------------------- folders

officeRoutes.get('/folders', async (c) => {
  const rows = await store(c).listFolders()
  return c.json({ folders: rows.map(toOfficeFolder) })
})

officeRoutes.post('/folders', async (c) => {
  const body = await readJson<{
    name?: unknown
    parentId?: unknown
    icon?: unknown
    color?: unknown
  }>(c, JSON_BODY_LIMITS.small)
  const name = folderName(body.name)
  const parentId = optionalFolderId(body.parentId)
  const icon = optionalText(body.icon, 'icon')
  const color = optionalText(body.color, 'color')
  const s = store(c)
  const graph = await s.folderGraph()
  validateParentFolder(graph, parentId)
  if (parentId && folderDepth(graph, parentId) >= OFFICE_LIMITS.folderDepthMax) {
    throw ApiError.badRequest(`Folder depth cannot exceed ${OFFICE_LIMITS.folderDepthMax} levels`)
  }
  if (siblingNameTaken(graph, parentId, name)) {
    throw ApiError.conflict('A folder with that name already exists in the destination')
  }
  if ((await s.countFolders()) >= OFFICE_LIMITS.foldersMaxPerUser) {
    throw new ApiError(
      400,
      'quota_exceeded',
      `The account can hold at most ${OFFICE_LIMITS.foldersMaxPerUser} folders`,
    )
  }
  const result = await s.createFolder({ id: newId(), parentId, name, icon, color, now: Date.now() })
  if (!result.applied || !result.row) {
    throw ApiError.conflict('The parent folder changed or a sibling already uses this name')
  }
  return c.json({ folder: toOfficeFolder(result.row) }, 201)
})

officeRoutes.patch('/folders/:id', async (c) => {
  const id = folderIdParam(c)
  const body = await readJson<{
    name?: unknown
    parentId?: unknown
    beforeId?: unknown
    icon?: unknown
    color?: unknown
  }>(c, JSON_BODY_LIMITS.small)
  const s = store(c)
  const existing = await s.folderState(id)
  if (!existing) throw ApiError.notFound('Folder not found')

  const columns: OfficeFolderPatchColumns = {}
  if (body.name !== undefined) columns.name = folderName(body.name)
  if (body.icon !== undefined) columns.icon = optionalText(body.icon, 'icon')
  if (body.color !== undefined) columns.color = optionalText(body.color, 'color')

  if (body.beforeId !== undefined && body.beforeId !== null && !isValidId(body.beforeId)) {
    throw ApiError.badRequest('beforeId must be a valid folder id or null')
  }
  if (body.beforeId !== undefined && body.parentId === undefined) {
    throw ApiError.badRequest('parentId is required when reordering a folder')
  }
  const beforeId = (body.beforeId as string | null | undefined) ?? null
  if (beforeId === id) throw ApiError.badRequest('A folder cannot be placed before itself')

  let parentId = existing.parent_id
  if (body.parentId !== undefined) {
    parentId = optionalFolderId(body.parentId)
    const graph = await s.folderGraph()
    validateParentFolder(graph, parentId, id)
    const nextDepth = (parentId ? folderDepth(graph, parentId) : 0) + subtreeHeight(graph, id)
    if (nextDepth > OFFICE_LIMITS.folderDepthMax) {
      throw ApiError.badRequest(`Folder depth cannot exceed ${OFFICE_LIMITS.folderDepthMax} levels`)
    }
    if (parentId !== existing.parent_id) columns.parent_id = parentId
  }

  const parentChanged = parentId !== existing.parent_id
  if (beforeId !== null || parentChanged) {
    const position = await resolveFolderPosition(s, id, existing.parent_id, parentId, beforeId)
    if (position !== null) columns.position = position
  }
  if (!Object.keys(columns).length) {
    const row = await s.folderRow(id)
    if (!row) throw ApiError.notFound('Folder not found')
    return c.json({ folder: toOfficeFolder(row) })
  }

  const updatedAt = Math.max(Date.now(), existing.updated_at + 1)
  const result = await s.patchFolder({
    id,
    current: existing,
    parentId,
    columns,
    updatedAt,
    beforeId,
  })
  if (!result.applied || !result.row) {
    throw ApiError.conflict('The folder changed elsewhere or a sibling already uses this name')
  }
  return c.json({ folder: toOfficeFolder(result.row) })
})

officeRoutes.delete('/folders/:id', async (c) => {
  const id = folderIdParam(c)
  const strategy = parseFolderDeleteStrategy(c.req.query('strategy'))
  const s = store(c)
  const row = await s.folderState(id)
  if (!row) throw ApiError.notFound('Folder not found')
  const now = Date.now()
  if (strategy === 'move-up') {
    const siblings = (await s.siblingOrder(row.parent_id)).filter((sibling) => sibling.id !== id)
    const base = siblings.reduce((max, sibling) => Math.max(max, sibling.position), 0)
    const children = await s.folderChildren(id)
    const placements = children.map((child, index) => ({
      id: child.id,
      position: base + (index + 1) * 1000,
    }))
    const deleted = await s.deleteFolderMoveUp({ current: row, placements, now })
    if (!deleted) throw ApiError.conflict('The folder changed elsewhere. Refresh and try again')
    return c.json({ ok: true })
  }
  const deleted = await s.deleteFolderSubtree({ id, updatedAt: row.updated_at, now })
  if (!deleted) throw ApiError.conflict('The folder changed elsewhere. Refresh and try again')
  return c.json({ ok: true })
})

officeRoutes.post('/folders/:id/restore', async (c) => {
  const row = await store(c).restoreFolder(folderIdParam(c), Date.now())
  if (!row) throw ApiError.notFound('Folder not found')
  return c.json({ folder: toOfficeFolder(row) })
})

// ----------------------------------------------------------------- tags

officeRoutes.get('/tags', async (c) => {
  const rows = await store(c).listTags()
  return c.json({ tags: rows.map(toOfficeTag) })
})

officeRoutes.post('/tags', async (c) => {
  const body = await readJson<{ name?: unknown; color?: unknown }>(c, JSON_BODY_LIMITS.small)
  const name = tagName(body.name)
  const color = optionalText(body.color, 'color')
  const s = store(c)
  if (await s.hasTagNamed(name)) throw ApiError.conflict('A tag with this name already exists')
  if ((await s.countTags()) >= OFFICE_LIMITS.tagsMaxPerUser) {
    throw new ApiError(
      400,
      'quota_exceeded',
      `The account can hold at most ${OFFICE_LIMITS.tagsMaxPerUser} tags`,
    )
  }
  const tag = await s.createTag({ id: newId(), name, color, now: Date.now() })
  return c.json({ tag: toOfficeTag(tag) }, 201)
})

officeRoutes.patch('/tags/:id', async (c) => {
  const id = tagIdParam(c)
  const body = await readJson<{ name?: unknown; color?: unknown; isPinned?: unknown }>(
    c,
    JSON_BODY_LIMITS.small,
  )
  const s = store(c)
  const existing = await s.tagRow(id)
  if (!existing) throw ApiError.notFound('Tag not found')
  if (body.name === undefined && body.color === undefined && body.isPinned === undefined) {
    return c.json({ tag: toOfficeTag(existing) })
  }
  const name = body.name === undefined ? existing.name : tagName(body.name)
  if (name.toLocaleLowerCase() !== existing.name.toLocaleLowerCase() && await s.hasTagNamed(name, id)) {
    throw ApiError.conflict('A tag with this name already exists')
  }
  const color = body.color === undefined ? undefined : optionalText(body.color, 'color')
  const isPinned = body.isPinned === undefined ? undefined : bodyFlag(body.isPinned, 'isPinned') ? 1 : 0
  const result = await s.renameTag({ id, name, color, isPinned, now: Date.now() })
  return c.json({ tag: toOfficeTag(result.tag) })
})

officeRoutes.delete('/tags/:id', async (c) => {
  const deleted = await store(c).deleteTagFamily(tagIdParam(c))
  if (!deleted) throw ApiError.notFound('Tag not found')
  return c.json({ ok: true })
})

// ---------------------------------------------------------------- helpers

function parseFolderDeleteStrategy(value: unknown): 'move-up' | 'delete' {
  if (value === undefined || value === null || value === '') return 'move-up'
  if (value === 'move-up' || value === 'delete') return value
  throw ApiError.badRequest('strategy must be move-up or delete')
}

function siblingNameTaken(graph: OfficeFolderGraph, parentId: string | null, name: string): boolean {
  return (graph.siblingNames.get(parentId ?? '') ?? new Set<string>()).has(name.toLocaleLowerCase())
}

function validateParentFolder(
  graph: OfficeFolderGraph,
  parentId: string | null,
  selfId?: string,
): void {
  if (!parentId) return
  if (!graph.parents.has(parentId)) throw ApiError.badRequest('The parent folder does not exist')
  const visited = new Set<string>()
  let cursor: string | null = parentId
  while (cursor) {
    if (cursor === selfId) throw ApiError.badRequest('A folder cannot be moved into its own descendant')
    if (visited.has(cursor)) throw ApiError.badRequest('The folder hierarchy contains a cycle')
    visited.add(cursor)
    cursor = graph.parents.get(cursor) ?? null
  }
}

function folderDepth(graph: OfficeFolderGraph, id: string): number {
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

function subtreeHeight(graph: OfficeFolderGraph, rootId: string): number {
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

async function resolveFolderPosition(
  s: OfficeStore,
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