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
  IconUsageSummary,
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
  ICON_JOB_MAX_ITEMS,
  ICON_RECENT_DAYS,
  ICON_SPRITE_MAX_ASSETS,
} from '@shared/development/icons/limits'
import { decodeIconCursor, encodeIconCursor } from '@shared/development/icons/cursor'
import {
  ICON_BRAND_PREFIXES,
  ICON_FILL_PREFIXES,
  ICON_LINE_PREFIXES,
} from '@shared/development/icons/builtins'
import { ApiError } from '../../lib/errors'
import { newId } from '../../lib/id'
import { iconObjectUrl, iconPublicUrl, userShard } from './r2'

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
  const rawUrl = iconObjectUrl(format, shard, sha256)
  const thumbKey = typeof row.thumb_key === 'string' ? row.thumb_key : ''
  const thumbUrl = thumbKey ? iconPublicUrl(thumbKey) : rawUrl
  const thumb2xKey = thumbKey.replace(/-w96\.webp$/, '-w192.webp')
  return {
    id: text(row.id),
    name: text(row.name),
    collectionId: typeof row.collection_id === 'string' ? row.collection_id : null,
    format,
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    bytes: number(row.bytes),
    sha256,
    thumbUrl,
    thumb2xUrl: thumbKey ? iconPublicUrl(thumb2xKey) : thumbUrl,
    rawUrl,
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

export async function usageFor(db: D1Database, userId: string): Promise<IconUsageSummary> {
  const [settings, assets, outputs, exports] = await Promise.all([
    ensureSettings(db, userId),
    db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS bytes FROM development_icons_assets WHERE user_id = ?1`).bind(userId).first<{ bytes: number }>(),
    db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS bytes FROM development_icons_job_outputs WHERE user_id = ?1`).bind(userId).first<{ bytes: number }>(),
    db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS bytes FROM development_icons_exports WHERE user_id = ?1 AND expires_at > ?2`).bind(userId, Date.now()).first<{ bytes: number }>(),
  ])
  const assetsBytes = number(assets?.bytes)
  const outputsBytes = number(outputs?.bytes)
  const exportsBytes = number(exports?.bytes)
  const usedBytes = assetsBytes + outputsBytes + exportsBytes
  return {
    usedBytes,
    quotaBytes: settings.quotaBytes,
    assetsBytes,
    outputsBytes,
    exportsBytes,
    overQuota: usedBytes > settings.quotaBytes,
  }
}

export async function bootstrap(db: D1Database, userId: string, isOwner = false): Promise<IconBootstrap> {
  const [collectionsResult, tagsResult, settings, limits, shard, usage] = await Promise.all([
    db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM development_icons_assets a WHERE a.user_id = c.user_id AND a.collection_id = c.id) AS count
         FROM development_icons_collections c WHERE c.user_id = ?1 ORDER BY c.sort_order, c.name`,
    ).bind(userId).all<Row>(),
    db.prepare(`SELECT * FROM development_icons_tags WHERE user_id = ?1 ORDER BY sort_order, created_at`).bind(userId).all<Row>(),
    ensureSettings(db, userId),
    ensureLimits(db),
    userShard(userId),
    usageFor(db, userId),
  ])
  const counts = await countsFor(db, userId, shard)
  return {
    collections: (collectionsResult.results ?? []).map(collectionRow),
    tags: (tagsResult.results ?? []).map(tagRow),
    counts,
    settings,
    limits,
    usage,
    isOwner,
    schemaVersions: [320, 321, 327, 328],
  }
}

export async function countsFor(db: D1Database, userId: string, _shard: string): Promise<IconCounts> {
  const cutoff = Date.now() - ICON_RECENT_DAYS * 24 * 60 * 60 * 1000
  const [all, favorites, pinned, recent, uncategorized, collections, tags, formats, colorModes, styles] = await Promise.all([
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
    db.prepare(
      `SELECT format AS id, COUNT(*) AS n FROM development_icons_assets WHERE user_id = ?1 GROUP BY format`,
    ).bind(userId).all<{ id: string; n: number }>(),
    db.prepare(
      `SELECT color_mode AS id, COUNT(*) AS n FROM development_icons_assets WHERE user_id = ?1 GROUP BY color_mode`,
    ).bind(userId).all<{ id: string; n: number }>(),
    db.prepare(
      `SELECT CASE
                WHEN a.name_key LIKE '%-duotone%' THEN 'duotone'
                WHEN c.slug IN (${sqlList(ICON_BRAND_PREFIXES)}) THEN 'brand'
                WHEN c.slug IN (${sqlList(ICON_FILL_PREFIXES)})
                  OR a.name_key LIKE '%-fill%'
                  OR a.name_key LIKE '%-solid%' THEN 'fill'
                WHEN c.slug IN (${sqlList(ICON_LINE_PREFIXES)}) THEN 'line'
                ELSE 'unknown'
              END AS style_key,
              COUNT(*) AS n
         FROM development_icons_assets a
         LEFT JOIN development_icons_collections c ON c.user_id = a.user_id AND c.id = a.collection_id
        WHERE a.user_id = ?1
        GROUP BY style_key`,
    ).bind(userId).all<{ style_key: string; n: number }>(),
  ])
  return {
    all: number(all?.n),
    favorites: number(favorites?.n),
    pinned: number(pinned?.n),
    recent: number(recent?.n),
    uncategorized: number(uncategorized?.n),
    collections: Object.fromEntries((collections.results ?? []).map((row) => [row.id, row.n])),
    tags: Object.fromEntries((tags.results ?? []).map((row) => [row.id, row.n])),
    formats: Object.fromEntries((formats.results ?? []).map((row) => [row.id, row.n])),
    colorModes: Object.fromEntries((colorModes.results ?? []).map((row) => [row.id, row.n])),
    styles: Object.fromEntries((styles.results ?? []).map((row) => [row.style_key, row.n])),
  }
}

interface ListInput {
  limit: number
  cursor?: string
  q?: string
  collectionId?: string
  collections?: string[]
  tagId?: string
  tags?: string[]
  format?: string
  formats?: string[]
  style?: 'line' | 'fill' | 'duotone' | 'brand'
  colorMode?: 'mono' | 'multi'
  sizeMin?: number
  sizeMax?: number
  from?: number
  to?: number
  state: string
  sort: string
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ')
}

function styleCondition(style: NonNullable<ListInput['style']>): string {
  const line = sqlList(ICON_LINE_PREFIXES)
  const fill = sqlList(ICON_FILL_PREFIXES)
  const brand = sqlList(ICON_BRAND_PREFIXES)
  if (style === 'duotone') return `(a.name_key LIKE '%-duotone%')`
  if (style === 'brand') return `(c.slug IN (${brand}))`
  if (style === 'line') {
    return `(c.slug IN (${line}) AND a.name_key NOT LIKE '%-fill%' AND a.name_key NOT LIKE '%-solid%' AND a.name_key NOT LIKE '%-duotone%')`
  }
  return `((c.slug IN (${fill}) OR a.name_key LIKE '%-fill%' OR a.name_key LIKE '%-solid%') AND a.name_key NOT LIKE '%-duotone%')`
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
  const addIn = (column: string, ids: readonly string[]): void => {
    const marks = ids.map((id) => {
      values.push(id)
      return `?${values.length}`
    })
    where.push(`${column} IN (${marks.join(', ')})`)
  }
  let searchRowIds: number[] | null = null
  if (input.q && input.q.trim().length >= 3) {
    const query = `"${input.q.trim().replace(/"/g, '""')}"`
    const matches = await db.prepare(
      `SELECT rowid FROM development_icons_fts WHERE development_icons_fts MATCH ?1 AND user_id = ?2 LIMIT 80`,
    ).bind(query, userId).all<{ rowid: number }>()
    searchRowIds = (matches.results ?? []).map((row) => row.rowid)
    if (!searchRowIds.length) return { items: [], nextCursor: null, hasMore: false, total: 0 }
  }
  if (input.collectionId) add('a.collection_id = ?', input.collectionId)
  if (input.collections?.length) addIn('a.collection_id', input.collections)
  if (input.format) add('a.format = ?', input.format)
  if (input.formats?.length) addIn('a.format', input.formats)
  if (input.tagId) add('EXISTS (SELECT 1 FROM development_icons_tag_links l WHERE l.user_id = a.user_id AND l.asset_id = a.id AND l.tag_id = ?)', input.tagId)
  if (input.tags?.length) {
    const marks = input.tags.map((tagId) => {
      values.push(tagId)
      return `?${values.length}`
    })
    where.push(`EXISTS (SELECT 1 FROM development_icons_tag_links l WHERE l.user_id = a.user_id AND l.asset_id = a.id AND l.tag_id IN (${marks.join(', ')}))`)
  }
  if (input.style) where.push(styleCondition(input.style))
  if (input.colorMode) add('a.color_mode = ?', input.colorMode)
  if (input.sizeMin !== undefined) add('COALESCE(a.width, 0) >= ?', input.sizeMin)
  if (input.sizeMax !== undefined) add('COALESCE(a.width, 0) <= ?', input.sizeMax)
  if (input.from !== undefined) add('a.created_at >= ?', input.from)
  if (input.to !== undefined) add('a.created_at <= ?', input.to)
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
      // A percent or underscore a reader types is a character in the name, not a wildcard.
      const escaped = query.toLowerCase().replace(/[\\%_]/g, '\\$&')
      add("a.name_key LIKE ? ESCAPE '\\'", `${escaped}%`)
    }
  }
  // The total is measured over the filters, before the cursor narrows the page, so the toolbar can
  // say how many icons the current selection holds even while the grid streams in later pages.
  const filterWhere = [...where]
  const filterValues = [...values]
  const totalRow = await db.prepare(
    `SELECT COUNT(*) AS n
       FROM development_icons_assets a
       LEFT JOIN development_icons_collections c ON c.user_id = a.user_id AND c.id = a.collection_id
       LEFT JOIN development_icons_user_state s ON s.user_id = a.user_id AND s.asset_id = a.id
      WHERE ${filterWhere.join(' AND ')}`,
  ).bind(...filterValues).first<{ n: number }>()
  const total = number(totalRow?.n)
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
       LEFT JOIN development_icons_collections c ON c.user_id = a.user_id AND c.id = a.collection_id
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
  return { items: mapped, nextCursor, hasMore: results.length > limit, total }
}

async function tagsForAssets(db: D1Database, userId: string, ids: string[]): Promise<Map<string, IconTagSummary[]>> {
  const map = new Map<string, IconTagSummary[]>()
  if (!ids.length) return map
  for (let index = 0; index < ids.length; index += 90) {
    const slice = ids.slice(index, index + 90)
    const placeholders = slice.map((_, offset) => `?${offset + 2}`).join(', ')
    const rows = await db.prepare(
      `SELECT l.asset_id, l.tag_id, t.name, t.color
         FROM development_icons_tag_links l
         JOIN development_icons_tags t ON t.user_id = l.user_id AND t.id = l.tag_id
        WHERE l.user_id = ?1 AND l.asset_id IN (${placeholders})
        ORDER BY t.sort_order, t.created_at`,
    ).bind(userId, ...slice).all<Row>()
    for (const row of rows.results ?? []) {
      const assetId = text(row.asset_id)
      const list = map.get(assetId) ?? []
      list.push(tagSummary(row))
      map.set(assetId, list)
    }
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
    mode: text(row.execution, 'browser') === 'queue' ? 'queue' : 'browser',
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

export async function createJob(
  db: D1Database,
  userId: string,
  assetIds: string[],
  options: IconJob['options'],
  execution: 'queue' | 'browser',
): Promise<IconJob> {
  const settings = await ensureSettings(db, userId)
  if (assetIds.length > settings.batchLimit || assetIds.length > ICON_JOB_MAX_ITEMS) throw ApiError.badRequest('The batch limit was exceeded')
  const uniqueIds = [...new Set(assetIds)]
  if (uniqueIds.length !== assetIds.length) throw ApiError.badRequest('The batch repeats an icon')
  let ownedCount = 0
  for (let index = 0; index < uniqueIds.length; index += 90) {
    const slice = uniqueIds.slice(index, index + 90)
    const marks = slice.map((_, offset) => `?${offset + 2}`).join(', ')
    const owned = await db.prepare(
      `SELECT COUNT(*) AS n FROM development_icons_assets WHERE user_id=?1 AND id IN (${marks})`,
    ).bind(userId, ...slice).first<{ n: number }>()
    ownedCount += Number(owned?.n ?? 0)
  }
  if (ownedCount !== uniqueIds.length) throw ApiError.notFound('An icon in this task was not found')
  if (options.kind === 'sprite_svg' || options.kind === 'sprite_png') {
    if (assetIds.length > ICON_SPRITE_MAX_ASSETS) throw ApiError.badRequest('The sprite asset limit was exceeded')
  }
  const usage = await usageFor(db, userId)
  if (usage.overQuota) throw new ApiError(413, 'icons_quota_exceeded', 'The icon storage quota is exceeded')
  const running = await db.prepare(
    `SELECT id FROM development_icons_jobs WHERE user_id = ?1 AND status IN ('queued','running') LIMIT 1`,
  ).bind(userId).first<{ id: string }>()
  if (running) throw new ApiError(409, 'icons_job_conflict', 'Another conversion task is still running')
  const id = newId()
  const now = Date.now()
  await db.prepare(
    `INSERT INTO development_icons_jobs (user_id, id, kind, status, execution, options_json, total_items, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?7, ?7)`,
  ).bind(userId, id, options.kind, execution, JSON.stringify(options), assetIds.length, now).run()
  for (let index = 0; index < assetIds.length; index += 50) {
    const slice = assetIds.slice(index, index + 50)
    await db.batch(slice.map((assetId) => db.prepare(
      `INSERT OR IGNORE INTO development_icons_job_items (user_id, job_id, asset_id, status, updated_at)
       VALUES (?1, ?2, ?3, 'queued', ?4)`,
    ).bind(userId, id, assetId, now)))
  }
  return jobRow({
    id,
    kind: options.kind,
    status: 'queued',
    execution,
    options_json: JSON.stringify(options),
    total_items: assetIds.length,
    created_at: now,
    updated_at: now,
  })
}

export async function listJobs(db: D1Database, userId: string): Promise<IconJob[]> {
  const rows = await db.prepare(
    `SELECT * FROM development_icons_jobs WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 20`,
  ).bind(userId).all<Row>()
  return (rows.results ?? []).map(jobRow)
}

export async function getJob(db: D1Database, userId: string, id: string): Promise<IconJob> {
  const row = await db.prepare(`SELECT * FROM development_icons_jobs WHERE user_id = ?1 AND id = ?2`).bind(userId, id).first<Row>()
  if (!row) throw ApiError.notFound('The conversion task was not found')
  return jobRow(row)
}

export interface JobAssetRow {
  id: string
  name: string
  format: string
  mime: string
  r2Key: string
  sha256: string
  width: number | null
  height: number | null
  collectionId: string | null
  license: string
  sourceUrl: string
}

export async function getJobAssets(db: D1Database, userId: string, jobId: string, onlyPending = true): Promise<JobAssetRow[]> {
  const rows = await db.prepare(
    `SELECT a.id, a.name, a.format, a.mime, a.r2_key, a.sha256, a.width, a.height,
            a.collection_id, a.license, a.source_url, i.status
       FROM development_icons_job_items i
       JOIN development_icons_assets a ON a.user_id = i.user_id AND a.id = i.asset_id
      WHERE i.user_id = ?1 AND i.job_id = ?2${onlyPending ? ` AND i.status IN ('queued','running')` : ''}
      ORDER BY a.name_key, a.id`,
  ).bind(userId, jobId).all<Row>()
  return (rows.results ?? []).map((row) => ({
    id: text(row.id),
    name: text(row.name),
    format: text(row.format, 'svg'),
    mime: text(row.mime),
    r2Key: text(row.r2_key),
    sha256: text(row.sha256),
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    collectionId: typeof row.collection_id === 'string' ? row.collection_id : null,
    license: text(row.license),
    sourceUrl: text(row.source_url),
  }))
}

export async function getAssetsByIds(db: D1Database, userId: string, ids: readonly string[]): Promise<JobAssetRow[]> {
  if (!ids.length) return []
  const rows: Row[] = []
  for (let index = 0; index < ids.length; index += 90) {
    const slice = ids.slice(index, index + 90)
    const marks = slice.map((_, offset) => `?${offset + 2}`).join(', ')
    const page = await db.prepare(
      `SELECT id, name, format, mime, r2_key, sha256, width, height, collection_id, license, source_url
         FROM development_icons_assets WHERE user_id = ?1 AND id IN (${marks}) ORDER BY name_key, id`,
    ).bind(userId, ...slice).all<Row>()
    rows.push(...(page.results ?? []))
  }
  return rows.map((row) => ({
    id: text(row.id),
    name: text(row.name),
    format: text(row.format, 'svg'),
    mime: text(row.mime),
    r2Key: text(row.r2_key),
    sha256: text(row.sha256),
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    collectionId: typeof row.collection_id === 'string' ? row.collection_id : null,
    license: text(row.license),
    sourceUrl: text(row.source_url),
  }))
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

export async function markJobRunning(db: D1Database, userId: string, id: string): Promise<void> {
  const now = Date.now()
  await db.prepare(
    `UPDATE development_icons_jobs SET status='running', started_at=COALESCE(started_at, ?3), updated_at=?3
      WHERE user_id=?1 AND id=?2 AND status='queued'`,
  ).bind(userId, id, now).run()
}

export async function setJobItemOutcome(
  db: D1Database,
  userId: string,
  jobId: string,
  assetId: string,
  status: IconJobItem['status'],
  outputs: Record<string, string>,
  error = '',
): Promise<void> {
  const now = Date.now()
  await db.prepare(
    `UPDATE development_icons_job_items
        SET status=?4, outputs_json=?5, error=?6, attempts=attempts+1, updated_at=?7
      WHERE user_id=?1 AND job_id=?2 AND asset_id=?3 AND (?4='skipped' OR status<>'skipped')`,
  ).bind(userId, jobId, assetId, status, JSON.stringify(outputs), error, now).run()
}

export async function recordJobOutput(
  db: D1Database,
  userId: string,
  jobId: string,
  assetId: string,
  name: string,
  r2Key: string,
  bytes: number,
  sha256: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO development_icons_job_outputs (user_id, job_id, asset_id, name, r2_key, bytes, sha256, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(user_id, job_id, asset_id, name) DO UPDATE SET
       r2_key=excluded.r2_key, bytes=excluded.bytes, sha256=excluded.sha256, created_at=excluded.created_at`,
  ).bind(userId, jobId, assetId, name, r2Key, bytes, sha256, Date.now()).run()
}

export async function syncJobProgress(db: D1Database, userId: string, id: string): Promise<{ done: number; failed: number; skipped: number; pending: number }> {
  const row = await db.prepare(
    `SELECT
       SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped,
       SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS pending
     FROM development_icons_job_items WHERE user_id=?1 AND job_id=?2`,
  ).bind(userId, id).first<Row>()
  const counts = {
    done: number(row?.done),
    failed: number(row?.failed),
    skipped: number(row?.skipped),
    pending: number(row?.pending),
  }
  await db.prepare(
    `UPDATE development_icons_jobs SET processed_items=?3, failed_items=?4, updated_at=?5 WHERE user_id=?1 AND id=?2`,
  ).bind(userId, id, counts.done, counts.failed, Date.now()).run()
  return counts
}

export async function finishJobIfComplete(
  db: D1Database,
  userId: string,
  id: string,
  manifestKey: string,
): Promise<IconJob['status'] | null> {
  const counts = await syncJobProgress(db, userId, id)
  if (counts.pending > 0) return null
  const job = await getJob(db, userId, id)
  const status: IconJob['status'] = job.status === 'canceled'
    ? 'canceled'
    : counts.done > 0 && counts.failed > 0
      ? 'partial'
      : counts.done > 0
        ? 'done'
        : counts.failed > 0
          ? 'failed'
          : 'canceled'
  const now = Date.now()
  await db.prepare(
    `UPDATE development_icons_jobs SET status=?3, manifest_key=?4, updated_at=?5, finished_at=?5 WHERE user_id=?1 AND id=?2`,
  ).bind(userId, id, status, manifestKey, now).run()
  return status
}

export async function requestJobCancel(db: D1Database, userId: string, id: string): Promise<void> {
  const now = Date.now()
  await db.batch([
    db.prepare(`UPDATE development_icons_jobs SET cancel_requested=1, updated_at=?3 WHERE user_id=?1 AND id=?2`).bind(userId, id, now),
    db.prepare(
      `UPDATE development_icons_job_items SET status='skipped', updated_at=?3
        WHERE user_id=?1 AND job_id=?2 AND status IN ('queued','running')`,
    ).bind(userId, id, now),
    db.prepare(
      `UPDATE development_icons_jobs SET status=CASE WHEN status IN ('queued','running') THEN 'canceled' ELSE status END,
         manifest_key='', finished_at=CASE WHEN status IN ('queued','running') THEN ?3 ELSE finished_at END, updated_at=?3
        WHERE user_id=?1 AND id=?2`,
    ).bind(userId, id, now),
  ])
  await syncJobProgress(db, userId, id)
}

export async function resetJobForRetry(db: D1Database, userId: string, id: string): Promise<void> {
  const now = Date.now()
  await db.batch([
    db.prepare(
      `UPDATE development_icons_job_items SET status='queued', error='', updated_at=?3
        WHERE user_id=?1 AND job_id=?2 AND status IN ('failed','skipped')`,
    ).bind(userId, id, now),
    db.prepare(
      `UPDATE development_icons_jobs SET status='queued', cancel_requested=0, error='', finished_at=NULL, updated_at=?3
        WHERE user_id=?1 AND id=?2`,
    ).bind(userId, id, now),
  ])
  await syncJobProgress(db, userId, id)
}

export async function jobOutputRows(db: D1Database, userId: string, jobId: string): Promise<{ assetId: string; name: string; r2Key: string; bytes: number }[]> {
  const rows = await db.prepare(
    `SELECT asset_id, name, r2_key, bytes FROM development_icons_job_outputs WHERE user_id=?1 AND job_id=?2 ORDER BY asset_id, name`,
  ).bind(userId, jobId).all<Row>()
  return (rows.results ?? []).map((row) => ({
    assetId: text(row.asset_id),
    name: text(row.name),
    r2Key: text(row.r2_key),
    bytes: number(row.bytes),
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

/** The asset a repeated upload would duplicate, matched on its content hash. */
export async function findAssetBySha(db: D1Database, userId: string, format: string, sha256: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT id FROM development_icons_assets WHERE user_id = ?1 AND format = ?2 AND sha256 = ?3`,
  ).bind(userId, format, sha256).first<{ id: string }>()
  return row?.id ?? null
}

export interface NewAssetRow {
  id: string
  collectionId: string | null
  name: string
  format: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  sha256: string
  r2Key: string
  thumbKey: string | null
  colorMode: string
  sanitized: number
  createdAt: number
}

/** Records one uploaded asset after its bytes and thumbnails are already in R2. */
export async function insertAsset(db: D1Database, userId: string, asset: NewAssetRow): Promise<void> {
  await db.prepare(
    `INSERT INTO development_icons_assets
       (user_id, id, collection_id, name, name_key, format, mime, bytes, width, height, view_box, sha256, r2_key, thumb_key, keywords, color_mode, license, source_url, sanitized, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, ?13, '', ?14, '', '', ?15, ?16, ?16)`,
  ).bind(
    userId, asset.id, asset.collectionId, asset.name, asset.name.toLowerCase(), asset.format, asset.mime,
    asset.bytes, asset.width, asset.height, asset.sha256, asset.r2Key, asset.thumbKey, asset.colorMode,
    asset.sanitized, asset.createdAt,
  ).run()
}

export interface ExportDownloadRow {
  filename: string
  r2_key: string
  format: string
  expires_at: number
}

/** The export record behind a download link, before its expiration is judged. */
export async function findExportDownload(db: D1Database, userId: string, id: string): Promise<ExportDownloadRow | null> {
  const row = await db.prepare(
    `SELECT filename, r2_key, format, expires_at FROM development_icons_exports WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<ExportDownloadRow>()
  return row ?? null
}

export interface ThumbBackfillRow {
  id: string
  format: string
  mime: string
  sha256: string
  r2_key: string
}

/** Assets still missing a thumbnail, newest first, for the owner's background backfill. */
export async function listAssetsMissingThumb(db: D1Database, userId: string, limit: number): Promise<ThumbBackfillRow[]> {
  const rows = await db.prepare(
    `SELECT id, format, mime, sha256, r2_key FROM development_icons_assets
      WHERE user_id=?1 AND (thumb_key IS NULL OR thumb_key='') ORDER BY created_at DESC LIMIT ?2`,
  ).bind(userId, limit).all<ThumbBackfillRow>()
  return rows.results ?? []
}

export async function setAssetThumbKey(db: D1Database, userId: string, id: string, key: string): Promise<void> {
  await db.prepare(`UPDATE development_icons_assets SET thumb_key=?3 WHERE user_id=?1 AND id=?2`).bind(userId, id, key).run()
}
