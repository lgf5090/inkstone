/**
 * D1 databases, tables, schemas and queries.
 *
 * Row counts are read in the same round trip as the table names: one statement for `sqlite_master`,
 * then one `UNION ALL` of `COUNT(*)` per table. Identifiers are always quoted with `quoteIdent`, and
 * table names are re-checked before they are used in a PRAGMA.
 */
import type { CloudflareAuth } from './cf-api'
import { cfFetch } from './cf-api'
import { ApiError } from '../lib/errors'
import { quoteIdent } from '../../shared/cloudflare/sql-utils'

export interface D1Database {
  id: string
  name: string
  created_at?: string
}

export interface D1Table {
  name: string
  rows: number
}

export interface D1Column {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

export interface D1QueryMeta {
  duration: number
  rows_read?: number
  rows_written?: number
  changes?: number
}

export interface D1QueryResult {
  results: Record<string, unknown>[]
  meta: D1QueryMeta
}

interface CfD1Database {
  uuid?: unknown
  id?: unknown
  name?: unknown
  created_at?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toDatabase(row: CfD1Database): D1Database | null {
  const id = text(row.uuid) || text(row.id)
  const name = text(row.name)
  if (!id || !name) return null
  const database: D1Database = { id, name }
  const createdAt = text(row.created_at)
  if (createdAt) database.created_at = createdAt
  return database
}

function d1Path(cfAccountId: string, databaseId?: string): string {
  const base = `/accounts/${encodeURIComponent(cfAccountId)}/d1/database`
  return databaseId ? `${base}/${encodeURIComponent(databaseId)}` : base
}

export async function listD1Databases(
  auth: CloudflareAuth,
  cfAccountId: string,
): Promise<D1Database[]> {
  const body = await cfFetch<{ result?: CfD1Database[] | null }>(auth, d1Path(cfAccountId))
  return (body.result ?? []).map(toDatabase).filter((row): row is D1Database => row !== null)
}

export async function createD1Database(
  auth: CloudflareAuth,
  cfAccountId: string,
  name: string,
): Promise<D1Database> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw ApiError.badRequest('A D1 database name may contain letters, numbers, underscores and hyphens')
  }
  const body = await cfFetch<{ result?: CfD1Database }>(auth, d1Path(cfAccountId), {
    method: 'POST',
    body: { name },
  })
  const created = body.result ? toDatabase(body.result) : null
  if (!created) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a database without answering with it')
  return created
}

export async function deleteD1Database(
  auth: CloudflareAuth,
  cfAccountId: string,
  databaseId: string,
): Promise<void> {
  await cfFetch(auth, d1Path(cfAccountId, databaseId), { method: 'DELETE' })
}

interface CfQueryEntry {
  results?: unknown[] | null
  meta?: Record<string, unknown>
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export async function runD1Query(
  auth: CloudflareAuth,
  cfAccountId: string,
  databaseId: string,
  sql: string,
): Promise<D1QueryResult> {
  if (!sql.trim()) throw ApiError.badRequest('SQL is required')
  const body = await cfFetch<{ result?: CfQueryEntry | CfQueryEntry[] | null }>(
    auth,
    `${d1Path(cfAccountId, databaseId)}/query`,
    { method: 'POST', body: { sql } },
  )
  const entries = Array.isArray(body.result) ? body.result : body.result ? [body.result] : []
  const first = entries.find((entry) => Array.isArray(entry.results)) ?? entries[0]
  const results = (first?.results ?? []).filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row),
  )
  let duration = 0
  let rowsRead: number | undefined
  let rowsWritten: number | undefined
  let changes: number | undefined
  for (const entry of entries) {
    duration += numberOrUndefined(entry.meta?.duration) ?? 0
    const read = numberOrUndefined(entry.meta?.rows_read)
    const written = numberOrUndefined(entry.meta?.rows_written)
    const changed = numberOrUndefined(entry.meta?.changes)
    if (read !== undefined) rowsRead = (rowsRead ?? 0) + read
    if (written !== undefined) rowsWritten = (rowsWritten ?? 0) + written
    if (changed !== undefined) changes = (changes ?? 0) + changed
  }
  const meta: D1QueryMeta = { duration }
  if (rowsRead !== undefined) meta.rows_read = rowsRead
  if (rowsWritten !== undefined) meta.rows_written = rowsWritten
  if (changes !== undefined) meta.changes = changes
  return { results, meta }
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export async function listD1Tables(
  auth: CloudflareAuth,
  cfAccountId: string,
  databaseId: string,
): Promise<D1Table[]> {
  const listing = await runD1Query(
    auth,
    cfAccountId,
    databaseId,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  )
  const names = listing.results
    .map((row) => text(row.name))
    .filter((name) => name.length > 0)
  if (names.length === 0) return []
  const counts = names
    .map((name) => `SELECT ${sqlString(name)} AS name, COUNT(*) AS rows FROM ${quoteIdent(name)}`)
    .join(' UNION ALL ')
  const counted = await runD1Query(auth, cfAccountId, databaseId, counts)
  const rowsByName = new Map<string, number>()
  for (const row of counted.results) {
    const name = text(row.name)
    if (!name) continue
    const rows = numberOrUndefined(row.rows)
    if (rows !== undefined) rowsByName.set(name, rows)
  }
  return names.map((name) => ({ name, rows: rowsByName.get(name) ?? 0 }))
}

export async function getD1TableSchema(
  auth: CloudflareAuth,
  cfAccountId: string,
  databaseId: string,
  tableName: string,
): Promise<D1Column[]> {
  if (!tableName || tableName.length > 128 || /[\u0000-\u001f]/.test(tableName)) {
    throw ApiError.badRequest('Invalid table name')
  }
  const body = await runD1Query(
    auth,
    cfAccountId,
    databaseId,
    `PRAGMA table_info(${quoteIdent(tableName)})`,
  )
  const columns: D1Column[] = []
  for (const row of body.results) {
    const name = text(row.name)
    if (!name) continue
    columns.push({
      cid: numberOrUndefined(row.cid) ?? 0,
      name,
      type: text(row.type),
      notnull: numberOrUndefined(row.notnull) ?? 0,
      dflt_value: typeof row.dflt_value === 'string' ? row.dflt_value : null,
      pk: numberOrUndefined(row.pk) ?? 0,
    })
  }
  return columns.sort((left, right) => left.cid - right.cid)
}
