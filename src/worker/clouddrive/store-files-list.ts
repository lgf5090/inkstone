/** Read-only file listings: folder pages, search, recent feeds and albums. */
import {
  CLOUDDRIVE_CATEGORIES,
  CLOUDDRIVE_LIMITS,
  foldedName,
  type AlbumKind,
  type CloudDriveSortDirection,
  type CloudDriveSortKey,
} from '@shared/clouddrive/model'
import { ApiError } from '../lib/errors'
import { decodeCursor, encodeCursor, type CloudDriveFileRow } from './lib'

const LIST_TOTAL_CAP = 10_000

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

/** Conditions shared by the folder half, file half and count half of a listing. */
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

/** The SQL LIKE equivalent of the same folded `*`/`?` glob used by metadata visibility. */
export function hiddenPatternToLike(pattern: string): string {
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
  const fileWhere = buildWhere(userId, mountId, parentId, 'file', options)
  const conditions = [fileWhere.sql]
  const params = [...fileWhere.params]
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor, options.sort)
    const condition = cursorCondition(options.sort, options.dir, decoded.v, decoded.id)
    conditions.push(condition.sql)
    params.push(...condition.params)
  }

  // One round trip for the two halves of the listing and the total: none reads the others' rows.
  const [folderQuery, fileQuery, total] = await Promise.all([
    db.prepare(
      `SELECT f.* FROM CloudDrive_files f
        WHERE ${folderWhere.sql}
        ORDER BY ${orderBy(options.sort, options.dir)}
        LIMIT ${CLOUDDRIVE_LIMITS.folderListMax + 1}`,
    ).bind(...folderWhere.params).all<CloudDriveFileRow>(),
    db.prepare(
      `SELECT f.* FROM CloudDrive_files f
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderBy(options.sort, options.dir)}
        LIMIT ?`,
    ).bind(...params, options.limit).all<CloudDriveFileRow>(),
    countRows(db, fileWhere),
  ])

  const folderRows = folderQuery.results ?? []
  const folders = folderRows.slice(0, CLOUDDRIVE_LIMITS.folderListMax)
  const foldersTruncated = folderRows.length > CLOUDDRIVE_LIMITS.folderListMax
  const files = fileQuery.results ?? []
  const last = files[files.length - 1]
  const cursor = last && files.length === options.limit
    ? encodeCursor(options.sort, cursorValue(options.sort, last), last.id)
    : null
  return { folders, files, cursor, total, foldersTruncated }
}

export async function folderSize(db: D1Database, userId: string, mountId: string, folderId: string): Promise<number> {
  const row = await db.prepare(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM CloudDrive_files
        WHERE user_id = ?1 AND mount_id = ?2 AND parent_id = ?3 AND deleted_at IS NULL
       UNION ALL
       SELECT f.id FROM CloudDrive_files f
         JOIN tree t ON f.parent_id = t.id
        WHERE f.user_id = ?1 AND f.mount_id = ?2 AND f.deleted_at IS NULL
     )
     SELECT COALESCE(SUM(size), 0) AS bytes FROM CloudDrive_files
      WHERE user_id = ?1 AND mount_id = ?2 AND kind = 'file' AND deleted_at IS NULL
        AND id IN (SELECT id FROM tree)`,
  ).bind(userId, mountId, folderId).first<{ bytes: number }>()
  return Number(row?.bytes ?? 0)
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
  ]
  const params: unknown[] = [userId, mountId]
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
  const prefixSql = `${escapeLike(query)}%`
  const containsSql = `%${escapeLike(query)}%`

  // The cursor says which of the two arms it stopped in: rank 0 is the prefix arm, rank 1 the
  // contains arm. That is what lets a second page resume mid-list without a second full scan.
  let arm = 0
  let afterName = ''
  let afterId = ''
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor, 'name')
    const encoded = requireString(decoded.v)
    const separator = encoded.indexOf('\u0000')
    if (separator < 0) throw ApiError.badRequest('The cursor is invalid')
    const rank = Number(encoded.slice(0, separator))
    if (!Number.isFinite(rank)) throw ApiError.badRequest('The cursor is invalid')
    arm = rank === 0 ? 0 : 1
    afterName = encoded.slice(separator + 1)
    afterId = decoded.id
  }

  const files: CloudDriveFileRow[] = []
  const runArm = (sql: string, params: unknown[]) => db.prepare(sql).bind(...params).all<CloudDriveFileRow>()

  if (arm === 0) {
    const { results } = await runArm(
      `SELECT f.* FROM CloudDrive_files f
        WHERE ${baseSql} AND f.name_folded LIKE ? ESCAPE '\\'
          AND (? = '' OR f.name_folded > ? OR (f.name_folded = ? AND f.id > ?))
        ORDER BY f.name_folded ASC, f.id ASC
        LIMIT ?`,
      [...params, prefixSql, afterName, afterName, afterName, afterId, options.limit],
    )
    files.push(...(results ?? []))
  }
  if (files.length < options.limit) {
    const { results } = await runArm(
      `SELECT f.* FROM CloudDrive_files f
        WHERE ${baseSql}
          AND f.name_folded NOT LIKE ? ESCAPE '\\'
          AND (f.name_folded LIKE ? ESCAPE '\\' OR f.name_initials LIKE ? ESCAPE '\\')
          AND (? = '' OR f.name_folded > ? OR (f.name_folded = ? AND f.id > ?))
        ORDER BY f.name_folded ASC, f.id ASC
        LIMIT ?`,
      [
        ...params, prefixSql, containsSql, containsSql,
        arm === 1 ? afterName : '', arm === 1 ? afterName : '', arm === 1 ? afterName : '', arm === 1 ? afterId : '',
        options.limit - files.length,
      ],
    )
    files.push(...(results ?? []))
  }

  const last = files[files.length - 1]
  let cursor: string | null = null
  if (last && files.length === options.limit) {
    const rank = last.name_folded.startsWith(query) ? 0 : 1
    cursor = encodeCursor('name', `${rank}\u0000${last.name_folded}`, last.id)
  }
  // A short page is the whole answer; a full page honestly reports that the total is unknown.
  const total = files.length < options.limit ? files.length : null
  return { files, cursor, total }
}

/** Tokenize a user query as an FTS phrase; LIKE below still covers substrings and pinyin initials. */
function globalFtsQuery(value: string): string {
  const tokens = normalizedQuery(value).split(/\s+/).filter(Boolean).slice(0, 8)
  if (tokens.length === 0) return '""'
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ')
}

/** Search every enabled primary-R2 mount with FTS5 plus substring/initials fallbacks. */
export async function searchAllMountEntries(
  db: D1Database,
  userId: string,
  options: SearchOptions,
): Promise<SearchResult> {
  const query = normalizedQuery(options.q)
  const clauses = [
    'f.user_id = ?',
    'f.deleted_at IS NULL',
    "f.name_folded <> '.keep'",
    'EXISTS (SELECT 1 FROM CloudDrive_mounts m WHERE m.user_id = f.user_id AND m.id = f.mount_id AND m.storage_id = \'primary\' AND m.enabled = 1)',
    `(f.rowid IN (SELECT rowid FROM CloudDrive_files_fts WHERE CloudDrive_files_fts MATCH ?)
       OR f.name_folded LIKE ? ESCAPE '\\' OR f.name_initials LIKE ? ESCAPE '\\')`,
  ]
  const params: unknown[] = [userId, globalFtsQuery(options.q), `%${escapeLike(query)}%`, `%${escapeLike(query)}%`]
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
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor, 'name')
    const name = requireString(decoded.v)
    clauses.push('(f.name_folded > ? OR (f.name_folded = ? AND f.id > ?))')
    params.push(name, name, decoded.id)
  }
  const { results } = await db.prepare(
    `SELECT f.* FROM CloudDrive_files f
      WHERE ${clauses.join(' AND ')}
      ORDER BY f.name_folded, f.id LIMIT ?`,
  ).bind(...params, options.limit).all<CloudDriveFileRow>()
  const files = results ?? []
  const last = files[files.length - 1]
  return {
    files,
    cursor: last && files.length === options.limit
      ? encodeCursor('name', last.name_folded, last.id)
      : null,
    total: files.length < options.limit ? files.length : null,
  }
}

export async function recentEntries(
  db: D1Database,
  userId: string,
  mountId: string,
  kind: 'viewed' | 'uploaded' | 'starred',
  options: { cursor?: string; limit: number },
): Promise<{ files: CloudDriveFileRow[]; cursor: string | null }> {
  const column = kind === 'viewed' ? 'last_viewed_at' : kind === 'starred' ? 'starred_at' : 'uploaded_at'
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
    const separator = decoded.id.indexOf('\u0000')
    const cursorKind = decoded.id.slice(0, separator)
    const id = decoded.id.slice(separator + 1)
    if (separator < 0 || cursorKind !== kind || !id) throw ApiError.badRequest('The cursor does not match this listing')
    clauses.push(`(f.${column} < ? OR (f.${column} = ? AND f.id < ?))`)
    params.push(value, value, id)
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
    ? encodeCursor('uploaded', kind === 'viewed' ? last.last_viewed_at ?? 0 : kind === 'starred' ? last.starred_at ?? 0 : last.uploaded_at, `${kind}\u0000${last.id}`)
    : null
  return { files, cursor }
}

export interface AlbumGroup {
  month: string
  files: CloudDriveFileRow[]
}

export type { AlbumKind } from '@shared/clouddrive/model'

const ALBUM_CATEGORIES: Record<AlbumKind, string> = {
  images: "'images'",
  videos: "'videos'",
  all: "'images', 'videos'",
}

/** Capture time from metadata, falling back to upload time for a missing or corrupt stamp. */
const MEDIA_AT = `CASE
  WHEN json_valid(f.metadata) AND json_extract(f.metadata, '$.takenAt') IS NOT NULL
    THEN CAST(json_extract(f.metadata, '$.takenAt') AS INTEGER)
  ELSE f.uploaded_at END`

export async function albumEntries(
  db: D1Database,
  userId: string,
  mountId: string,
  options: {
    from?: number | null
    to?: number | null
    cursor?: string
    limit: number
    kind?: AlbumKind
  },
): Promise<{ groups: AlbumGroup[]; cursor: string | null }> {
  const kind = options.kind ?? 'images'
  const clauses = [
    'f.user_id = ?',
    'f.mount_id = ?',
    "f.kind = 'file'",
    `f.category IN (${ALBUM_CATEGORIES[kind] ?? ALBUM_CATEGORIES.images})`,
    'f.deleted_at IS NULL',
    "f.name_folded <> '.keep'",
  ]
  const params: unknown[] = [userId, mountId]
  if (options.from !== null && options.from !== undefined) {
    clauses.push(`${MEDIA_AT} >= ?`)
    params.push(options.from)
  }
  if (options.to !== null && options.to !== undefined) {
    clauses.push(`${MEDIA_AT} <= ?`)
    params.push(options.to)
  }
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor, 'uploaded')
    const value = requireNumber(decoded.v)
    clauses.push(`(${MEDIA_AT} < ? OR (${MEDIA_AT} = ? AND f.id < ?))`)
    params.push(value, value, decoded.id)
  }
  const { results } = await db.prepare(
    `SELECT f.*, ${MEDIA_AT} AS media_at FROM CloudDrive_files f
      WHERE ${clauses.join(' AND ')}
      ORDER BY media_at DESC, f.id DESC
      LIMIT ?`,
  ).bind(...params, options.limit).all<CloudDriveFileRow & { media_at: number }>()
  const files = results ?? []
  const groups: AlbumGroup[] = []
  for (const file of files) {
    const month = new Date(file.media_at).toISOString().slice(0, 7)
    const last = groups[groups.length - 1]
    if (last && last.month === month) last.files.push(file)
    else groups.push({ month, files: [file] })
  }
  const lastFile = files[files.length - 1]
  const cursor = lastFile && files.length === options.limit
    ? encodeCursor('uploaded', lastFile.media_at, lastFile.id)
    : null
  return { groups, cursor }
}
