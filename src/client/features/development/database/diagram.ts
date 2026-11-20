import type { ParsedColumn, ParsedTable, SchemaModel, TableIndexInfo } from '@shared/development/database/types'
import {
  constraintSignature,
  makeDiagramId,
  normalizeRefAction,
  parseTableConstraint,
  serializeConstraint,
  splitIdentifierList,
  type DiagramConstraint,
  type RefAction,
} from './constraints'
import { buildErdLayout, ERD_NODE_WIDTH } from './flow-layout'
import { rewriteSqlIdentifiers } from './schema-parse'

export interface DiagramColumn {
  id: string
  name: string
  sourceName?: string
  type: string
  notNull: boolean
  pk: boolean
  pkPosition: number
  default: string | null
  unique: boolean
  check: string | null
  collate: string | null
  generated: string | null
  autoIncrement: boolean
}

export interface DiagramIndex {
  id: string
  name: string
  unique: boolean
  columns: string[]
  raw: string | null
}

export interface DiagramTable {
  id: string
  name: string
  columns: DiagramColumn[]
  constraints: DiagramConstraint[]
  indexes: DiagramIndex[]
  withoutRowid: boolean
  strict: boolean
  x: number
  y: number
  width: number
}

export interface DiagramRelationship {
  id: string
  name?: string
  startTableId: string
  startColumns: string[]
  endTableId: string
  endColumns: string[]
  onUpdate: RefAction
  onDelete: RefAction
  constraintId: string
}

export interface DiagramDraft {
  tables: DiagramTable[]
  relationships: DiagramRelationship[]
  renames?: DiagramRename[]
}

export interface DiagramRename {
  from: string
  to: string
}

export interface DiagramPosition {
  x: number
  y: number
}

export type DiagramPositions = Record<string, DiagramPosition>

const POSITION_LIMIT = 1_000_000

export function clampPosition(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-POSITION_LIMIT, Math.min(POSITION_LIMIT, Math.round(value)))
}

function diagramColumn(column: ParsedColumn, tableName: string, index: number): DiagramColumn {
  return {
    id: `col:${tableName}:${index}`,
    name: column.name,
    sourceName: column.name,
    type: column.type,
    notNull: column.notNull,
    pk: column.pk,
    pkPosition: column.pkPosition,
    default: column.default,
    unique: column.unique,
    check: column.check ?? null,
    collate: column.collate ?? null,
    generated: column.generated ?? null,
    autoIncrement: column.autoIncrement,
  }
}

function foreignKeyKey(constraint: DiagramConstraint): string {
  const lower = (values: string[] | undefined): string =>
    (values ?? []).map((value) => value.toLowerCase()).join('\u0000')
  return [
    lower(constraint.columns),
    (constraint.refTable ?? '').toLowerCase(),
    lower(constraint.refColumns),
    normalizeRefAction(constraint.onUpdate),
    normalizeRefAction(constraint.onDelete),
  ].join('\u0001')
}

export function constraintsFromTable(table: ParsedTable): DiagramConstraint[] {
  const constraints: DiagramConstraint[] = []
  const seenForeignKeys = new Set<string>()

  for (const raw of table.tableConstraints) {
    const parsed = parseTableConstraint(raw)
    if (!parsed) continue
    if (parsed.kind === 'foreign-key') {
      const key = foreignKeyKey(parsed)
      if (seenForeignKeys.has(key)) continue
      seenForeignKeys.add(key)
    }
    constraints.push(parsed)
  }

  for (const column of table.columns) {
    const reference = column.references
    if (!reference?.table) continue
    const constraint: DiagramConstraint = {
      id: makeDiagramId('constraint'),
      kind: 'foreign-key',
      raw: '',
      columns: [column.name],
      refTable: reference.table,
      refColumns: splitIdentifierList(reference.column ?? ''),
      onUpdate: reference.onUpdate ? normalizeRefAction(reference.onUpdate) : undefined,
      onDelete: reference.onDelete ? normalizeRefAction(reference.onDelete) : undefined,
    }
    const key = foreignKeyKey(constraint)
    if (seenForeignKeys.has(key)) continue
    seenForeignKeys.add(key)
    constraints.push(constraint)
  }

  return constraints
}

function indexesForTable(schema: SchemaModel, tableName: string): DiagramIndex[] {
  return schema.indexes
    .filter((index: TableIndexInfo) => index.table === tableName)
    .map((index) => ({
      id: makeDiagramId('index'),
      name: index.name,
      unique: index.unique,
      columns: [...index.columns],
      raw: index.sql,
    }))
}

export function relationshipId(tableId: string, constraintId: string): string {
  return `${tableId}::${constraintId}`
}

export function buildRelationships(tables: DiagramTable[]): DiagramRelationship[] {
  const relationships: DiagramRelationship[] = []
  for (const table of tables) {
    for (const constraint of table.constraints) {
      if (constraint.kind !== 'foreign-key' || !constraint.refTable) continue
      relationships.push({
        id: relationshipId(table.id, constraint.id),
        ...(constraint.name ? { name: constraint.name } : {}),
        startTableId: table.id,
        startColumns: [...(constraint.columns ?? [])],
        endTableId: constraint.refTable,
        endColumns: [...(constraint.refColumns ?? [])],
        onUpdate: normalizeRefAction(constraint.onUpdate),
        onDelete: normalizeRefAction(constraint.onDelete),
        constraintId: constraint.id,
      })
    }
  }
  return relationships
}

export function syncRelationships(
  draft: { tables: DiagramTable[]; relationships?: DiagramRelationship[]; renames?: DiagramRename[] },
): DiagramDraft {
  return {
    tables: draft.tables,
    relationships: buildRelationships(draft.tables),
    ...(draft.renames && draft.renames.length > 0 ? { renames: draft.renames } : {}),
  }
}

export function parsedTableToDiagramTable(
  table: ParsedTable,
  indexes: DiagramIndex[] = [],
  position: DiagramPosition = { x: 0, y: 0 },
): DiagramTable {
  return {
    id: table.name,
    name: table.name,
    columns: table.columns.map((column, index) => diagramColumn(column, table.name, index)),
    constraints: constraintsFromTable(table),
    indexes,
    withoutRowid: table.withoutRowid,
    strict: table.strict,
    x: position.x,
    y: position.y,
    width: ERD_NODE_WIDTH,
  }
}

export function schemaToDiagram(schema: SchemaModel, positions: DiagramPositions = {}): DiagramDraft {
  const layout = buildErdLayout(schema.tables)
  const nodeByName = new Map(layout.nodes.map((node) => [node.id, node]))

  const tables: DiagramTable[] = schema.tables.map((table) => {
    const node = nodeByName.get(table.name)
    const stored = positions[table.name]
    return parsedTableToDiagramTable(
      table,
      indexesForTable(schema, table.name),
      stored
        ? { x: clampPosition(stored.x), y: clampPosition(stored.y) }
        : { x: node?.x ?? 0, y: node?.y ?? 0 },
    )
  })

  return { tables, relationships: buildRelationships(tables) }
}

export function diagramTableToParsedTable(table: DiagramTable): ParsedTable {
  return {
    name: table.name,
    sql: '',
    columns: table.columns.map((column) => ({
      name: column.name,
      type: column.type,
      notNull: column.notNull,
      pk: column.pk,
      pkPosition: column.pkPosition,
      default: column.default,
      unique: column.unique,
      check: column.check,
      collate: column.collate,
      generated: column.generated,
      autoIncrement: column.autoIncrement,
    })),
    tableConstraints: table.constraints.map(serializeConstraint),
    withoutRowid: table.withoutRowid,
    strict: table.strict,
  }
}

export function diagramTablesToParsedTables(draft: DiagramDraft): ParsedTable[] {
  return draft.tables.map(diagramTableToParsedTable)
}

function columnSignature(column: DiagramColumn): unknown[] {
  return [
    column.name,
    column.type,
    column.notNull,
    column.pk,
    column.pkPosition,
    column.default,
    column.unique,
    column.check,
    column.collate,
    column.generated,
    column.autoIncrement,
  ]
}

export function tableStructureSignature(table: DiagramTable): string {
  return JSON.stringify([
    table.columns.map(columnSignature),
    table.constraints.map(constraintSignature).sort(),
    table.withoutRowid,
    table.strict,
  ])
}

export function tableContentSignature(table: DiagramTable): string {
  return JSON.stringify([
    table.columns.map(columnSignature),
    table.constraints.map(constraintSignature).sort(),
    table.indexes
      .map((index) => [index.name, index.unique, index.columns, index.raw ?? ''])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    table.withoutRowid,
    table.strict,
  ])
}

export function diagramSignature(draft: DiagramDraft): string {
  const tables = draft.tables.toSorted((left, right) => left.name.localeCompare(right.name))
    .map((table) => [table.name, tableContentSignature(table)])
  return JSON.stringify([tables, draft.renames ?? []])
}

export function findTable(draft: DiagramDraft, tableId: string): DiagramTable | null {
  return draft.tables.find((table) => table.id === tableId) ?? null
}

export function renameTableInDraft(draft: DiagramDraft, tableId: string, nextName: string): DiagramDraft {
  const name = nextName.trim()
  if (!name || name === tableId) return draft
  const tables = draft.tables.map((table) => {
    if (table.id === tableId) return { ...table, id: name, name }
    const constraints = table.constraints.map((constraint) => (
      constraint.refTable === tableId ? { ...constraint, refTable: name } : constraint
    ))
    return { ...table, constraints }
  })

  const renames = [...(draft.renames ?? [])]
  const chainIndex = renames.findIndex((entry) => entry.to === tableId)
  if (chainIndex >= 0) {
    const chain = renames[chainIndex]!
    const next = { ...chain, to: name }
    renames.splice(chainIndex, 1)
    if (next.from !== next.to) renames.push(next)
  } else {
    renames.push({ from: tableId, to: name })
  }

  return syncRelationships({ tables, ...(renames.length > 0 ? { renames } : {}) })
}

export interface NewDiagramColumn {
  name: string
  type: string
  pk: boolean
  notNull: boolean
  unique: boolean
  default: string
}

export function createDiagramTable(
  name: string,
  columns: NewDiagramColumn[],
  position: DiagramPosition = { x: 0, y: 0 },
): DiagramTable {
  let pkPosition = 0
  return {
    id: name,
    name,
    columns: columns.map((column, index) => ({
      id: `col:${name}:${index}`,
      name: column.name.trim() || `column_${index + 1}`,
      type: column.type,
      notNull: column.notNull,
      pk: column.pk,
      pkPosition: column.pk ? ++pkPosition : 0,
      default: column.default.trim() === '' ? null : column.default,
      unique: column.unique,
      check: null,
      collate: null,
      generated: null,
      autoIncrement: false,
    })),
    constraints: [],
    indexes: [],
    withoutRowid: false,
    strict: false,
    x: position.x,
    y: position.y,
    width: ERD_NODE_WIDTH,
  }
}

export function nextTablePosition(draft: DiagramDraft): DiagramPosition {
  if (draft.tables.length === 0) return { x: 0, y: 0 }
  const maxX = Math.max(...draft.tables.map((table) => table.x + table.width))
  return { x: clampPosition(maxX + 40), y: 0 }
}

export function duplicateTable(
  table: DiagramTable,
  name: string,
  position: DiagramPosition,
): DiagramTable {
  const mapping = new Map([[table.name.toLowerCase(), name]])
  return {
    id: name,
    name,
    columns: table.columns.map((column, index) => ({
      ...column,
      id: `col:${name}:${index}`,
      sourceName: undefined,
    })),
    constraints: table.constraints.map((constraint) => ({
      ...constraint,
      id: `constraint-${table.name}-${constraint.id}`,
      ...(constraint.kind === 'unknown' ? { raw: rewriteSqlIdentifiers(constraint.raw, mapping) } : {}),
    })),
    indexes: table.indexes.map((index) => ({
      ...index,
      id: `index-${table.name}-${index.id}`,
      name: `${name}_${index.name}`,
      raw: index.raw ? rewriteSqlIdentifiers(index.raw, mapping) : null,
    })),
    x: position.x,
    y: position.y,
    width: table.width,
    withoutRowid: table.withoutRowid,
    strict: table.strict,
  }
}

export function isUniqueKey(table: DiagramTable, columns: string[]): boolean {
  if (columns.length === 0) return false
  const target = columns.map((column) => column.toLowerCase()).join('\u0000')
  const primaryKey = table.columns
    .filter((column) => column.pk)
    .sort((left, right) => left.pkPosition - right.pkPosition)
    .map((column) => column.name.toLowerCase())
  if (primaryKey.join('\u0000') === target) return true
  return table.constraints.some((constraint) => {
    if (constraint.kind !== 'unique') return false
    return (constraint.uniqueColumns ?? []).map((column) => column.toLowerCase()).join('\u0000') === target
  })
}

export function relationshipCardinality(
  draft: DiagramDraft,
  relationship: DiagramRelationship,
): '1:1' | 'N:1' {
  const table = findTable(draft, relationship.startTableId)
  if (!table) return 'N:1'
  return isUniqueKey(table, relationship.startColumns) ? '1:1' : 'N:1'
}

export function relationshipLabel(
  draft: DiagramDraft,
  relationship: DiagramRelationship,
): string {
  const columns = relationship.startColumns.join(', ')
  const target = findTable(draft, relationship.endTableId)
  const targetColumns = relationship.endColumns.join(', ')
  return target
    ? `${columns} → ${target.name}${targetColumns ? ` (${targetColumns})` : ''}`
    : `${columns} → ${relationship.endTableId}`
}