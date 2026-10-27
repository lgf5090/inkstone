import { quoteIdent, splitSqlStatements } from '@shared/development/database/sql-utils'

export const DISTINCT_VALUE_LIMIT = 50

export function buildDistinctSql(table: string, column: string, knownColumns: string[]): string | null {
  if (!knownColumns.includes(column)) return null
  const sql = `SELECT ${quoteIdent(column)} AS value, COUNT(*) AS occurrences FROM ${quoteIdent(table)} GROUP BY 1 ORDER BY occurrences DESC, value ASC LIMIT ${DISTINCT_VALUE_LIMIT}`
  return splitSqlStatements(sql).length === 1 ? sql : null
}
