import { Hono, type Context } from 'hono'
import {
  CLOUDDRIVE_CATEGORIES,
  CLOUDDRIVE_LIMITS,
  foldedName,
  parentPathOf,
  type CloudDriveCategory,
} from '@shared/clouddrive/model'
import { organizerColorOrNull } from '@shared/organizer-colors'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { readJson } from '../lib/request'
import { requireOwner } from '../middleware/auth'
import { ensurePrimaryMount } from './store'
import { initialsOf, parseName, parsePath } from './lib'

export const clouddriveMaintenanceRoutes = new Hono<AppBindings>()

clouddriveMaintenanceRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})
clouddriveMaintenanceRoutes.use('*', requireOwner)
clouddriveMaintenanceRoutes.use('*', async (c, next) => {
  await ensurePrimaryMount(c.env.DB, c.get('userId'))
  await next()
})

const OBJECT_PREFIX = 'CloudDrive/'
const SCAN_LIMIT_DEFAULT = 200
const SCAN_LIMIT_MAX = 1000
const DELETE_MAX = 500
const EXPORT_MAX = 10_000
const IMPORT_MAX = 2000
const SQL_CHUNK = 90
const IMPORT_BODY_LIMIT = 8 * 1024 * 1024
const DELETE_BODY_LIMIT = DELETE_MAX * 1024 + 8 * 1024

interface OrphanObject {
  key: string
  size: number
  uploaded: number
}

interface ManifestTag {
  tag: string
  color: string
}

interface ManifestEntry {
  path: string
  name: string
  kind: 'file' | 'folder'
  category?: string
  mime?: string
  size?: number
  etag?: string | null
  checksum?: string | null
  storageKey?: string | null
  color?: string | null
  starredAt?: number | null
  createdAt?: number
  updatedAt?: number
  uploadedAt?: number
  modifiedAt?: number
  tags?: ManifestTag[]
}

interface ImportResult {
  imported: number
  skipped: number
  errors: { path: string; reason: string }[]
}

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

function hasR2(c: Context<AppBindings>): boolean {
  if (!c.env.FILES) throw new ApiError(503, 'clouddrive_mount_unavailable', 'R2 is not bound')
  return true
}

function scanLimit(value: string | undefined): number {
  const requested = Number(value)
  return Number.isSafeInteger(requested) && requested >= 1 && requested <= SCAN_LIMIT_MAX
    ? requested
    : SCAN_LIMIT_DEFAULT
}

async function referencedKeys(db: D1Database, keys: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (let offset = 0; offset < keys.length; offset += SQL_CHUNK) {
    const chunk = keys.slice(offset, offset + SQL_CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    const [files, uploads, versions, parts, uploadParts] = await Promise.all([
      db.prepare(`SELECT DISTINCT storage_key FROM CloudDrive_files WHERE storage_key IN (${placeholders})`)
        .bind(...chunk).all<{ storage_key: string }>(),
      db.prepare(
        `SELECT DISTINCT storage_key FROM CloudDrive_upload_sessions
          WHERE status = 'active' AND storage_key IN (${placeholders})`,
      ).bind(...chunk).all<{ storage_key: string }>(),
      db.prepare(`SELECT DISTINCT storage_key FROM CloudDrive_file_versions WHERE storage_key IN (${placeholders})`)
        .bind(...chunk).all<{ storage_key: string }>(),
      db.prepare(`SELECT DISTINCT storage_key FROM CloudDrive_file_parts WHERE storage_key IN (${placeholders})`)
        .bind(...chunk).all<{ storage_key: string }>(),
      db.prepare(`SELECT DISTINCT storage_key FROM CloudDrive_upload_part_objects WHERE storage_key IN (${placeholders})`)
        .bind(...chunk).all<{ storage_key: string }>(),
    ])
    for (const row of files.results ?? []) found.add(row.storage_key)
    for (const row of uploads.results ?? []) found.add(row.storage_key)
    for (const row of versions.results ?? []) found.add(row.storage_key)
    for (const row of parts.results ?? []) found.add(row.storage_key)
    for (const row of uploadParts.results ?? []) found.add(row.storage_key)
  }
  return found
}

clouddriveMaintenanceRoutes.get('/admin/maintenance/orphans', async (c) => {
  hasR2(c)
  const cursor = c.req.query('cursor') || undefined
  const page = await c.env.FILES!.list({ prefix: OBJECT_PREFIX, cursor, limit: scanLimit(c.req.query('limit')) })
  const keys = page.objects.map((object) => object.key)
  const referenced = await referencedKeys(c.env.DB, keys)
  const orphans: OrphanObject[] = page.objects
    .filter((object) => !referenced.has(object.key))
    .map((object) => ({ key: object.key, size: object.size, uploaded: object.uploaded?.getTime() ?? 0 }))
  return c.json({
    orphans,
    scanned: keys.length,
    cursor: page.truncated ? page.cursor ?? null : null,
    done: !page.truncated,
  })
})

clouddriveMaintenanceRoutes.post('/admin/maintenance/orphans/delete', async (c) => {
  hasR2(c)
  const body = await readJson<{ keys?: unknown }>(c, DELETE_BODY_LIMIT)
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw ApiError.badRequest('keys must name at least one object')
  if (body.keys.length > DELETE_MAX) throw ApiError.badRequest(`keys holds at most ${DELETE_MAX} objects`)
  const keys = new Set<string>()
  for (const key of body.keys) {
    if (typeof key !== 'string' || !key.startsWith(OBJECT_PREFIX) || key.length > 1024) {
      throw ApiError.badRequest('keys contains an invalid object key')
    }
    keys.add(key)
  }
  const list = [...keys]
  const referenced = await referencedKeys(c.env.DB, list)
  const deletable = list.filter((key) => !referenced.has(key))
  if (deletable.length > 0) await c.env.FILES!.delete(deletable)
  return c.json({ deleted: deletable.length, skipped: list.length - deletable.length })
})

clouddriveMaintenanceRoutes.get('/admin/maintenance/export', async (c) => {
  const userId = userIdOf(c)
  const { results } = await c.env.DB.prepare(
    `SELECT id, path, name, kind, category, mime, size, etag, checksum, storage_key, color,
            starred_at, created_at, updated_at, uploaded_at, modified_at
       FROM CloudDrive_files
      WHERE user_id = ? AND mount_id = 'primary' AND deleted_at IS NULL
      ORDER BY path LIMIT ?`,
  ).bind(userId, EXPORT_MAX + 1).all<{
    id: string
    path: string
    name: string
    kind: 'file' | 'folder'
    category: string
    mime: string
    size: number
    etag: string | null
    checksum: string | null
    storage_key: string | null
    color: string
    starred_at: number | null
    created_at: number
    updated_at: number
    uploaded_at: number
    modified_at: number
  }>()
  const rows = (results ?? []).slice(0, EXPORT_MAX)
  const tagRows = await c.env.DB.prepare(
    `SELECT file_id, tag, color FROM CloudDrive_file_tags WHERE user_id = ? ORDER BY created_at`,
  ).bind(userId).all<{ file_id: string; tag: string; color: string }>()
  const tagsByFile = new Map<string, ManifestTag[]>()
  for (const tag of tagRows.results ?? []) {
    const list = tagsByFile.get(tag.file_id) ?? []
    list.push({ tag: tag.tag, color: tag.color })
    tagsByFile.set(tag.file_id, list)
  }
  return c.json({
    format: 'inkstone-clouddrive',
    version: 1,
    exportedAt: Date.now(),
    truncated: (results ?? []).length > EXPORT_MAX,
    entries: rows.map((row) => ({
      path: row.path,
      name: row.name,
      kind: row.kind,
      category: row.category,
      mime: row.mime,
      size: row.size,
      etag: row.etag,
      checksum: row.checksum,
      storageKey: row.storage_key,
      color: row.color || null,
      starredAt: row.starred_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      uploadedAt: row.uploaded_at,
      modifiedAt: row.modified_at,
      tags: tagsByFile.get(row.id) ?? [],
    })),
  })
})

function timestampOrNow(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function categoryOrOther(value: unknown): CloudDriveCategory {
  return typeof value === 'string' && (CLOUDDRIVE_CATEGORIES as readonly string[]).includes(value)
    ? value as CloudDriveCategory
    : 'other'
}

function validStorageKey(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > 1024) throw new Error('invalid_storage_key')
  if (!/^CloudDrive\/[a-z]+\/[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_storage_key')
  return value
}

async function pathExists(db: D1Database, userId: string, path: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS hit FROM CloudDrive_files
      WHERE user_id = ? AND mount_id = 'primary' AND path = ? AND deleted_at IS NULL`,
  ).bind(userId, path).first<{ hit: number }>()
  return !!row
}

async function parentIdFor(db: D1Database, userId: string, path: string): Promise<string | null> {
  if (path === '/') return ''
  const row = await db.prepare(
    `SELECT id FROM CloudDrive_files
      WHERE user_id = ? AND mount_id = 'primary' AND path = ? AND kind = 'folder' AND deleted_at IS NULL`,
  ).bind(userId, path).first<{ id: string }>()
  return row?.id ?? null
}

async function storageKeyTaken(db: D1Database, key: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS hit FROM CloudDrive_files WHERE storage_key = ? LIMIT 1`)
    .bind(key).first<{ hit: number }>()
  if (row) return true
  const upload = await db.prepare(
    `SELECT 1 AS hit FROM CloudDrive_upload_sessions WHERE storage_key = ? AND status = 'active' LIMIT 1`,
  ).bind(key).first<{ hit: number }>()
  return !!upload
}

function parseTags(value: unknown): ManifestTag[] {
  if (!Array.isArray(value)) return []
  const tags: ManifestTag[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as { tag?: unknown; color?: unknown }
    if (typeof record.tag !== 'string') continue
    const tag = record.tag.trim()
    if (!tag || tag.length > CLOUDDRIVE_LIMITS.tagMaxLength) continue
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push({ tag, color: organizerColorOrNull(record.color) ?? '' })
    if (tags.length >= CLOUDDRIVE_LIMITS.tagsPerFileMax) break
  }
  return tags
}

clouddriveMaintenanceRoutes.post('/admin/maintenance/import', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ format?: unknown; version?: unknown; entries?: unknown }>(c, IMPORT_BODY_LIMIT)
  if (body.format !== 'inkstone-clouddrive' || body.version !== 1) {
    throw ApiError.badRequest('The manifest format is not supported')
  }
  if (!Array.isArray(body.entries)) throw ApiError.badRequest('entries must be an array')
  if (body.entries.length > IMPORT_MAX) throw ApiError.badRequest(`entries holds at most ${IMPORT_MAX} entries`)
  const entries = body.entries as ManifestEntry[]
  const ordered = [...entries].sort((left, right) => {
    const leftPath = typeof left?.path === 'string' ? left.path : ''
    const rightPath = typeof right?.path === 'string' ? right.path : ''
    return leftPath.split('/').length - rightPath.split('/').length
  })
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] }
  const pushError = (path: string, reason: string) => {
    result.skipped += 1
    if (result.errors.length < 50) result.errors.push({ path, reason })
  }
  const now = Date.now()
  const created = new Map<string, string>()

  for (const entry of ordered) {
    let path = ''
    try {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        pushError('', 'invalid_entry')
        continue
      }
      path = parsePath(entry?.path)
      if (path === '/') { pushError(path, 'root'); continue }
      const name = parseName(entry.name)
      if (path !== `/${name}` && !path.endsWith(`/${name}`)) {
        pushError(path, 'name_mismatch')
        continue
      }
      const kind = entry.kind === 'folder' ? 'folder' : entry.kind === 'file' ? 'file' : null
      if (!kind) { pushError(path, 'invalid_kind'); continue }
      if (await pathExists(c.env.DB, userId, path)) { pushError(path, 'exists'); continue }
      const parentPath = parentPathOf(path)
      const parentId = parentPath === '/' ? '' : created.get(parentPath) ?? await parentIdFor(c.env.DB, userId, parentPath)
      if (parentId === null) { pushError(path, 'missing_parent'); continue }
      const storageKey = kind === 'file' ? validStorageKey(entry.storageKey) : null
      if (storageKey && await storageKeyTaken(c.env.DB, storageKey)) { pushError(path, 'storage_key_taken'); continue }
      const id = newId()
      const createdAt = timestampOrNow(entry.createdAt, now)
      const updatedAt = timestampOrNow(entry.updatedAt, createdAt)
      const uploadedAt = timestampOrNow(entry.uploadedAt, createdAt)
      const modifiedAt = timestampOrNow(entry.modifiedAt, uploadedAt)
      const category = kind === 'folder' ? 'other' : categoryOrOther(entry.category)
      const mime = kind === 'folder'
        ? 'application/octet-stream'
        : typeof entry.mime === 'string' && entry.mime.length <= 255 ? entry.mime : 'application/octet-stream'
      const size = kind === 'folder'
        ? 0
        : typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : 0
      const color = kind === 'folder' ? organizerColorOrNull(entry.color) ?? '' : ''
      const starredAt = typeof entry.starredAt === 'number' && Number.isSafeInteger(entry.starredAt)
        ? entry.starredAt
        : null
      await c.env.DB.prepare(
        `INSERT INTO CloudDrive_files
           (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
            category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
            starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
         VALUES (?, ?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'r2', ?, '{}', ?,
                 ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
      ).bind(
        id, userId, parentId, kind, name, foldedName(name), initialsOf(name), path,
        category, mime, size,
        typeof entry.etag === 'string' ? entry.etag.slice(0, 256) : null,
        typeof entry.checksum === 'string' ? entry.checksum.slice(0, 256) : null,
        storageKey, color, starredAt, createdAt, updatedAt, uploadedAt, modifiedAt,
      ).run()
      if (kind === 'folder') created.set(path, id)
      const tags = kind === 'file' ? parseTags(entry.tags) : []
      for (const tag of tags) {
        await c.env.DB.prepare(
          `INSERT INTO CloudDrive_file_tags (user_id, file_id, tag, tag_folded, color, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, file_id, tag_folded) DO NOTHING`,
        ).bind(userId, id, tag.tag, tag.tag.toLocaleLowerCase(), tag.color, now).run()
      }
      result.imported += 1
    } catch (error) {
      if (error instanceof ApiError) {
        pushError(typeof entry?.path === 'string' ? entry.path : '', error.message)
      } else {
        throw error
      }
    }
  }
  return c.json(result)
})
