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
  constraintChanges: ColumnChange[]
}

export function diffSchemas(source: TableShape[], target: TableShape[]): TableDiff[] {
  const targetByName = new Map(target.map((table) => [table.name, table]))
  const sourceNames = new Set(source.map((table) => table.name))
  const diffs: TableDiff[] = []
  for (const table of source) {
    const other = targetByName.get(table.name)
    if (!other) {
      diffs.push({ table: table.name, missingInTarget: true, missingInSource: false, addedColumns: [], removedColumns: [], typeChanges: [], constraintChanges: [] })
      continue
    }
    const targetColumns = new Map(other.columns.map((column) => [column.name, column]))
    const sourceColumns = new Set(table.columns.map((column) => column.name))
    const addedColumns = table.columns.filter((column) => !targetColumns.has(column.name))
    const removedColumns = other.columns.filter((column) => !sourceColumns.has(column.name)).map((column) => column.name)
    const typeChanges: ColumnChange[] = []
    const constraintChanges: ColumnChange[] = []
    for (const column of table.columns) {
      const counterpart = targetColumns.get(column.name)
      if (!counterpart) continue
      if (counterpart.type.trim().toUpperCase() !== column.type.trim().toUpperCase() && column.type) {
        typeChanges.push({ column: column.name, from: counterpart.type, to: column.type })
      }
      if (counterpart.notNull !== column.notNull) {
        constraintChanges.push({
          column: column.name,
          from: counterpart.notNull ? 'NOT NULL' : 'NULL',
          to: column.notNull ? 'NOT NULL' : 'NULL',
        })
      }
      if (counterpart.pk !== column.pk) {
        constraintChanges.push({
          column: column.name,
          from: counterpart.pk ? 'PK' : 'not PK',
          to: column.pk ? 'PK' : 'not PK',
        })
      }
    }
    if (addedColumns.length > 0 || removedColumns.length > 0 || typeChanges.length > 0 || constraintChanges.length > 0) {
      diffs.push({ table: table.name, missingInTarget: false, missingInSource: false, addedColumns, removedColumns, typeChanges, constraintChanges })
    }
  }
  for (const table of target) {
    if (!sourceNames.has(table.name)) {
      diffs.push({ table: table.name, missingInTarget: false, missingInSource: true, addedColumns: [], removedColumns: [], typeChanges: [], constraintChanges: [] })
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

export interface SchemaObjectShape {
  name: string
  sql: string | null
}

export interface SchemaObjectShapes {
  views: SchemaObjectShape[]
  triggers: SchemaObjectShape[]
  indexes: SchemaObjectShape[]
}

function changedObjectStatements(
  kind: 'INDEX' | 'VIEW' | 'TRIGGER',
  source: SchemaObjectShape[],
  target: SchemaObjectShape[],
): string[] {
  const statements: string[] = []
  for (const object of source) {
    if (!object.sql) continue
    const sql = `${object.sql.trim().replace(/;+$/, '')};`
    const existing = target.find((entry) => entry.name === object.name)
    if (!existing) {
      statements.push(sql)
      continue
    }
    const existingSql = existing.sql ? `${existing.sql.trim().replace(/;+$/, '')};` : ''
    if (existingSql !== sql) {
      statements.push(`DROP ${kind} IF EXISTS ${quoteIdent(object.name)};`, sql)
    }
  }
  return statements
}

export function objectDiffStatements(source: SchemaObjectShapes, target: SchemaObjectShapes): string[] {
  return [
    ...changedObjectStatements('INDEX', source.indexes, target.indexes),
    ...changedObjectStatements('VIEW', source.views, target.views),
    ...changedObjectStatements('TRIGGER', source.triggers, target.triggers),
  ]
}
