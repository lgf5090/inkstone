import type { ParsedTable, TableIndexInfo } from '@shared/development/database/types'
import { quoteIdent } from '@shared/development/database/sql-utils'
import type { ColumnDraft } from './types'
import { extractSqlIdentifiers, parseCreateIndex } from './schema-parse'

export type DdlWarningCode =
  | 'missing_table_name'
  | 'no_columns'
  | 'constraint_references_removed_column'
  | 'index_references_removed_column'
  | 'trigger_references_removed_column'
  | 'without_rowid_without_primary_key'

export interface DdlWarning {
  code: DdlWarningCode
  target: string
  columns?: string[]
}

export interface DdlResult {
  sql: string
  warnings: DdlWarning[]
}

export interface DdlTableOptions {
  withoutRowid?: boolean
  strict?: boolean
}

export interface RebuildObjects {
  indexes?: ReadonlyArray<Pick<TableIndexInfo, 'name' | 'columns' | 'sql'>>
  triggers?: ReadonlyArray<{ name: string; sql: string }>
  views?: ReadonlyArray<{ name: string; sql: string }>
}

const PRIMARY_KEY_CONSTRAINT =
  /^\s*(?:CONSTRAINT\s+(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|\S+)\s+)?PRIMARY\s+KEY\b/i

function columnDefinition(
  draft: ColumnDraft,
  includeOriginal: boolean,
  inlinePrimaryKey: boolean,
): string {
  const name = draft.name.trim()
  const original = includeOriginal ? draft.original : undefined
  const parts = [quoteIdent(name), draft.type.trim() || 'TEXT']

  if (original?.generated) {
    parts.push(`GENERATED ALWAYS AS ${original.generated}`)
    if (draft.notNull) parts.push('NOT NULL')
    if (draft.unique) parts.push('UNIQUE')
    return parts.join(' ')
  }

  if (draft.pk && inlinePrimaryKey) parts.push('PRIMARY KEY')
  if (draft.notNull) parts.push('NOT NULL')
  if (draft.unique) parts.push('UNIQUE')
  if (draft.default !== '') parts.push(`DEFAULT ${draft.default}`)
  if (original?.collate) parts.push(`COLLATE ${quoteIdent(original.collate)}`)
  if (original?.check) parts.push(`CHECK ${original.check}`)
  if (original?.references) {
    const target = quoteIdent(original.references.table)
    const column = original.references.column
      ? ` (${original.references.column
          .split(',')
          .map((part) => quoteIdent(part.trim()))
          .join(', ')})`
      : ''
    parts.push(`REFERENCES ${target}${column}`)
  }
  if (original?.autoIncrement && draft.pk && inlinePrimaryKey) parts.push('AUTOINCREMENT')
  return parts.join(' ')
}

function aliveDrafts(drafts: ColumnDraft[]): ColumnDraft[] {
  return drafts.filter((draft) => !draft.deleted && Boolean(draft.name.trim()))
}

function tableBody(
  alive: ColumnDraft[],
  constraints: string[],
  includeOriginal: boolean,
): string {
  const primaryKey = alive.filter((draft) => draft.pk)
  const inlinePrimaryKey = primaryKey.length === 1
  const definitions = alive.map((draft) => columnDefinition(draft, includeOriginal, inlinePrimaryKey))
  if (primaryKey.length > 1) {
    const columns = primaryKey.map((draft) => quoteIdent(draft.name.trim())).join(', ')
    definitions.push(`PRIMARY KEY (${columns})`)
  }
  return [...definitions, ...constraints].join(',\n  ')
}

function tableOptionsSql(options: DdlTableOptions): string {
  const values: string[] = []
  if (options.withoutRowid) values.push('WITHOUT ROWID')
  if (options.strict) values.push('STRICT')
  return values.length > 0 ? ` ${values.join(', ')}` : ''
}

export function buildCreateTableSql(
  tableName: string,
  columns: ColumnDraft[],
  options: DdlTableOptions = {},
): DdlResult {
  const name = tableName.trim()
  if (!name) return { sql: '', warnings: [{ code: 'missing_table_name', target: '' }] }
  const alive = aliveDrafts(columns)
  if (alive.length === 0) return { sql: '', warnings: [{ code: 'no_columns', target: name }] }

  const body = tableBody(alive, [], false)
  const sql = `CREATE TABLE ${quoteIdent(name)} (\n  ${body}\n)${tableOptionsSql(options)};`
  const warnings: DdlWarning[] = []
  if (options.withoutRowid && !alive.some((draft) => draft.pk)) {
    warnings.push({ code: 'without_rowid_without_primary_key', target: name })
  }
  return { sql, warnings }
}

function intersectColumns(columns: string[], removed: string[]): string[] {
  const byLower = new Map(removed.map((column) => [column.toLowerCase(), column]))
  const hits = new Set<string>()
  for (const column of columns) {
    const match = byLower.get(column.toLowerCase())
    if (match) hits.add(match)
  }
  return [...hits]
}

function referencesRemoved(sql: string, removed: string[]): string[] {
  return intersectColumns(extractSqlIdentifiers(sql), removed)
}

function withoutSemicolon(sql: string): string {
  const trimmed = sql.trim()
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`
}

export function buildRebuildSql(
  original: ParsedTable,
  drafts: ColumnDraft[],
  objects: RebuildObjects = {},
): DdlResult {
  const name = original.name.trim()
  if (!name) return { sql: '', warnings: [{ code: 'missing_table_name', target: '' }] }
  const alive = aliveDrafts(drafts)
  if (alive.length === 0) return { sql: '', warnings: [{ code: 'no_columns', target: name }] }

  const warnings: DdlWarning[] = []
  const sourceNames = new Set(
    alive
      .map((draft) => draft.original?.name)
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase()),
  )
  const removed = original.columns
    .filter((column) => !sourceNames.has(column.name.toLowerCase()))
    .map((column) => column.name)

  const constraints: string[] = []
  for (const constraint of original.tableConstraints) {
    if (PRIMARY_KEY_CONSTRAINT.test(constraint)) continue
    const columns = referencesRemoved(constraint, removed)
    if (columns.length > 0) {
      warnings.push({ code: 'constraint_references_removed_column', target: constraint, columns })
      continue
    }
    constraints.push(constraint)
  }

  const body = tableBody(alive, constraints, true)
  const temporary = quoteIdent(`${name}__rebuild`)
  const table = quoteIdent(name)
  const options = tableOptionsSql({
    withoutRowid: original.withoutRowid,
    strict: original.strict,
  })

  const dependentViews = (objects.views ?? []).filter((view) => {
    return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(view.sql)
  })
  const lines: string[] = [
    'PRAGMA foreign_keys = OFF;',
    'BEGIN;',
    ...dependentViews.map((view) => `DROP VIEW ${quoteIdent(view.name)};`),
    `CREATE TABLE ${temporary} (\n  ${body}\n)${options};`,
  ]

  const copyColumns = alive.filter(
    (draft) =>
      Boolean(draft.original)
      && !draft.original?.generated
      && original.columns.some(
        (column) => column.name.toLowerCase() === draft.original!.name.toLowerCase(),
      ),
  )
  if (copyColumns.length > 0) {
    const targets = copyColumns.map((draft) => quoteIdent(draft.name.trim())).join(', ')
    const sources = copyColumns.map((draft) => quoteIdent(draft.original!.name)).join(', ')
    lines.push(`INSERT INTO ${temporary} (${targets}) SELECT ${sources} FROM ${table};`)
  }

  lines.push(`DROP TABLE ${table};`, `ALTER TABLE ${temporary} RENAME TO ${table};`)

  for (const view of dependentViews) {
    lines.push(withoutSemicolon(view.sql))
  }

  for (const index of objects.indexes ?? []) {
    if (!index.sql) continue
    const columns = index.columns.length > 0 ? index.columns : (parseCreateIndex(index.sql)?.columns ?? [])
    const referenced = intersectColumns(columns, removed)
    if (referenced.length > 0) {
      warnings.push({
        code: 'index_references_removed_column',
        target: index.name,
        columns: referenced,
      })
      continue
    }
    lines.push(withoutSemicolon(index.sql))
  }

  for (const trigger of objects.triggers ?? []) {
    const referenced = referencesRemoved(trigger.sql, removed)
    if (referenced.length > 0) {
      warnings.push({
        code: 'trigger_references_removed_column',
        target: trigger.name,
        columns: referenced,
      })
    }
    lines.push(withoutSemicolon(trigger.sql))
  }

  lines.push('COMMIT;', 'PRAGMA foreign_keys = ON;')

  if (original.withoutRowid && !alive.some((draft) => draft.pk)) {
    warnings.push({ code: 'without_rowid_without_primary_key', target: name })
  }

  return { sql: lines.join('\n'), warnings }
}
