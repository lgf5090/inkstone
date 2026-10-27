import { quoteIdent } from '@shared/development/database/sql-utils'

export const DATA_SEARCH_LIMIT_MAX = 100

export function searchableColumns(columns: Array<{ name: string; type: string }>): string[] {
  return columns
    .filter((column) => !/BLOB/i.test(column.type) && column.name.trim().length > 0)
    .map((column) => column.name)
}

export function buildDataSearchSql(
  table: string,
  columns: string[],
  keyword: string,
  limit: number,
): { sql: string; params: unknown[] } | null {
  if (!table || columns.length === 0 || !keyword.trim()) return null
  const safeLimit = Math.max(1, Math.min(DATA_SEARCH_LIMIT_MAX, Math.trunc(limit) || 1))
  const clauses = columns.map((column) =>
    `instr(lower(coalesce(cast(${quoteIdent(column)} as text), '')), lower(?)) > 0`,
  )
  return {
    sql: `SELECT * FROM ${quoteIdent(table)} WHERE ${clauses.join(' OR ')} LIMIT ${safeLimit}`,
    params: columns.map(() => keyword.trim()),
  }
}
