import type {
  IconAssetDetail,
  IconAssetSummary,
  IconBootstrap,
  IconCollection,
  IconCounts,
  IconExport,
  IconImport,
  IconJob,
  IconJobItem,
  IconLimits,
  IconPage,
  IconSettings,
  IconTag,
  IconTagSummary,
} from '@shared/development/icons/types'
import {
  ICON_DEFAULT_BATCH_LIMIT,
  ICON_DEFAULT_MAX_DIMENSION,
  ICON_DEFAULT_MAX_RASTER_BYTES,
  ICON_DEFAULT_MAX_SVG_BYTES,
  ICON_DEFAULT_QUOTA_BYTES,
  ICON_DEFAULT_ZIP_LIMIT_BYTES,
  ICON_DEFAULT_ZIP_LIMIT_ENTRIES,
  ICON_HARD_BATCH_LIMIT,
  ICON_HARD_MAX_DIMENSION,
  ICON_HARD_MAX_RASTER_BYTES,
  ICON_HARD_MAX_SVG_BYTES,
  ICON_HARD_QUOTA_BYTES,
  ICON_HARD_ZIP_LIMIT_BYTES,
  ICON_HARD_ZIP_LIMIT_ENTRIES,
  ICON_RECENT_DAYS,
} from '@shared/development/icons/limits'
import { decodeIconCursor, encodeIconCursor } from '@shared/development/icons/cursor'
import { ApiError } from '../../lib/errors'
import { newId } from '../../lib/id'
import { iconObjectUrl, userShard } from './r2'

type Row = Record<string, unknown>

const ASSET_COLUMNS = `a.id, a.collection_id, a.name, a.name_key, a.format, a.mime, a.bytes,
  a.width, a.height, a.view_box, a.sha256, a.r2_key, a.thumb_key, a.keywords, a.color_mode,
  a.license, a.source_url, a.sanitized, a.created_at, a.updated_at`

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function collectionRow(row: Row): IconCollection {
  return {
    id: text(row.id),
    name: text(row.name),
    slug: text(row.slug),
    description: text(row.description),
    source: text(row.source, 'upload') as IconCollection['source'],
    license: text(row.license),
    homepage: text(row.homepage),
    sortOrder: number(row.sort_order),
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at),
    count: row.count === undefined ? undefined : number(row.count),
  }
}

function tagRow(row: Row): IconTag {
  return {
    id: text(row.id),
    name: text(row.name),
    color: text(row.color, '#64748b'),
    parentId: typeof row.parent_id === 'string' ? row.parent_id : null,
    sortOrder: number(row.sort_order),
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at),
  }
}

function tagSummary(row: Row): IconTagSummary {
  return { id: text(row.tag_id), name: text(row.name), color: text(row.color, '#64748b') }
}

function assetSummary(row: Row, shard: string, tags: IconTagSummary[], favorited: boolean, pinned: boolean): IconAssetSummary {
  const format = text(row.format, 'svg') as IconAssetSummary['format']
  const sha256 = text(row.sha256)
  return {
    id: text(row.id),
    name: text(row.name),
    collectionId: typeof row.collection_id === 'string' ? row.collection_id : null,
    format,
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    bytes: number(row.bytes),
    sha256,
    thumbUrl: iconObjectUrl(format, shard, sha256),
    rawUrl: iconObjectUrl(format, shard, sha256),
    tags,
    favorited,
    pinned,
    colorMode: text(row.color_mode, 'unknown') as IconAssetSummary['colorMode'],
    updatedAt: number(row.updated_at),
  }
}

function assetDetail(row: Row, shard: string, tags: IconTagSummary[], favorited: boolean, pinned: boolean, useCount: number, lastUsedAt: number | null): IconAssetDetail {
  return {
    ...assetSummary(row, shard, tags, favorited, pinned),
    mime: text(row.mime, 'application/octet-stream'),
    viewBox: typeof row.view_box === 'string' ? row.view_box : null,
    keywords: text(row.keywords),
    license: text(row.license),
    sourceUrl: text(row.source_url),
    sanitized: number(row.sanitized) === 1,
    createdAt: number(row.created_at),
    useCount,
    lastUsedAt,
  }
}

export async function ensureSettings(db: D1Database, userId: string, now = Date.now()): Promise<IconSettings> {
  await db.prepare(
    `INSERT OR IGNORE INTO development_icons_settings
      (user_id, quota_bytes, max_svg_bytes, max_raster_bytes, max_dimension, batch_limit, zip_limit_bytes, zip_limit_entries, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    userId,
    ICON_DEFAULT_QUOTA_BYTES,
    ICON_DEFAULT_MAX_SVG_BYTES,
    ICON_DEFAULT_MAX_RASTER_BYTES,
    ICON_DEFAULT_MAX_DIMENSION,
    ICON_DEFAULT_BATCH_LIMIT,
    ICON_DEFAULT_ZIP_LIMIT_BYTES,
    ICON_DEFAULT_ZIP_LIMIT_ENTRIES,
    now,
  ).run()
  const row = await db.prepare(`SELECT * FROM development_icons_settings WHERE user_id = ?1`).bind(userId).first<Row>()
  if (!row) throw new Error('The icon settings row could not be created')
  return {
    quotaBytes: number(row.quota_bytes, ICON_DEFAULT_QUOTA_BYTES),
    maxSvgBytes: number(row.max_svg_bytes, ICON_DEFAULT_MAX_SVG_BYTES),
    maxRasterBytes: number(row.max_raster_bytes, ICON_DEFAULT_MAX_RASTER_BYTES),
    maxDimension: number(row.max_dimension, ICON_DEFAULT_MAX_DIMENSION),
    batchLimit: number(row.batch_limit, ICON_DEFAULT_BATCH_LIMIT),
    zipLimitBytes: number(row.zip_limit_bytes, ICON_DEFAULT_ZIP_LIMIT_BYTES),
    zipLimitEntries: number(row.zip_limit_entries, ICON_DEFAULT_ZIP_LIMIT_ENTRIES),
  }
}

export async function ensureLimits(db: D1Database, now = Date.now()): Promise<IconLimits> {
  await db.prepare(
    `INSERT OR IGNORE INTO development_icons_limits
      (id, hard_quota_bytes, hard_max_svg_bytes, hard_max_raster_bytes, hard_max_dimension, hard_batch_limit, hard_zip_limit_bytes, hard_zip_limit_entries, updated_at)
     VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(
    ICON_HARD_QUOTA_BYTES,
    ICON_HARD_MAX_SVG_BYTES,
    ICON_HARD_MAX_RASTER_BYTES,
    ICON_HARD_MAX_DIMENSION,
    ICON_HARD_BATCH_LIMIT,
    ICON_HARD_ZIP_LIMIT_BYTES,
    ICON_HARD_ZIP_LIMIT_ENTRIES,
    now,
  ).run()
  const row = await db.prepare(`SELECT * FROM development_icons_limits WHERE id = 1`).first<Row>()
  if (!row) throw new Error('The icon limits row could not be created')
  return {
    hardQuotaBytes: number(row.hard_quota_bytes, ICON_HARD_QUOTA_BYTES),
    hardMaxSvgBytes: number(row.hard_max_svg_bytes, ICON_HARD_MAX_SVG_BYTES),
    hardMaxRasterBytes: number(row.hard_max_raster_bytes, ICON_HARD_MAX_RASTER_BYTES),
    hardMaxDimension: number(row.hard_max_dimension, ICON_HARD_MAX_DIMENSION),
    hardBatchLimit: number(row.hard_batch_limit, ICON_HARD_BATCH_LIMIT),
    hardZipLimitBytes: number(row.hard_zip_limit_bytes, ICON_HARD_ZIP_LIMIT_BYTES),
    hardZipLimitEntries: number(row.hard_zip_limit_entries, ICON_HARD_ZIP_LIMIT_ENTRIES),
  }
}

export async function bootstrap(db: D1Database, userId: string): Promise<IconBootstrap> {
  const [collectionsResult, tagsResult, settings, limits, shard] = await Promise.all([
    db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM development_icons_assets a WHERE a.user_id = c.user_id AND a.collection_id = c.id) AS count
         FROM development_icons_collections c WHERE c.user_id = ?1 ORDER BY c.sort_order, c.name`,
    ).bind(userId).all<Row>(),
    db.prepare(`SELECT * FROM development_icons_tags WHERE user_id = ?1 ORDER BY sort_order, created_at`).bind(userId).all<Row>(),
    ensureSettings(db, userId),
    ensureLimits(db),
    userShard(userId),
  ])
  const counts = await countsFor(db, userId, shard)
  return {
    collections: (collectionsResult.results ?? []).map(collectionRow),
    tags: (tagsResult.results ?? []).map(tagRow),
    counts,
    settings,
    limits,
    schemaVersions: [320, 321],
  }
}

export async function countsFor(db: D1Database, userId: string, _shard: string): Promise<IconCounts> {
  const cutoff = Date.now() - ICON_RECENT_DAYS * 24 * 60 * 60 * 1000
  const [all, favorites, pinned, recent, uncategorized, collections, tags] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM development_icons_assets WHERE user_id = ?1`).bind(userId).first<{ n: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS n FROM development_icons_user_state s
        JOIN development_icons_assets a ON a.user_id = s.user_id AND a.id = s.asset_id
       WHERE s.user_id = ?1 AND s.favorited = 1`,
    ).bind(userId).first<{ n: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS n FROM development_icons_user_state s
        JOIN development_icons_assets a ON a.user_id = s.user_id AND a.id = s.asset_id
       WHERE s.user_id = ?1 AND s.pinned = 1`,
    ).bind(userId).first<{ n: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS n FROM development_icons_user_state s
        JOIN development_icons_assets a ON a.user_id = s.user_id AND a.id = s.asset_id
       WHERE s.user_id = ?1 AND s.last_used_at >= ?2`,
    ).bind(userId, cutoff).first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM development_icons_assets WHERE user_id = ?1 AND collection_id IS NULL`).bind(userId).first<{ n: number }>(),
    db.prepare(
      `SELECT collection_id AS id, COUNT(*) AS n FROM development_icons_assets
        WHERE user_id = ?1 AND collection_id IS NOT NULL GROUP BY collection_id`,
    ).bind(userId).all<{ id: string; n: number }>(),
    db.prepare(
      `SELECT tag_id AS id, COUNT(*) AS n FROM development_icons_tag_links WHERE user_id = ?1 GROUP BY tag_id`,
    ).bind(userId).all<{ id: string; n: number }>(),
  ])
  return {
    all: number(all?.n),
    favorites: number(favorites?.n),
    pinned: number(pinned?.n),
    recent: number(recent?.n),
    uncategorized: number(uncategorized?.n),
    collections: Object.fromEntries((collections.results ?? []).map((row) => [row.id, row.n])),
    tags: Object.fromEntries((tags.results ?? []).map((row) => [row.id, row.n])),
  }
}

interface ListInput {
  limit: number
  cursor?: string
  q?: string
  collectionId?: string
  tagId?: string
  format?: string
  state: string
  sort: string
}

function cursorCondition(sort: string, cursor: { key: string | number; id: string }, direction: 'asc' | 'desc'): { sql: string; values: unknown[] } {
  const column = sort === 'name' ? 'a.name_key' : sort === 'updated' ? 'a.updated_at' : sort === 'used' ? 'COALESCE(s.last_used_at, 0)' : 'a.created_at'
  const operator = direction === 'asc' ? '>' : '<'
  return {
    sql: `(${column} ${operator} ? OR (${column} = ? AND a.id ${operator} ?))`,
    values: [cursor.key, cursor.key, cursor.id],
  }
}

export async function listAssets(db: D1Database, userId: string, input: ListInput): Promise<IconPage<IconAssetSummary>> {
  const shard = await userShard(userId)
  const where: string[] = ['a.user_id = ?1']
  const values: unknown[] = [userId]
  const add = (sql: string, value: unknown): void => {
    values.push(value)
    where.push(sql.replace('?', `?${values.length}`))
  }
  let searchRowIds: number[] | null = null
  if (input.q && input.q.trim().length >= 3) {
    const query = `"${input.q.trim().replace(/"/g, '""')}"`
    const matches = await db.prepare(
      `SELECT rowid FROM development_icons_fts WHERE development_icons_fts MATCH ?1 AND user_id = ?2 LIMIT 80`,
    ).bind(query, userId).all<{ rowid: number }>()
    searchRowIds = (matches.results ?? []).map((row) => row.rowid)
    if (!searchRowIds.length) return { items: [], nextCursor: null, hasMore: false }
  }
  if (input.collectionId) add('a.collection_id = ?', input.collectionId)
  if (input.format) add('a.format = ?', input.format)
  if (input.tagId) add('EXISTS (SELECT 1 FROM development_icons_tag_links l WHERE l.user_id = a.user_id AND l.asset_id = a.id AND l.tag_id = ?)', input.tagId)
  if (input.state === 'favorites') where.push('COALESCE(s.favorited, 0) = 1')
  if (input.state === 'pinned') where.push('COALESCE(s.pinned, 0) = 1')
  if (input.state === 'recent') where.push('s.last_used_at IS NOT NULL')
  if (input.state === 'uncategorized') where.push('a.collection_id IS NULL')
  if (input.q) {
    const query = input.q.trim()
    if (query.length >= 3 && searchRowIds) {
      const marks = searchRowIds.map((rowid) => {
        values.push(rowid)
        return `?${values.length}`
      })
      where.push(`a.rowid IN (${marks.join(', ')})`)
    } else if (query.length < 3) {
      add('a.name_key LIKE ?', `${query.toLowerCase()}%`)
    }
  }
  const cursor = input.cursor ? decodeIconCursor(input.cursor) : null
  if (input.cursor && !cursor) throw ApiError.badRequest('The cursor is not valid')
  const direction = input.sort === 'name' ? 'asc' : 'desc'
  if (cursor) {
    const condition = cursorCondition(input.sort, cursor, direction)
    let offset = values.length
    values.push(...condition.values)
    const shifted = condition.sql.replace(/\?/g, () => `?${++offset}`)
    where.push(shifted)
  }
  const order = input.sort === 'name'
    ? 'a.name_key ASC, a.id ASC'
    : input.sort === 'updated'
      ? 'a.updated_at DESC, a.id DESC'
      : input.sort === 'used'
        ? 'COALESCE(s.last_used_at, 0) DESC, a.id DESC'
        : 'a.created_at DESC, a.id DESC'
  const limit = input.limit
  values.push(limit + 1)
  const rows = await db.prepare(
    `SELECT ${ASSET_COLUMNS}, COALESCE(s.favorited, 0) AS favorited, COALESCE(s.pinned, 0) AS pinned
       FROM development_icons_assets a
       LEFT JOIN development_icons_user_state s ON s.user_id = a.user_id AND s.asset_id = a.id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ?${values.length}`,
  ).bind(...values).all<Row>()
  const results = rows.results ?? []
  const items = results.slice(0, limit)
  const tagMap = await tagsForAssets(db, userId, items.map((row) => text(row.id)))
  const mapped = items.map((row) => assetSummary(
    row,
    shard,
    tagMap.get(text(row.id)) ?? [],
    number(row.favorited) === 1,
    number(row.pinned) === 1,
  ))
  const last = items.at(-1)
  const nextCursor = last && results.length > limit
    ? encodeIconCursor({
        sort: input.sort as never,
        key: input.sort === 'name' ? text(last.name_key) : input.sort === 'updated' ? number(last.updated_at) : input.sort === 'used' ? number(last.last_used_at) : number(last.created_at),
        id: text(last.id),
      })
    : null
  return { items: mapped, nextCursor, hasMore: results.length > limit }
}

async function tagsForAssets(db: D1Database, userId: string, ids: string[]): Promise<Map<string, IconTagSummary[]>> {
  const map = new Map<string, IconTagSummary[]>()
  if (!ids.length) return map
  const placeholders = ids.map((_, index) => `?${index + 2}`).join(', ')
  const rows = await db.prepare(
    `SELECT l.asset_id, l.tag_id, t.name, t.color
       FROM development_icons_tag_links l
       JOIN development_icons_tags t ON t.user_id = l.user_id AND t.id = l.tag_id
      WHERE l.user_id = ?1 AND l.asset_id IN (${placeholders})
      ORDER BY t.sort_order, t.created_at`,
  ).bind(userId, ...ids).all<Row>()
  for (const row of rows.results ?? []) {
    const assetId = text(row.asset_id)
    const list = map.get(assetId) ?? []
    list.push(tagSummary(row))
    map.set(assetId, list)
  }
  return map
}

export async function getAsset(db: D1Database, userId: string, id: string): Promise<IconAssetDetail> {
  const shard = await userShard(userId)
  const row = await db.prepare(
    `SELECT ${ASSET_COLUMNS}, COALESCE(s.favorited, 0) AS favorited, COALESCE(s.pinned, 0) AS pinned,
            COALESCE(s.use_count, 0) AS use_count, s.last_used_at
       FROM development_icons_assets a
       LEFT JOIN development_icons_user_state s ON s.user_id = a.user_id AND s.asset_id = a.id
      WHERE a.user_id = ?1 AND a.id = ?2`,
  ).bind(userId, id).first<Row>()
  if (!row) throw ApiError.notFound('The icon was not found')
  const tagMap = await tagsForAssets(db, userId, [id])
  return assetDetail(row, shard, tagMap.get(id) ?? [], number(row.favorited) === 1, number(row.pinned) === 1, number(row.use_count), nullableNumber(row.last_used_at))
}

export async function createCollection(db: D1Database, userId: string, input: { name: string; description: string; source: string; license: string; homepage: string; sortOrder: number }): Promise<IconCollection> {
  const id = newId()
  const now = Date.now()
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || id
  await db.prepare(
    `INSERT INTO development_icons_collections (user_id, id, name, slug, description, source, license, homepage, sort_order, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
  ).bind(userId, id, input.name, slug, input.description, input.source, input.license, input.homepage, input.sortOrder, now).run()
  return { id, name: input.name, slug, description: input.description, source: input.source as IconCollection['source'], license: input.license, homepage: input.homepage, sortOrder: input.sortOrder, createdAt: now, updatedAt: now }
}

export async function updateCollection(db: D1Database, userId: string, id: string, patch: Record<string, unknown>): Promise<void> {
  const fields: string[] = []
  const values: unknown[] = [userId, id]
  const set = (column: string, value: unknown): void => {
    values.push(value)
    fields.push(`${column} = ?${values.length}`)
  }
  if (patch.name !== undefined) set('name', patch.name)
  if (patch.description !== undefined) set('description', patch.description)
  if (patch.license !== undefined) set('license', patch.license)
  if (patch.homepage !== undefined) set('homepage', patch.homepage)
  if (patch.sortOrder !== undefined) set('sort_order', patch.sortOrder)
  if (!fields.length) return
  values.push(Date.now())
  fields.push(`updated_at = ?${values.length}`)
  const result = await db.prepare(`UPDATE development_icons_collections SET ${fields.join(', ')} WHERE user_id = ?1 AND id = ?2`).bind(...values).run()
  if (!result.meta.changes) throw ApiError.notFound('The collection was not found')
}

export async function deleteCollection(db: D1Database, userId: string, id: string): Promise<void> {
  const now = Date.now()
  await db.batch([
    db.prepare(`UPDATE development_icons_assets SET collection_id = NULL, updated_at = ?3 WHERE user_id = ?1 AND collection_id = ?2`).bind(userId, id, now),
    db.prepare(`DELETE FROM development_icons_collections WHERE user_id = ?1 AND id = ?2`).bind(userId, id),
  ])
}

export async function createTag(db: D1Database, userId: string, input: { name: string; color: string; parentId: string | null; sortOrder: number }): Promise<IconTag> {
  if (input.parentId) {
    const parent = await db.prepare(`SELECT id FROM development_icons_tags WHERE user_id = ?1 AND id = ?2`).bind(userId, input.parentId).first()
    if (!parent) throw ApiError.badRequest('The parent tag was not found')
  }
  const id = newId()
  const now = Date.now()
  await db.prepare(
    `INSERT INTO development_icons_tags (user_id, id, name, name_key, color, parent_id, sort_order, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
  ).bind(userId, id, input.name, input.name.toLowerCase(), input.color, input.parentId, input.sortOrder, now).run()
  return { id, name: input.name, color: input.color, parentId: input.parentId, sortOrder: input.sortOrder, createdAt: now, updatedAt: now }
}

export async function updateTag(db: D1Database, userId: string, id: string, patch: Record<string, unknown>): Promise<void> {
  if (patch.parentId) {
    const rows = await db.prepare(`SELECT id, parent_id FROM development_icons_tags WHERE user_id = ?1`).bind(userId).all<Row>()
    const descendants = new Set<string>([id])
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows.results ?? []) {
        const rowId = text(row.id)
        const parentId = typeof row.parent_id === 'string' ? row.parent_id : null
        if (parentId && descendants.has(parentId) && !descendants.has(rowId)) {
          descendants.add(rowId)
          changed = true
        }
      }
    }
    if (descendants.has(String(patch.parentId))) throw ApiError.badRequest('A tag cannot be moved under its own descendant')
  }
  const fields: string[] = []
  const values: unknown[] = [userId, id]
  const set = (column: string, value: unknown): void => {
    values.push(value)
    fields.push(`${column} = ?${values.length}`)
  }
  if (patch.name !== undefined) {
    set('name', patch.name)
    set('name_key', String(patch.name).toLowerCase())
  }
  if (patch.color !== undefined) set('color', patch.color)
  if (patch.parentId !== undefined) set('parent_id', patch.parentId)
  if (patch.sortOrder !== undefined) set('sort_order', patch.sortOrder)
  if (!fields.length) return
  values.push(Date.now())
  fields.push(`updated_at = ?${values.length}`)
  const result = await db.prepare(`UPDATE development_icons_tags SET ${fields.join(', ')} WHERE user_id = ?1 AND id = ?2`).bind(...values).run()
  if (!result.meta.changes) throw ApiError.notFound('The tag was not found')
}

export async function deleteTag(db: D1Database, userId: string, id: string): Promise<void> {
  const rows = await db.prepare(`SELECT id, parent_id FROM development_icons_tags WHERE user_id = ?1`).bind(userId).all<Row>()
  const remove = new Set<string>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows.results ?? []) {
      const rowId = text(row.id)
      const parentId = typeof row.parent_id === 'string' ? row.parent_id : null
      if (parentId && remove.has(parentId) && !remove.has(rowId)) {
        remove.add(rowId)
        changed = true
      }
    }
  }
  const ids = [...remove]
  const placeholders = ids.map((_, index) => `?${index + 2}`).join(', ')
  await db.batch([
    db.prepare(`DELETE FROM development_icons_tag_links WHERE user_id = ?1 AND tag_id IN (${placeholders})`).bind(userId, ...ids),
    db.prepare(`DELETE FROM development_icons_tags WHERE user_id = ?1 AND id IN (${placeholders})`).bind(userId, ...ids),
  ])
}

export async function setAsset(db: D1Database, userId: string, id: string, patch: Record<string, unknown>): Promise<void> {
  const fields: string[] = []
  const values: unknown[] = [userId, id]
  const set = (column: string, value: unknown): void => {
    values.push(value)
    fields.push(`${column} = ?${values.length}`)
  }
  if (patch.name !== undefined) {
    set('name', patch.name)
    set('name_key', String(patch.name).toLowerCase())
  }
  if (patch.collectionId !== undefined) set('collection_id', patch.collectionId)
  if (patch.keywords !== undefined) set('keywords', patch.keywords)
  if (fields.length) {
    values.push(Date.now())
    fields.push(`updated_at = ?${values.length}`)
    await db.prepare(`UPDATE development_icons_assets SET ${fields.join(', ')} WHERE user_id = ?1 AND id = ?2`).bind(...values).run()
  }
  if (Array.isArray(patch.tagIds)) await setAssetTags(db, userId, id, patch.tagIds.map(String))
}

export async function setAssetTags(db: D1Database, userId: string, id: string, tagIds: string[]): Promise<void> {
  const unique = [...new Set(tagIds)]
  const statements = [
    db.prepare(`DELETE FROM development_icons_tag_links WHERE user_id = ?1 AND asset_id = ?2`).bind(userId, id),
    ...unique.map((tagId) => db.prepare(
      `INSERT OR IGNORE INTO development_icons_tag_links (user_id, asset_id, tag_id, created_at) VALUES (?1, ?2, ?3, ?4)`,
    ).bind(userId, id, tagId, Date.now())),
  ]
  await db.batch(statements)
}

export async function deleteAsset(db: D1Database, userId: string, id: string): Promise<{ r2Key: string; thumbKey: string | null }> {
  const row = await db.prepare(`SELECT r2_key, thumb_key FROM development_icons_assets WHERE user_id = ?1 AND id = ?2`).bind(userId, id).first<Row>()
  if (!row) throw ApiError.notFound('The icon was not found')
  await db.batch([
    db.prepare(`DELETE FROM development_icons_tag_links WHERE user_id = ?1 AND asset_id = ?2`).bind(userId, id),
    db.prepare(`DELETE FROM development_icons_user_state WHERE user_id = ?1 AND asset_id = ?2`).bind(userId, id),
    db.prepare(`DELETE FROM development_icons_usage_daily WHERE user_id = ?1 AND asset_id = ?2`).bind(userId, id),
    db.prepare(`DELETE FROM development_icons_assets WHERE user_id = ?1 AND id = ?2`).bind(userId, id),
  ])
  return { r2Key: text(row.r2_key), thumbKey: typeof row.thumb_key === 'string' ? row.thumb_key : null }
}

export async function setState(db: D1Database, userId: string, id: string, patch: { favorited?: boolean; pinned?: boolean }): Promise<void> {
  const now = Date.now()
  const favorite = patch.favorited === undefined ? null : patch.favorited ? 1 : 0
  const pinned = patch.pinned === undefined ? null : patch.pinned ? 1 : 0
  await db.prepare(
    `INSERT INTO development_icons_user_state (user_id, asset_id, favorited, pinned, pinned_at, use_count, last_used_at, updated_at)
     VALUES (?1, ?2, COALESCE(?3, 0), COALESCE(?4, 0), CASE WHEN ?4 = 1 THEN ?5 ELSE NULL END, 0, NULL, ?5)
     ON CONFLICT(user_id, asset_id) DO UPDATE SET
       favorited = COALESCE(?3, favorited),
       pinned = COALESCE(?4, pinned),
       pinned_at = CASE WHEN ?4 = 1 THEN ?5 WHEN ?4 = 0 THEN NULL ELSE pinned_at END,
       updated_at = ?5`,
  ).bind(userId, id, favorite, pinned, now).run()
}

export async function recordUsage(db: D1Database, userId: string, id: string, action: string, day: string): Promise<void> {
  const now = Date.now()
  await db.batch([
    db.prepare(
      `INSERT INTO development_icons_usage_daily (user_id, day, asset_id, action, count, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5)
       ON CONFLICT(user_id, day, asset_id, action) DO UPDATE SET count = count + 1, updated_at = ?5`,
    ).bind(userId, day, id, action, now),
    db.prepare(
      `INSERT INTO development_icons_user_state (user_id, asset_id, favorited, pinned, pinned_at, use_count, last_used_at, updated_at)
       VALUES (?1, ?2, 0, 0, NULL, 1, ?3, ?3)
       ON CONFLICT(user_id, asset_id) DO UPDATE SET use_count = use_count + 1, last_used_at = ?3, updated_at = ?3`,
    ).bind(userId, id, now),
  ])
}

export async function stats(db: D1Database, userId: string, days = 365): Promise<{ daily: { day: string; count: number }[]; top: { id: string; name: string; count: number }[] }> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const [daily, top] = await Promise.all([
    db.prepare(
      `SELECT day, SUM(count) AS count FROM development_icons_usage_daily
        WHERE user_id = ?1 AND day >= ?2 GROUP BY day ORDER BY day`,
    ).bind(userId, cutoff).all<{ day: string; count: number }>(),
    db.prepare(
      `SELECT u.asset_id AS id, a.name, SUM(u.count) AS count
         FROM development_icons_usage_daily u
         JOIN development_icons_assets a ON a.user_id = u.user_id AND a.id = u.asset_id
        WHERE u.user_id = ?1 AND u.day >= ?2
        GROUP BY u.asset_id ORDER BY count DESC LIMIT 12`,
    ).bind(userId, cutoff).all<{ id: string; name: string; count: number }>(),
  ])
  return { daily: daily.results ?? [], top: top.results ?? [] }
}

export async function updateSettings(db: D1Database, userId: string, patch: Record<string, number>): Promise<IconSettings> {
  const settings = await ensureSettings(db, userId)
  const limits = await ensureLimits(db)
  const merged = {
    quotaBytes: Math.min(patch.quotaBytes ?? settings.quotaBytes, limits.hardQuotaBytes),
    maxSvgBytes: Math.min(patch.maxSvgBytes ?? settings.maxSvgBytes, limits.hardMaxSvgBytes),
    maxRasterBytes: Math.min(patch.maxRasterBytes ?? settings.maxRasterBytes, limits.hardMaxRasterBytes),
    maxDimension: Math.min(patch.maxDimension ?? settings.maxDimension, limits.hardMaxDimension),
    batchLimit: Math.min(patch.batchLimit ?? settings.batchLimit, limits.hardBatchLimit),
    zipLimitBytes: Math.min(patch.zipLimitBytes ?? settings.zipLimitBytes, limits.hardZipLimitBytes),
    zipLimitEntries: Math.min(patch.zipLimitEntries ?? settings.zipLimitEntries, limits.hardZipLimitEntries),
  }
  await db.prepare(
    `UPDATE development_icons_settings SET quota_bytes=?2, max_svg_bytes=?3, max_raster_bytes=?4, max_dimension=?5,
       batch_limit=?6, zip_limit_bytes=?7, zip_limit_entries=?8, updated_at=?9 WHERE user_id=?1`,
  ).bind(userId, merged.quotaBytes, merged.maxSvgBytes, merged.maxRasterBytes, merged.maxDimension, merged.batchLimit, merged.zipLimitBytes, merged.zipLimitEntries, Date.now()).run()
  return merged
}

export async function updateLimits(db: D1Database, patch: Record<string, number>): Promise<IconLimits> {
  const limits = await ensureLimits(db)
  const merged = {
    hardQuotaBytes: patch.hardQuotaBytes ?? limits.hardQuotaBytes,
    hardMaxSvgBytes: patch.hardMaxSvgBytes ?? limits.hardMaxSvgBytes,
    hardMaxRasterBytes: patch.hardMaxRasterBytes ?? limits.hardMaxRasterBytes,
    hardMaxDimension: patch.hardMaxDimension ?? limits.hardMaxDimension,
    hardBatchLimit: patch.hardBatchLimit ?? limits.hardBatchLimit,
    hardZipLimitBytes: patch.hardZipLimitBytes ?? limits.hardZipLimitBytes,
    hardZipLimitEntries: patch.hardZipLimitEntries ?? limits.hardZipLimitEntries,
  }
  await db.prepare(
    `UPDATE development_icons_limits SET hard_quota_bytes=?1, hard_max_svg_bytes=?2, hard_max_raster_bytes=?3,
       hard_max_dimension=?4, hard_batch_limit=?5, hard_zip_limit_bytes=?6, hard_zip_limit_entries=?7, updated_at=?8 WHERE id=1`,
  ).bind(merged.hardQuotaBytes, merged.hardMaxSvgBytes, merged.hardMaxRasterBytes, merged.hardMaxDimension, merged.hardBatchLimit, merged.hardZipLimitBytes, merged.hardZipLimitEntries, Date.now()).run()
  return merged
}

export function jobRow(row: Row): IconJob {
  return {
    id: text(row.id),
    kind: text(row.kind, 'png') as IconJob['kind'],
    status: text(row.status, 'queued') as IconJob['status'],
    options: JSON.parse(text(row.options_json, '{}')) as IconJob['options'],
    totalItems: number(row.total_items),
    processedItems: number(row.processed_items),
    failedItems: number(row.failed_items),
    error: text(row.error),
    manifestUrl: text(row.manifest_key) ? `/api/development/icons/jobs/${text(row.id)}/manifest` : null,
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at),
    startedAt: nullableNumber(row.started_at),
    finishedAt: nullableNumber(row.finished_at),
  }
}

export async function createJob(db: D1Database, userId: string, assetIds: string[], options: IconJob['options']): Promise<IconJob> {
  const settings = await ensureSettings(db, userId)
  if (assetIds.length > settings.batchLimit) throw ApiError.badRequest('The batch limit was exceeded')
  const id = newId()
  const now = Date.now()
  const statements = [
    db.prepare(
      `INSERT INTO development_icons_jobs (user_id, id, kind, status, options_json, total_items, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?6)`,
    ).bind(userId, id, options.kind, JSON.stringify(options), assetIds.length, now),
    ...assetIds.map((assetId) => db.prepare(
      `INSERT OR IGNORE INTO development_icons_job_items (user_id, job_id, asset_id, status, updated_at)
       VALUES (?1, ?2, ?3, 'queued', ?4)`,
    ).bind(userId, id, assetId, now)),
  ]
  await db.batch(statements)
  return jobRow({ id, kind: options.kind, status: 'queued', options_json: JSON.stringify(options), total_items: assetIds.length, created_at: now, updated_at: now })
}

export async function getJob(db: D1Database, userId: string, id: string): Promise<IconJob> {
  const row = await db.prepare(`SELECT * FROM development_icons_jobs WHERE user_id = ?1 AND id = ?2`).bind(userId, id).first<Row>()
  if (!row) throw ApiError.notFound('The conversion task was not found')
  return jobRow(row)
}

export async function getJobItems(db: D1Database, userId: string, id: string): Promise<IconJobItem[]> {
  const rows = await db.prepare(
    `SELECT asset_id, status, outputs_json, attempts, error FROM development_icons_job_items WHERE user_id = ?1 AND job_id = ?2`,
  ).bind(userId, id).all<Row>()
  return (rows.results ?? []).map((row) => ({
    assetId: text(row.asset_id),
    status: text(row.status, 'queued') as IconJobItem['status'],
    outputs: JSON.parse(text(row.outputs_json, '{}')) as Record<string, string>,
    attempts: number(row.attempts),
    error: text(row.error),
  }))
}

export async function setJobStatus(db: D1Database, userId: string, id: string, status: IconJob['status'], error = ''): Promise<void> {
  const now = Date.now()
  await db.prepare(
    `UPDATE development_icons_jobs SET status=?3, error=?4, updated_at=?5,
       started_at=CASE WHEN ?3='running' THEN COALESCE(started_at, ?5) ELSE started_at END,
       finished_at=CASE WHEN ?3 IN ('done','partial','failed','canceled') THEN ?5 ELSE finished_at END
     WHERE user_id=?1 AND id=?2`,
  ).bind(userId, id, status, error, now).run()
}

export async function listExports(db: D1Database, userId: string): Promise<IconExport[]> {
  const rows = await db.prepare(
    `SELECT * FROM development_icons_exports WHERE user_id=?1 ORDER BY created_at DESC LIMIT 20`,
  ).bind(userId).all<Row>()
  return (rows.results ?? []).map((row) => ({
    id: text(row.id),
    format: text(row.format, 'zip') as IconExport['format'],
    filename: text(row.filename),
    bytes: number(row.bytes),
    assetCount: number(row.asset_count),
    status: text(row.status, 'pending') as IconExport['status'],
    error: text(row.error),
    createdAt: number(row.created_at),
    expiresAt: number(row.expires_at),
    downloadUrl: `/api/development/icons/exports/${text(row.id)}/download`,
  }))
}

export async function createExportRow(db: D1Database, userId: string, input: { format: string; filename: string; r2Key: string; bytes: number; assetCount: number; expiresAt: number }): Promise<IconExport> {
  const id = newId()
  const now = Date.now()
  await db.prepare(
    `INSERT INTO development_icons_exports (user_id, id, format, filename, r2_key, bytes, asset_count, status, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'done', ?8, ?9)`,
  ).bind(userId, id, input.format, input.filename, input.r2Key, input.bytes, input.assetCount, now, input.expiresAt).run()
  return { id, format: input.format as IconExport['format'], filename: input.filename, bytes: input.bytes, assetCount: input.assetCount, status: 'done', error: '', createdAt: now, expiresAt: input.expiresAt, downloadUrl: `/api/development/icons/exports/${id}/download` }
}

export async function listImports(db: D1Database, userId: string): Promise<IconImport[]> {
  const rows = await db.prepare(`SELECT * FROM development_icons_imports WHERE user_id=?1 ORDER BY created_at DESC LIMIT 20`).bind(userId).all<Row>()
  return (rows.results ?? []).map((row) => ({
    id: text(row.id),
    kind: text(row.kind, 'upload') as IconImport['kind'],
    status: text(row.status, 'pending') as IconImport['status'],
    prefix: text(row.prefix),
    totalItems: number(row.total_items),
    processedItems: number(row.processed_items),
    failedItems: number(row.failed_items),
    skippedItems: number(row.skipped_items),
    bytesTotal: number(row.bytes_total),
    error: text(row.error),
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at),
    finishedAt: nullableNumber(row.finished_at),
  }))
}
