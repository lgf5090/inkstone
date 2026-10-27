import { quoteIdent } from '@shared/development/database/sql-utils'
import type { RowKey, SqlStatement } from './types'

function binding(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  return value === undefined ? null : value
}

function rowidValue(value: unknown): number | bigint | string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint' || typeof value === 'string') return value
  return null
}

export function rowKeyOf(
  row: unknown[],
  columns: string[],
  primaryKey: string[],
  rowid?: unknown,
): RowKey {
  if (primaryKey.length > 0) {
    const positions = new Map<string, number>()
    columns.forEach((column, index) => {
      const key = column.toLowerCase()
      if (!positions.has(key)) positions.set(key, index)
    })
    const values: Record<string, unknown> = {}
    let complete = true
    for (const column of primaryKey) {
      const index = positions.get(column.toLowerCase())
      if (index === undefined) {
        complete = false
        break
      }
      values[column] = row[index] ?? null
    }
    if (complete) return { kind: 'pk', values }
  }

  const normalized = rowidValue(rowid)
  if (normalized !== null) return { kind: 'rowid', rowid: normalized }
  return { kind: 'none' }
}

function keyClause(key: RowKey): { sql: string; params: unknown[] } | null {
  if (key.kind === 'rowid') {
    return { sql: 'rowid = ?', params: [binding(key.rowid)] }
  }
  if (key.kind === 'pk') {
    const entries = Object.entries(key.values)
    if (entries.length === 0) return null
    const clauses: string[] = []
    const params: unknown[] = []
    for (const [column, value] of entries) {
      const normalized = binding(value)
      if (normalized === null) {
        clauses.push(`${quoteIdent(column)} IS NULL`)
        continue
      }
      clauses.push(`${quoteIdent(column)} = ?`)
      params.push(normalized)
    }
    return { sql: clauses.join(' AND '), params }
  }
  return null
}

export function buildUpdate(
  table: string,
  key: RowKey,
  changes: ReadonlyArray<readonly [string, unknown]>,
): SqlStatement | null {
  if (!table || key.kind === 'none') return null
  const merged = new Map<string, unknown>()
  for (const [column, value] of changes) {
    if (column) merged.set(column, binding(value))
  }
  if (merged.size === 0) return null
  const where = keyClause(key)
  if (!where) return null

  const assignments: string[] = []
  const params: unknown[] = []
  for (const [column, value] of merged) {
    assignments.push(`${quoteIdent(column)} = ?`)
    params.push(value)
  }
  params.push(...where.params)
  return {
    sql: `UPDATE ${quoteIdent(table)} SET ${assignments.join(', ')} WHERE ${where.sql}`,
    params,
  }
}

export function buildDelete(table: string, key: RowKey): SqlStatement | null {
  if (!table || key.kind === 'none') return null
  const where = keyClause(key)
  if (!where) return null
  return {
    sql: `DELETE FROM ${quoteIdent(table)} WHERE ${where.sql}`,
    params: where.params,
  }
}
