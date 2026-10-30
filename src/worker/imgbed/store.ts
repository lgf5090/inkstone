import {
  IMGBED_SETTINGS_DEFAULTS,
  type ImgbedSettingsMap,
} from '@shared/imgbed/settings'
import type {
  ImgbedFile,
  ImgbedListQuery,
  ImgbedListResult,
  ImgbedPart,
} from '@shared/imgbed/model'

export interface FileRow {
  id: string
  object_key: string
  file_name: string
  file_type: string
  file_size_bytes: number
  width: number | null
  height: number | null
  upload_ip: string | null
  upload_address: string | null
  list_type: string
  label: string
  directory: string
  source: string
  external_link: string | null
  channel: string
  channel_name: string
  is_chunked: number
  parts: string | null
  uploader_id: string | null
  favorite: number
  pinned: number
  created_at: number
  updated_at: number
}

export function rowToFile(row: FileRow, tags: string[] = []): ImgbedFile {
  let parts: ImgbedPart[] | null = null
  if (row.parts) {
    try { parts = JSON.parse(row.parts) as ImgbedPart[] } catch { parts = null }
  }
  return {
    id: row.id,
    objectKey: row.object_key,
    fileName: row.file_name,
    fileType: row.file_type,
    sizeBytes: row.file_size_bytes,
    width: row.width,
    height: row.height,
    uploadIp: row.upload_ip,
    uploadAddress: row.upload_address,
    listType: row.list_type === 'White' || row.list_type === 'Block' ? row.list_type : 'None',
    label: row.label === 'adult' || row.label === 'teen' || row.label === 'everyone' ? row.label : 'None',
    directory: row.directory,
    source: row.source === 'external' || row.source === 'webdav' ? row.source : row.source as ImgbedFile['source'],
    externalLink: row.external_link,
    channel: row.channel,
    channelName: row.channel_name,
    isChunked: row.is_chunked === 1,
    parts,
    uploaderId: row.uploader_id,
    favorite: row.favorite === 1,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags,
  }
}

export async function getSettingsGroup<K extends keyof ImgbedSettingsMap>(
  db: D1Database,
  group: K,
): Promise<ImgbedSettingsMap[K]> {
  const row = await db.prepare('SELECT value FROM imgbed_settings WHERE key = ?1')
    .bind(group).first<{ value: string }>()
  const defaults = IMGBED_SETTINGS_DEFAULTS[group]
  if (!row?.value) return structuredClone(defaults)
  try {
    const parsed = JSON.parse(row.value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return structuredClone(defaults)
    return { ...structuredClone(defaults), ...(parsed as object) } as ImgbedSettingsMap[K]
  } catch {
    return structuredClone(defaults)
  }
}

export async function saveSettingsGroup(
  db: D1Database,
  group: keyof ImgbedSettingsMap,
  value: unknown,
): Promise<void> {
  await db.prepare(
    `INSERT INTO imgbed_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(group, JSON.stringify(value), Date.now()).run()
}

export async function getSecretRow<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare('SELECT value FROM imgbed_settings WHERE key = ?1')
    .bind(key).first<{ value: string }>()
  if (!row?.value) return null
  try { return JSON.parse(row.value) as T } catch { return null }
}

export async function saveSecretRow(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare(
    `INSERT INTO imgbed_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, JSON.stringify(value), Date.now()).run()
}

export async function fileExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS found FROM imgbed_files WHERE id = ?1').bind(id).first<{ found: number }>()
  return Boolean(row?.found)
}

export async function getFileRow(db: D1Database, id: string): Promise<FileRow | null> {
  return await db.prepare('SELECT * FROM imgbed_files WHERE id = ?1').bind(id).first<FileRow>()
}

export async function getFile(db: D1Database, id: string): Promise<ImgbedFile | null> {
  const row = await getFileRow(db, id)
  if (!row) return null
  const tags = await getFileTags(db, id)
  return rowToFile(row, tags)
}

export interface InsertFileInput {
  id: string
  objectKey: string
  fileName: string
  fileType: string
  sizeBytes: number
  width: number | null
  height: number | null
  uploadIp: string | null
  uploadAddress: string | null
  listType?: string
  label?: string
  source: string
  externalLink?: string | null
  channel: string
  channelName: string
  isChunked?: boolean
  parts?: ImgbedPart[] | null
  uploaderId: string | null
  createdAt: number
}

export async function insertFile(db: D1Database, file: InsertFileInput): Promise<void> {
  const directory = file.id.includes('/') ? file.id.slice(0, file.id.lastIndexOf('/') + 1) : ''
  await db.prepare(
    `INSERT INTO imgbed_files (
       id, object_key, file_name, file_type, file_size_bytes, width, height, upload_ip,
       upload_address, list_type, label, directory, source, external_link, channel, channel_name,
       is_chunked, parts, uploader_id, created_at, updated_at
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?20)
     ON CONFLICT(id) DO UPDATE SET
       object_key=excluded.object_key, file_name=excluded.file_name, file_type=excluded.file_type,
       file_size_bytes=excluded.file_size_bytes, width=excluded.width, height=excluded.height,
       upload_ip=excluded.upload_ip, upload_address=excluded.upload_address,
       list_type=excluded.list_type, label=excluded.label, directory=excluded.directory,
       source=excluded.source, external_link=excluded.external_link, channel=excluded.channel,
       channel_name=excluded.channel_name, is_chunked=excluded.is_chunked, parts=excluded.parts,
       uploader_id=excluded.uploader_id, updated_at=excluded.updated_at`,
  ).bind(
    file.id, file.objectKey, file.fileName, file.fileType, file.sizeBytes, file.width, file.height,
    file.uploadIp, file.uploadAddress, file.listType ?? 'None', file.label ?? 'None', directory,
    file.source, file.externalLink ?? null, file.channel, file.channelName,
    file.isChunked ? 1 : 0, file.parts ? JSON.stringify(file.parts) : null, file.uploaderId,
    file.createdAt,
  ).run()
}

export async function updateFileMetadata(
  db: D1Database,
  id: string,
  patch: { fileName?: string; fileType?: string; listType?: string; label?: string },
): Promise<void> {
  const sets: string[] = ['updated_at = ?2']
  const binds: unknown[] = [id, Date.now()]
  let index = 3
  if (patch.fileName !== undefined) { sets.push(`file_name = ?${index++}`); binds.push(patch.fileName) }
  if (patch.fileType !== undefined) { sets.push(`file_type = ?${index++}`); binds.push(patch.fileType) }
  if (patch.listType !== undefined) { sets.push(`list_type = ?${index++}`); binds.push(patch.listType) }
  if (patch.label !== undefined) { sets.push(`label = ?${index++}`); binds.push(patch.label) }
  await db.prepare(`UPDATE imgbed_files SET ${sets.join(', ')} WHERE id = ?1`)
    .bind(...binds as [unknown, ...unknown[]]).run()
}

export async function deleteFileRow(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM imgbed_file_tags WHERE file_id = ?1').bind(id),
    db.prepare('DELETE FROM imgbed_files WHERE id = ?1').bind(id),
  ])
}

export async function getFileTags(db: D1Database, id: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT tag FROM imgbed_file_tags WHERE file_id = ?1 ORDER BY tag')
    .bind(id).all<{ tag: string }>()
  return results.map((row) => row.tag)
}

export async function setFileTags(db: D1Database, id: string, tags: string[]): Promise<void> {
  const now = Date.now()
  const statements = [db.prepare('DELETE FROM imgbed_file_tags WHERE file_id = ?1').bind(id)]
  for (const tag of tags) {
    statements.push(db.prepare('INSERT INTO imgbed_file_tags (file_id, tag, created_at) VALUES (?1, ?2, ?3)')
      .bind(id, tag, now))
  }
  statements.push(db.prepare('UPDATE imgbed_files SET updated_at = ?2 WHERE id = ?1').bind(id, now))
  await db.batch(statements)
}

export async function addFileTags(db: D1Database, id: string, tags: string[]): Promise<void> {
  const now = Date.now()
  for (const tag of tags) {
    await db.prepare('INSERT OR IGNORE INTO imgbed_file_tags (file_id, tag, created_at) VALUES (?1, ?2, ?3)')
      .bind(id, tag, now).run()
  }
  await db.prepare('UPDATE imgbed_files SET updated_at = ?2 WHERE id = ?1').bind(id, now).run()
}

export async function removeFileTags(db: D1Database, id: string, tags: string[]): Promise<void> {
  for (const tag of tags) {
    await db.prepare('DELETE FROM imgbed_file_tags WHERE file_id = ?1 AND tag = ?2').bind(id, tag).run()
  }
  await db.prepare('UPDATE imgbed_files SET updated_at = ?2 WHERE id = ?1').bind(id, Date.now()).run()
}

export async function autocompleteTags(db: D1Database, prefix: string, limit: number): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT tag, COUNT(*) AS n FROM imgbed_file_tags
      WHERE tag LIKE ?1 ESCAPE '\\'
      GROUP BY tag ORDER BY n DESC, tag LIMIT ?2`,
  ).bind(`${prefix.replace(/[%_\\]/g, '\\$&')}%`, limit).all<{ tag: string }>()
  return results.map((row) => row.tag)
}

const FILE_TYPE_EXTENSIONS: Record<string, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'heic'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', '3gp', 'mpeg', 'mpg', 'ts', 'flv', 'wmv', 'rmvb'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'ape'],
}

function fileTypeCondition(category: string, bind: (value: unknown) => string): string {
  const extensions = FILE_TYPE_EXTENSIONS[category]
  if (extensions) {
    const mime = category === 'image' ? 'image/' : category === 'video' ? 'video/' : 'audio/'
    const extensionSql = extensions.map((ext) => `lower(f.id) LIKE ${bind(`%.${ext}`)}`).join(' OR ')
    return `(f.file_type LIKE ${bind(`${mime}%`)} OR ${extensionSql})`
  }
  if (category === 'other') {
    const parts = Object.entries(FILE_TYPE_EXTENSIONS).map(([key]) => fileTypeCondition(key, bind))
    return `NOT (${parts.join(' OR ')})`
  }
  return '1 = 1'
}

function normalizeDirectory(input: string | undefined): string {
  let dir = String(input ?? '').replace(/\.\./g, '_').replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (dir.startsWith('/')) dir = dir.slice(1)
  if (dir && !dir.endsWith('/')) dir += '/'
  return dir
}

interface SqlParts {
  where: string
  binds: unknown[]
}

function buildListWhere(query: ImgbedListQuery, dirPrefix: string, includeDirectory: boolean): SqlParts {
  const clauses: string[] = []
  const binds: unknown[] = []
  const bind = (value: unknown) => { binds.push(value); return `?${binds.length}` }

  if (includeDirectory) {
    if (dirPrefix) clauses.push(`f.directory LIKE ${bind(`${dirPrefix}%`)}`)
    else clauses.push('1 = 1')
  }
  const search = String(query.search ?? '').trim().toLowerCase()
  if (search) {
    const pattern = `%${search.replace(/[%_\\]/g, '\\$&')}%`
    if (search.startsWith('#')) {
      const tagPattern = `%${search.slice(1).replace(/[%_\\]/g, '\\$&')}%`
      clauses.push(`EXISTS (SELECT 1 FROM imgbed_file_tags st WHERE st.file_id = f.id AND lower(st.tag) LIKE ${bind(tagPattern)} ESCAPE '\\')`)
    } else {
      clauses.push(`(lower(f.file_name) LIKE ${bind(pattern)} ESCAPE '\\' OR lower(f.id) LIKE ${bind(pattern)} ESCAPE '\\' OR EXISTS (SELECT 1 FROM imgbed_file_tags st WHERE st.file_id = f.id AND lower(st.tag) LIKE ${bind(pattern)} ESCAPE '\\'))`)
    }
  }
  if (query.favorite === true) clauses.push('f.favorite = 1')
  if (query.pinned === true) clauses.push('f.pinned = 1')
  const tagPrefix = String(query.tagPrefix ?? '').trim()
  if (tagPrefix) {
    const tagPattern = `${tagPrefix.replace(/[%_\\]/g, '\\$&')}/%`
    clauses.push(`EXISTS (SELECT 1 FROM imgbed_file_tags pt WHERE pt.file_id = f.id AND (pt.tag = ${bind(tagPrefix)} OR pt.tag LIKE ${bind(tagPattern)} ESCAPE '\\'))`)
  }
  if (typeof query.createdFrom === 'number' && Number.isFinite(query.createdFrom)) clauses.push(`f.created_at >= ${bind(query.createdFrom)}`)
  if (typeof query.createdTo === 'number' && Number.isFinite(query.createdTo)) clauses.push(`f.created_at <= ${bind(query.createdTo)}`)
  const listTypes = (query.listType ?? []).filter(Boolean)
  if (listTypes.length) {
    const parts = listTypes.map((type) => {
      if (type === 'None') return `(f.list_type IS NULL OR f.list_type = '' OR f.list_type = 'None')`
      return `f.list_type = ${bind(type)}`
    })
    clauses.push(`(${parts.join(' OR ')})`)
  }
  const access = (query.accessStatus ?? []).filter(Boolean)
  if (access.length) {
    const parts = access.map((status) => status === 'blocked'
      ? `(f.list_type = 'Block' OR (f.label = 'adult' AND f.list_type <> 'White'))`
      : `NOT (f.list_type = 'Block' OR (f.label = 'adult' AND f.list_type <> 'White'))`)
    clauses.push(`(${parts.join(' OR ')})`)
  }
  const labels = (query.label ?? []).filter(Boolean)
  if (labels.length) {
    const parts = labels.map((label) => label === 'normal'
      ? `(f.label IS NULL OR f.label = '' OR f.label = 'None' OR f.label = 'everyone')`
      : `f.label = ${bind(label)}`)
    clauses.push(`(${parts.join(' OR ')})`)
  }
  const types = (query.fileType ?? []).filter(Boolean)
  if (types.length) clauses.push(`(${types.map((type) => fileTypeCondition(type, bind)).join(' OR ')})`)
  const channels = (query.channel ?? []).filter(Boolean)
  if (channels.length) clauses.push(`lower(f.channel) IN (${channels.map((value) => bind(value.toLowerCase())).join(', ')})`)
  const channelNames = (query.channelName ?? []).filter(Boolean)
  if (channelNames.length) {
    const parts = channelNames.map((value) => {
      if (value.includes(':')) {
        const [type, name] = value.split(':', 2)
        return `(f.channel = ${bind(type)} AND f.channel_name = ${bind(name)})`
      }
      return `f.channel_name = ${bind(value)}`
    })
    clauses.push(`(${parts.join(' OR ')})`)
  }
  for (const tag of query.includeTags ?? []) {
    clauses.push(`EXISTS (SELECT 1 FROM imgbed_file_tags t WHERE t.file_id = f.id AND t.tag = ${bind(tag)})`)
  }
  for (const tag of query.excludeTags ?? []) {
    clauses.push(`NOT EXISTS (SELECT 1 FROM imgbed_file_tags t WHERE t.file_id = f.id AND t.tag = ${bind(tag)})`)
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1 = 1', binds }
}

function sortSql(query: ImgbedListQuery): string {
  const field = query.sort === 'size' ? 'f.file_size_bytes'
    : query.sort === 'rawName' ? 'f.id'
      : query.sort === 'fileName' ? 'f.file_name'
        : 'f.created_at'
  const order = query.sortOrder === 'asc' ? 'ASC' : 'DESC'
  return `f.pinned DESC, ${field} ${order}, f.id ${order}`
}

export async function listFiles(db: D1Database, query: ImgbedListQuery): Promise<ImgbedListResult> {
  const dir = normalizeDirectory(query.dir)
  const recursive = query.recursive === true
  const base = buildListWhere(query, dir, false)
  const dirClause = dir ? `f.directory ${recursive ? 'LIKE' : '='} ?` : recursive ? '1 = 1' : "f.directory = ''"
  const dirBind = dir ? `${dir}${recursive ? '%' : ''}` : undefined
  const where = `${base.where} AND ${dirClause}`
  const binds = dirBind === undefined ? [...base.binds] : [...base.binds, dirBind]

  const totalRow = await db.prepare(`SELECT COUNT(*) AS n FROM imgbed_files f WHERE ${where}`)
    .bind(...binds).first<{ n: number }>()
  const directWhere = `${base.where} AND ${dir ? 'f.directory = ?' : "f.directory = ''"}`
  const directBinds = dir ? [...base.binds, dir] : [...base.binds]
  const directRow = await db.prepare(`SELECT COUNT(*) AS n FROM imgbed_files f WHERE ${directWhere}`)
    .bind(...directBinds).first<{ n: number }>()

  const dirWhere = `${base.where} AND ${dir ? 'f.directory LIKE ?' : '1 = 1'}`
  const dirBinds = dir ? [...base.binds, `${dir}%`] : [...base.binds]
  const dirRows = await db.prepare(
    `SELECT DISTINCT f.directory AS directory FROM imgbed_files f WHERE ${dirWhere}`,
  ).bind(...dirBinds).all<{ directory: string }>()
  const directorySet = new Set<string>()
  for (const row of dirRows.results ?? []) {
    if (!row.directory || !row.directory.startsWith(dir)) continue
    const relative = row.directory.slice(dir.length)
    const first = relative.split('/').filter(Boolean)[0]
    if (first) directorySet.add(`${dir}${first}/`)
  }

  const start = Math.max(0, Number(query.start) || 0)
  const count = query.count === -1 ? -1 : Math.min(Math.max(1, Number(query.count) || 50), 1000)
  const limitSql = count === -1 ? '' : ` LIMIT ${count} OFFSET ${start}`
  const { results } = await db.prepare(
    `SELECT f.* FROM imgbed_files f WHERE ${where} ORDER BY ${sortSql(query)}${limitSql}`,
  ).bind(...binds).all<FileRow>()

  const tags = new Map<string, string[]>()
  const ids = (results ?? []).map((row) => row.id)
  for (let offset = 0; offset < ids.length; offset += 50) {
    const chunk = ids.slice(offset, offset + 50)
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(',')
    const tagRows = await db.prepare(
      `SELECT file_id, tag FROM imgbed_file_tags WHERE file_id IN (${placeholders}) ORDER BY tag`,
    ).bind(...chunk).all<{ file_id: string; tag: string }>()
    for (const row of tagRows.results ?? []) {
      const list = tags.get(row.file_id) ?? []
      list.push(row.tag)
      tags.set(row.file_id, list)
    }
  }

  return {
    files: (results ?? []).map((row) => rowToFile(row, tags.get(row.id) ?? [])),
    directories: [...directorySet].sort((a, b) => a.localeCompare(b)),
    totalCount: Number(totalRow?.n ?? 0),
    directFileCount: recursive ? Number(totalRow?.n ?? 0) : Number(directRow?.n ?? 0),
    directFolderCount: directorySet.size,
    returnedCount: results?.length ?? 0,
  }
}

export async function randomFile(
  db: D1Database,
  query: ImgbedListQuery & { orientation?: 'landscape' | 'portrait' | 'square' },
): Promise<ImgbedFile | null> {
  const dir = normalizeDirectory(query.dir)
  const base = buildListWhere(query, dir, false)
  const clauses = [base.where]
  const binds = [...base.binds]
  if (dir) {
    clauses.push('f.directory LIKE ?')
    binds.push(`${dir}%`)
  }
  if (query.orientation === 'landscape') clauses.push('f.width IS NOT NULL AND f.height IS NOT NULL AND f.width > f.height * 1.1')
  if (query.orientation === 'portrait') clauses.push('f.width IS NOT NULL AND f.height IS NOT NULL AND f.width < f.height * 0.9')
  if (query.orientation === 'square') clauses.push('f.width IS NOT NULL AND f.height IS NOT NULL AND f.width >= f.height * 0.9 AND f.width <= f.height * 1.1')
  const row = await db.prepare(
    `SELECT f.* FROM imgbed_files f WHERE ${clauses.join(' AND ')} ORDER BY RANDOM() LIMIT 1`,
  ).bind(...binds).first<FileRow>()
  return row ? rowToFile(row) : null
}

export interface ImgbedStats {
  totalFiles: number
  totalBytes: number
  categoryStats: Record<string, number>
  accessStats: { normal: number; blocked: number }
  labelStats: Record<string, number>
  directoryCount: number
  oldestAt: number | null
  newestAt: number | null
  lastUpdated: number | null
  uploadTrend: {
    labels: string[]
    total: number[]
    range: { startDate: string; endDate: string } | null
    groupBy: {
      category: { series: { name: string; total: number; data: number[] }[]; limited: boolean }
      directory: { series: { name: string; total: number; data: number[] }[]; limited: boolean }
    }
  }
}

function localDay(ms: number, offsetMinutes: number): number {
  return Math.floor((ms - offsetMinutes * 60_000) / 86_400_000)
}

function dayLabel(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10)
}

function parseDay(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null
}

export async function getStats(
  db: D1Database,
  options: { timezoneOffset?: number; startDate?: string; endDate?: string; maxPoints?: number; seriesLimit?: number } = {},
): Promise<ImgbedStats> {
  const offset = Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(options.timezoneOffset ?? 0)))
  const maxPoints = Math.max(7, Math.min(366, Math.trunc(options.maxPoints ?? 90)))
  const seriesLimit = Math.max(1, Math.min(20, Math.trunc(options.seriesLimit ?? 8)))
  const totals = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(file_size_bytes), 0) AS bytes,
            MIN(created_at) AS oldest, MAX(created_at) AS newest, MAX(updated_at) AS updated,
            COUNT(DISTINCT directory) AS dirs
       FROM imgbed_files`,
  ).first<{ n: number; bytes: number; oldest: number | null; newest: number | null; updated: number | null; dirs: number }>()
  const category = await db.prepare(
    `SELECT file_type AS type, COUNT(*) AS n FROM imgbed_files GROUP BY file_type`,
  ).all<{ type: string; n: number }>()
  const access = await db.prepare(
    `SELECT
       SUM(CASE WHEN list_type = 'Block' OR (label = 'adult' AND list_type <> 'White') THEN 0 ELSE 1 END) AS normal,
       SUM(CASE WHEN list_type = 'Block' OR (label = 'adult' AND list_type <> 'White') THEN 1 ELSE 0 END) AS blocked
       FROM imgbed_files`,
  ).first<{ normal: number; blocked: number }>()
  const labels = await db.prepare(
    `SELECT label, COUNT(*) AS n FROM imgbed_files GROUP BY label`,
  ).all<{ label: string; n: number }>()
  const categoryStats: Record<string, number> = {}
  for (const row of category.results ?? []) {
    const key = row.type.startsWith('image/') ? 'images'
      : row.type.startsWith('video/') ? 'videos'
        : row.type.startsWith('audio/') ? 'audios'
          : row.type.startsWith('text/') ? 'txt' : 'other'
    categoryStats[key] = (categoryStats[key] ?? 0) + row.n
  }
  const labelStats: Record<string, number> = {}
  for (const row of labels.results ?? []) labelStats[row.label || 'None'] = row.n

  const newest = totals?.newest ?? null
  const oldest = totals?.oldest ?? null
  const startDay = parseDay(options.startDate)
    ?? (newest === null ? null : localDay(newest, offset) - 6)
  const endDay = parseDay(options.endDate)
    ?? (newest === null ? null : localDay(newest, offset))
  let trend: ImgbedStats['uploadTrend'] = {
    labels: [], total: [], range: null,
    groupBy: { category: { series: [], limited: false }, directory: { series: [], limited: false } },
  }
  if (startDay !== null && endDay !== null) {
    const rangeStart = Math.min(startDay, endDay)
    const rangeEnd = Math.max(startDay, endDay)
    const span = rangeEnd - rangeStart + 1
    const bucket = Math.max(1, Math.ceil(span / maxPoints))
    const buckets = Math.ceil(span / bucket)
    const labels = Array.from({ length: buckets }, (_, index) => {
      const start = rangeStart + index * bucket
      const end = Math.min(rangeEnd, start + bucket - 1)
      return start === end ? dayLabel(start) : `${dayLabel(start)}~${dayLabel(end)}`
    })
    const rows = await db.prepare(
      `SELECT created_at, file_type, directory FROM imgbed_files WHERE created_at >= ?1 AND created_at < ?2`,
    ).bind(rangeStart * 86_400_000 + offset * 60_000, (rangeEnd + 1) * 86_400_000 + offset * 60_000)
      .all<{ created_at: number; file_type: string; directory: string }>()
    const total = Array(buckets).fill(0) as number[]
    const groups = { category: new Map<string, number[]>(), directory: new Map<string, number[]>() }
    for (const row of rows.results ?? []) {
      const index = Math.floor((localDay(row.created_at, offset) - rangeStart) / bucket)
      if (index < 0 || index >= buckets) continue
      total[index] += 1
      const categoryName = row.file_type.startsWith('image/') ? 'images'
        : row.file_type.startsWith('video/') ? 'videos'
          : row.file_type.startsWith('audio/') ? 'audios'
            : row.file_type.startsWith('text/') ? 'txt' : 'other'
      for (const [map, name] of [[groups.category, categoryName], [groups.directory, row.directory || '/']] as const) {
        const data = map.get(name) ?? Array(buckets).fill(0)
        data[index] += 1
        map.set(name, data)
      }
    }
    const series = (map: Map<string, number[]>) => {
      const entries = [...map.entries()].sort((left, right) => {
        const leftTotal = left[1].reduce((sum, value) => sum + value, 0)
        const rightTotal = right[1].reduce((sum, value) => sum + value, 0)
        return rightTotal - leftTotal || left[0].localeCompare(right[0])
      })
      const top = entries.slice(0, seriesLimit)
      const rest = entries.slice(seriesLimit)
      const out = top.map(([name, data]) => ({ name, total: data.reduce((sum, value) => sum + value, 0), data }))
      if (rest.length) {
        const data = Array(buckets).fill(0) as number[]
        for (const [, values] of rest) values.forEach((value, index) => { data[index] += value })
        out.push({ name: '__other__', total: data.reduce((sum, value) => sum + value, 0), data })
      }
      return { series: out, limited: rest.length > 0 }
    }
    trend = {
      labels,
      total,
      range: { startDate: dayLabel(rangeStart), endDate: dayLabel(rangeEnd) },
      groupBy: { category: series(groups.category), directory: series(groups.directory) },
    }
  }
  return {
    totalFiles: Number(totals?.n ?? 0),
    totalBytes: Number(totals?.bytes ?? 0),
    categoryStats,
    accessStats: { normal: Number(access?.normal ?? 0), blocked: Number(access?.blocked ?? 0) },
    labelStats,
    directoryCount: Number(totals?.dirs ?? 0),
    oldestAt: oldest,
    newestAt: newest,
    lastUpdated: totals?.updated ?? null,
    uploadTrend: trend,
  }
}

export interface ChannelUsageRow {
  channel: string
  channelName: string
  count: number
  usedMB: number
}

export interface ImgbedUploadPartRow {
  index: number
  partNumber: number | null
  etag: string | null
  fileId: string | null
  messageId: string | null
  size: number
}

export async function upsertUploadPart(db: D1Database, sessionId: string, part: ImgbedUploadPartRow): Promise<void> {
  await db.prepare(
    `INSERT INTO imgbed_upload_parts (session_id, part_index, part_number, etag, file_id, message_id, size, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT(session_id, part_index) DO UPDATE SET
       part_number=excluded.part_number, etag=excluded.etag, file_id=excluded.file_id,
       message_id=excluded.message_id, size=excluded.size, created_at=excluded.created_at`,
  ).bind(sessionId, part.index, part.partNumber, part.etag, part.fileId, part.messageId, part.size, Date.now()).run()
}

export async function listUploadParts(db: D1Database, sessionId: string): Promise<ImgbedUploadPartRow[]> {
  const { results } = await db.prepare(
    `SELECT part_index AS idx, part_number AS partNumber, etag, file_id AS fileId,
            message_id AS messageId, size
       FROM imgbed_upload_parts WHERE session_id = ?1 ORDER BY part_index`,
  ).bind(sessionId).all<{ idx: number; partNumber: number | null; etag: string | null; fileId: string | null; messageId: string | null; size: number }>()
  return (results ?? []).map((row) => ({
    index: Number(row.idx), partNumber: row.partNumber === null ? null : Number(row.partNumber),
    etag: row.etag, fileId: row.fileId, messageId: row.messageId, size: Number(row.size),
  }))
}

export async function deleteUploadParts(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM imgbed_upload_parts WHERE session_id = ?1').bind(sessionId).run()
}

export async function setFileFlags(
  db: D1Database,
  ids: readonly string[],
  flags: { favorite?: boolean; pinned?: boolean },
): Promise<void> {
  const now = Date.now()
  const sets: string[] = []
  const values: number[] = []
  if (typeof flags.favorite === 'boolean') { values.push(flags.favorite ? 1 : 0); sets.push(`favorite = ?${values.length}`) }
  if (typeof flags.pinned === 'boolean') { values.push(flags.pinned ? 1 : 0); sets.push(`pinned = ?${values.length}`) }
  if (!sets.length) return
  const nowIndex = values.length + 1
  const statements = ids.map((id) => db.prepare(
    `UPDATE imgbed_files SET ${sets.join(', ')}, updated_at = ?${nowIndex} WHERE id = ?${nowIndex + 1}`,
  ).bind(...values, now, id))
  if (statements.length) await db.batch(statements)
}

export interface ImgbedSidebarData {
  counts: { all: number; favorite: number; pinned: number; images: number; videos: number; audios: number; other: number }
  channels: { channel: string; channelName: string; count: number }[]
  tags: { tag: string; count: number }[]
  activity: { date: string; count: number }[]
}

export async function getSidebarData(
  db: D1Database,
  options: { timezoneOffset?: number; days?: number } = {},
): Promise<ImgbedSidebarData> {
  const offset = Math.max(-840, Math.min(840, Math.trunc(options.timezoneOffset ?? 0)))
  const days = Math.max(7, Math.min(366, Math.trunc(options.days ?? 90)))
  const cutoff = Date.now() - days * 86_400_000
  const counts = await db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(favorite), 0) AS favorite,
            COALESCE(SUM(pinned), 0) AS pinned,
            COALESCE(SUM(CASE WHEN file_type LIKE 'image/%' THEN 1 ELSE 0 END), 0) AS images,
            COALESCE(SUM(CASE WHEN file_type LIKE 'video/%' THEN 1 ELSE 0 END), 0) AS videos,
            COALESCE(SUM(CASE WHEN file_type LIKE 'audio/%' THEN 1 ELSE 0 END), 0) AS audios
       FROM imgbed_files`,
  ).first<{ total: number; favorite: number; pinned: number; images: number; videos: number; audios: number }>()
  const channelRows = await db.prepare(
    `SELECT channel, channel_name AS channelName, COUNT(*) AS n
       FROM imgbed_files GROUP BY channel, channel_name ORDER BY n DESC, channel, channel_name`,
  ).all<{ channel: string; channelName: string; n: number }>()
  const tagRows = await db.prepare(
    `SELECT tag, COUNT(*) AS n FROM imgbed_file_tags GROUP BY tag ORDER BY n DESC, tag LIMIT 1000`,
  ).all<{ tag: string; n: number }>()
  const activityRows = await db.prepare(
    `SELECT strftime('%Y-%m-%d', (created_at + ?1 * 60000) / 1000, 'unixepoch') AS day, COUNT(*) AS n
       FROM imgbed_files WHERE created_at >= ?2 GROUP BY day ORDER BY day`,
  ).bind(offset, cutoff).all<{ day: string; n: number }>()
  const total = Number(counts?.total ?? 0)
  const images = Number(counts?.images ?? 0)
  const videos = Number(counts?.videos ?? 0)
  const audios = Number(counts?.audios ?? 0)
  return {
    counts: {
      all: total,
      favorite: Number(counts?.favorite ?? 0),
      pinned: Number(counts?.pinned ?? 0),
      images, videos, audios,
      other: Math.max(0, total - images - videos - audios),
    },
    channels: (channelRows.results ?? []).map((row) => ({ channel: row.channel, channelName: row.channelName, count: Number(row.n) })),
    tags: (tagRows.results ?? []).map((row) => ({ tag: row.tag, count: Number(row.n) })),
    activity: (activityRows.results ?? []).map((row) => ({ date: row.day, count: Number(row.n) })),
  }
}

export async function getChannelUsage(db: D1Database): Promise<ChannelUsageRow[]> {
  const { results } = await db.prepare(
    `SELECT channel, channel_name AS channelName, COUNT(*) AS count,
            COALESCE(SUM(file_size_bytes), 0) / 1048576.0 AS usedMB
       FROM imgbed_files GROUP BY channel, channel_name ORDER BY channel, channel_name`,
  ).all<ChannelUsageRow>()
  return results ?? []
}

export async function customerRows(db: D1Database, start: number, count: number): Promise<{
  ip: string; address: string; count: number; lastUploadAt: number
}[]> {
  const { results } = await db.prepare(
    `SELECT upload_ip AS ip,
            COALESCE(MAX(NULLIF(upload_address, '')), '') AS address,
            COUNT(*) AS n, MAX(created_at) AS lastUploadAt
       FROM imgbed_files WHERE upload_ip IS NOT NULL AND upload_ip <> ''
       GROUP BY upload_ip ORDER BY n DESC, upload_ip ASC LIMIT ?1 OFFSET ?2`,
  ).bind(count, start).all<{ ip: string; address: string; n: number; lastUploadAt: number }>()
  return (results ?? []).map((row) => ({ ip: row.ip, address: row.address, count: row.n, lastUploadAt: row.lastUploadAt }))
}

export async function filesByIp(db: D1Database, ip: string, start: number, count: number): Promise<{
  files: ImgbedFile[]; total: number
}> {
  const total = await db.prepare('SELECT COUNT(*) AS n FROM imgbed_files WHERE upload_ip = ?1')
    .bind(ip).first<{ n: number }>()
  const { results } = await db.prepare(
    'SELECT * FROM imgbed_files WHERE upload_ip = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3',
  ).bind(ip, count, start).all<FileRow>()
  return { files: (results ?? []).map((row) => rowToFile(row)), total: Number(total?.n ?? 0) }
}

export async function renameFileRow(
  db: D1Database,
  oldId: string,
  newId: string,
  objectKey: string,
  updatedAt = Date.now(),
): Promise<void> {
  const directory = newId.includes('/') ? newId.slice(0, newId.lastIndexOf('/') + 1) : ''
  await db.batch([
    db.prepare(
      'UPDATE imgbed_files SET id = ?2, object_key = ?3, directory = ?4, updated_at = ?5 WHERE id = ?1',
    ).bind(oldId, newId, objectKey, directory, updatedAt),
    db.prepare('UPDATE imgbed_file_tags SET file_id = ?2 WHERE file_id = ?1').bind(oldId, newId),
  ])
}

export async function allDirectories(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT DISTINCT directory FROM imgbed_files WHERE directory <> \'\'')
    .all<{ directory: string }>()
  return (results ?? []).map((row) => row.directory)
}

export async function replaceFileTags(db: D1Database, id: string, tags: string[]): Promise<void> {
  await setFileTags(db, id, tags)
}
