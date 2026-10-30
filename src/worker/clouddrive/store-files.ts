/**
 * D1 access for the CloudDrive file surface.
 *
 * The route layer resolves mounts and paths; this module owns every statement over
 * `CloudDrive_files` and `CloudDrive_file_tags`. Sorting and cursor values are whitelisted here as
 * well, because they are interpolated into SQL. Every read binds `user_id`.
 */
import {
  CLOUDDRIVE_CATEGORIES,
  CLOUDDRIVE_LIMITS,
  autoSuffixName,
  foldedName,
  restoredName,
  type CloudDriveSortDirection,
  type CloudDriveSortKey,
  type CloudDriveTagView,
} from '@shared/clouddrive/model'
import { organizerColorOrNull } from '@shared/organizer-colors'
import type { Env } from '../env'
import { deleteFileParts } from './distributed'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import {
  decodeCursor,
  encodeCursor,
  foldName,
  initialsOf,
  type CloudDriveFileRow,
} from './lib'

const MAX_DESCENDANTS = 5000
const LIST_TOTAL_CAP = 10_000
const CHUNK = 90

export interface ListOptions {
  sort: CloudDriveSortKey
  dir: CloudDriveSortDirection
  cursor?: string
  limit: number
  q?: string
  type?: string
  starred?: boolean
  tag?: string
  color?: string
  from?: number | null
  to?: number | null
  hidden?: readonly string[]
}

export interface ListResult {
  folders: CloudDriveFileRow[]
  files: CloudDriveFileRow[]
  cursor: string | null
  total: number | null
  foldersTruncated: boolean
}

interface Where {
  sql: string
  params: unknown[]
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function normalizedQuery(value: string): string {
  return foldedName(value.trim())
}

function typeFilter(value: string | undefined): string | null {
  return value && (CLOUDDRIVE_CATEGORIES as readonly string[]).includes(value) ? value : null
}

/**
 * The conditions shared by the folder half, the file half and the count half of a listing.
 * `EXISTS` for a tag keeps the row shape unchanged and still binds the owner.
 */
function buildWhere(
  userId: string,
  mountId: string,
  parentId: string,
  kind: 'folder' | 'file',
  options: ListOptions,
): Where {
  const clauses = [
    'f.user_id = ?',
    'f.mount_id = ?',
    'f.parent_id = ?',
    'f.kind = ?',
    'f.deleted_at IS NULL',
    "f.name_folded <> '.keep'",
  ]
  const params: unknown[] = [userId, mountId, parentId, kind]

  if (options.q) {
    const query = normalizedQuery(options.q)
    if (query) {
      const pattern = `%${escapeLike(query)}%`
      clauses.push("f.name_folded LIKE ? ESCAPE '\\'")
      params.push(pattern)
      if (/^[\x00-\x7f]+$/.test(query)) {
        clauses.push("f.name_initials LIKE ? ESCAPE '\\'")
        params.push(`${escapeLike(query)}%`)
      }
    }
  }
  const type = typeFilter(options.type)
  if (type) {
    clauses.push('f.category = ?')
    params.push(type)
  }
  if (options.starred) clauses.push('f.starred_at IS NOT NULL')
  if (options.tag) {
    clauses.push(
      'EXISTS (SELECT 1 FROM CloudDrive_file_tags t WHERE t.user_id = ? AND t.file_id = f.id AND t.tag_folded = ?)',
    )
    params.push(userId, normalizedQuery(options.tag))
  }
  if (options.color) {
    clauses.push('f.color = ?')
    params.push(options.color)
  }
  if (options.from !== null && options.from !== undefined) {
    clauses.push('f.uploaded_at >= ?')
    params.push(options.from)
  }
  if (options.to !== null && options.to !== undefined) {
    clauses.push('f.uploaded_at <= ?')
    params.push(options.to)
  }
  if (options.hidden && options.hidden.length > 0) {
    const patterns = options.hidden.map(hiddenPatternToLike)
    clauses.push(`(${patterns.map(() => "f.name_folded NOT LIKE ? ESCAPE '\\'").join(' AND ')})`)
    params.push(...patterns)
  }
  return { sql: clauses.join(' AND '), params }
}

function hiddenPatternToLike(pattern: string): string {
  let out = ''
  for (const char of foldedName(pattern)) {
    if (char === '*') out += '%'
    else if (char === '?') out += '_'
    else if (char === '\\' || char === '%' || char === '_') out += `\\${char}`
    else out += char
  }
  return out
}

function orderBy(sort: CloudDriveSortKey, dir: CloudDriveSortDirection): string {
  const direction = dir === 'desc' ? 'DESC' : 'ASC'
  switch (sort) {
    case 'size':
      return `f.size ${direction}, f.id ${direction}`
    case 'uploaded':
      return `f.uploaded_at ${direction}, f.id ${direction}`
    case 'modified':
      return `f.modified_at ${direction}, f.id ${direction}`
    case 'type':
      return `f.category ${direction}, f.name_folded ${direction}, f.id ${direction}`
    case 'name':
    default:
      return `f.name_folded ${direction}, f.id ${direction}`
  }
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('The cursor is invalid')
  return value
}

function requireNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw ApiError.badRequest('The cursor is invalid')
  return value
}

/** `(sortValue, id)` comparison for the next page; every branch uses only whitelisted columns. */
function cursorCondition(
  sort: CloudDriveSortKey,
  dir: CloudDriveSortDirection,
  value: string | number | null,
  id: string,
): Where {
  const op = dir === 'asc' ? '>' : '<'
  switch (sort) {
    case 'size':
      return { sql: `(f.size ${op} ? OR (f.size = ? AND f.id ${op} ?))`, params: [requireNumber(value), requireNumber(value), id] }
    case 'uploaded':
      return { sql: `(f.uploaded_at ${op} ? OR (f.uploaded_at = ? AND f.id ${op} ?))`, params: [requireNumber(value), requireNumber(value), id] }
    case 'modified':
      return { sql: `(f.modified_at ${op} ? OR (f.modified_at = ? AND f.id ${op} ?))`, params: [requireNumber(value), requireNumber(value), id] }
    case 'type': {
      const [category, name] = requireString(value).split('\u0000')
      if (category === undefined || name === undefined) throw ApiError.badRequest('The cursor is invalid')
      return {
        sql: `(f.category ${op} ? OR (f.category = ? AND (f.name_folded ${op} ? OR (f.name_folded = ? AND f.id ${op} ?))))`,
        params: [category, category, name, name, id],
      }
    }
    case 'name':
    default: {
      const name = requireString(value)
      return { sql: `(f.name_folded ${op} ? OR (f.name_folded = ? AND f.id ${op} ?))`, params: [name, name, id] }
    }
  }
}

function cursorValue(sort: CloudDriveSortKey, row: CloudDriveFileRow): string | number {
  switch (sort) {
    case 'size': return row.size
    case 'uploaded': return row.uploaded_at
    case 'modified': return row.modified_at
    case 'type': return `${row.category}\u0000${row.name_folded}`
    case 'name':
    default: return row.name_folded
  }
}

async function countRows(db: D1Database, where: Where): Promise<number | null> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM CloudDrive_files f WHERE ${where.sql}`,
  ).bind(...where.params).first<{ count: number }>()
  const count = row?.count ?? 0
  return count > LIST_TOTAL_CAP ? null : count
}

export async function listFolder(
  db: D1Database,
  userId: string,
  mountId: string,
  parentId: string,
  options: ListOptions,
): Promise<ListResult> {
  const folderWhere = buildWhere(userId, mountId, parentId, 'folder', options)
  const { results: folderRows } = await db.prepare(
    `SELECT f.* FROM CloudDrive_files f
      WHERE ${folderWhere.sql}
      ORDER BY ${orderBy(options.sort, options.dir)}
      LIMIT ${CLOUDDRIVE_LIMITS.folderListMax + 1}`,
  ).bind(...folderWhere.params).all<CloudDriveFileRow>()
  const folders = (folderRows ?? []).slice(0, CLOUDDRIVE_LIMITS.folderListMax)
  const foldersTruncated = (folderRows?.length ?? 0) > CLOUDDRIVE_LIMITS.folderListMax

  const fileWhere = buildWhere(userId, mountId, parentId, 'file', options)
  const conditions = [fileWhere.sql]
  const params = [...fileWhere.params]
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor, options.sort)
    const condition = cursorCondition(options.sort, options.dir, decoded.v, decoded.id)
    conditions.push(condition.sql)
    params.push(...condition.params)
  }
  const { results: fileRows } = await db.prepare(
    `SELECT f.* FROM CloudDrive_files f
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy(options.sort, options.dir)}
      LIMIT ?`,
  ).bind(...params, options.limit).all<CloudDriveFileRow>()
  const files = fileRows ?? []
  const last = files[files.length - 1]
  const cursor = last && files.length === options.limit
    ? encodeCursor(options.sort, cursorValue(options.sort, last), last.id)
    : null
  const total = await countRows(db, fileWhere)
  return { folders, files, cursor, total, foldersTruncated }
}

/** Trash is one flat page; the route splits it into the folder and file groups it presents. */
export async function listTrash(
  db: D1Database,
  userId: string,
  mountId: string,
  options: { cursor?: string; limit: number },
): Promise<{ folders: CloudDriveFileRow[]; files: CloudDriveFileRow[]; cursor: string | null; total: number | null }> {
  const clauses = [
    'f.user_id = ?',
    'f.mount_id = ?',
    'f.deleted_at IS NOT NULL',
    "f.name_folded <> '.keep'",
  ]
  const params: unknown[] = [userId, mountId]
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor, 'uploaded')
    const deletedAt = requireNumber(decoded.v)
    clauses.push('(f.deleted_at < ? OR (f.deleted_at = ? AND f.id < ?))')
    params.push(deletedAt, deletedAt, decoded.id)
  }
  const where = clauses.join(' AND ')
  const { results } = await db.prepare(
    `SELECT f.* FROM CloudDrive_files f
      WHERE ${where}
      ORDER BY f.deleted_at DESC, f.id DESC
      LIMIT ?`,
  ).bind(...params, options.limit).all<CloudDriveFileRow>()
  const rows = results ?? []
  const last = rows[rows.length - 1]
  const cursor = last && rows.length === options.limit
    ? encodeCursor('uploaded', last.deleted_at ?? 0, last.id)
    : null
  const count = await db.prepare(
    `SELECT COUNT(*) AS count FROM CloudDrive_files f
      WHERE f.user_id = ? AND f.mount_id = ? AND f.deleted_at IS NOT NULL`,
  ).bind(userId, mountId).first<{ count: number }>()
  const total = (count?.count ?? 0) > LIST_TOTAL_CAP ? null : count?.count ?? 0
  return {
    folders: rows.filter((row) => row.kind === 'folder'),
    files: rows.filter((row) => row.kind === 'file'),
    cursor,
    total,
  }
}

async function liveSibling(
  db: D1Database,
  userId: string,
  mountId: string,
  parentId: string,
  nameFolded: string,
  excludeId?: string,
): Promise<CloudDriveFileRow | null> {
  const exclude = excludeId ? ' AND id <> ?' : ''
  const params: unknown[] = [userId, mountId, parentId, nameFolded]
  if (excludeId) params.push(excludeId)
  return await db.prepare(
    `SELECT * FROM CloudDrive_files
      WHERE user_id = ? AND mount_id = ? AND parent_id = ? AND name_folded = ?
        AND deleted_at IS NULL${exclude}
      LIMIT 1`,
  ).bind(...params).first<CloudDriveFileRow>()
}

/** `name`, then `name (1)`, … and a random tail after a hundred attempts. */
async function availableName(
  db: D1Database,
  userId: string,
  mountId: string,
  parentId: string,
  name: string,
  excludeId?: string,
): Promise<string> {
  for (let attempt = 0; attempt <= 100; attempt++) {
    const candidate = attempt === 0 ? name : autoSuffixName(name, attempt)
    if (!await liveSibling(db, userId, mountId, parentId, foldName(candidate), excludeId)) return candidate
  }
  const dot = name.lastIndexOf('.')
  const base = dot <= 0 ? name : name.slice(0, dot)
  const extension = dot <= 0 ? '' : name.slice(dot)
  return `${base} (${newId().slice(-4)})${extension}`
}

async function liveAtPath(
  db: D1Database,
  userId: string,
  mountId: string,
  path: string,
  excludeId?: string,
): Promise<CloudDriveFileRow | null> {
  const exclude = excludeId ? ' AND id <> ?' : ''
  const params: unknown[] = [userId, mountId, path]
  if (excludeId) params.push(excludeId)
  return await db.prepare(
    `SELECT * FROM CloudDrive_files
      WHERE user_id = ? AND mount_id = ? AND path = ? AND deleted_at IS NULL${exclude}
      LIMIT 1`,
  ).bind(...params).first<CloudDriveFileRow>()
}

/** Look a row up by id alone; the route then resolves its mount for the entry view. */
export async function getFileById(
  db: D1Database,
  userId: string,
  id: string,
  options: { includeTrash?: boolean } = {},
): Promise<CloudDriveFileRow | null> {
  const sql = options.includeTrash
    ? `SELECT * FROM CloudDrive_files WHERE user_id = ? AND id = ?`
    : `SELECT * FROM CloudDrive_files WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
  return await db.prepare(sql).bind(userId, id).first<CloudDriveFileRow>()
}

export interface CreateFolderResult {
  entry?: CloudDriveFileRow
  conflict?: string
}

export async function createFolder(
  db: D1Database,
  userId: string,
  mountId: string,
  parent: CloudDriveFileRow,
  name: string,
  now: number,
): Promise<CreateFolderResult> {
  const nameFolded = foldName(name)
  if (await liveSibling(db, userId, mountId, parent.id, nameFolded)) {
    return { conflict: await availableName(db, userId, mountId, parent.id, name) }
  }
  const id = newId()
  const path = parent.path === '/' ? `/${name}` : `${parent.path}/${name}`
  try {
    await db.prepare(
      `INSERT INTO CloudDrive_files
         (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
          category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
          starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
       VALUES (?, ?, ?, ?, 'folder', ?, ?, ?, ?, 'other', 'application/octet-stream', 0,
               NULL, NULL, 'r2', NULL, '{}', '', NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    ).bind(id, userId, mountId, parent.id, name, nameFolded, initialsOf(name), path, now, now, now, now).run()
  } catch (error) {
    if (String(error).includes('UNIQUE')) {
      return { conflict: await availableName(db, userId, mountId, parent.id, name) }
    }
    throw error
  }
  return { entry: await getRowById(db, userId, mountId, id) ?? undefined }
}

async function getRowById(
  db: D1Database,
  userId: string,
  mountId: string,
  id: string,
): Promise<CloudDriveFileRow | null> {
  return await db.prepare(
    `SELECT * FROM CloudDrive_files WHERE user_id = ? AND mount_id = ? AND id = ?`,
  ).bind(userId, mountId, id).first<CloudDriveFileRow>()
}

async function descendantCount(
  db: D1Database,
  userId: string,
  mountId: string,
  path: string,
): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM CloudDrive_files
      WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL
        AND substr(path, 1, length(?) + 1) = ? || '/'`,
  ).bind(userId, mountId, path, path).first<{ count: number }>()
  return row?.count ?? 0
}

function descendantPathUpdate(
  db: D1Database,
  userId: string,
  mountId: string,
  oldPath: string,
  newPath: string,
  now: number,
): D1PreparedStatement {
  // `substr` rather than `LIKE`: a folder named `100%` must not match `100x`.
  return db.prepare(
    `UPDATE CloudDrive_files
        SET path = ? || substr(path, length(?) + 1), updated_at = ?
      WHERE user_id = ? AND mount_id = ?
        AND substr(path, 1, length(?) + 1) = ? || '/'`,
  ).bind(newPath, oldPath, now, userId, mountId, oldPath, oldPath)
}

export interface RenameResult {
  entry?: CloudDriveFileRow
  conflict?: string
  tooLarge?: boolean
}

export async function renameEntry(
  db: D1Database,
  userId: string,
  mountId: string,
  row: CloudDriveFileRow,
  name: string,
  now: number,
): Promise<RenameResult> {
  if (name === row.name) return { entry: row }
  if (await liveSibling(db, userId, mountId, row.parent_id, foldName(name), row.id)) {
    return { conflict: await availableName(db, userId, mountId, row.parent_id, name, row.id) }
  }

  const parentPath = parentPathOfEntry(row.path)
  const nextPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`
  const statements: D1PreparedStatement[] = []
  if (row.kind === 'folder') {
    const descendants = await descendantCount(db, userId, mountId, row.path)
    if (descendants > MAX_DESCENDANTS) return { tooLarge: true }
    if (descendants > 0) statements.push(descendantPathUpdate(db, userId, mountId, row.path, nextPath, now))
  }
  statements.push(db.prepare(
    `UPDATE CloudDrive_files
        SET name = ?, name_folded = ?, name_initials = ?, path = ?, updated_at = ?
      WHERE user_id = ? AND mount_id = ? AND id = ?`,
  ).bind(name, foldName(name), initialsOf(name), nextPath, now, userId, mountId, row.id))
  await db.batch(statements)
  return { entry: await getRowById(db, userId, mountId, row.id) ?? undefined }
}

export interface EntryFlags {
  starred?: boolean
  color?: string | null
  metadata?: Record<string, unknown>
}

export async function setEntryFlags(
  db: D1Database,
  userId: string,
  mountId: string,
  row: CloudDriveFileRow,
  flags: EntryFlags,
  now: number,
): Promise<CloudDriveFileRow> {
  const sets: string[] = []
  const params: unknown[] = []
  if (flags.starred !== undefined) {
    sets.push('starred_at = ?')
    params.push(flags.starred ? now : null)
  }
  if (flags.color !== undefined) {
    sets.push('color = ?')
    // `null` and the empty string both mean "no colour"; the route has already validated the rest.
    params.push(flags.color ? (organizerColorOrNull(flags.color) ?? '') : '')
  }
  if (flags.metadata !== undefined) {
    sets.push('metadata = ?')
    params.push(JSON.stringify(flags.metadata))
  }
  if (sets.length === 0) return row
  sets.push('updated_at = ?')
  params.push(now)
  await db.prepare(
    `UPDATE CloudDrive_files SET ${sets.join(', ')}
      WHERE user_id = ? AND mount_id = ? AND id = ?`,
  ).bind(...params, userId, mountId, row.id).run()
  return await getRowById(db, userId, mountId, row.id) ?? row
}

async function liveIdsByPrefix(
  db: D1Database,
  userId: string,
  mountId: string,
  root: CloudDriveFileRow,
): Promise<string[]> {
  if (root.kind === 'file') return [root.id]
  const { results } = await db.prepare(
    `SELECT id FROM CloudDrive_files
      WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL
        AND (id = ? OR substr(path, 1, length(?) + 1) = ? || '/')`,
  ).bind(userId, mountId, root.id, root.path, root.path).all<{ id: string }>()
  return (results ?? []).map((row) => row.id)
}

async function rowsByIds(
  db: D1Database,
  userId: string,
  mountId: string,
  ids: readonly string[],
): Promise<CloudDriveFileRow[]> {
  const rows: CloudDriveFileRow[] = []
  for (let offset = 0; offset < ids.length; offset += CHUNK) {
    const chunk = ids.slice(offset, offset + CHUNK)
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(', ')
    const { results } = await db.prepare(
      `SELECT * FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND id IN (${placeholders})`,
    ).bind(userId, mountId, ...chunk).all<CloudDriveFileRow>()
    rows.push(...(results ?? []))
  }
  return rows
}

function chunkStatements(
  ids: readonly string[],
  build: (placeholders: string, chunk: string[]) => D1PreparedStatement,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  for (let offset = 0; offset < ids.length; offset += CHUNK) {
    const chunk = ids.slice(offset, offset + CHUNK)
    if (chunk.length === 0) continue
    statements.push(build(chunk.map(() => '?').join(', '), chunk))
  }
  return statements
}

/** Move the requested roots and their subtrees to the trash under one batch id. */
export async function trashEntries(
  db: D1Database,
  userId: string,
  mountId: string,
  ids: readonly string[],
  now: number,
): Promise<number> {
  const roots = (await rowsByIds(db, userId, mountId, ids)).filter((row) => row.deleted_at === null)
  if (roots.length === 0) return 0
  const batch = newId()
  const trashIds = new Set<string>()
  for (const root of roots) {
    for (const id of await liveIdsByPrefix(db, userId, mountId, root)) trashIds.add(id)
  }
  const all = [...trashIds]

  const fileStatements = chunkStatements(all, (placeholders, chunk) => db.prepare(
    `UPDATE CloudDrive_files
        SET deleted_at = ?, trash_batch = ?, updated_at = ?
      WHERE user_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`,
  ).bind(now, batch, now, userId, ...chunk))
  // A share points at a live target; once that target is in the trash the public face must not
  // resolve it, so every affected id (including descendants) revokes its shares in the same batch.
  const shareStatements = chunkStatements(all, (placeholders, chunk) => db.prepare(
    `UPDATE CloudDrive_shares SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL AND file_id IN (${placeholders})`,
  ).bind(now, userId, ...chunk))
  if (fileStatements.length === 0) return 0
  const results = await db.batch([...fileStatements, ...shareStatements])
  let changed = 0
  for (let index = 0; index < fileStatements.length; index++) {
    changed += Number((results[index]?.meta as { changes?: number } | undefined)?.changes ?? 0)
  }
  return changed
}

async function chooseRestorePath(
  db: D1Database,
  userId: string,
  mountId: string,
  row: CloudDriveFileRow,
): Promise<{ name: string; path: string } | null> {
  const parentPath = parentPathOfEntry(row.path)
  if (!await liveAtPath(db, userId, mountId, row.path, row.id)) {
    return { name: row.name, path: row.path }
  }
  const first = restoredName(row.name)
  const firstPath = parentPath === '/' ? `/${first}` : `${parentPath}/${first}`
  if (!await liveAtPath(db, userId, mountId, firstPath, row.id)) {
    return { name: first, path: firstPath }
  }
  for (let attempt = 1; attempt <= 100; attempt++) {
    const candidate = autoSuffixName(first, attempt)
    const candidatePath = parentPath === '/' ? `/${candidate}` : `${parentPath}/${candidate}`
    if (!await liveAtPath(db, userId, mountId, candidatePath, row.id)) {
      return { name: candidate, path: candidatePath }
    }
  }
  return null
}

async function restoreRow(
  db: D1Database,
  userId: string,
  mountId: string,
  row: CloudDriveFileRow,
  now: number,
): Promise<CloudDriveFileRow> {
  const chosen = await chooseRestorePath(db, userId, mountId, row)
  if (!chosen) throw ApiError.conflict('A name could not be found for the restored entry')
  const statements: D1PreparedStatement[] = []
  if (row.kind === 'folder' && chosen.path !== row.path) {
    statements.push(descendantPathUpdate(db, userId, mountId, row.path, chosen.path, now))
  }
  statements.push(db.prepare(
    `UPDATE CloudDrive_files
        SET name = ?, name_folded = ?, name_initials = ?, path = ?,
            deleted_at = NULL, trash_batch = NULL, updated_at = ?
      WHERE user_id = ? AND mount_id = ? AND id = ?`,
  ).bind(
    chosen.name, foldName(chosen.name), initialsOf(chosen.name), chosen.path, now,
    userId, mountId, row.id,
  ))
  await db.batch(statements)
  return await getRowById(db, userId, mountId, row.id) ?? row
}

export interface RestoreResult {
  id: string
  ok: boolean
  entry?: CloudDriveFileRow
  error?: string
}

/** Restore each row after its trashed ancestors, renaming on a path conflict. */
export async function restoreEntries(
  db: D1Database,
  userId: string,
  mountId: string,
  ids: readonly string[],
  now: number,
): Promise<RestoreResult[]> {
  const results: RestoreResult[] = []
  for (const id of ids) {
    const row = await getRowById(db, userId, mountId, id)
    if (!row || row.deleted_at === null) {
      results.push({ id, ok: false, error: 'not_found' })
      continue
    }
    const chain: string[] = []
    let cursor: CloudDriveFileRow | null = row
    for (let depth = 0; cursor && depth <= CLOUDDRIVE_LIMITS.depthMax; depth++) {
      if (cursor.deleted_at !== null) chain.push(cursor.id)
      if (!cursor.parent_id) break
      const parent: CloudDriveFileRow | null = await getRowById(db, userId, mountId, cursor.parent_id)
      if (!parent || parent.deleted_at === null) break
      cursor = parent
    }
    try {
      for (const ancestorId of chain.reverse()) {
        const ancestor = await getRowById(db, userId, mountId, ancestorId)
        if (ancestor && ancestor.deleted_at !== null) await restoreRow(db, userId, mountId, ancestor, now)
      }
      const restored = await getRowById(db, userId, mountId, id)
      results.push(restored
        ? { id, ok: true, entry: restored }
        : { id, ok: false, error: 'not_found' })
    } catch (error) {
      if (error instanceof ApiError) {
        results.push({ id, ok: false, error: error.code })
      } else {
        throw error
      }
    }
  }
  return results
}

interface PurgeTarget {
  id: string
  storage_key: string | null
}

async function purgeTargets(
  db: D1Database,
  userId: string,
  mountId: string | null,
  roots: readonly CloudDriveFileRow[],
): Promise<PurgeTarget[]> {
  const targets = new Map<string, PurgeTarget>()
  for (const root of roots) {
    const params: unknown[] = [userId]
    let sql = `SELECT id, storage_key FROM CloudDrive_files
                WHERE user_id = ? AND deleted_at IS NOT NULL`
    if (mountId) {
      sql += ' AND mount_id = ?'
      params.push(mountId)
    }
    if (root.kind === 'folder') {
      sql += " AND (id = ? OR substr(path, 1, length(?) + 1) = ? || '/')"
      params.push(root.id, root.path, root.path)
    } else {
      sql += ' AND id = ?'
      params.push(root.id)
    }
    const { results } = await db.prepare(sql).bind(...params).all<PurgeTarget>()
    for (const target of results ?? []) targets.set(target.id, target)
  }
  return [...targets.values()]
}

export async function storageKeyReferenced(db: D1Database, userId: string, key: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM CloudDrive_files WHERE user_id = ?1 AND storage_key = ?2)
          + (SELECT COUNT(*) FROM CloudDrive_file_versions WHERE user_id = ?1 AND storage_key = ?2) AS count`,
  ).bind(userId, key).first<{ count: number }>()
  return (row?.count ?? 0) > 0
}

async function purgeRows(
  db: D1Database,
  userId: string,
  targets: readonly PurgeTarget[],
  env: Env,
): Promise<{ deleted: number; failed: number }> {
  if (targets.length === 0) return { deleted: 0, failed: 0 }
  const ids = targets.map((target) => target.id)
  let failed = await deleteFileParts(db, env, userId, ids)

  const versionKeys: string[] = []
  for (let offset = 0; offset < ids.length; offset += 90) {
    const chunk = ids.slice(offset, offset + 90)
    const placeholders = chunk.map(() => '?').join(', ')
    const versions = await db.prepare(
      `SELECT storage_key FROM CloudDrive_file_versions WHERE user_id = ? AND file_id IN (${placeholders})`,
    ).bind(userId, ...chunk).all<{ storage_key: string }>()
    for (const version of versions.results ?? []) versionKeys.push(version.storage_key)
  }
  const tagStatements = chunkStatements(ids, (placeholders, chunk) => db.prepare(
    `DELETE FROM CloudDrive_file_tags WHERE user_id = ? AND file_id IN (${placeholders})`,
  ).bind(userId, ...chunk))
  const versionStatements = chunkStatements(ids, (placeholders, chunk) => db.prepare(
    `DELETE FROM CloudDrive_file_versions WHERE user_id = ? AND file_id IN (${placeholders})`,
  ).bind(userId, ...chunk))
  const rowStatements = chunkStatements(ids, (placeholders, chunk) => db.prepare(
    `DELETE FROM CloudDrive_files WHERE user_id = ? AND id IN (${placeholders})`,
  ).bind(userId, ...chunk))
  await db.batch([...tagStatements, ...versionStatements, ...rowStatements])

  const keys = [...new Set([
    ...targets.map((target) => target.storage_key),
    ...versionKeys,
  ].filter((key): key is string => !!key))]
  for (const key of keys) {
    if (await storageKeyReferenced(db, userId, key)) continue
    if (!env.FILES) continue
    try {
      await env.FILES.delete(key)
    } catch (error) {
      // The row is already gone, so the object is now an orphan rather than a failed delete of a
      // referenced object. Report it in `failed` instead of pretending the purge completed.
      console.warn('[clouddrive] purging an R2 object failed:', key, error)
      failed++
    }
  }
  return { deleted: ids.length, failed }
}

export async function purgeTrashEntries(
  db: D1Database,
  userId: string,
  mountId: string,
  ids: readonly string[],
  env: Env,
): Promise<{ deleted: number; failed: number }> {
  const rows = await rowsByIds(db, userId, mountId, ids)
  const trashed = rows.filter((row) => row.deleted_at !== null)
  const targets = await purgeTargets(db, userId, mountId, trashed)
  const result = await purgeRows(db, userId, targets, env)
  return { deleted: result.deleted, failed: result.failed + (ids.length - trashed.length) }
}

export async function purgeAllTrash(
  db: D1Database,
  userId: string,
  env: Env,
): Promise<{ deleted: number; failed: number }> {
  const { results } = await db.prepare(
    `SELECT * FROM CloudDrive_files WHERE user_id = ? AND deleted_at IS NOT NULL`,
  ).bind(userId).all<CloudDriveFileRow>()
  const roots = results ?? []
  const targets = await purgeTargets(db, userId, null, roots)
  return await purgeRows(db, userId, targets, env)
}

export interface TransferConflict {
  mode: 'rename' | 'overwrite' | 'skip'
}

export interface TransferResult {
  id: string
  ok: boolean
  error?: string
  toPath?: string
}

function parentPathOfEntry(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

async function resolveConflict(
  db: D1Database,
  userId: string,
  mountId: string,
  targetParent: CloudDriveFileRow,
  row: CloudDriveFileRow,
  existing: CloudDriveFileRow,
  conflict: TransferConflict,
  now: number,
): Promise<{ name: string } | { skipped: true }> {
  if (conflict.mode === 'skip') return { skipped: true }
  if (conflict.mode === 'overwrite') {
    await trashEntries(db, userId, mountId, [existing.id], now)
    return { name: row.name }
  }
  // The conflicting row is live, so the first `name (1)` candidate is the first free one.
  return { name: await availableName(db, userId, mountId, targetParent.id, row.name) }
}

export async function moveEntries(
  db: D1Database,
  userId: string,
  mountId: string,
  ids: readonly string[],
  targetParent: CloudDriveFileRow,
  conflict: TransferConflict,
  now: number,
): Promise<TransferResult[]> {
  const results: TransferResult[] = []
  for (const id of ids) {
    const row = await getRowById(db, userId, mountId, id)
    if (!row || row.deleted_at !== null) {
      results.push({ id, ok: false, error: 'not_found' })
      continue
    }
    if (row.id === targetParent.id
      || (row.kind === 'folder' && (targetParent.path === row.path || targetParent.path.startsWith(`${row.path}/`)))) {
      throw ApiError.badRequest('A folder cannot be moved into itself')
    }
    if (row.parent_id === targetParent.id) {
      results.push({ id, ok: true, toPath: row.path })
      continue
    }

    let name = row.name
    const existing = await liveSibling(db, userId, mountId, targetParent.id, row.name_folded, row.id)
    if (existing) {
      const resolved = await resolveConflict(db, userId, mountId, targetParent, row, existing, conflict, now)
      if ('skipped' in resolved) {
        results.push({ id, ok: false, error: 'conflict' })
        continue
      }
      name = resolved.name
    }

    const nextPath = targetParent.path === '/' ? `/${name}` : `${targetParent.path}/${name}`
    const statements: D1PreparedStatement[] = []
    if (row.kind === 'folder') {
      const descendants = await descendantCount(db, userId, mountId, row.path)
      if (descendants > MAX_DESCENDANTS) throw ApiError.tooLarge('The folder is too large to move synchronously')
      statements.push(descendantPathUpdate(db, userId, mountId, row.path, nextPath, now))
    }
    statements.push(db.prepare(
      `UPDATE CloudDrive_files
          SET parent_id = ?, name = ?, name_folded = ?, name_initials = ?, path = ?, updated_at = ?
        WHERE user_id = ? AND mount_id = ? AND id = ?`,
    ).bind(targetParent.id, name, foldName(name), initialsOf(name), nextPath, now, userId, mountId, row.id))
    await db.batch(statements)
    results.push({ id, ok: true, toPath: nextPath })
  }
  return results
}

interface CopyRow {
  source: CloudDriveFileRow
  id: string
  parentId: string
  name: string
  path: string
}

export async function copyEntries(
  db: D1Database,
  userId: string,
  mountId: string,
  ids: readonly string[],
  targetParent: CloudDriveFileRow,
  conflict: TransferConflict,
  now: number,
): Promise<TransferResult[]> {
  const results: TransferResult[] = []
  for (const id of ids) {
    const source = await getRowById(db, userId, mountId, id)
    if (!source || source.deleted_at !== null) {
      results.push({ id, ok: false, error: 'not_found' })
      continue
    }
    if (source.id === targetParent.id
      || (source.kind === 'folder' && (targetParent.path === source.path || targetParent.path.startsWith(`${source.path}/`)))) {
      throw ApiError.badRequest('A folder cannot be copied into itself')
    }

    let name = source.name
    const existing = await liveSibling(db, userId, mountId, targetParent.id, source.name_folded)
    if (existing) {
      const resolved = await resolveConflict(db, userId, mountId, targetParent, source, existing, conflict, now)
      if ('skipped' in resolved) {
        results.push({ id, ok: false, error: 'conflict' })
        continue
      }
      name = resolved.name
    }
    const rootPath = targetParent.path === '/' ? `/${name}` : `${targetParent.path}/${name}`

    const sources: CloudDriveFileRow[] = [source]
    if (source.kind === 'folder') {
      const { results: descendants } = await db.prepare(
        `SELECT * FROM CloudDrive_files
          WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL
            AND substr(path, 1, length(?) + 1) = ? || '/'
          ORDER BY length(path), path`,
      ).bind(userId, mountId, source.path, source.path).all<CloudDriveFileRow>()
      sources.push(...(descendants ?? []))
    }
    if (sources.length > MAX_DESCENDANTS + 1) {
      throw ApiError.tooLarge('The folder is too large to copy synchronously')
    }
    if (sources.some((row) => row.storage_kind === 'distributed')) {
      results.push({ id, ok: false, error: 'not_supported' })
      continue
    }

    const idMap = new Map<string, string>([[source.id, newId()]])
    const copies: CopyRow[] = [{
      source,
      id: idMap.get(source.id)!,
      parentId: targetParent.id,
      name,
      path: rootPath,
    }]
    for (const child of sources.slice(1)) {
      const newIdForChild = newId()
      idMap.set(child.id, newIdForChild)
      copies.push({
        source: child,
        id: newIdForChild,
        parentId: idMap.get(child.parent_id) ?? targetParent.id,
        name: child.name,
        path: `${rootPath}${child.path.slice(source.path.length)}`,
      })
    }

    const statements = copies.map((copy) => db.prepare(
      `INSERT INTO CloudDrive_files
         (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
          category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
          starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    ).bind(
      copy.id, userId, mountId, copy.parentId, copy.source.kind, copy.name,
      foldName(copy.name), initialsOf(copy.name), copy.path,
      copy.source.category, copy.source.mime, copy.source.size, copy.source.etag,
      copy.source.checksum, copy.source.storage_kind,
      // A copy shares the object with its source; only the last row reference may delete it.
      copy.source.storage_key, copy.source.metadata, copy.source.color,
      now, now, now, copy.source.modified_at,
    ))
    await db.batch(statements)
    results.push({ id, ok: true, toPath: rootPath })
  }
  return results
}

export interface SearchOptions {
  q: string
  type?: string
  starred?: boolean
  from?: number | null
  to?: number | null
  cursor?: string
  limit: number
}

export interface SearchResult {
  files: CloudDriveFileRow[]
  cursor: string | null
  total: number | null
}

/** Name match plus pinyin initials; prefix hits sort before interior ones. */
export async function searchEntries(
  db: D1Database,
  userId: string,
  mountId: string,
  options: SearchOptions,
): Promise<SearchResult> {
  const query = normalizedQuery(options.q)
  const clauses = [
    'f.user_id = ?',
    'f.mount_id = ?',
    'f.deleted_at IS NULL',
    "f.name_folded <> '.keep'",
    "(f.name_folded LIKE ? ESCAPE '\\' OR f.name_initials LIKE ? ESCAPE '\\')",
  ]
  const params: unknown[] = [
    userId,
    mountId,
    `%${escapeLike(query)}%`,
    `${escapeLike(query)}%`,
  ]
  const type = typeFilter(options.type)
  if (type) {
    clauses.push('f.category = ?')
    params.push(type)
  }
  if (options.starred) clauses.push('f.starred_at IS NOT NULL')
  if (options.from !== null && options.from !== undefined) {
    clauses.push('f.uploaded_at >= ?')
    params.push(options.from)
  }
  if (options.to !== null && options.to !== undefined) {
    clauses.push('f.uploaded_at <= ?')
    params.push(options.to)
  }
  const baseSql = clauses.join(' AND ')

  let cursorClause = ''
  const cursorParams: unknown[] = []
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor, 'name')
    const encoded = requireString(decoded.v)
    const separator = encoded.indexOf('\u0000')
    if (separator < 0) throw ApiError.badRequest('The cursor is invalid')
    const rank = Number(encoded.slice(0, separator))
    const name = encoded.slice(separator + 1)
    if (!Number.isFinite(rank)) throw ApiError.badRequest('The cursor is invalid')
    cursorClause = ` AND (
      (CASE WHEN f.name_folded LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END) > ?
      OR ((CASE WHEN f.name_folded LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END) = ?
        AND (f.name_folded > ? OR (f.name_folded = ? AND f.id > ?))))`
    const prefix = `${escapeLike(query)}%`
    cursorParams.push(prefix, rank, prefix, rank, name, name, decoded.id)
  }

  const { results } = await db.prepare(
    `SELECT f.* FROM CloudDrive_files f
      WHERE ${baseSql}${cursorClause}
      ORDER BY (CASE WHEN f.name_folded LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END) ASC,
               f.name_folded ASC, f.id ASC
      LIMIT ?`,
  ).bind(...params, ...cursorParams, `${escapeLike(query)}%`, options.limit).all<CloudDriveFileRow>()
  const files = results ?? []
  const last = files[files.length - 1]
  let cursor: string | null = null
  if (last && files.length === options.limit) {
    const prefix = last.name_folded.startsWith(query) ? 0 : 1
    cursor = encodeCursor('name', `${prefix}\u0000${last.name_folded}`, last.id)
  }
  const count = await db.prepare(
    `SELECT COUNT(*) AS count FROM CloudDrive_files f WHERE ${baseSql}`,
  ).bind(...params).first<{ count: number }>()
  const total = (count?.count ?? 0) > LIST_TOTAL_CAP ? null : count?.count ?? 0
  return { files, cursor, total }
}

export async function recentEntries(
  db: D1Database,
  userId: string,
  mountId: string,
  kind: 'viewed' | 'uploaded',
  options: { cursor?: string; limit: number },
): Promise<{ files: CloudDriveFileRow[]; cursor: string | null }> {
  const column = kind === 'viewed' ? 'last_viewed_at' : 'uploaded_at'
  const clauses = [
    'f.user_id = ?',
    'f.mount_id = ?',
    'f.deleted_at IS NULL',
    "f.name_folded <> '.keep'",
    `f.${column} IS NOT NULL`,
  ]
  const params: unknown[] = [userId, mountId]
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor, 'uploaded')
    const value = requireNumber(decoded.v)
    clauses.push(`(f.${column} < ? OR (f.${column} = ? AND f.id < ?))`)
    params.push(value, value, decoded.id)
  }
  const { results } = await db.prepare(
    `SELECT f.* FROM CloudDrive_files f
      WHERE ${clauses.join(' AND ')}
      ORDER BY f.${column} DESC, f.id DESC
      LIMIT ?`,
  ).bind(...params, options.limit).all<CloudDriveFileRow>()
  const files = results ?? []
  const last = files[files.length - 1]
  const cursor = last && files.length === options.limit
    ? encodeCursor('uploaded', kind === 'viewed' ? last.last_viewed_at ?? 0 : last.uploaded_at, last.id)
    : null
  return { files, cursor }
}

export interface AlbumGroup {
  month: string
  files: CloudDriveFileRow[]
}

export async function albumEntries(
  db: D1Database,
  userId: string,
  mountId: string,
  options: { from?: number | null; to?: number | null; cursor?: string; limit: number },
): Promise<{ groups: AlbumGroup[]; cursor: string | null }> {
  const clauses = [
    'f.user_id = ?',
    'f.mount_id = ?',
    "f.kind = 'file'",
    "f.category = 'images'",
    'f.deleted_at IS NULL',
    "f.name_folded <> '.keep'",
  ]
  const params: unknown[] = [userId, mountId]
  if (options.from !== null && options.from !== undefined) {
    clauses.push('f.uploaded_at >= ?')
    params.push(options.from)
  }
  if (options.to !== null && options.to !== undefined) {
    clauses.push('f.uploaded_at <= ?')
    params.push(options.to)
  }
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor, 'uploaded')
    const value = requireNumber(decoded.v)
    clauses.push('(f.uploaded_at < ? OR (f.uploaded_at = ? AND f.id < ?))')
    params.push(value, value, decoded.id)
  }
  const { results } = await db.prepare(
    `SELECT f.* FROM CloudDrive_files f
      WHERE ${clauses.join(' AND ')}
      ORDER BY f.uploaded_at DESC, f.id DESC
      LIMIT ?`,
  ).bind(...params, options.limit).all<CloudDriveFileRow>()
  const files = results ?? []
  const groups: AlbumGroup[] = []
  for (const file of files) {
    const month = new Date(file.uploaded_at).toISOString().slice(0, 7)
    const last = groups[groups.length - 1]
    if (last && last.month === month) last.files.push(file)
    else groups.push({ month, files: [file] })
  }
  const lastFile = files[files.length - 1]
  const cursor = lastFile && files.length === options.limit
    ? encodeCursor('uploaded', lastFile.uploaded_at, lastFile.id)
    : null
  return { groups, cursor }
}

export async function listTags(
  db: D1Database,
  userId: string,
  mountId: string,
): Promise<{ name: string; color: string; count: number }[]> {
  const { results } = await db.prepare(
    `SELECT MAX(t.tag) AS name, MAX(t.color) AS color, COUNT(DISTINCT t.file_id) AS count
       FROM CloudDrive_file_tags t
       JOIN CloudDrive_files f ON f.user_id = t.user_id AND f.id = t.file_id
      WHERE t.user_id = ? AND f.mount_id = ? AND f.deleted_at IS NULL
      GROUP BY t.tag_folded
      ORDER BY count DESC, t.tag_folded ASC`,
  ).bind(userId, mountId).all<{ name: string; color: string; count: number }>()
  return (results ?? []).map((row) => ({ name: row.name, color: row.color, count: row.count }))
}

function normalizeTag(tag: string): { tag: string; tagFolded: string } {
  const trimmed = tag.normalize('NFC').trim()
  if (trimmed.length === 0 || trimmed.length > CLOUDDRIVE_LIMITS.tagMaxLength) {
    throw ApiError.badRequest(`A tag must contain 1 to ${CLOUDDRIVE_LIMITS.tagMaxLength} characters`)
  }
  if (/[\u0000-\u001f]/.test(trimmed)) throw ApiError.badRequest('A tag cannot contain a control character')
  return { tag: trimmed, tagFolded: foldedName(trimmed) }
}

export async function upsertTag(
  db: D1Database,
  userId: string,
  fileId: string,
  tag: string,
  color: string,
  now: number,
): Promise<void> {
  const normalized = normalizeTag(tag)
  const count = await db.prepare(
    `SELECT COUNT(*) AS count FROM CloudDrive_file_tags WHERE user_id = ? AND file_id = ?`,
  ).bind(userId, fileId).first<{ count: number }>()
  const existing = await db.prepare(
    `SELECT 1 AS present FROM CloudDrive_file_tags
      WHERE user_id = ? AND file_id = ? AND tag_folded = ?`,
  ).bind(userId, fileId, normalized.tagFolded).first<{ present: number }>()
  if (!existing && (count?.count ?? 0) >= CLOUDDRIVE_LIMITS.tagsPerFileMax) {
    throw ApiError.badRequest(`A file can have at most ${CLOUDDRIVE_LIMITS.tagsPerFileMax} tags`)
  }
  await db.prepare(
    `INSERT INTO CloudDrive_file_tags (user_id, file_id, tag, tag_folded, color, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, file_id, tag_folded)
     DO UPDATE SET tag = excluded.tag, color = excluded.color`,
  ).bind(userId, fileId, normalized.tag, normalized.tagFolded, color, now).run()
}

export async function removeTag(
  db: D1Database,
  userId: string,
  fileId: string,
  tag: string,
): Promise<void> {
  const normalized = normalizeTag(tag)
  await db.prepare(
    `DELETE FROM CloudDrive_file_tags WHERE user_id = ? AND file_id = ? AND tag_folded = ?`,
  ).bind(userId, fileId, normalized.tagFolded).run()
}

export async function tagsOf(
  db: D1Database,
  userId: string,
  fileId: string,
): Promise<CloudDriveTagView[]> {
  const { results } = await db.prepare(
    `SELECT tag, color FROM CloudDrive_file_tags
      WHERE user_id = ? AND file_id = ? ORDER BY created_at, tag_folded`,
  ).bind(userId, fileId).all<{ tag: string; color: string }>()
  return (results ?? []).map((row) => ({ name: row.tag, color: row.color }))
}
