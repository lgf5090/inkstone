import type { Database as SqlJsDatabase, SqlValue } from 'sql.js'
import { MAX_QUERY_BYTES, MAX_QUERY_ROWS, type QueryResult } from '@shared/development/database/types'
import { utf8ByteLength } from '@shared/text-utils'

export function affectsRows(sql: string): boolean {
  const head = sql.trimStart().toUpperCase()
  if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/.test(head)) return true
  return head.startsWith('WITH') && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/.test(head)
}

export function bindParams(params: unknown[]): SqlValue[] {
  return params.map((value) => (value === undefined ? null : (value as SqlValue)))
}

export function rowBytes(row: unknown[]): number {
  let total = 0
  for (const value of row) {
    if (value instanceof Uint8Array) total += value.byteLength
    else if (typeof value === 'string') total += utf8ByteLength(value) + 4
    else if (typeof value === 'number' || typeof value === 'bigint') total += 24
    else total += 8
  }
  return total
}

export function runSqliteQuery(db: SqlJsDatabase, sql: string, params: unknown[] = []): QueryResult {
  const started = Date.now()
  const statement = db.prepare(sql)
  try {
    if (params.length > 0) statement.bind(bindParams(params))
    const columns = statement.getColumnNames()
    const rows: unknown[][] = []
    let bytes = 0
    let truncated = false
    while (statement.step()) {
      if (rows.length >= MAX_QUERY_ROWS) {
        truncated = true
        break
      }
      const row = statement.get()
      const size = rowBytes(row)
      if (bytes + size > MAX_QUERY_BYTES) {
        truncated = true
        break
      }
      bytes += size
      rows.push(row)
    }
    const rowsAffected = affectsRows(sql) ? db.getRowsModified() : 0
    return {
      columns,
      rows,
      rowsAffected,
      durationMs: Date.now() - started,
      ...(truncated ? { truncated: true } : {}),
    }
  } finally {
    statement.free()
  }
}
