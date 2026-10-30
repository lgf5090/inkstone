import { quoteIdent } from '@shared/development/database/sql-utils'
import { sqlLiteral } from './export-utils'

export interface DataDiffInput {
  table: string
  keyColumns: string[]
  sourceColumns: string[]
  sourceRows: unknown[][]
  targetColumns: string[]
  targetRows: unknown[][]
}

export interface DataDiffResult {
  inserts: string[]
  updates: string[]
  deletes: string[]
}

export interface DataDiffOptions {
  allowDeletes?: boolean
}

function keyOf(row: unknown[], indexes: number[]): string {
  return indexes.map((index) => JSON.stringify(row[index] ?? null)).join('|')
}

export function diffRows(input: DataDiffInput, options: DataDiffOptions = {}): DataDiffResult {
  const empty: DataDiffResult = { inserts: [], updates: [], deletes: [] }
  const allowDeletes = options.allowDeletes ?? true
  const sourceKeyIndexes = input.keyColumns.map((column) => input.sourceColumns.indexOf(column))
  const targetKeyIndexes = input.keyColumns.map((column) => input.targetColumns.indexOf(column))
  if (input.keyColumns.length === 0 || sourceKeyIndexes.some((index) => index < 0) || targetKeyIndexes.some((index) => index < 0)) {
    return empty
  }
  const targetIndexByColumn = new Map(input.targetColumns.map((column, index) => [column, index]))
  const sharedColumns = input.sourceColumns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => targetIndexByColumn.has(column))

  const keyClause = (row: unknown[], indexes: number[]) => input.keyColumns
    .map((column, position) => {
      const value = row[indexes[position]!]
      return value === null || value === undefined
        ? `${quoteIdent(column)} IS NULL`
        : `${quoteIdent(column)} = ${sqlLiteral(value)}`
    })
    .join(' AND ')

  const targetByKey = new Map<string, unknown[]>()
  for (const row of input.targetRows) targetByKey.set(keyOf(row, targetKeyIndexes), row)

  const inserts: string[] = []
  const updates: string[] = []
  const deletes: string[] = []
  const seen = new Set<string>()

  for (const row of input.sourceRows) {
    const key = keyOf(row, sourceKeyIndexes)
    seen.add(key)
    const existing = targetByKey.get(key)
    if (!existing) {
      inserts.push(`INSERT INTO ${quoteIdent(input.table)} (${sharedColumns.map(({ column }) => quoteIdent(column)).join(', ')}) VALUES (${sharedColumns.map(({ index }) => sqlLiteral(row[index])).join(', ')});`)
      continue
    }
    const changes = sharedColumns
      .filter(({ column }) => !input.keyColumns.includes(column))
      .filter(({ column, index }) => JSON.stringify(row[index] ?? null) !== JSON.stringify(existing[targetIndexByColumn.get(column)!] ?? null))
      .map(({ column, index }) => `${quoteIdent(column)} = ${sqlLiteral(row[index])}`)
    if (changes.length > 0) {
      updates.push(`UPDATE ${quoteIdent(input.table)} SET ${changes.join(', ')} WHERE ${keyClause(row, sourceKeyIndexes)};`)
    }
  }

  for (const row of input.targetRows) {
    if (allowDeletes && !seen.has(keyOf(row, targetKeyIndexes))) {
      deletes.push(`DELETE FROM ${quoteIdent(input.table)} WHERE ${keyClause(row, targetKeyIndexes)};`)
    }
  }

  return { inserts, updates, deletes }
}
