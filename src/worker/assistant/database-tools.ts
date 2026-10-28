import { quoteIdent, isDestructiveSql, isWriteSql, splitSqlStatements } from '@shared/development/database/sql-utils'
import { executeBatch, executeQuery, QueryFailure } from '../development/database/query'
import { findConnection, listConnections } from '../development/database/store'
import type { ConnectionRecord } from '../development/database/store'
import type { QueryResult } from '@shared/development/database/types'
import { MAX_SQL_LENGTH } from '@shared/development/database/types'
import { ToolError, type ToolContext, type ToolDefinition } from './tools'

const CONNECTION_FIELD = {
  type: 'string' as const,
  description: 'Saved connection id from database_list_connections. Omit to use the connection open in the Studio.',
  optional: true,
  maxLength: 64,
}
const TABLE_FIELD = { type: 'string' as const, minLength: 1, maxLength: 200, description: 'Table or view name.' }
const SQL_FIELD = { type: 'string' as const, minLength: 1, maxLength: Math.min(MAX_SQL_LENGTH, 20_000) }
const MAX_RESULT_ROWS = 100

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/
const DEFAULT_LITERAL = /^(?:NULL|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|[+-]?\d+(?:\.\d+)?|'(?:[^']|'')*')$/i

function connectionIdOf(args: Record<string, unknown>, ctx: ToolContext): string {
  const explicit = typeof args.connectionId === 'string' ? args.connectionId.trim() : ''
  const id = explicit || ctx.databaseConnectionId || ''
  if (!id) throw new ToolError('No connection chosen. Call database_list_connections and pass a connectionId.')
  return id
}

async function requireConnection(ctx: ToolContext, id: string): Promise<ConnectionRecord> {
  const connection = await findConnection(ctx.env.DB, ctx.store.userId, id)
  if (!connection) throw new ToolError('That connection does not exist. Call database_list_connections for the ids.')
  return connection
}

function refusal(error: unknown): never {
  if (error instanceof QueryFailure) {
    const detail = error.detail?.trim()
    throw new ToolError(detail ? `The database refused it: ${detail}` : 'The database refused that statement.')
  }
  throw error
}

async function run(ctx: ToolContext, connectionId: string, sql: string, params: unknown[] = []): Promise<QueryResult> {
  try {
    return await executeQuery(ctx.env, ctx.env.DB, ctx.store.userId, connectionId, sql, params)
  } catch (error) {
    return refusal(error)
  }
}

async function runBatch(ctx: ToolContext, connectionId: string, statements: Array<{ sql: string }>): Promise<void> {
  try {
    await executeBatch(ctx.env, ctx.env.DB, ctx.store.userId, connectionId, statements)
  } catch (error) {
    refusal(error)
  }
}

function compactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (value instanceof Uint8Array) return `[BLOB ${value.byteLength} bytes]`
  if (typeof value === 'object') {
    const encoded = (value as Record<string, unknown>).__inkstone_blob__
    if (typeof encoded === 'string') return `[BLOB ${Math.floor((encoded.length * 3) / 4)} bytes]`
    return value
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`
  return value
}

function compact(result: QueryResult, limit = MAX_RESULT_ROWS): Record<string, unknown> {
  const rows = result.rows.slice(0, limit).map((row) => row.map(compactValue))
  return {
    columns: result.columns,
    rows,
    rowCount: result.rows.length,
    ...(result.rows.length > limit ? { truncated: true, note: `Only the first ${limit} rows are shown.` } : {}),
    ...(typeof result.rowsAffected === 'number' ? { rowsAffected: result.rowsAffected } : {}),
  }
}

async function tableColumns(ctx: ToolContext, connectionId: string, table: string): Promise<string[]> {
  const result = await run(ctx, connectionId, `PRAGMA table_info(${quoteIdent(table)})`)
  if (result.rows.length === 0) throw new ToolError(`Table "${table}" does not exist in that connection.`)
  return result.rows.map((row) => String(row[1]))
}

function whereClause(where: Record<string, unknown>, columns: string[]): { sql: string; params: unknown[] } {
  const entries = Object.entries(where).filter(([, value]) => value !== undefined)
  if (entries.length === 0) throw new ToolError('A where object with at least one column is required.')
  const parts: string[] = []
  const params: unknown[] = []
  for (const [column, value] of entries) {
    if (!columns.includes(column)) throw new ToolError(`Column "${column}" does not exist. Known columns: ${columns.join(', ')}.`)
    if (value === null) {
      parts.push(`${quoteIdent(column)} IS NULL`)
    } else {
      parts.push(`${quoteIdent(column)} = ?`)
      params.push(value)
    }
  }
  return { sql: parts.join(' AND '), params }
}

function normalizeRows(rows: Array<Record<string, unknown>>, columns: string[]): Array<Record<string, unknown>> {
  if (rows.length === 0) throw new ToolError('rows cannot be empty.')
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) throw new ToolError(`Column "${key}" does not exist. Known columns: ${columns.join(', ')}.`)
    }
  }
  return rows
}

function insertStatement(table: string, rows: Array<Record<string, unknown>>): { sql: string; params: unknown[] } {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const params: unknown[] = []
  const tuples = rows.map((row) => `(${columns.map((column) => {
    const value = row[column]
    if (value === undefined) return 'NULL'
    params.push(value)
    return '?'
  }).join(', ')})`)
  return {
    sql: `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES ${tuples.join(', ')}`,
    params,
  }
}

export const DATABASE_TOOLS: ToolDefinition[] = [
  {
    name: 'database_list_connections',
    description: 'List the saved database connections this account may use, with their ids and types. Call this before other database tools unless the screen context already names the connection.',
    permission: 'read',
    fields: {},
    async run(_args, ctx) {
      const connections = await listConnections(ctx.env.DB, ctx.store.userId)
      return {
        connections: connections.map((connection) => ({
          id: connection.id,
          name: connection.name,
          type: connection.type,
          ...(connection.type === 'd1' ? { database: connection.d1DatabaseName || connection.d1DatabaseId } : { url: connection.tursoUrl }),
        })),
        ...(ctx.databaseConnectionId ? { openConnectionId: ctx.databaseConnectionId } : {}),
      }
    },
  },
  {
    name: 'database_list_objects',
    description: 'List tables, views and triggers in one connection. Use it before describing or changing a table.',
    permission: 'read',
    fields: { connectionId: CONNECTION_FIELD },
    async run(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      const result = await run(ctx, connectionId, "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
      const rows = result.rows.map((row) => ({ type: String(row[0]), name: String(row[1]), table: String(row[2]) }))
      return {
        tables: rows.filter((row) => row.type === 'table').map((row) => row.name),
        views: rows.filter((row) => row.type === 'view').map((row) => row.name),
        triggers: rows.filter((row) => row.type === 'trigger').map((row) => row.name),
      }
    },
  },
  {
    name: 'database_describe_table',
    description: 'Read a table or view: columns with types and defaults, indexes, foreign keys and the original CREATE statement.',
    permission: 'read',
    fields: { connectionId: CONNECTION_FIELD, table: TABLE_FIELD },
    async run(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      const table = String(args.table)
      const [info, indexes, foreignKeys, ddl] = await Promise.all([
        run(ctx, connectionId, `PRAGMA table_info(${quoteIdent(table)})`),
        run(ctx, connectionId, `PRAGMA index_list(${quoteIdent(table)})`),
        run(ctx, connectionId, `PRAGMA foreign_key_list(${quoteIdent(table)})`),
        run(ctx, connectionId, 'SELECT sql FROM sqlite_master WHERE name = ? LIMIT 1', [table]),
      ])
      return {
        table,
        columns: info.rows.map((row) => ({
          name: String(row[1]),
          type: String(row[2] ?? ''),
          notNull: Number(row[3]) === 1,
          default: row[4] === null ? null : String(row[4]),
          primaryKey: Number(row[5]) > 0,
        })),
        indexes: indexes.rows.map((row) => ({ name: String(row[1]), unique: Number(row[2]) === 1, origin: String(row[3] ?? '') })),
        foreignKeys: foreignKeys.rows.map((row) => ({ from: String(row[3]), table: String(row[2]), to: String(row[4] ?? '') })),
        ddl: ddl.rows[0]?.[0] ?? null,
      }
    },
  },
  {
    name: 'database_preview_rows',
    description: 'Preview rows from a table or view. Default 20 rows, maximum 100.',
    permission: 'read',
    fields: {
      connectionId: CONNECTION_FIELD,
      table: TABLE_FIELD,
      limit: { type: 'integer', description: 'Row count, 1–100.', minimum: 1, maximum: 100, optional: true },
    },
    async run(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, args.limit)) : 20
      const result = await run(ctx, connectionId, `SELECT * FROM ${quoteIdent(String(args.table))} LIMIT ${limit}`)
      return { table: String(args.table), ...compact(result, limit) }
    },
  },
  {
    name: 'database_run_query',
    description: 'Run one read-only SQL statement (SELECT, WITH or PRAGMA). Use the write tools for changes; destructive SQL is refused here.',
    permission: 'read',
    fields: { connectionId: CONNECTION_FIELD, sql: { ...SQL_FIELD, description: 'One SELECT/WITH/PRAGMA statement. No semicolon-separated scripts.' } },
    async run(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      const sql = String(args.sql)
      const statements = splitSqlStatements(sql)
      if (statements.length !== 1) throw new ToolError('Run one statement at a time.')
      if (isWriteSql(statements[0]!)) throw new ToolError('That statement changes the database. Use database_insert_rows, database_update_rows, database_write_sql, or a destructive tool with approval.')
      return compact(await run(ctx, connectionId, statements[0]!))
    },
  },
  {
    name: 'database_explain',
    description: 'Run EXPLAIN QUERY PLAN for one read statement and return the plan rows.',
    permission: 'read',
    fields: { connectionId: CONNECTION_FIELD, sql: { ...SQL_FIELD, description: 'The SELECT/WITH statement to explain.' } },
    async run(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      return compact(await run(ctx, connectionId, `EXPLAIN QUERY PLAN ${String(args.sql)}`), 200)
    },
  },
  {
    name: 'database_insert_rows',
    description: 'Insert rows into an existing table. Column names must exist; missing columns use their defaults. Up to 200 rows per call.',
    permission: 'write',
    fields: {
      connectionId: CONNECTION_FIELD,
      table: TABLE_FIELD,
      rows: { type: 'array', items: 'object', maxItems: 200, description: 'Rows as objects keyed by column name.' },
    },
    async run(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      const table = String(args.table)
      const columns = await tableColumns(ctx, connectionId, table)
      const rows = normalizeRows(Array.isArray(args.rows) ? args.rows as Array<Record<string, unknown>> : [], columns)
      const statement = insertStatement(table, rows)
      const result = await run(ctx, connectionId, statement.sql, statement.params)
      return { inserted: rows.length, rowsAffected: result.rowsAffected ?? rows.length }
    },
  },
  {
    name: 'database_update_rows',
    description: 'Update columns on rows matched by an exact where map. Requires at least one where column; use database_write_sql for anything else.',
    permission: 'write',
    fields: {
      connectionId: CONNECTION_FIELD,
      table: TABLE_FIELD,
      set: { type: 'object', description: 'Columns to set, keyed by column name.' },
      where: { type: 'object', description: 'Exact-match filter, keyed by column name. At least one column.' },
    },
    async run(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      const table = String(args.table)
      const columns = await tableColumns(ctx, connectionId, table)
      const set = args.set as Record<string, unknown>
      const entries = Object.entries(set).filter(([, value]) => value !== undefined)
      if (entries.length === 0) throw new ToolError('set cannot be empty.')
      for (const [column] of entries) {
        if (!columns.includes(column)) throw new ToolError(`Column "${column}" does not exist. Known columns: ${columns.join(', ')}.`)
      }
      const where = whereClause(args.where as Record<string, unknown>, columns)
      const statement = `UPDATE ${quoteIdent(table)} SET ${entries.map(([column]) => `${quoteIdent(column)} = ?`).join(', ')} WHERE ${where.sql}`
      const result = await run(ctx, connectionId, statement, [...entries.map(([, value]) => value), ...where.params])
      return { updated: result.rowsAffected ?? 0 }
    },
  },
  {
    name: 'database_write_sql',
    description: 'Run one non-destructive write statement: INSERT, UPDATE with WHERE, CREATE or ALTER. DELETE and statements without WHERE are refused; propose those with the destructive tools instead.',
    permission: 'write',
    fields: { connectionId: CONNECTION_FIELD, sql: { ...SQL_FIELD, description: 'Exactly one INSERT/UPDATE/CREATE/ALTER statement.' } },
    async run(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      const statements = splitSqlStatements(String(args.sql))
      if (statements.length !== 1) throw new ToolError('Run one statement at a time.')
      const statement = statements[0]!
      if (!isWriteSql(statement)) throw new ToolError('That statement does not change the database. Use database_run_query.')
      if (isDestructiveSql(statement)) throw new ToolError('That statement is destructive. Propose it with database_delete_rows, database_drop_table or database_run_script so the reader can approve it.')
      return compact(await run(ctx, connectionId, statement))
    },
  },
  {
    name: 'database_create_table',
    description: 'Create a table from column definitions. Identifiers are quoted; defaults must be simple SQL literals or NULL/CURRENT_TIMESTAMP.',
    permission: 'write',
    fields: {
      connectionId: CONNECTION_FIELD,
      table: TABLE_FIELD,
      columns: {
        type: 'array',
        items: 'object',
        maxItems: 60,
        description: 'Column objects: {name, type, pk?, notNull?, unique?, default?}.',
      },
    },
    async run(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      const table = String(args.table)
      if (!IDENTIFIER.test(table)) throw new ToolError('Use a plain identifier for the table name.')
      const columns = Array.isArray(args.columns) ? args.columns as Array<Record<string, unknown>> : []
      if (columns.length === 0) throw new ToolError('columns cannot be empty.')
      const definitions = columns.map((column) => {
        const name = String(column.name ?? '')
        const type = String(column.type ?? 'TEXT')
        if (!IDENTIFIER.test(name)) throw new ToolError(`"${name}" is not a valid column name.`)
        if (!/^[A-Za-z ]{1,64}$/.test(type)) throw new ToolError(`"${type}" is not a valid column type.`)
        const parts = [quoteIdent(name), type]
        if (column.pk) parts.push('PRIMARY KEY')
        if (column.notNull) parts.push('NOT NULL')
        if (column.unique) parts.push('UNIQUE')
        if (column.default !== undefined && column.default !== null) {
          const literal = String(column.default)
          if (!DEFAULT_LITERAL.test(literal)) throw new ToolError(`Default "${literal}" must be a literal, NULL or CURRENT_TIMESTAMP.`)
          parts.push(`DEFAULT ${literal}`)
        }
        return parts.join(' ')
      })
      const result = await run(ctx, connectionId, `CREATE TABLE ${quoteIdent(table)} (${definitions.join(', ')})`)
      return { created: table, rowsAffected: result.rowsAffected ?? 0 }
    },
  },
  {
    name: 'database_alter_table',
    description: 'Change a table: add a column, rename a column, or rename the table.',
    permission: 'write',
    fields: {
      connectionId: CONNECTION_FIELD,
      table: TABLE_FIELD,
      action: { type: 'string', enum: ['add_column', 'rename_column', 'rename_table'], description: 'What to change.' },
      column: { type: 'string', description: 'Existing column for rename_column.', optional: true, maxLength: 200 },
      newName: { type: 'string', description: 'New column or table name.', optional: true, maxLength: 200 },
      type: { type: 'string', description: 'Column type for add_column, e.g. TEXT.', optional: true, maxLength: 64 },
    },
    async run(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      const table = String(args.table)
      await tableColumns(ctx, connectionId, table)
      const action = String(args.action)
      const newName = typeof args.newName === 'string' ? args.newName.trim() : ''
      if (action === 'add_column') {
        const column = typeof args.column === 'string' ? args.column.trim() : ''
        const type = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : 'TEXT'
        if (!IDENTIFIER.test(column)) throw new ToolError('Provide a plain identifier for column.')
        if (!/^[A-Za-z ]{1,64}$/.test(type)) throw new ToolError('Provide a plain type such as TEXT or INTEGER.')
        await run(ctx, connectionId, `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(column)} ${type}`)
        return { added: `${table}.${column}` }
      }
      if (!IDENTIFIER.test(newName)) throw new ToolError('Provide a plain identifier for newName.')
      if (action === 'rename_table') {
        await run(ctx, connectionId, `ALTER TABLE ${quoteIdent(table)} RENAME TO ${quoteIdent(newName)}`)
        return { renamedTable: { from: table, to: newName } }
      }
      const column = typeof args.column === 'string' ? args.column.trim() : ''
      if (!column) throw new ToolError('Provide column for rename_column.')
      await run(ctx, connectionId, `ALTER TABLE ${quoteIdent(table)} RENAME COLUMN ${quoteIdent(column)} TO ${quoteIdent(newName)}`)
      return { renamedColumn: { table, from: column, to: newName } }
    },
  },
  {
    name: 'database_delete_rows',
    description: 'Delete rows matched by an exact where map. This is proposed for the reader to approve; nothing changes until they press Approve.',
    permission: 'destructive',
    keepArgs: true,
    fields: {
      connectionId: CONNECTION_FIELD,
      table: TABLE_FIELD,
      where: { type: 'object', description: 'Exact-match filter, keyed by column name. At least one column; there is no unfiltered delete.' },
    },
    async prepare(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      const connection = await requireConnection(ctx, connectionId)
      const table = String(args.table)
      const columns = await tableColumns(ctx, connectionId, table)
      const where = whereClause(args.where as Record<string, unknown>, columns)
      const which = Object.entries(args.where as Record<string, unknown>).map(([column, value]) => `${column}=${JSON.stringify(value)}`).join(', ')
      return { targetId: `${connectionId}:${table}`, targetLabel: `delete from "${table}" where ${which} on "${connection.name}"${where.sql ? '' : ' (no rows)'}` }
    },
    async commit(targetId, ctx, args) {
      const [connectionId] = targetId.split(':')
      const table = String(args.table)
      const columns = await tableColumns(ctx, connectionId!, table)
      const where = whereClause(args.where as Record<string, unknown>, columns)
      const result = await run(ctx, connectionId!, `DELETE FROM ${quoteIdent(table)} WHERE ${where.sql}`, where.params)
      return { deleted: result.rowsAffected ?? 0 }
    },
  },
  {
    name: 'database_drop_table',
    description: 'Drop a table, view or trigger. This is proposed for the reader to approve; nothing changes until they press Approve.',
    permission: 'destructive',
    keepArgs: true,
    fields: {
      connectionId: CONNECTION_FIELD,
      name: { type: 'string', minLength: 1, maxLength: 200, description: 'Object name to drop.' },
      kind: { type: 'string', enum: ['table', 'view', 'trigger'], description: 'What kind of object it is.' },
    },
    async prepare(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      const connection = await requireConnection(ctx, connectionId)
      const name = String(args.name)
      const kind = String(args.kind)
      const found = await run(ctx, connectionId, 'SELECT type FROM sqlite_master WHERE name = ? LIMIT 1', [name])
      const actual = found.rows[0]?.[0] === undefined ? null : String(found.rows[0][0])
      if (actual === null) throw new ToolError(`No object named "${name}" in that connection.`)
      if (actual !== kind) throw new ToolError(`"${name}" is a ${actual}, not a ${kind}.`)
      return { targetId: `${connectionId}:${name}`, targetLabel: `drop ${kind} "${name}" on "${connection.name}"` }
    },
    async commit(targetId, ctx, args) {
      const [connectionId] = targetId.split(':')
      const name = String(args.name)
      const kind = String(args.kind)
      const keyword = kind === 'table' ? 'TABLE' : kind === 'view' ? 'VIEW' : 'TRIGGER'
      const result = await run(ctx, connectionId!, `DROP ${keyword} ${quoteIdent(name)}`)
      return { dropped: { kind, name }, rowsAffected: result.rowsAffected ?? 0 }
    },
  },
  {
    name: 'database_run_script',
    description: 'Run a multi-statement SQL script (DDL or writes) on one connection. This is proposed for the reader to approve; nothing changes until they press Approve.',
    permission: 'destructive',
    keepArgs: true,
    fields: { connectionId: CONNECTION_FIELD, sql: { ...SQL_FIELD, description: 'One or more statements separated by semicolons.', maxLength: 20_000 } },
    async prepare(args, ctx) {
      const connectionId = connectionIdOf(args, ctx)
      const connection = await requireConnection(ctx, connectionId)
      const statements = splitSqlStatements(String(args.sql))
      if (statements.length === 0) throw new ToolError('The script is empty.')
      const preview = statements.slice(0, 2).join('; ')
      return { targetId: connectionId, targetLabel: `${statements.length} statement(s) on "${connection.name}": ${preview}${preview.length > 120 ? '…' : ''}` }
    },
    async commit(targetId, ctx, args) {
      const statements = splitSqlStatements(String(args.sql)).map((sql) => ({ sql }))
      if (statements.length === 0) return { statements: 0 }
      await runBatch(ctx, targetId, statements)
      return { statements: statements.length }
    },
  },
]
