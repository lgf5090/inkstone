import type { Env } from '../../env'
import { quoteIdent } from '@shared/development/database/sql-utils'
import { INKSTONE_BLOB_KEY, MAX_TOOL_CELL_CHARS, MAX_TOOL_ROWS, type QueryResult } from '@shared/development/database/types'
import { databaseToolDef } from '@shared/development/database/tools'
import { isWriteSql } from '@shared/development/database/sql-utils'
import { ApiError } from '../../lib/errors'
import { listConnections } from './store'
import { executeQuery, failureToApiError, QueryFailure } from './query'

function tableName(args: Record<string, unknown>): string {
  const value = String(args.table ?? '').trim()
  if (!value) throw ApiError.badRequest('Missing table')
  return value
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function displayCell(value: unknown): unknown {
  if (value instanceof Uint8Array) return `[BLOB ${value.byteLength} bytes]`
  if (value && typeof value === 'object' && INKSTONE_BLOB_KEY in value) return '[BLOB]'
  if (typeof value === 'string' && value.length > MAX_TOOL_CELL_CHARS) return `${value.slice(0, MAX_TOOL_CELL_CHARS)}…`
  if (typeof value === 'bigint') return value.toString()
  return value
}

export function formatToolResult(result: QueryResult): {
  columns: string[]
  rows: Array<Record<string, unknown>>
  total: number
  truncated: boolean
} {
  const rows = result.rows.slice(0, MAX_TOOL_ROWS).map((row) => {
    const object: Record<string, unknown> = {}
    result.columns.forEach((column, index) => {
      object[column] = displayCell(row[index] ?? null)
    })
    return object
  })
  return {
    columns: result.columns,
    rows,
    total: result.rows.length,
    truncated: result.rows.length > MAX_TOOL_ROWS || Boolean(result.truncated),
  }
}

async function query(env: Env, userId: string, connectionId: string, sql: string, params: unknown[] = []): Promise<QueryResult> {
  try {
    return await executeQuery(env, env.DB, userId, connectionId, sql, params)
  } catch (error) {
    if (error instanceof QueryFailure) throw failureToApiError(error)
    throw error
  }
}

export async function executeDatabaseTool(
  env: Env,
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const definition = databaseToolDef(name)
  if (!definition) throw ApiError.badRequest(`Unknown database tool: ${name}`)
  const parsed = definition.schema.safeParse(args)
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid tool arguments')
  }
  const input = parsed.data as Record<string, unknown>
  const connectionId = String(input.connectionId ?? '')

  switch (name) {
    case 'list_connections': {
      const connections = await listConnections(env.DB, userId)
      return connections.map((connection) => ({
        id: connection.id,
        name: connection.name,
        type: connection.type,
        d1DatabaseName: connection.d1DatabaseName,
      }))
    }
    case 'list_tables': {
      const result = await query(env, userId, connectionId, "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table','view','trigger') ORDER BY type, name")
      return formatToolResult(result)
    }
    case 'search_tables': {
      const keyword = String(input.keyword ?? '').trim()
      const result = await query(env, userId, connectionId, "SELECT type, name, tbl_name FROM sqlite_master WHERE name LIKE ? ESCAPE '\\' ORDER BY type, name", [`%${escapeLike(keyword)}%`])
      return formatToolResult(result)
    }
    case 'get_table_schema': {
      const table = tableName(input)
      const columns = await query(env, userId, connectionId, `PRAGMA table_info(${quoteIdent(table)})`)
      const indexes = await query(env, userId, connectionId, `PRAGMA index_list(${quoteIdent(table)})`)
      const foreignKeys = await query(env, userId, connectionId, `PRAGMA foreign_key_list(${quoteIdent(table)})`)
      return {
        table,
        columns: formatToolResult(columns),
        indexes: formatToolResult(indexes),
        foreignKeys: formatToolResult(foreignKeys),
      }
    }
    case 'get_table_ddl': {
      const table = tableName(input)
      const result = await query(env, userId, connectionId, "SELECT sql FROM sqlite_master WHERE type IN ('table','view','trigger') AND name = ?", [table])
      return result.rows[0]?.[0] ?? `No DDL found for ${table}`
    }
    case 'list_indexes': {
      const table = input.table ? tableName(input) : ''
      const sql = table
        ? `PRAGMA index_list(${quoteIdent(table)})`
        : "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY tbl_name, name"
      return formatToolResult(await query(env, userId, connectionId, sql))
    }
    case 'get_table_foreign_keys': {
      return formatToolResult(await query(env, userId, connectionId, `PRAGMA foreign_key_list(${quoteIdent(tableName(input))})`))
    }
    case 'preview_table': {
      const table = tableName(input)
      const limit = Math.max(1, Math.min(200, Number(input.limit ?? 50) || 50))
      return formatToolResult(await query(env, userId, connectionId, `SELECT * FROM ${quoteIdent(table)} LIMIT ?`, [limit]))
    }
    case 'get_table_row_count': {
      const table = tableName(input)
      const result = await query(env, userId, connectionId, `SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`)
      return { table, rowCount: Number(result.rows[0]?.[0] ?? 0) }
    }
    case 'run_query': {
      const sql = String(input.sql ?? '').trim()
      if (isWriteSql(sql) && input.confirm !== true) {
        throw ApiError.badRequest('Writing requires confirm: true after the user agrees')
      }
      const params = Array.isArray(input.params) ? input.params : []
      const result = await query(env, userId, connectionId, sql, params)
      return { ...formatToolResult(result), rowsAffected: result.rowsAffected, meta: result.meta }
    }
    case 'explain_query': {
      const sql = String(input.sql ?? '').trim()
      return formatToolResult(await query(env, userId, connectionId, `EXPLAIN QUERY PLAN ${sql}`))
    }
    default:
      throw ApiError.badRequest(`Unknown database tool: ${name}`)
  }
}
