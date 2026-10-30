/**
 * Helpers shared by the CloudDrive file and settings routes.
 *
 * Everything that turns a path, a mount or a D1 row into the vocabulary the API speaks lives here, so
 * the routes only parse, call a store function and shape the response. D1 statements stay in the
 * store modules; this file owns the two lookups every request makes first (mount, then entry).
 */
import { pinyin } from 'pinyin-pro'
import {
  CLOUDDRIVE_CATEGORIES,
  CLOUDDRIVE_LIMITS,
  CLOUDDRIVE_SORT_KEYS,
  decodeCloudDriveCursor,
  encodeCloudDriveCursor,
  foldedName,
  normalizeCloudDrivePath,
  cloudDriveNameProblem,
  type CloudDriveCategory,
  type CloudDriveEntry,
  type CloudDriveSortDirection,
  type CloudDriveSortKey,
  type CloudDriveTagView,
} from '@shared/clouddrive/model'
import { clampInt } from '../lib/request'
import { ApiError } from '../lib/errors'

/** One `CloudDrive_files` row, by column name. */
export interface CloudDriveFileRow {
  id: string
  user_id: string
  mount_id: string
  parent_id: string
  kind: 'folder' | 'file'
  name: string
  name_folded: string
  name_initials: string
  path: string
  category: string
  mime: string
  size: number
  etag: string | null
  checksum: string | null
  storage_kind: string
  storage_key: string | null
  metadata: string
  color: string
  starred_at: number | null
  last_viewed_at: number | null
  deleted_at: number | null
  trash_batch: string | null
  created_at: number
  updated_at: number
  uploaded_at: number
  modified_at: number
}

export interface CloudDriveMountInfo {
  id: string
  name: string
  mountPath: string
  storageId: string
  storageType: string
  readOnly: boolean
  enabled: boolean
}

interface MountRow {
  id: string
  storage_id: string
  name: string
  mount_path: string
  read_only: number
  enabled: number
}

export const PRIMARY_MOUNT = 'primary'

/** A thrown `invalid_path` from the shared model becomes the API's own code. */
export function pathInvalid(message = 'The path is invalid'): ApiError {
  return new ApiError(400, 'clouddrive_path_invalid', message)
}

/** Normalize a path, turning the shared model's `invalid_path` into the documented error code. */
export function parsePath(input: unknown, options: { allowRoot?: boolean } = {}): string {
  if (typeof input !== 'string') throw pathInvalid()
  try {
    return normalizeCloudDrivePath(input, options)
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_path') throw pathInvalid()
    throw error
  }
}

/** Validate a name segment the way a path segment is validated, with a readable message. */
export function parseName(input: unknown): string {
  if (typeof input !== 'string') throw pathInvalid('A name is required')
  const name = input.normalize('NFC')
  const problem = cloudDriveNameProblem(name)
  if (problem) throw pathInvalid(problem)
  return name
}

/** The mount must exist, be enabled and belong to this user; a foreign id is simply absent. */
export async function resolveMount(
  db: D1Database,
  userId: string,
  mountId: string,
): Promise<CloudDriveMountInfo> {
  const row = await db.prepare(
    `SELECT id, storage_id, name, mount_path, read_only, enabled
       FROM CloudDrive_mounts
      WHERE user_id = ? AND id = ? AND enabled = 1`,
  ).bind(userId, mountId).first<MountRow>()
  if (!row) throw ApiError.notFound('Mount not found')

  let storageType = 'r2'
  if (row.storage_id !== PRIMARY_MOUNT) {
    const storage = await db.prepare(
      `SELECT type, status FROM CloudDrive_storages WHERE user_id = ? AND id = ?`,
    ).bind(userId, row.storage_id).first<{ type: string; status: string }>()
    if (!storage || storage.status !== 'enabled') {
      throw new ApiError(502, 'clouddrive_mount_unavailable', 'The mount storage is unavailable')
    }
    storageType = storage.type
  }

  return {
    id: row.id,
    name: row.name,
    mountPath: row.mount_path,
    storageId: row.storage_id,
    storageType,
    readOnly: row.read_only === 1,
    enabled: row.enabled === 1,
  }
}

/** Mutating routes reject a read-only mount before touching a row. */
export function assertWritable(mount: CloudDriveMountInfo): void {
  if (mount.readOnly || mount.storageId !== PRIMARY_MOUNT) {
    throw new ApiError(403, 'clouddrive_read_only', 'This mount is read-only')
  }
}

function rootRow(userId: string, mountId: string): CloudDriveFileRow {
  return {
    id: '',
    user_id: userId,
    mount_id: mountId,
    parent_id: '',
    kind: 'folder',
    name: '',
    name_folded: '',
    name_initials: '',
    path: '/',
    category: 'other',
    mime: 'application/octet-stream',
    size: 0,
    etag: null,
    checksum: null,
    storage_kind: 'r2',
    storage_key: null,
    metadata: '{}',
    color: '',
    starred_at: null,
    last_viewed_at: null,
    deleted_at: null,
    trash_batch: null,
    created_at: 0,
    updated_at: 0,
    uploaded_at: 0,
    modified_at: 0,
  }
}

export async function getEntryById(
  db: D1Database,
  userId: string,
  mountId: string,
  id: string,
  options: { includeTrash?: boolean } = {},
): Promise<CloudDriveFileRow | null> {
  const sql = options.includeTrash
    ? `SELECT * FROM CloudDrive_files WHERE user_id = ? AND mount_id = ? AND id = ?`
    : `SELECT * FROM CloudDrive_files WHERE user_id = ? AND mount_id = ? AND id = ? AND deleted_at IS NULL`
  return await db.prepare(sql).bind(userId, mountId, id).first<CloudDriveFileRow>()
}

/**
 * Resolve an absolute path to its row. The root has no row of its own (children point at `''`), so
 * it is answered with a synthetic folder whose id is empty — callers then use `row.id` uniformly.
 */
export async function resolveEntry(
  db: D1Database,
  userId: string,
  mountId: string,
  path: string,
  options: { includeTrash?: boolean } = {},
): Promise<CloudDriveFileRow> {
  const normalized = parsePath(path)
  if (normalized === '/') return rootRow(userId, mountId)

  const live = await db.prepare(
    `SELECT * FROM CloudDrive_files
      WHERE user_id = ? AND mount_id = ? AND path = ? AND deleted_at IS NULL`,
  ).bind(userId, mountId, normalized).first<CloudDriveFileRow>()
  if (live) return live
  if (options.includeTrash) {
    // The partial unique index only covers live rows, so a trashed row can share the path with a
    // newer live one; the trash lookup takes the most recently deleted of that path.
    const trashed = await db.prepare(
      `SELECT * FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND path = ? AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC LIMIT 1`,
    ).bind(userId, mountId, normalized).first<CloudDriveFileRow>()
    if (trashed) return trashed
  }
  throw ApiError.notFound('File not found')
}

/**
 * First letters of the Han characters in a name, so a Chinese title can be found by its initials.
 *
 * `pinyin-pro` is a dictionary call that can throw on input it cannot segment; a name whose reading
 * is unavailable is still a perfectly good name, so the index is left empty and the filename search
 * still works.
 */
export function initialsOf(name: string): string {
  try {
    const parts = pinyin(name.normalize('NFC'), {
      pattern: 'first',
      toneType: 'none',
      type: 'array',
      nonZh: 'removed',
    })
    return parts.join('').toLocaleLowerCase().replace(/[^a-z0-9]/g, '')
  } catch (error) {
    console.warn('[clouddrive] pinyin initials failed:', error)
    return ''
  }
}

export function parseSort(value: string | undefined): CloudDriveSortKey {
  return CLOUDDRIVE_SORT_KEYS.includes(value as CloudDriveSortKey)
    ? value as CloudDriveSortKey
    : 'name'
}

export function parseDir(value: string | undefined): CloudDriveSortDirection {
  return value === 'desc' ? 'desc' : 'asc'
}

export function parseLimit(value: string | undefined, fallback: number = CLOUDDRIVE_LIMITS.listLimit): number {
  return clampInt(value, 1, CLOUDDRIVE_LIMITS.listMax, fallback)
}

export function parseTimestamp(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null
}

export function parseFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

/**
 * The opaque cursor is the shared base64url helper over the sort key and value the ordering used.
 * Encoding the key alongside the value means a client cannot change `sort` mid-listing and silently
 * get the wrong page.
 */
export function encodeCursor(
  sortKey: CloudDriveSortKey,
  value: string | number | null,
  id: string,
): string {
  return encodeCloudDriveCursor({ v: JSON.stringify({ k: sortKey, v: value }), id })
}

export function decodeCursor(
  cursor: string,
  sortKey: CloudDriveSortKey,
): { v: string | number | null; id: string } {
  let decoded: { v: string | number | null; id: string }
  try {
    decoded = decodeCloudDriveCursor(cursor)
  } catch {
    throw ApiError.badRequest('The cursor is invalid')
  }
  let state: { k?: unknown; v?: unknown }
  try {
    state = JSON.parse(String(decoded.v)) as { k?: unknown; v?: unknown }
  } catch {
    throw ApiError.badRequest('The cursor is invalid')
  }
  const validValue = typeof state.v === 'string' || typeof state.v === 'number' || state.v === null
  if (!state || state.k !== sortKey || !validValue) {
    throw ApiError.badRequest('The cursor does not match this listing')
  }
  return { v: state.v as string | number | null, id: decoded.id }
}

function categoryOf(value: string): CloudDriveCategory {
  return (CLOUDDRIVE_CATEGORIES as readonly string[]).includes(value)
    ? value as CloudDriveCategory
    : 'other'
}

function storageKindOf(value: string): CloudDriveEntry['storageKind'] {
  return value === 'distributed' || value === 'external' ? value : 'r2'
}

/** The core row → entry conversion; mount-specific fields are empty until {@link buildEntry}. */
export function rowToEntry(row: CloudDriveFileRow, tags: CloudDriveTagView[] = []): CloudDriveEntry {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    mountId: row.mount_id,
    mountName: '',
    category: categoryOf(row.category),
    mime: row.mime,
    size: row.size,
    uploadedAt: row.uploaded_at,
    modifiedAt: row.modified_at,
    starredAt: row.starred_at,
    readOnly: false,
    hasThumbnail: row.kind === 'file' && row.category === 'images',
    storage: row.storage_kind === 'r2' ? 'primary' : row.storage_kind,
    storageKind: storageKindOf(row.storage_kind),
    color: row.kind === 'folder' && row.color ? row.color : null,
    tags,
  }
}

/** An entry with the mount context the listing surface needs. */
export function buildEntry(
  row: CloudDriveFileRow,
  mount: CloudDriveMountInfo,
  tags: CloudDriveTagView[] = [],
): CloudDriveEntry {
  const entry = rowToEntry(row, tags)
  return {
    ...entry,
    mountName: mount.name,
    readOnly: mount.readOnly,
    storage: mount.storageId === PRIMARY_MOUNT ? 'primary' : mount.storageType,
  }
}

/** Tags for many rows in one pass, chunked because D1 caps the placeholders a statement may bind. */
export async function tagsForFiles(
  db: D1Database,
  userId: string,
  fileIds: readonly string[],
): Promise<Map<string, CloudDriveTagView[]>> {
  const map = new Map<string, CloudDriveTagView[]>()
  const unique = [...new Set(fileIds.filter((id) => id.length > 0))]
  for (let offset = 0; offset < unique.length; offset += 90) {
    const chunk = unique.slice(offset, offset + 90)
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(', ')
    const { results } = await db.prepare(
      `SELECT file_id, tag, color FROM CloudDrive_file_tags
        WHERE user_id = ? AND file_id IN (${placeholders})
        ORDER BY created_at, tag_folded`,
    ).bind(userId, ...chunk).all<{ file_id: string; tag: string; color: string }>()
    for (const row of results ?? []) {
      const tags = map.get(row.file_id) ?? []
      tags.push({ name: row.tag, color: row.color })
      map.set(row.file_id, tags)
    }
  }
  return map
}

/** `foldedName` in one place, so a caller does not repeat NFC + lowercase. */
export function foldName(name: string): string {
  return foldedName(name)
}
