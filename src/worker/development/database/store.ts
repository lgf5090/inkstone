import {
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  HISTORY_LIMIT_MIN,
} from '@shared/development/database/types'
import type {
  DatabaseConnectionType,
  DatabaseConnectionView,
  DatabaseSettings,
  ExportFormat,
  QueryHistoryEntry,
  SavedQuery,
} from '@shared/development/database/types'

export interface ConnectionRecord {
  id: string
  name: string
  type: DatabaseConnectionType
  d1AccountId: string
  d1DatabaseId: string
  d1DatabaseName: string
  tursoUrl: string
  secretCiphertext: string
  sort: number
  isFavorite: boolean
  isPinned: boolean
  createdAt: number
  updatedAt: number
}

export interface ConnectionInsert {
  id: string
  name: string
  type: DatabaseConnectionType
  d1AccountId?: string
  d1DatabaseId?: string
  d1DatabaseName?: string
  tursoUrl?: string
  secretCiphertext: string
  createdAt: number
  updatedAt: number
}

export interface ConnectionPatch {
  name?: string
  d1AccountId?: string
  d1DatabaseId?: string
  d1DatabaseName?: string
  tursoUrl?: string
  secretCiphertext?: string
}

export interface ConnectionFlags {
  isFavorite?: boolean
  isPinned?: boolean
}

export interface SavedQueryInsert {
  id: string
  connectionId: string
  name: string
  sql: string
  namespace: string
  createdAt: number
  updatedAt: number
}

export interface SavedQueryPatch {
  name?: string
  sql?: string
  namespace?: string
}

export interface HistoryInsert {
  id: string
  connectionId: string
  query: string
  executedAt: number
  durationMs: number
  error: string | null
}

export interface ExportRecord {
  id: string
  filename: string
  format: ExportFormat
  r2Key: string
  size: number
  createdAt: number
}

export interface ExportInsert {
  id: string
  filename: string
  format: ExportFormat
  r2Key: string
  size: number
  createdAt: number
}

interface ConnectionRow {
  id: string
  name: string
  type: string
  d1_account_id: string
  d1_database_id: string
  d1_database_name: string
  turso_url: string
  secret_ciphertext: string
  sort: number
  is_favorite: number
  is_pinned: number
  created_at: number
  updated_at: number
}

interface SavedQueryRow {
  id: string
  connection_id: string
  name: string
  sql: string
  namespace: string
  created_at: number
  updated_at: number
}

interface HistoryRow {
  id: string
  connection_id: string
  query: string
  executed_at: number
  duration_ms: number
  error: string | null
}

interface ExportRow {
  id: string
  filename: string
  format: string
  r2_key: string
  size: number
  created_at: number
}

const CONNECTION_COLUMNS = `id, name, type, d1_account_id, d1_database_id, d1_database_name,
  turso_url, secret_ciphertext, sort, is_favorite, is_pinned, created_at, updated_at`

const SAVED_QUERY_COLUMNS = `id, connection_id, name, sql, namespace, created_at, updated_at`

const HISTORY_COLUMNS = `id, connection_id, query, executed_at, duration_ms, error`

const EXPORT_COLUMNS = `id, filename, format, r2_key, size, created_at`

const CONNECTION_PATCH_COLUMNS: ReadonlyArray<[keyof ConnectionPatch, string]> = [
  ['name', 'name'],
  ['d1AccountId', 'd1_account_id'],
  ['d1DatabaseId', 'd1_database_id'],
  ['d1DatabaseName', 'd1_database_name'],
  ['tursoUrl', 'turso_url'],
  ['secretCiphertext', 'secret_ciphertext'],
]

function rowToConnection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type === 'turso' ? 'turso' : 'd1',
    d1AccountId: row.d1_account_id,
    d1DatabaseId: row.d1_database_id,
    d1DatabaseName: row.d1_database_name,
    tursoUrl: row.turso_url,
    secretCiphertext: row.secret_ciphertext,
    sort: row.sort,
    isFavorite: row.is_favorite === 1,
    isPinned: row.is_pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToSavedQuery(row: SavedQueryRow): SavedQuery {
  return {
    id: row.id,
    connectionId: row.connection_id,
    name: row.name,
    sql: row.sql,
    namespace: row.namespace || 'default',
    updatedAt: row.updated_at,
  }
}

function rowToHistory(row: HistoryRow): QueryHistoryEntry {
  return {
    id: row.id,
    connectionId: row.connection_id,
    query: row.query,
    executedAt: row.executed_at,
    durationMs: row.duration_ms,
    error: row.error,
  }
}

function rowToExport(row: ExportRow): ExportRecord {
  return {
    id: row.id,
    filename: row.filename,
    format: row.format === 'csv' || row.format === 'json' || row.format === 'sql' ? row.format : 'txt',
    r2Key: row.r2_key,
    size: row.size,
    createdAt: row.created_at,
  }
}

export function toConnectionView(record: ConnectionRecord): DatabaseConnectionView {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    d1AccountId: record.d1AccountId,
    d1DatabaseId: record.d1DatabaseId,
    d1DatabaseName: record.d1DatabaseName,
    tursoUrl: record.tursoUrl,
    hasSecret: record.secretCiphertext.length > 0,
    sort: record.sort,
    isFavorite: record.isFavorite,
    isPinned: record.isPinned,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export async function listConnections(db: D1Database, userId: string): Promise<ConnectionRecord[]> {
  const result = await db
    .prepare(
      `SELECT ${CONNECTION_COLUMNS}
         FROM development_database_connections
        WHERE user_id = ?1
        ORDER BY is_pinned DESC, is_favorite DESC, sort ASC, id ASC`,
    )
    .bind(userId)
    .all<ConnectionRow>()
  return (result.results ?? []).map(rowToConnection)
}

export async function countConnections(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM development_database_connections WHERE user_id = ?1')
    .bind(userId)
    .first<{ count: number }>()
  return row?.count ?? 0
}

export async function findConnection(
  db: D1Database,
  userId: string,
  id: string,
): Promise<ConnectionRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${CONNECTION_COLUMNS}
         FROM development_database_connections
        WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, id)
    .first<ConnectionRow>()
  return row ? rowToConnection(row) : null
}

export async function insertConnection(
  db: D1Database,
  userId: string,
  record: ConnectionInsert,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO development_database_connections
         (user_id, id, name, type, d1_account_id, d1_database_id, d1_database_name, turso_url,
          secret_ciphertext, sort, is_favorite, is_pinned, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
               (SELECT COALESCE(MAX(sort), -1) + 1
                  FROM development_database_connections
                 WHERE user_id = ?1),
               0, 0, ?10, ?10)`,
    )
    .bind(
      userId,
      record.id,
      record.name,
      record.type,
      record.d1AccountId ?? '',
      record.d1DatabaseId ?? '',
      record.d1DatabaseName ?? '',
      record.tursoUrl ?? '',
      record.secretCiphertext,
      record.createdAt,
    )
    .run()
}

export async function updateConnection(
  db: D1Database,
  userId: string,
  id: string,
  patch: ConnectionPatch,
  updatedAt: number,
): Promise<boolean> {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, column] of CONNECTION_PATCH_COLUMNS) {
    const value = patch[key]
    if (value === undefined) continue
    values.push(value)
    sets.push(`${column} = ?${values.length}`)
  }
  if (sets.length === 0) return true
  values.push(updatedAt)
  sets.push(`updated_at = ?${values.length}`)
  values.push(userId, id)
  const result = await db
    .prepare(
      `UPDATE development_database_connections
          SET ${sets.join(', ')}
        WHERE user_id = ?${values.length - 1} AND id = ?${values.length}`,
    )
    .bind(...values)
    .run()
  return (result.meta.changes ?? 0) > 0
}

export async function updateConnectionFlags(
  db: D1Database,
  userId: string,
  id: string,
  flags: ConnectionFlags,
  updatedAt: number,
): Promise<boolean> {
  const sets: string[] = []
  const values: unknown[] = []
  if (flags.isFavorite !== undefined) {
    values.push(flags.isFavorite ? 1 : 0)
    sets.push(`is_favorite = ?${values.length}`)
  }
  if (flags.isPinned !== undefined) {
    values.push(flags.isPinned ? 1 : 0)
    sets.push(`is_pinned = ?${values.length}`)
  }
  if (sets.length === 0) return true
  values.push(updatedAt)
  sets.push(`updated_at = ?${values.length}`)
  values.push(userId, id)
  const result = await db
    .prepare(
      `UPDATE development_database_connections
          SET ${sets.join(', ')}
        WHERE user_id = ?${values.length - 1} AND id = ?${values.length}`,
    )
    .bind(...values)
    .run()
  return (result.meta.changes ?? 0) > 0
}

export async function findMissingConnectionIds(
  db: D1Database,
  userId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return []
  const placeholders = ids.map((_, index) => `?${index + 2}`).join(', ')
  const result = await db
    .prepare(
      `SELECT id FROM development_database_connections
        WHERE user_id = ?1 AND id IN (${placeholders})`,
    )
    .bind(userId, ...ids)
    .all<{ id: string }>()
  const found = new Set((result.results ?? []).map((row) => row.id))
  return ids.filter((id) => !found.has(id))
}

export async function updateConnectionOrder(
  db: D1Database,
  userId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  await db.batch(
    ids.map((id, index) =>
      db
        .prepare(
          `UPDATE development_database_connections
              SET sort = ?1
            WHERE user_id = ?2 AND id = ?3`,
        )
        .bind(index, userId, id),
    ),
  )
}

export async function deleteConnection(db: D1Database, userId: string, id: string): Promise<boolean> {
  const existing = await findConnection(db, userId, id)
  if (!existing) return false
  await db.batch([
    db
      .prepare('DELETE FROM development_database_saved_queries WHERE user_id = ?1 AND connection_id = ?2')
      .bind(userId, id),
    db
      .prepare('DELETE FROM development_database_query_history WHERE user_id = ?1 AND connection_id = ?2')
      .bind(userId, id),
    db
      .prepare('DELETE FROM development_database_connections WHERE user_id = ?1 AND id = ?2')
      .bind(userId, id),
  ])
  return true
}

export async function listSavedQueries(
  db: D1Database,
  userId: string,
  connectionId?: string,
): Promise<SavedQuery[]> {
  const result = connectionId
    ? await db
        .prepare(
          `SELECT ${SAVED_QUERY_COLUMNS}
             FROM development_database_saved_queries
            WHERE user_id = ?1 AND connection_id = ?2
            ORDER BY updated_at DESC, id DESC`,
        )
        .bind(userId, connectionId)
        .all<SavedQueryRow>()
    : await db
        .prepare(
          `SELECT ${SAVED_QUERY_COLUMNS}
             FROM development_database_saved_queries
            WHERE user_id = ?1
            ORDER BY updated_at DESC, id DESC`,
        )
        .bind(userId)
        .all<SavedQueryRow>()
  return (result.results ?? []).map(rowToSavedQuery)
}

export async function countSavedQueries(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM development_database_saved_queries WHERE user_id = ?1')
    .bind(userId)
    .first<{ count: number }>()
  return row?.count ?? 0
}

export async function findSavedQuery(
  db: D1Database,
  userId: string,
  id: string,
): Promise<SavedQuery | null> {
  const row = await db
    .prepare(
      `SELECT ${SAVED_QUERY_COLUMNS}
         FROM development_database_saved_queries
        WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, id)
    .first<SavedQueryRow>()
  return row ? rowToSavedQuery(row) : null
}

export async function insertSavedQuery(
  db: D1Database,
  userId: string,
  record: SavedQueryInsert,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO development_database_saved_queries
         (user_id, id, connection_id, name, sql, namespace, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      userId,
      record.id,
      record.connectionId,
      record.name,
      record.sql,
      record.namespace,
      record.createdAt,
      record.updatedAt,
    )
    .run()
}

export async function updateSavedQuery(
  db: D1Database,
  userId: string,
  id: string,
  patch: SavedQueryPatch,
  updatedAt: number,
): Promise<SavedQuery | null> {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    values.push(patch.name)
    sets.push(`name = ?${values.length}`)
  }
  if (patch.sql !== undefined) {
    values.push(patch.sql)
    sets.push(`sql = ?${values.length}`)
  }
  if (patch.namespace !== undefined) {
    values.push(patch.namespace || 'default')
    sets.push(`namespace = ?${values.length}`)
  }
  if (sets.length > 0) {
    values.push(updatedAt)
    sets.push(`updated_at = ?${values.length}`)
    values.push(userId, id)
    await db
      .prepare(
        `UPDATE development_database_saved_queries
            SET ${sets.join(', ')}
          WHERE user_id = ?${values.length - 1} AND id = ?${values.length}`,
      )
      .bind(...values)
      .run()
  }
  return await findSavedQuery(db, userId, id)
}

export async function deleteSavedQuery(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM development_database_saved_queries WHERE user_id = ?1 AND id = ?2')
    .bind(userId, id)
    .run()
  return (result.meta.changes ?? 0) > 0
}

export async function insertHistory(
  db: D1Database,
  userId: string,
  entry: HistoryInsert,
  createdAt: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO development_database_query_history
         (user_id, id, connection_id, query, executed_at, duration_ms, error, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      userId,
      entry.id,
      entry.connectionId,
      entry.query,
      entry.executedAt,
      entry.durationMs,
      entry.error,
      createdAt,
    )
    .run()
}

export async function trimHistory(
  db: D1Database,
  userId: string,
  connectionId: string,
  limit: number,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM development_database_query_history
        WHERE user_id = ?1 AND connection_id = ?2 AND id NOT IN (
          SELECT id FROM development_database_query_history
           WHERE user_id = ?3 AND connection_id = ?4
           ORDER BY executed_at DESC, id DESC
           LIMIT ?5
        )`,
    )
    .bind(userId, connectionId, userId, connectionId, limit)
    .run()
}

export async function recordHistory(
  db: D1Database,
  userId: string,
  entry: HistoryInsert,
  limit: number,
  createdAt: number,
): Promise<void> {
  await insertHistory(db, userId, entry, createdAt)
  await trimHistory(db, userId, entry.connectionId, limit)
}

export async function listHistory(
  db: D1Database,
  userId: string,
  connectionId: string,
  limit: number,
): Promise<QueryHistoryEntry[]> {
  const result = await db
    .prepare(
      `SELECT ${HISTORY_COLUMNS}
         FROM development_database_query_history
        WHERE user_id = ?1 AND connection_id = ?2
        ORDER BY executed_at DESC, id DESC
        LIMIT ?3`,
    )
    .bind(userId, connectionId, limit)
    .all<HistoryRow>()
  return (result.results ?? []).map(rowToHistory)
}

export async function clearHistory(
  db: D1Database,
  userId: string,
  connectionId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM development_database_query_history WHERE user_id = ?1 AND connection_id = ?2')
    .bind(userId, connectionId)
    .run()
}

export async function getSettings(db: D1Database, userId: string): Promise<DatabaseSettings> {
  const row = await db
    .prepare('SELECT history_limit FROM development_database_settings WHERE user_id = ?1')
    .bind(userId)
    .first<{ history_limit: number }>()
  const limit = Number(row?.history_limit)
  return {
    historyLimit:
      Number.isFinite(limit) && limit >= HISTORY_LIMIT_MIN && limit <= HISTORY_LIMIT_MAX
        ? Math.round(limit)
        : HISTORY_LIMIT_DEFAULT,
  }
}

export async function saveSettings(
  db: D1Database,
  userId: string,
  historyLimit: number,
  updatedAt: number,
): Promise<DatabaseSettings> {
  const limit = Math.min(HISTORY_LIMIT_MAX, Math.max(HISTORY_LIMIT_MIN, Math.round(historyLimit)))
  await db
    .prepare(
      `INSERT INTO development_database_settings (user_id, history_limit, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(user_id) DO UPDATE
          SET history_limit = excluded.history_limit, updated_at = excluded.updated_at`,
    )
    .bind(userId, limit, updatedAt)
    .run()
  return { historyLimit: limit }
}

export async function insertExport(
  db: D1Database,
  userId: string,
  record: ExportInsert,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO development_database_exports
         (user_id, id, filename, format, r2_key, size, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      userId,
      record.id,
      record.filename,
      record.format,
      record.r2Key,
      record.size,
      record.createdAt,
    )
    .run()
}

export async function findExport(
  db: D1Database,
  userId: string,
  id: string,
): Promise<ExportRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${EXPORT_COLUMNS}
         FROM development_database_exports
        WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, id)
    .first<ExportRow>()
  return row ? rowToExport(row) : null
}

export async function listExpiredExports(
  db: D1Database,
  userId: string,
  before: number,
): Promise<ExportRecord[]> {
  const result = await db
    .prepare(
      `SELECT ${EXPORT_COLUMNS}
         FROM development_database_exports
        WHERE user_id = ?1 AND created_at < ?2
        ORDER BY created_at ASC`,
    )
    .bind(userId, before)
    .all<ExportRow>()
  return (result.results ?? []).map(rowToExport)
}

export async function deleteExpiredExports(
  db: D1Database,
  userId: string,
  before: number,
): Promise<void> {
  await db
    .prepare('DELETE FROM development_database_exports WHERE user_id = ?1 AND created_at < ?2')
    .bind(userId, before)
    .run()
}

export async function deleteExport(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM development_database_exports WHERE user_id = ?1 AND id = ?2')
    .bind(userId, id)
    .run()
  return (result.meta.changes ?? 0) > 0
}
