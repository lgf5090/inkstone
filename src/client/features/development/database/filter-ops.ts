import { quoteIdent } from '@shared/development/database/sql-utils'
import type { FilterCondition } from './types'

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

export function buildWhere(
  filters: FilterCondition[],
  search = '',
  searchColumns: string[] = [],
): { sql: string; params: unknown[] } | null {
  const parts: string[] = []
  const params: unknown[] = []

  for (const filter of filters) {
    if (!filter.column) continue
    const column = quoteIdent(filter.column)
    switch (filter.op) {
      case 'equals':
        parts.push(`${column} = ?`)
        params.push(filter.value)
        break
      case 'notEquals':
        parts.push(`${column} != ?`)
        params.push(filter.value)
        break
      case 'contains':
        parts.push(`${column} LIKE ? ESCAPE '\\'`)
        params.push(`%${escapeLikePattern(filter.value)}%`)
        break
      case 'startsWith':
        parts.push(`${column} LIKE ? ESCAPE '\\'`)
        params.push(`${escapeLikePattern(filter.value)}%`)
        break
      case 'endsWith':
        parts.push(`${column} LIKE ? ESCAPE '\\'`)
        params.push(`%${escapeLikePattern(filter.value)}`)
        break
      case 'gt':
        parts.push(`${column} > ?`)
        params.push(filter.value)
        break
      case 'gte':
        parts.push(`${column} >= ?`)
        params.push(filter.value)
        break
      case 'lt':
        parts.push(`${column} < ?`)
        params.push(filter.value)
        break
      case 'lte':
        parts.push(`${column} <= ?`)
        params.push(filter.value)
        break
      case 'isNull':
        parts.push(`${column} IS NULL`)
        break
      case 'notNull':
        parts.push(`${column} IS NOT NULL`)
        break
    }
  }

  const keyword = search.trim()
  if (keyword && searchColumns.length > 0) {
    const expressions = searchColumns
      .filter((column) => Boolean(column))
      .map(
        (column) =>
          `instr(lower(coalesce(cast(${quoteIdent(column)} as text), '')), lower(?)) > 0`,
      )
    if (expressions.length > 0) {
      parts.push(`(${expressions.join(' OR ')})`)
      for (let index = 0; index < expressions.length; index++) params.push(keyword)
    }
  }

  if (parts.length === 0) return null
  return { sql: parts.join(' AND '), params }
}
