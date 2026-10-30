import { sqlLiteral } from './export-utils'
import { quoteIdent } from '@shared/development/database/sql-utils'

export function buildRowInsert(table: string, columns: string[], row: unknown[]): string {
  return `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map((_, index) => sqlLiteral(row[index])).join(', ')})`
}
