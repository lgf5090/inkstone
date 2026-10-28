import { quoteIdent } from '@shared/development/database/sql-utils'

export interface ShapeColumn {
  name: string
  type: string
  notNull: boolean
  pk: boolean
}

export interface TableShape {
  name: string
  columns: ShapeColumn[]
  sql: string
}

export interface ColumnChange {
  column: string
  from: string
  to: string
}

export interface TableDiff {
  table: string
  missingInTarget: boolean
  missingInSource: boolean
  addedColumns: ShapeColumn[]
  removedColumns: string[]
  typeChanges: ColumnChange[]
}

export function diffSchemas(source: TableShape[], target: TableShape[]): TableDiff[] {
  const targetByName = new Map(target.map((table) => [table.name, table]))
  const sourceNames = new Set(source.map((table) => table.name))
  const diffs: TableDiff[] = []
  for (const table of source) {
    const other = targetByName.get(table.name)
    if (!other) {
      diffs.push({ table: table.name, missingInTarget: true, missingInSource: false, addedColumns: [], removedColumns: [], typeChanges: [] })
      continue
    }
    const targetColumns = new Map(other.columns.map((column) => [column.name, column]))
    const sourceColumns = new Set(table.columns.map((column) => column.name))
    const addedColumns = table.columns.filter((column) => !targetColumns.has(column.name))
    const removedColumns = other.columns.filter((column) => !sourceColumns.has(column.name)).map((column) => column.name)
    const typeChanges: ColumnChange[] = []
    for (const column of table.columns) {
      const counterpart = targetColumns.get(column.name)
      if (counterpart && counterpart.type.trim().toUpperCase() !== column.type.trim().toUpperCase() && column.type) {
        typeChanges.push({ column: column.name, from: counterpart.type, to: column.type })
      }
    }
    if (addedColumns.length > 0 || removedColumns.length > 0 || typeChanges.length > 0) {
      diffs.push({ table: table.name, missingInTarget: false, missingInSource: false, addedColumns, removedColumns, typeChanges })
    }
  }
  for (const table of target) {
    if (!sourceNames.has(table.name)) {
      diffs.push({ table: table.name, missingInTarget: false, missingInSource: true, addedColumns: [], removedColumns: [], typeChanges: [] })
    }
  }
  return diffs
}

export function schemaStatements(diffs: TableDiff[], source: TableShape[]): string[] {
  const sourceByName = new Map(source.map((table) => [table.name, table]))
  const statements: string[] = []
  for (const diff of diffs) {
    const table = sourceByName.get(diff.table)
    if (!table) continue
    if (diff.missingInTarget && table.sql.trim()) {
      statements.push(`${table.sql.trim().replace(/;+$/, '')};`)
    }
    for (const column of diff.addedColumns) {
      statements.push(`ALTER TABLE ${quoteIdent(table.name)} ADD COLUMN ${quoteIdent(column.name)} ${column.type || 'TEXT'};`)
    }
  }
  return statements
}
