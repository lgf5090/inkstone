/**
 * Public D1 entry for CloudDrive file mutations and lifecycle operations.
 *
 * Read-only listings live in `store-files-list`; tag assignments live in `store-files-tags`. They are
 * re-exported here so routes keep one stable module boundary without mixing unrelated SQL duties.
 */
import {
  CLOUDDRIVE_LIMITS,
  autoSuffixName,
  restoredName,
  type CloudDriveCategory,
} from '@shared/clouddrive/model'
import { organizerColorOrNull } from '@shared/organizer-colors'
import type { Env } from '../env'
import { deleteFileParts } from './distributed'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import {
  chunkedBatch,
  decodeCursor,
  encodeCursor,
  foldName,
  initialsOf,
  parseFolderMeta,
  type CloudDriveFileRow,
} from './lib'

export {
  albumEntries,
  folderSize,
  listFolder,
  recentEntries,
  searchAllMountEntries,
  searchEntries,
  type AlbumGroup,
  type AlbumKind,
  type ListOptions,
  type ListResult,
  type SearchOptions,
  type SearchResult,
} from './store-files-list'
export {
  countVisibleTags,
  listTagAssignments,
  removeTag,
  tagsOf,
  upsertTag,
  type CloudDriveTagAssignment,
} from './store-files-tags'

const MAX_DESCENDANTS = 5000
const LIST_TOTAL_CAP = 10_000
const CHUNK = 90

function requireNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw ApiError.badRequest('The cursor is invalid')
  return value
}

/**
 * The hiding rules each of these folders carries in its own `metadata` JSON. The metadata table keeps
 * the rules a mount-path view sets, the folder row keeps the ones the inspector sets, and a caller
 * that shows a list has to honour both — otherwise the same rule hides a file in one view and not
 * another.
 */
export async function folderHiddenPatterns(
  db: D1Database,
  userId: string,
  mountId: string,
  paths: readonly string[],
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  const unique = [...new Set(paths)]
  for (let offset = 0; offset < unique.length; offset += CHUNK) {
    const chunk = unique.slice(offset, offset + CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    const { results } = await db.prepare(
      `SELECT path, metadata FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND kind = 'folder' AND path IN (${placeholders})`,
    ).bind(userId, mountId, ...chunk).all<{ path: string; metadata: string }>()
    for (const row of results ?? []) {
      const patterns = parseFolderMeta(row.metadata).hiddenPatterns
      if (patterns.length > 0) found.set(row.path, patterns)
    }
  }
  return found
}

/**
 * Trash is one page of *deleted roots*: a folder that went to the trash with its contents is listed
 * once, with `descendant_trashed` saying there is more under it, because restoring the folder restores
 * them too. A child whose own parent is still live — the reader deleted one file out of a live folder —
 * is its own root and stays visible.
 */
export interface CloudDriveTrashRow extends CloudDriveFileRow {
  /** True when the folder holds more trashed items than the row itself; restoring it restores them. */
  descendantsTrashed: boolean
}

export async function listTrash(
  db: D1Database,
  userId: string,
  mountId: string,
  options: { cursor?: string; limit: number },
): Promise<{ folders: CloudDriveTrashRow[]; files: CloudDriveTrashRow[]; cursor: string | null; total: number | null }> {
  const clauses = [
    'f.user_id = ?',
    'f.mount_id = ?',
    'f.deleted_at IS NOT NULL',
    "f.name_folded <> '.keep'",
    `NOT EXISTS (
       SELECT 1 FROM CloudDrive_files p
        WHERE p.user_id = f.user_id AND p.id = f.parent_id AND p.deleted_at IS NOT NULL
     )`,
  ]
  const params: unknown[] = [userId, mountId]
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor, 'uploaded')
    const deletedAt = requireNumber(decoded.v)
    clauses.push('(f.deleted_at < ? OR (f.deleted_at = ? AND f.id < ?))')
    params.push(deletedAt, deletedAt, decoded.id)
  }
  const where = clauses.join(' AND ')
  const [pageQuery, countQuery] = await Promise.all([
    db.prepare(
      `SELECT f.*, EXISTS (
          SELECT 1 FROM CloudDrive_files d
           WHERE d.user_id = f.user_id AND d.mount_id = f.mount_id AND d.deleted_at IS NOT NULL
             AND f.kind = 'folder'
             AND substr(d.path, 1, length(f.path) + 1) = f.path || '/'
         ) AS descendant_trashed
          FROM CloudDrive_files f
         WHERE ${where}
         ORDER BY f.deleted_at DESC, f.id DESC
         LIMIT ?`,
    ).bind(...params, options.limit).all<CloudDriveFileRow & { descendant_trashed: number | bigint }>(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM CloudDrive_files f
        WHERE f.user_id = ? AND f.mount_id = ? AND f.deleted_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM CloudDrive_files p
             WHERE p.user_id = f.user_id AND p.id = f.parent_id AND p.deleted_at IS NOT NULL
          )`,
    ).bind(userId, mountId).first<{ count: number }>(),
  ])
  const rows: CloudDriveTrashRow[] = (pageQuery.results ?? []).map((row) => ({
    ...row,
    descendantsTrashed: Number(row.descendant_trashed) === 1,
  }))
  const last = rows[rows.length - 1]
  const cursor = last && rows.length === options.limit
    ? encodeCursor('uploaded', last.deleted_at ?? 0, last.id)
    : null
  const total = (countQuery?.count ?? 0) > LIST_TOTAL_CAP ? null : countQuery?.count ?? 0
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

export interface CreateEntryResult {
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
): Promise<CreateEntryResult> {
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

/**
 * The row for a file the drive created itself, once its (empty) object is already in the bucket. The
 * caller mints the id and writes the object under it, because the storage key names that id; a
 * rejected name reports a conflict instead of writing a second row, and `UNIQUE` does the same later.
 */
export async function createFile(
  db: D1Database,
  userId: string,
  mountId: string,
  parent: CloudDriveFileRow,
  name: string,
  data: { id: string; category: CloudDriveCategory; mime: string; storageKey: string; etag: string },
  now: number,
): Promise<CreateEntryResult> {
  const nameFolded = foldName(name)
  if (await liveSibling(db, userId, mountId, parent.id, nameFolded)) {
    return { conflict: await availableName(db, userId, mountId, parent.id, name) }
  }
  const path = parent.path === '/' ? `/${name}` : `${parent.path}/${name}`
  try {
    await db.prepare(
      `INSERT INTO CloudDrive_files
         (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
          category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
          starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
       VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, 0, ?, NULL, 'r2', ?, '{}', '', NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    ).bind(
      data.id, userId, mountId, parent.id, name, nameFolded, initialsOf(name), path,
      data.category, data.mime, data.etag, data.storageKey, now, now, now, now,
    ).run()
  } catch (error) {
    if (String(error).includes('UNIQUE')) {
      return { conflict: await availableName(db, userId, mountId, parent.id, name) }
    }
    throw error
  }
  return { entry: await getRowById(db, userId, mountId, data.id) ?? undefined }
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

/**
 * Move every path-scoped policy row with the entry that owns the path. These updates must travel in
 * the same D1 batch as `CloudDrive_files`: a committed file move with stale locks, request targets or
 * sync roots would silently change what those controls mean.
 * API key prefixes are global across mounts, so they are intentionally not migrated here.
 */
function dependentPathUpdates(
  db: D1Database,
  userId: string,
  mountId: string,
  oldPath: string,
  newPath: string,
  now: number,
  descendants: boolean,
): D1PreparedStatement[] {
  const next = (column: string) => `${column} = ?1 || substr(${column}, length(?2) + 1)`
  const scope = (column: string) => descendants
    ? `(${column} = ?3 OR substr(${column}, 1, length(?3) + 1) = ?3 || '/')`
    : `${column} = ?3`
  const common = [newPath, oldPath, oldPath, userId] as const
  return [
    db.prepare(
      `UPDATE CloudDrive_meta SET ${next('path')}, updated_at = ?6
        WHERE user_id = ?4 AND mount_id = ?5 AND ${scope('path')}`,
    ).bind(...common, mountId, now),
    db.prepare(
      `UPDATE CloudDrive_meta_unlocks SET ${next('path')}
        WHERE user_id = ?4 AND mount_id = ?5 AND ${scope('path')}`,
    ).bind(...common, mountId),
    db.prepare(
      `UPDATE CloudDrive_file_requests SET ${next('target_path')}
        WHERE user_id = ?4 AND target_mount = ?5 AND ${scope('target_path')}`,
    ).bind(...common, mountId),
    db.prepare(
      `UPDATE CloudDrive_sync_targets SET ${next('remote_path')}, updated_at = ?6
        WHERE user_id = ?4 AND mount_id = ?5 AND ${scope('remote_path')}`,
    ).bind(...common, mountId, now),
  ]
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
  statements.push(...dependentPathUpdates(db, userId, mountId, row.path, nextPath, now, row.kind === 'folder'))
  await db.batch(statements)
  return { entry: await getRowById(db, userId, mountId, row.id) ?? undefined }
}

export interface EntryFlags {
  starred?: boolean
  color?: string | null
  metadata?: Record<string, unknown>
}

/**
 * Record that a file was just opened. The recent-view page is ordered by this column, so a writer
 * it stays empty forever; only the read route knows a view actually happened.
 */
export async function markViewed(db: D1Database, userId: string, id: string, now: number): Promise<void> {
  await db.prepare(
    'UPDATE CloudDrive_files SET last_viewed_at = ?1 WHERE user_id = ?2 AND id = ?3 AND kind = ?4 AND deleted_at IS NULL',
  ).bind(now, userId, id, 'file').run()
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

export async function rowsByIds(
  db: D1Database,
  userId: string,
  mountId: string,
  ids: readonly string[],
): Promise<CloudDriveFileRow[]> {
  return await rowsByColumn(db, userId, mountId, ids, 'id')
}

/** The same lookup by virtual path, so a batch call hands over one query per chunk. */
export async function rowsByPaths(
  db: D1Database,
  userId: string,
  mountId: string,
  paths: readonly string[],
): Promise<CloudDriveFileRow[]> {
  return await rowsByColumn(db, userId, mountId, paths, 'path')
}

async function rowsByColumn(
  db: D1Database,
  userId: string,
  mountId: string,
  values: readonly string[],
  column: 'id' | 'path',
): Promise<CloudDriveFileRow[]> {
  const rows: CloudDriveFileRow[] = []
  for (let offset = 0; offset < values.length; offset += CHUNK) {
    const chunk = values.slice(offset, offset + CHUNK)
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(', ')
    const { results } = await db.prepare(
      `SELECT * FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND ${column} IN (${placeholders})`,
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
  if (row.kind === 'folder') {
    // The trash lists one root for a whole subtree, so restoring that root brings its contents back
    // with it. Paths have already been rewritten above, so the prefix is the restored one.
    statements.push(db.prepare(
      `UPDATE CloudDrive_files
          SET deleted_at = NULL, trash_batch = NULL, updated_at = ?
        WHERE user_id = ? AND mount_id = ? AND deleted_at IS NOT NULL AND id <> ?
          AND substr(path, 1, length(?) + 1) = ? || '/'`,
    ).bind(now, userId, mountId, row.id, chosen.path, chosen.path))
  }
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

/**
 * Whether any live row or stored version still points at an object.
 *
 * Deliberately not scoped to one account: a saved shared item is another user's row over the same
 * bytes, so a per-user check would let the owner's purge delete data the reader can still open.
 */
export async function storageKeyReferenced(db: D1Database, key: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM CloudDrive_files WHERE storage_key = ?1)
          + (SELECT COUNT(*) FROM CloudDrive_file_versions WHERE storage_key = ?1)
          + (SELECT COUNT(*) FROM CloudDrive_snapshot_items
              WHERE json_extract(payload, '$.file.storage_key') = ?1) AS count`,
  ).bind(key).first<{ count: number }>()
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
  // A purged file must stop authorising: an ACL grant or a share link that outlives its row is a ghost
  // that reads as a live permission to anything that joins on the id alone.
  const now = Date.now()
  const aclStatements = chunkStatements(ids, (placeholders, chunk) => db.prepare(
    `UPDATE CloudDrive_acl SET revoked_at = ?
      WHERE owner_id = ? AND revoked_at IS NULL AND file_id IN (${placeholders})`,
  ).bind(now, userId, ...chunk))
  const shareStatements = chunkStatements(ids, (placeholders, chunk) => db.prepare(
    `UPDATE CloudDrive_shares SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL AND file_id IN (${placeholders})`,
  ).bind(now, userId, ...chunk))
  await db.batch([...tagStatements, ...versionStatements, ...aclStatements, ...shareStatements, ...rowStatements])

  const keys = [...new Set([
    ...targets.map((target) => target.storage_key),
    ...versionKeys,
  ].filter((key): key is string => !!key))]
  for (const key of keys) {
    if (await storageKeyReferenced(db, key)) continue
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
  // Every trashed row is already a target, so one read of them beats expanding each root's subtree
  // and de-duplicating the same folders back out again.
  const { results } = await db.prepare(
    `SELECT id, storage_key FROM CloudDrive_files WHERE user_id = ? AND deleted_at IS NOT NULL`,
  ).bind(userId).all<PurgeTarget>()
  return await purgeRows(db, userId, results ?? [], env)
}

export interface TransferConflict {
  mode: 'rename' | 'overwrite' | 'skip'
}

export interface TransferResult {
  id: string
  ok: boolean
  error?: string
  toPath?: string
  /** A cross-mount move copied the row but could not trash the source; the caller can retry safely. */
  sourceRetained?: boolean
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

/** Keep only selected roots so a folder and one of its descendants are not transferred twice. */
async function selectedRootIds(
  db: D1Database,
  userId: string,
  mountId: string,
  ids: readonly string[],
): Promise<string[]> {
  const selected = await rowsByIds(db, userId, mountId, ids)
  const liveById = new Map(selected.filter((row) => row.deleted_at === null).map((row) => [row.id, row]))
  return ids.filter((id) => {
    if (!liveById.has(id)) return true
    let current = liveById.get(id)
    while (current?.parent_id) {
      if (liveById.has(current.parent_id)) return false
      current = liveById.get(current.parent_id)
    }
    return true
  })
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
  // A selection can contain a folder and one of its descendants. Moving both would tear the child
  // out of the folder after the folder's subtree had already moved; keep only the selected roots.
  const roots = await selectedRootIds(db, userId, mountId, ids)
  const results: TransferResult[] = []
  for (const id of roots) {
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
    statements.push(...dependentPathUpdates(db, userId, mountId, row.path, nextPath, now, row.kind === 'folder'))
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
  targetMountId: string = mountId,
): Promise<TransferResult[]> {
  const results: TransferResult[] = []
  const roots = await selectedRootIds(db, userId, mountId, ids)
  for (const id of roots) {
    const source = await getRowById(db, userId, mountId, id)
    if (!source || source.deleted_at !== null) {
      results.push({ id, ok: false, error: 'not_found' })
      continue
    }
    if (targetMountId === mountId && (source.id === targetParent.id
      || (source.kind === 'folder' && (targetParent.path === source.path || targetParent.path.startsWith(`${source.path}/`))))) {
      throw ApiError.badRequest('A folder cannot be copied into itself')
    }

    let name = source.name
    const existing = await liveSibling(db, userId, targetMountId, targetParent.id, source.name_folded)
    if (existing) {
      const resolved = await resolveConflict(db, userId, targetMountId, targetParent, source, existing, conflict, now)
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
    if (sources.some((row) => row.storage_kind !== 'r2')) {
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

    const fileStatements = copies.map((copy) => db.prepare(
      `INSERT INTO CloudDrive_files
         (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
          category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
          starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    ).bind(
      copy.id, userId, targetMountId, copy.parentId, copy.source.kind, copy.name,
      foldName(copy.name), initialsOf(copy.name), copy.path,
      copy.source.category, copy.source.mime, copy.source.size, copy.source.etag,
      copy.source.checksum, copy.source.storage_kind,
      // A copy shares the object with its source; only the last row reference may delete it.
      copy.source.storage_key, copy.source.metadata, copy.source.color,
      now, now, now, copy.source.modified_at,
    ))
    const policyStatements: D1PreparedStatement[] = []
    if (source.kind === 'folder') {
      // Folder policy is path-scoped rather than stored on the file row. Copy it with the tree so a
      // cross-mount copy cannot turn hidden or password-protected content into an open directory.
      const { results: metas } = await db.prepare(
        `SELECT * FROM CloudDrive_meta
          WHERE user_id = ? AND mount_id = ?
            AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')`,
      ).bind(userId, mountId, source.path, source.path, source.path).all<{
        path: string; header_md: string; footer_md: string; hide_patterns: string; password_hash: string
        inherit_header: number; inherit_footer: number; inherit_hide: number; inherit_password: number
        vault: number; created_at: number
      }>()
      // A renamed or overwritten destination may carry policy left by an older folder at the same
      // path. Remove that subtree's policy and unlocks before installing the source's current rules.
      const targetScope = `(path = ? OR substr(path, 1, length(?) + 1) = ? || '/')`
      policyStatements.push(
        db.prepare(`DELETE FROM CloudDrive_meta WHERE user_id = ? AND mount_id = ? AND ${targetScope}`)
          .bind(userId, targetMountId, rootPath, rootPath, rootPath),
        db.prepare(`DELETE FROM CloudDrive_meta_unlocks WHERE user_id = ? AND mount_id = ? AND ${targetScope}`)
          .bind(userId, targetMountId, rootPath, rootPath, rootPath),
        db.prepare(`DELETE FROM CloudDrive_vault_unlocks WHERE user_id = ? AND mount_id = ? AND ${targetScope}`)
          .bind(userId, targetMountId, rootPath, rootPath, rootPath),
      )
      for (const meta of metas ?? []) {
        policyStatements.push(db.prepare(
          `INSERT INTO CloudDrive_meta
             (user_id,mount_id,path,header_md,footer_md,hide_patterns,password_hash,
              inherit_header,inherit_footer,inherit_hide,inherit_password,vault,created_at,updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id,mount_id,path) DO UPDATE SET
             header_md = excluded.header_md, footer_md = excluded.footer_md,
             hide_patterns = excluded.hide_patterns, password_hash = excluded.password_hash,
             inherit_header = excluded.inherit_header, inherit_footer = excluded.inherit_footer,
             inherit_hide = excluded.inherit_hide, inherit_password = excluded.inherit_password,
             vault = excluded.vault, created_at = excluded.created_at, updated_at = excluded.updated_at`,
        ).bind(
          userId, targetMountId, `${rootPath}${meta.path.slice(source.path.length)}`,
          meta.header_md, meta.footer_md, meta.hide_patterns, meta.password_hash,
          meta.inherit_header, meta.inherit_footer, meta.inherit_hide, meta.inherit_password,
          meta.vault, meta.created_at, now,
        ))
      }
    }
    // Policies are written first: if a later file chunk fails, any partial copy is still hidden or
    // locked rather than briefly exposed without the source folder's access rules.
    const statements = [...policyStatements, ...fileStatements]
    try {
      await chunkedBatch(db, statements)
    } catch (error) {
      // A chunk that failed leaves the earlier chunks applied, so report it against this root instead
      // of failing the request and hiding which copy is half-done.
      console.warn('[clouddrive] copying an entry failed:', id, error)
      results.push({ id, ok: false, error: 'copy_failed' })
      continue
    }
    results.push({ id, ok: true, toPath: rootPath })
  }
  return results
}
