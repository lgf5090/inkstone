import type {
  ParsedTable,
  RawSchemaObject,
  SchemaModel,
  TableDataOptions,
  TableIndexInfo,
} from '@shared/development/database/types'
import { MAX_QUERY_ROWS } from '@shared/development/database/types'
import { quoteIdent } from '@shared/development/database/sql-utils'
import type { StudioDriver } from './drivers'
import { parseCreateTable, parseIndexesFromSchema } from './schema-parse'

export async function loadSchema(driver: StudioDriver): Promise<SchemaModel> {
  const result = await driver.query(
    'SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name',
  )
  const objects: RawSchemaObject[] = result.rows.map((row) => ({
    type: String(row[0] ?? ''),
    name: String(row[1] ?? ''),
    tbl_name: String(row[2] ?? ''),
    sql: row[3] == null ? null : String(row[3]),
  }))

  const tables: ParsedTable[] = []
  const views: { name: string; sql: string }[] = []
  const triggers: { name: string; sql: string }[] = []

  for (const object of objects) {
    if (object.type === 'table') {
      const parsed = object.sql ? parseCreateTable(object.sql) : null
      tables.push(
        parsed ?? {
          name: object.name,
          sql: object.sql ?? '',
          columns: [],
          tableConstraints: [],
          withoutRowid: false,
          strict: false,
        },
      )
    } else if (object.type === 'view') {
      if (object.sql) views.push({ name: object.name, sql: object.sql })
    } else if (object.type === 'trigger') {
      if (object.sql) triggers.push({ name: object.name, sql: object.sql })
    }
  }

  const indexes: TableIndexInfo[] = parseIndexesFromSchema(objects)
  return { tables, views, triggers, indexes }
}

export function buildSchemaNamespace(model: SchemaModel): Record<string, string[]> {
  const namespace: Record<string, string[]> = {}
  for (const table of model.tables) {
    namespace[table.name] = table.columns.map((column) => column.name)
  }
  return namespace
}

export function buildTableDataSql(
  table: string,
  options: TableDataOptions,
  knownColumns: string[],
): { sql: string; params: unknown[] } {
  const parts: string[] = [`SELECT * FROM ${quoteIdent(table)}`]
  const params: unknown[] = []

  if (options.whereSql) {
    parts.push(`WHERE ${options.whereSql}`)
    params.push(...(options.whereParams ?? []))
  }
  if (options.orderBy && knownColumns.includes(options.orderBy)) {
    const direction = options.orderDir === 'DESC' ? 'DESC' : 'ASC'
    parts.push(`ORDER BY ${quoteIdent(options.orderBy)} ${direction}`)
  }

  const limit = Math.max(1, Math.min(Math.trunc(options.limit) || 1, MAX_QUERY_ROWS))
  const offset = Math.max(0, Math.trunc(options.offset) || 0)
  parts.push(`LIMIT ${limit} OFFSET ${offset}`)
  return { sql: parts.join(' '), params }
}

export function buildCountSql(
  table: string,
  whereSql?: string,
  whereParams: unknown[] = [],
): { sql: string; params: unknown[] } {
  const parts: string[] = [`SELECT COUNT(*) AS __cnt FROM ${quoteIdent(table)}`]
  if (whereSql) parts.push(`WHERE ${whereSql}`)
  return { sql: parts.join(' '), params: whereParams }
}

export function primaryKeyColumns(table: ParsedTable): string[] {
  return table.columns
    .filter((column) => column.pk)
    .sort((a, b) => a.pkPosition - b.pkPosition)
    .map((column) => column.name)
}
