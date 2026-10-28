import { sqlLiteral } from './export-utils'
import { quoteIdent } from '@shared/development/database/sql-utils'

export const TRANSFER_ROW_CAP = 5000
export const TRANSFER_CHUNK = 200

export function chunkRows<T>(rows: T[], size = TRANSFER_CHUNK): T[][] {
  if (size <= 0) return [rows]
  const chunks: T[][] = []
  for (let index = 0; index < rows.length; index += size) chunks.push(rows.slice(index, index + size))
  return chunks
}

export function buildRowInsert(table: string, columns: string[], row: unknown[]): string {
  return `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map((_, index) => sqlLiteral(row[index])).join(', ')})`
}

export function transferInsertStatements(table: string, columns: string[], rows: unknown[][]): string[] {
  return rows.map((row) => `${buildRowInsert(table, columns, row)};`)
}
