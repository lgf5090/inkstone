/**
 * D1 databases, tables, schemas and queries.
 *
 * Row counts are read in the same round trip as the table names: one statement for `sqlite_master`,
 * then one statement per batch of `COUNT(*)` subqueries. Identifiers are always quoted with
 * `quoteIdent`, and table names are re-checked before they are used in a PRAGMA.
 */
import type { CloudflareAuth } from './cf-api'
import { cfFetch } from './cf-api'
import { ApiError } from '../lib/errors'
import { quoteIdent } from '../../shared/cloudflare/sql-utils'

/** Tables counted per round trip, so one oversized statement cannot fail the whole listing. */
const ROW_COUNT_BATCH = 40

export interface D1Database {
  id: string
  name: string
  created_at?: string
}

/** A table as the sidebar shows it; the count is filled only when someone asked for it. */
export interface D1Table {
  name: string
  rows: number | null
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
  params: readonly unknown[] = [],
): Promise<D1QueryResult> {
  if (!sql.trim()) throw ApiError.badRequest('SQL is required')
  const body = await cfFetch<{ result?: CfQueryEntry | CfQueryEntry[] | null }>(
    auth,
    `${d1Path(cfAccountId, databaseId)}/query`,
    { method: 'POST', body: { sql, ...(params.length > 0 ? { params } : {}) } },
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

/**
 * The tables of a database, with row counts only when asked.
 *
 * `COUNT(*)` walks the table (or its smallest index), so counting every table turns opening a
 * database into a scan of the whole database — and D1 bills for that CPU. Listing names is one small
 * query; the panel offers the counts as a separate, visible action.
 */
export async function listD1Tables(
  auth: CloudflareAuth,
  cfAccountId: string,
  databaseId: string,
  options: { counts?: boolean } = {},
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
  if (!options.counts) return names.map((name) => ({ name, rows: null }))
  const rowsByName = await countTableRows(auth, cfAccountId, databaseId, names)
  return names.map((name) => ({ name, rows: rowsByName.get(name) ?? 0 }))
}

/**
 * Row counts for the named tables, read in as few round trips as SQLite allows.
 *
 * The obvious shape — one `SELECT … COUNT(*)` per table joined with `UNION ALL` — is rejected on any
 * real database: SQLite caps the terms of a compound select far below the table count a D1 database
 * reaches. Scalar subqueries in one select list carry no such cap, so a batch comes back as one row
 * keyed by table name.
 */
async function countTableRows(
  auth: CloudflareAuth,
  cfAccountId: string,
  databaseId: string,
  names: readonly string[],
): Promise<Map<string, number>> {
  const batches: string[][] = []
  for (let index = 0; index < names.length; index += ROW_COUNT_BATCH) {
    batches.push(names.slice(index, index + ROW_COUNT_BATCH))
  }
  // Each batch is one statement and the batches are independent, so the wall time is a single round
  // trip however many tables the database holds.
  const counted = await Promise.all(batches.map((batch) => runD1Query(
    auth,
    cfAccountId,
    databaseId,
    `SELECT ${batch.map((name) => `(SELECT COUNT(*) FROM ${quoteIdent(name)}) AS ${quoteIdent(name)}`).join(', ')}`,
  )))
  const rowsByName = new Map<string, number>()
  counted.forEach((result, index) => {
    for (const row of result.results) {
      for (const name of batches[index] ?? []) {
        const rows = numberOrUndefined(row[name])
        if (rows !== undefined) rowsByName.set(name, rows)
      }
    }
  })
  return rowsByName
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

export interface D1RowsPage {
  columns: string[]
  primaryKey: string[]
  rows: Record<string, unknown>[]
  total: number
  limit: number
  offset: number
}

export interface D1RowWriteResult {
  changes: number
}

function primaryKeyOf(columns: readonly D1Column[]): D1Column[] {
  return columns.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk)
}

function rowValue(value: unknown, label: string): string | number | null {
  if (value === null) return null
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value
  throw ApiError.badRequest(`${label} must be a string, number or null`)
}

function readRowKey(
  value: unknown,
  primaryKey: readonly D1Column[],
): Array<string | number | null> {
  if (primaryKey.length === 0) throw ApiError.badRequest('This table has no primary key')
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  if (!row) throw ApiError.badRequest('A row key is required')
  const allowed = new Set(primaryKey.map((column) => column.name))
  for (const name of Object.keys(row)) {
    if (!allowed.has(name)) throw ApiError.badRequest(`Unexpected key column: ${name}`)
  }
  return primaryKey.map((column) => {
    if (!(column.name in row)) throw ApiError.badRequest(`Missing key column: ${column.name}`)
    const current = row[column.name]
    if (current === null || current === undefined) throw ApiError.badRequest(`Key column ${column.name} is null`)
    return rowValue(current, `Key column ${column.name}`)
  })
}

function readRowValues(
  value: unknown,
  columns: readonly D1Column[],
  primaryKey: readonly D1Column[],
): Array<{ column: D1Column; value: string | number | null }> {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  if (!row) throw ApiError.badRequest('Row values are required')
  const names = Object.keys(row)
  if (names.length === 0) throw ApiError.badRequest('No values were supplied')
  const primaryNames = new Set(primaryKey.map((column) => column.name))
  for (const name of names) {
    if (primaryNames.has(name)) throw ApiError.badRequest(`Primary key column ${name} cannot be edited`)
  }
  return names.map((name) => {
    const column = columns.find((entry) => entry.name === name)
    if (!column) throw ApiError.badRequest(`Unknown column: ${name}`)
    return { column, value: rowValue(row[name], `Column ${name}`) }
  })
}

function assertSingleRow(changes: number | undefined): D1RowWriteResult {
  if (changes === undefined) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not report the affected rows')
  if (changes === 0) throw ApiError.notFound('No row matched the primary key')
  if (changes > 1) throw new ApiError(502, 'cloudflare_upstream', 'More than one row matched the primary key')
  return { changes }
}

/** Update one row selected by its primary key; identifiers come from the schema, values are bound. */
export async function updateD1Row(
  auth: CloudflareAuth,
  cfAccountId: string,
  databaseId: string,
  tableName: string,
  input: { key: unknown; values: unknown },
): Promise<D1RowWriteResult> {
  if (!tableName || tableName.length > 128 || /[\u0000-\u001f]/.test(tableName)) {
    throw ApiError.badRequest('Invalid table name')
  }
  const columns = await getD1TableSchema(auth, cfAccountId, databaseId, tableName)
  if (columns.length === 0) throw ApiError.notFound('That table has no columns')
  const primaryKey = primaryKeyOf(columns)
  const keyValues = readRowKey(input.key, primaryKey)
  const values = readRowValues(input.values, columns, primaryKey)
  const assignments = values.map(({ column }) => `${quoteIdent(column.name)} = ?`).join(', ')
  const where = primaryKey.map((column) => `${quoteIdent(column.name)} = ?`).join(' AND ')
  const result = await runD1Query(
    auth,
    cfAccountId,
    databaseId,
    `UPDATE ${quoteIdent(tableName)} SET ${assignments} WHERE ${where}`,
    [...values.map(({ value }) => value), ...keyValues],
  )
  return assertSingleRow(result.meta.changes)
}

/** Delete one row selected by its primary key; identifiers come from the schema, values are bound. */
export async function deleteD1Row(
  auth: CloudflareAuth,
  cfAccountId: string,
  databaseId: string,
  tableName: string,
  key: unknown,
): Promise<D1RowWriteResult> {
  if (!tableName || tableName.length > 128 || /[\u0000-\u001f]/.test(tableName)) {
    throw ApiError.badRequest('Invalid table name')
  }
  const columns = await getD1TableSchema(auth, cfAccountId, databaseId, tableName)
  if (columns.length === 0) throw ApiError.notFound('That table has no columns')
  const primaryKey = primaryKeyOf(columns)
  const keyValues = readRowKey(key, primaryKey)
  const where = primaryKey.map((column) => `${quoteIdent(column.name)} = ?`).join(' AND ')
  const result = await runD1Query(
    auth,
    cfAccountId,
    databaseId,
    `DELETE FROM ${quoteIdent(tableName)} WHERE ${where}`,
    keyValues,
  )
  return assertSingleRow(result.meta.changes)
}

/**
 * One page of a table's rows, optionally filtered across every column.
 *
 * The table name comes from the database's own listing and is re-quoted; the search text is bound
 * as a parameter, never spliced into the statement. Filtering casts each column to text so an
 * integer or blob column can still match a reader's search without guessing its type.
 *
 * This is read-only: it never builds an UPDATE or DELETE.
 */
export async function readD1Rows(
  auth: CloudflareAuth,
  cfAccountId: string,
  databaseId: string,
  tableName: string,
  options: { limit: number; offset: number; search: string },
): Promise<D1RowsPage> {
  if (!tableName || tableName.length > 128 || /[\u0000-\u001f]/.test(tableName)) {
    throw ApiError.badRequest('Invalid table name')
  }
  const columns = await getD1TableSchema(auth, cfAccountId, databaseId, tableName)
  if (columns.length === 0) throw ApiError.notFound('That table has no columns')
  const search = options.search.trim()
  if (search.length > 200) throw ApiError.badRequest('The search text is longer than 200 characters')

  let where = ''
  const params: unknown[] = []
  if (search) {
    where = ` WHERE ${columns.map((column) => `CAST(${quoteIdent(column.name)} AS TEXT) LIKE ?`).join(' OR ')}`
    for (let index = 0; index < columns.length; index += 1) params.push(`%${search}%`)
  }
  const identifier = quoteIdent(tableName)
  const counted = await runD1Query(
    auth,
    cfAccountId,
    databaseId,
    `SELECT COUNT(*) AS total FROM ${identifier}${where}`,
    params,
  )
  const total = numberOrUndefined(counted.results[0]?.total) ?? 0

  const order = columns.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk)
  const orderBy = order.length > 0
    ? ` ORDER BY ${order.map((column) => quoteIdent(column.name)).join(', ')}`
    : ''
  const page = await runD1Query(
    auth,
    cfAccountId,
    databaseId,
    `SELECT * FROM ${identifier}${where}${orderBy} LIMIT ? OFFSET ?`,
    [...params, options.limit, options.offset],
  )
  return {
    columns: columns.map((column) => column.name),
    primaryKey: primaryKeyOf(columns).map((column) => column.name),
    rows: page.results,
    total,
    limit: options.limit,
    offset: options.offset,
  }
}
