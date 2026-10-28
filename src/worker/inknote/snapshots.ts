/**
 * Whole-library snapshots: JSON the server builds from D1, restores under a lease, and keeps ten of.
 *
 * The same row definitions are used to validate a snapshot read back from object storage, so a
 * corrupted object is rejected before the current library is touched. Assets are never copied or
 * deleted here; a snapshot only names the ids it references.
 */
import {
  INKNOTE_ASSET_ID_RE,
  INKNOTE_ASSET_URL_PREFIX,
  INKNOTE_LIMITS,
} from '@shared/inknote/constants'
import { sanitizeInknoteSettings } from '@shared/inknote/settings'
import type { InknoteSettings, InknoteSnapshotMeta } from '@shared/inknote/types'
import {
  deleteAttachmentObjects,
  hasAttachmentStorage,
  putAttachmentObject,
  readAttachmentObject,
  selectAttachmentStorage,
} from '../attachments/backend'
import type { AttachmentObjectStorage } from '../attachments/keys'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { acquireLease } from '../lib/lease'
import { drainInknoteCleanup, scheduleInknoteCleanup } from './assets'

export const INKNOTE_SNAPSHOT_FORMAT = 'inknote-snapshot'
export const INKNOTE_SNAPSHOT_VERSION = 1

const SNAPSHOT_LABEL_MAX = 80
const SNAPSHOT_KEEP = INKNOTE_LIMITS.snapshotRetention
const RESTORE_LEASE_MS = 5 * 60 * 1000
const WRITE_BATCH = 100
const ASSET_LOOKUP_BATCH = 90
const AUTO_SNAPSHOT_WINDOW_MS = 60 * 1000
const AUTO_SNAPSHOT_LIMIT = 2

type SnapshotCell = string | number | null
type SnapshotRow = Record<string, SnapshotCell>

type ColumnType = 'string' | 'int' | 'string?' | 'int?'

interface ColumnDefinition {
  name: string
  type: ColumnType
}

interface SnapshotTable {
  table: string
  key: 'subjects' | 'notebooks' | 'notes' | 'pages' | 'templates'
  orderBy: string
  columns: readonly ColumnDefinition[]
}

const SNAPSHOT_TABLES: readonly SnapshotTable[] = [
  {
    table: 'inknote_subjects',
    key: 'subjects',
    orderBy: 'position, id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'position', type: 'int' },
      { name: 'created_at', type: 'int' },
      { name: 'updated_at', type: 'int' },
    ],
  },
  {
    table: 'inknote_notebooks',
    key: 'notebooks',
    orderBy: 'subject_id, position, id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'subject_id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'cover_color', type: 'string' },
      { name: 'emoji', type: 'string' },
      { name: 'position', type: 'int' },
      { name: 'created_at', type: 'int' },
      { name: 'updated_at', type: 'int' },
    ],
  },
  {
    table: 'inknote_notes',
    key: 'notes',
    orderBy: 'created_at, id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'notebook_id', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'title_key', type: 'string' },
      { name: 'paper_style', type: 'string' },
      { name: 'paper_color', type: 'string' },
      { name: 'paper_spacing', type: 'string' },
      { name: 'page_width', type: 'int' },
      { name: 'page_height', type: 'int' },
      { name: 'content_width', type: 'int' },
      { name: 'content_height', type: 'int' },
      { name: 'color_tag', type: 'string?' },
      { name: 'pinned', type: 'int' },
      { name: 'page_count', type: 'int' },
      { name: 'content_bytes', type: 'int' },
      { name: 'cover_asset_id', type: 'string?' },
      { name: 'rev', type: 'int' },
      { name: 'created_at', type: 'int' },
      { name: 'updated_at', type: 'int' },
      { name: 'deleted_at', type: 'int?' },
    ],
  },
  {
    table: 'inknote_pages',
    key: 'pages',
    orderBy: 'note_id, position, id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'note_id', type: 'string' },
      { name: 'position', type: 'int' },
      { name: 'content', type: 'string' },
      { name: 'search_text', type: 'string' },
      { name: 'rev', type: 'int' },
      { name: 'created_at', type: 'int' },
      { name: 'updated_at', type: 'int' },
    ],
  },
  {
    table: 'inknote_templates',
    key: 'templates',
    orderBy: 'created_at, id',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'paper_style', type: 'string' },
      { name: 'paper_color', type: 'string' },
      { name: 'paper_spacing', type: 'string' },
      { name: 'bg_asset_id', type: 'string?' },
      { name: 'texts', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'sub', type: 'string' },
      { name: 'title_size', type: 'int' },
      { name: 'sub_size', type: 'int' },
      { name: 'created_at', type: 'int' },
      { name: 'updated_at', type: 'int' },
    ],
  },
]

export interface InknoteSnapshotMetaRow {
  id: string
  label: string
  note_count: number
  size: number
  object_key: string
  created_at: number
}

export interface InknoteSettingsRecord {
  config: string
  updated_at: number
}

export interface InknoteTemplateRow {
  user_id: string
  id: string
  name: string
  paper_style: string
  paper_color: string
  paper_spacing: string
  bg_asset_id: string | null
  texts: string
  title: string
  sub: string
  title_size: number
  sub_size: number
  created_at: number
  updated_at: number
}

interface ParsedSnapshot {
  createdAt: number
  label: string
  rows: Record<SnapshotTable['key'], SnapshotRow[]>
  settings: InknoteSettings
  assetIds: string[]
}

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function own(row: JsonRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined
}

function corrupt(): ApiError {
  return ApiError.badRequest('The snapshot is corrupted')
}

function readCell(row: JsonRecord, column: ColumnDefinition): SnapshotCell {
  const value = own(row, column.name)
  if (column.type === 'string') {
    if (typeof value !== 'string') throw corrupt()
    return value
  }
  if (column.type === 'int') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw corrupt()
    return value
  }
  if (value === undefined || value === null) return null
  if (column.type === 'string?') {
    if (typeof value !== 'string') throw corrupt()
    return value
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw corrupt()
  return value
}

function readRow(value: unknown, table: SnapshotTable, userId: string): SnapshotRow {
  const row = record(value)
  if (!row) throw corrupt()
  const owner = own(row, 'user_id')
  if (owner !== undefined && owner !== userId) throw corrupt()
  const out: SnapshotRow = {}
  for (const column of table.columns) out[column.name] = readCell(row, column)
  return out
}

function parseSnapshot(raw: unknown, userId: string): ParsedSnapshot {
  const row = record(raw)
  if (!row || own(row, 'format') !== INKNOTE_SNAPSHOT_FORMAT || own(row, 'version') !== INKNOTE_SNAPSHOT_VERSION) {
    throw corrupt()
  }
  const createdAt = own(row, 'createdAt')
  const label = own(row, 'label')
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || typeof label !== 'string') {
    throw corrupt()
  }
  const settings = own(row, 'settings')
  if (!record(settings)) throw corrupt()

  const rows = {} as Record<SnapshotTable['key'], SnapshotRow[]>
  for (const table of SNAPSHOT_TABLES) {
    const rawRows = own(row, table.key)
    if (!Array.isArray(rawRows)) throw corrupt()
    rows[table.key] = rawRows.map((entry) => readRow(entry, table, userId))
  }

  const rawAssetIds = own(row, 'assetIds')
  if (!Array.isArray(rawAssetIds)) throw corrupt()
  const assetIds: string[] = []
  const seen = new Set<string>()
  for (const entry of rawAssetIds) {
    if (typeof entry !== 'string' || !INKNOTE_ASSET_ID_RE.test(entry)) throw corrupt()
    if (!seen.has(entry)) {
      seen.add(entry)
      assetIds.push(entry)
    }
  }

  return {
    createdAt,
    label,
    rows,
    settings: sanitizeInknoteSettings(settings),
    assetIds,
  }
}

function pageAssetIds(content: string, out: Set<string>): void {
  const pattern = new RegExp(`${escapeRegExp(INKNOTE_ASSET_URL_PREFIX)}([0-9a-hjkmnp-tv-z]{26})`, 'g')
  for (const match of content.matchAll(pattern)) {
    if (match[1]) out.add(match[1])
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function snapshotAssetIds(snapshot: ParsedSnapshot): string[] {
  const ids = new Set<string>(snapshot.assetIds)
  for (const row of snapshot.rows.pages) {
    if (typeof row.content === 'string') pageAssetIds(row.content, ids)
  }
  for (const row of snapshot.rows.notes) {
    if (typeof row.cover_asset_id === 'string' && INKNOTE_ASSET_ID_RE.test(row.cover_asset_id)) {
      ids.add(row.cover_asset_id)
    }
  }
  for (const row of snapshot.rows.templates) {
    if (typeof row.bg_asset_id === 'string' && INKNOTE_ASSET_ID_RE.test(row.bg_asset_id)) {
      ids.add(row.bg_asset_id)
    }
  }
  return [...ids]
}

function settingsFromRecord(row: InknoteSettingsRecord | null): InknoteSettings {
  if (!row) return sanitizeInknoteSettings({})
  try {
    return sanitizeInknoteSettings(JSON.parse(row.config))
  } catch {
    return sanitizeInknoteSettings({})
  }
}

function snapshotLabel(label: string | undefined): string {
  const cleaned = (label ?? '')
    .replace(/[\x00-\x1f]/g, '')
    .trim()
    .slice(0, SNAPSHOT_LABEL_MAX)
  return cleaned || 'manual'
}

export function inknoteSnapshotObjectKey(userId: string, id: string): string {
  return `inknote/txt/${userId}/snapshots/${id}.json`
}

async function readSnapshotRows(
  db: D1Database,
  userId: string,
): Promise<Record<SnapshotTable['key'], SnapshotRow[]>> {
  const rows = {} as Record<SnapshotTable['key'], SnapshotRow[]>
  for (const table of SNAPSHOT_TABLES) {
    const { results } = await db.prepare(
      `SELECT * FROM ${table.table} WHERE user_id = ?1 ORDER BY ${table.orderBy}`,
    ).bind(userId).all<SnapshotRow>()
    rows[table.key] = results ?? []
  }
  return rows
}

export async function readInknoteSettingsRecord(
  db: D1Database,
  userId: string,
): Promise<InknoteSettingsRecord | null> {
  return await db.prepare(
    `SELECT config, updated_at FROM inknote_settings WHERE user_id = ?1`,
  ).bind(userId).first<InknoteSettingsRecord>()
}

/**
 * Write settings under an optional compare-and-set token.
 *
 * `false` means another device wrote first: the caller reads the row again to answer 409 with the
 * server copy, which is the one the client must show.
 */
export async function writeInknoteSettingsRecord(
  db: D1Database,
  userId: string,
  config: string,
  updatedAt: number,
  baseUpdatedAt?: number,
): Promise<boolean> {
  if (baseUpdatedAt === undefined) {
    await db.prepare(
      `INSERT INTO inknote_settings (user_id, config, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    ).bind(userId, config, updatedAt).run()
    return true
  }
  const updated = await db.prepare(
    `UPDATE inknote_settings SET config = ?3, updated_at = ?4
      WHERE user_id = ?1 AND updated_at = ?2`,
  ).bind(userId, baseUpdatedAt, config, updatedAt).run()
  if (updated.meta.changes) return true
  if (baseUpdatedAt !== 0) return false
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO inknote_settings (user_id, config, updated_at) VALUES (?1, ?2, ?3)`,
  ).bind(userId, config, updatedAt).run()
  return Boolean(inserted.meta.changes)
}

export async function listInknoteTemplateRows(
  db: D1Database,
  userId: string,
): Promise<InknoteTemplateRow[]> {
  const { results } = await db.prepare(
    `SELECT user_id, id, name, paper_style, paper_color, paper_spacing, bg_asset_id,
            texts, title, sub, title_size, sub_size, created_at, updated_at
       FROM inknote_templates WHERE user_id = ?1 ORDER BY created_at, id`,
  ).bind(userId).all<InknoteTemplateRow>()
  return results ?? []
}

export async function inknoteTemplateRowById(
  db: D1Database,
  userId: string,
  id: string,
): Promise<InknoteTemplateRow | null> {
  return await db.prepare(
    `SELECT user_id, id, name, paper_style, paper_color, paper_spacing, bg_asset_id,
            texts, title, sub, title_size, sub_size, created_at, updated_at
       FROM inknote_templates WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<InknoteTemplateRow>()
}

/** `false` means the account reached the template ceiling in the same statement that inserted. */
export async function insertInknoteTemplateRow(
  db: D1Database,
  row: Omit<InknoteTemplateRow, 'user_id'>,
  userId: string,
  maxTemplates: number,
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO inknote_templates (
       user_id, id, name, paper_style, paper_color, paper_spacing, bg_asset_id,
       texts, title, sub, title_size, sub_size, created_at, updated_at
     )
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
      WHERE (SELECT COUNT(*) FROM inknote_templates WHERE user_id = ?1) < ?15`,
  ).bind(
    userId,
    row.id,
    row.name,
    row.paper_style,
    row.paper_color,
    row.paper_spacing,
    row.bg_asset_id,
    row.texts,
    row.title,
    row.sub,
    row.title_size,
    row.sub_size,
    row.created_at,
    row.updated_at,
    maxTemplates,
  ).run()
  return Boolean(result.meta.changes)
}

export async function renameInknoteTemplateRow(
  db: D1Database,
  userId: string,
  id: string,
  name: string,
  updatedAt: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE inknote_templates SET name = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id, name, updatedAt).run()
  return Boolean(result.meta.changes)
}

export async function deleteInknoteTemplateRow(
  db: D1Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM inknote_templates WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).run()
  return Boolean(result.meta.changes)
}

/**
 * Build and store one snapshot.
 *
 * Automatic snapshots are capped at two per minute; manual ones are not, because the settings screen
 * lets a reader take several before a risky change and the retention sweep is the real ceiling.
 */
export async function createInknoteSnapshot(
  env: Env,
  userId: string,
  label?: string,
  now = Date.now(),
): Promise<InknoteSnapshotMeta> {
  const snapshotLabelValue = snapshotLabel(label)
  if (snapshotLabelValue === 'auto') {
    const recent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM inknote_snapshots
        WHERE user_id = ?1 AND label = 'auto' AND created_at > ?2`,
    ).bind(userId, now - AUTO_SNAPSHOT_WINDOW_MS).first<{ n: number }>()
    if (Number(recent?.n ?? 0) >= AUTO_SNAPSHOT_LIMIT) {
      throw new ApiError(429, 'too_many_attempts', 'Automatic snapshots are limited to two per minute', {
        retryAfter: 60,
      })
    }
  }

  const storage = selectAttachmentStorage(env)
  if (!storage) {
    throw new ApiError(
      503,
      'storage_unavailable',
      'Attachment storage is not configured. Bind R2 or Workers KV before saving snapshots.',
    )
  }

  const rows = await readSnapshotRows(env.DB, userId)
  const settings = settingsFromRecord(await readInknoteSettingsRecord(env.DB, userId))
  const referenced = new Set<string>()
  for (const row of rows.pages) {
    if (typeof row.content === 'string') pageAssetIds(row.content, referenced)
  }
  for (const row of rows.notes) {
    if (typeof row.cover_asset_id === 'string' && INKNOTE_ASSET_ID_RE.test(row.cover_asset_id)) {
      referenced.add(row.cover_asset_id)
    }
  }
  for (const row of rows.templates) {
    if (typeof row.bg_asset_id === 'string' && INKNOTE_ASSET_ID_RE.test(row.bg_asset_id)) {
      referenced.add(row.bg_asset_id)
    }
  }

  const payload = {
    format: INKNOTE_SNAPSHOT_FORMAT,
    version: INKNOTE_SNAPSHOT_VERSION,
    createdAt: now,
    label: snapshotLabelValue,
    subjects: rows.subjects,
    notebooks: rows.notebooks,
    notes: rows.notes,
    pages: rows.pages,
    templates: rows.templates,
    settings,
    assetIds: [...referenced],
  }
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  if (bytes.byteLength > INKNOTE_LIMITS.snapshotMaxBytes) {
    throw ApiError.tooLarge('The library is too large for a snapshot; export a .notebook file instead')
  }

  const id = newId()
  const objectKey = inknoteSnapshotObjectKey(userId, id)
  await putAttachmentObject(env, storage, objectKey, bytes, {
    userId,
    objectId: id,
    kind: 'import',
    filename: `snapshot-${id}.json`,
    mime: 'application/json',
    sha256: await sha256Hex(bytes),
  })

  try {
    await env.DB.prepare(
      `INSERT INTO inknote_snapshots (user_id, id, label, note_count, size, object_key, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(userId, id, snapshotLabelValue, rows.notes.length, bytes.byteLength, objectKey, now).run()
  } catch (error) {
    try {
      await deleteAttachmentObjects(env, storage, [objectKey])
    } catch (cleanupError) {
      await scheduleInknoteCleanup(env.DB, userId, [{ objectKey, storage }]).catch(() => {})
      console.warn('[inkstone] Snapshot cleanup after a write rollback will retry later:', cleanupError)
    }
    throw error
  }

  await pruneInknoteSnapshots(env, userId).catch((error) => {
    console.warn('[inkstone] Snapshot retention will retry on the next save:', error)
  })
  await drainInknoteCleanup(env, userId).catch((error) => {
    console.warn('[inkstone] Snapshot cleanup will retry later:', error)
  })

  return { id, label: snapshotLabelValue, noteCount: rows.notes.length, size: bytes.byteLength, createdAt: now }
}

export async function listInknoteSnapshots(
  db: D1Database,
  userId: string,
): Promise<InknoteSnapshotMeta[]> {
  const { results } = await db.prepare(
    `SELECT id, label, note_count, size, object_key, created_at
       FROM inknote_snapshots WHERE user_id = ?1
      ORDER BY created_at DESC, id DESC LIMIT ?2`,
  ).bind(userId, SNAPSHOT_KEEP).all<InknoteSnapshotMetaRow>()
  return (results ?? []).map((row) => ({
    id: row.id,
    label: row.label,
    noteCount: row.note_count,
    size: row.size,
    createdAt: row.created_at,
  }))
}

async function snapshotMetaById(
  db: D1Database,
  userId: string,
  id: string,
): Promise<InknoteSnapshotMetaRow | null> {
  return await db.prepare(
    `SELECT id, label, note_count, size, object_key, created_at
       FROM inknote_snapshots WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<InknoteSnapshotMetaRow>()
}

/** Drop snapshots past the retention window and queue their objects for best-effort deletion. */
export async function pruneInknoteSnapshots(
  env: Env,
  userId: string,
  keep = SNAPSHOT_KEEP,
): Promise<{ removed: number }> {
  const storage = selectAttachmentStorage(env)
  if (!storage) return { removed: 0 }
  const { results } = await env.DB.prepare(
    `SELECT id, object_key FROM inknote_snapshots WHERE user_id = ?1
      ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?2`,
  ).bind(userId, Math.max(0, keep)).all<{ id: string; object_key: string }>()
  const stale = results ?? []
  if (!stale.length) return { removed: 0 }

  const statements: D1PreparedStatement[] = []
  const now = Date.now()
  for (const row of stale) {
    statements.push(
      env.DB.prepare(`DELETE FROM inknote_snapshots WHERE user_id = ?1 AND id = ?2`).bind(userId, row.id),
      env.DB.prepare(
        `INSERT OR IGNORE INTO inknote_cleanup (user_id, object_key, storage, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(userId, row.object_key, storage, now),
    )
    if (statements.length >= WRITE_BATCH) {
      await env.DB.batch(statements.splice(0, statements.length))
    }
  }
  if (statements.length) await env.DB.batch(statements)
  return { removed: stale.length }
}

export async function deleteInknoteSnapshot(
  env: Env,
  userId: string,
  id: string,
): Promise<boolean> {
  const row = await snapshotMetaById(env.DB, userId, id)
  if (!row) return false
  const storage = selectAttachmentStorage(env)
  const statements = [
    env.DB.prepare(`DELETE FROM inknote_snapshots WHERE user_id = ?1 AND id = ?2`).bind(userId, id),
  ]
  if (storage) {
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO inknote_cleanup (user_id, object_key, storage, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(userId, row.object_key, storage, Date.now()))
  }
  const results = await env.DB.batch(statements)
  return Boolean(results[0]?.meta.changes)
}

async function readSnapshotObject(env: Env, objectKey: string): Promise<Uint8Array | null> {
  const current = selectAttachmentStorage(env)
  const order: AttachmentObjectStorage[] = []
  if (current) order.push(current)
  if (env.FILES && current !== 'r2') order.push('r2')
  if (env.FILES_KV && current !== 'kv') order.push('kv')
  for (const storage of order) {
    if (!hasAttachmentStorage(env, storage)) continue
    const bytes = await readAttachmentObject(env, storage, objectKey)
    if (bytes) return bytes
  }
  return null
}

async function missingAssetIds(
  db: D1Database,
  userId: string,
  assetIds: readonly string[],
): Promise<string[]> {
  if (!assetIds.length) return []
  const found = new Set<string>()
  for (let offset = 0; offset < assetIds.length; offset += ASSET_LOOKUP_BATCH) {
    const chunk = assetIds.slice(offset, offset + ASSET_LOOKUP_BATCH)
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    const { results } = await db.prepare(
      `SELECT id FROM inknote_assets WHERE user_id = ?1 AND id IN (${placeholders})`,
    ).bind(userId, ...chunk).all<{ id: string }>()
    for (const row of results ?? []) found.add(row.id)
  }
  return assetIds.filter((id) => !found.has(id))
}

function insertStatements(
  db: D1Database,
  table: SnapshotTable,
  userId: string,
  rows: readonly SnapshotRow[],
): D1PreparedStatement[] {
  const columns = table.columns.map((column) => column.name)
  const placeholders = columns.map((_, index) => `?${index + 2}`).join(', ')
  const sql = `INSERT INTO ${table.table} (user_id, ${columns.join(', ')}) VALUES (?1, ${placeholders})`
  return rows.map((row) =>
    db.prepare(sql).bind(userId, ...columns.map((column) => row[column] ?? null)),
  )
}

/**
 * Replace the library with a snapshot.
 *
 * The current state is snapshotted first, the restore lease keeps a second restore out, and rows are
 * deleted then inserted in batches of at most 100 statements. Asset rows are deliberately untouched.
 */
export async function restoreInknoteSnapshot(
  env: Env,
  userId: string,
  id: string,
): Promise<{ restored: true; missingAssets: string[] }> {
  const meta = await snapshotMetaById(env.DB, userId, id)
  if (!meta) throw ApiError.notFound('Snapshot not found')

  const release = await acquireLease(
    env.DB,
    `inknote-snapshot-restore:${userId}`,
    RESTORE_LEASE_MS,
    'Another snapshot restore is already running for this account',
  )
  try {
    const bytes = await readSnapshotObject(env, meta.object_key)
    if (!bytes) throw ApiError.notFound('Snapshot data is missing')
    if (bytes.byteLength > INKNOTE_LIMITS.snapshotMaxBytes) {
      throw ApiError.tooLarge('The snapshot exceeds the 16 MB limit')
    }
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw corrupt()
    }
    const snapshot = parseSnapshot(raw, userId)

    await createInknoteSnapshot(env, userId, 'pre-restore')

    const deletes: D1PreparedStatement[] = SNAPSHOT_TABLES.map((table) =>
      env.DB.prepare(`DELETE FROM ${table.table} WHERE user_id = ?1`).bind(userId),
    )
    deletes.push(env.DB.prepare(`DELETE FROM inknote_settings WHERE user_id = ?1`).bind(userId))
    await env.DB.batch(deletes)

    let statements: D1PreparedStatement[] = []
    const flush = async (): Promise<void> => {
      if (!statements.length) return
      await env.DB.batch(statements)
      statements = []
    }
    for (const table of SNAPSHOT_TABLES) {
      for (const statement of insertStatements(env.DB, table, userId, snapshot.rows[table.key])) {
        statements.push(statement)
        if (statements.length >= WRITE_BATCH) await flush()
      }
    }
    const restoredAt = Date.now()
    statements.push(env.DB.prepare(
      `INSERT INTO inknote_settings (user_id, config, updated_at) VALUES (?1, ?2, ?3)`,
    ).bind(userId, JSON.stringify(snapshot.settings), restoredAt))
    await flush()

    const missingAssets = await missingAssetIds(env.DB, userId, snapshotAssetIds(snapshot))
    return { restored: true, missingAssets }
  } finally {
    await release()
  }
}
