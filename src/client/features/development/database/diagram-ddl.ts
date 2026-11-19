import type { ParsedTable, SchemaModel } from '@shared/development/database/types'
import { quoteIdent } from '@shared/development/database/sql-utils'
import {
  serializeConstraint,
  type DiagramConstraint,
} from './constraints'
import {
  findTable,
  isUniqueKey,
  parsedTableToDiagramTable,
  tableStructureSignature,
  type DiagramColumn,
  type DiagramDraft,
  type DiagramIndex,
  type DiagramRelationship,
  type DiagramTable,
} from './diagram'
import type { DdlWarning, RebuildObjects } from './ddl'
import {
  extractSqlIdentifiers,
  parseCreateIndex,
  rewriteSqlIdentifiers,
} from './schema-parse'

export interface DiagramDdlSummary {
  createdTables: number
  rebuiltTables: number
  droppedTables: number
  createdIndexes: number
  droppedIndexes: number
}

export interface DiagramDdlPlan {
  statements: string[]
  warnings: DdlWarning[]
  summary: DiagramDdlSummary
}

function columnDefinition(column: DiagramColumn, inlinePrimaryKey: boolean): string {
  const name = column.name.trim()
  const parts = [quoteIdent(name), column.type.trim() || 'TEXT']

  if (column.generated) {
    parts.push(`GENERATED ALWAYS AS ${column.generated}`)
    if (column.notNull) parts.push('NOT NULL')
    if (column.unique) parts.push('UNIQUE')
    return parts.join(' ')
  }

  if (column.pk && inlinePrimaryKey) parts.push('PRIMARY KEY')
  if (column.notNull) parts.push('NOT NULL')
  if (column.unique) parts.push('UNIQUE')
  if (column.default !== null && column.default !== '') parts.push(`DEFAULT ${column.default}`)
  if (column.collate) parts.push(`COLLATE ${quoteIdent(column.collate)}`)
  if (column.check) parts.push(`CHECK ${column.check}`)
  if (column.autoIncrement && column.pk && inlinePrimaryKey) parts.push('AUTOINCREMENT')
  return parts.join(' ')
}

function tableOptions(table: DiagramTable): string {
  const values: string[] = []
  if (table.withoutRowid) values.push('WITHOUT ROWID')
  if (table.strict) values.push('STRICT')
  return values.length > 0 ? ` ${values.join(', ')}` : ''
}

function primaryKeyColumns(table: DiagramTable): DiagramColumn[] {
  return table.columns
    .filter((column) => column.pk)
    .sort((left, right) => left.pkPosition - right.pkPosition)
}

function tableBody(table: DiagramTable): string {
  const alive = table.columns.filter((column) => column.name.trim())
  const keyColumns = primaryKeyColumns(table)
  const inlinePrimaryKey = keyColumns.length === 1
  const definitions = alive.map((column) => columnDefinition(column, inlinePrimaryKey))
  if (keyColumns.length > 1) {
    definitions.push(`PRIMARY KEY (${keyColumns.map((column) => quoteIdent(column.name)).join(', ')})`)
  }
  for (const constraint of table.constraints) {
    definitions.push(serializeConstraint(constraint))
  }
  return definitions.join(',\n  ')
}

function indexStatements(table: DiagramTable, mapping: ReadonlyMap<string, string> = new Map()): string[] {
  const statements: string[] = []
  for (const index of table.indexes) {
    if (index.columns.length > 0) {
      const columns = index.columns.map((column) => mapping.get(column.toLowerCase()) ?? column)
      statements.push(
        `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(index.name)} ` +
        `ON ${quoteIdent(table.name)} (${columns.map(quoteIdent).join(', ')});`,
      )
      continue
    }
    if (index.raw) {
      statements.push(withSemicolon(rewriteSqlIdentifiers(index.raw, mapping)))
    }
  }
  return statements
}

function withSemicolon(sql: string): string {
  const trimmed = sql.trim()
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`
}

function createTableStatements(table: DiagramTable, mapping: ReadonlyMap<string, string> = new Map()): {
  statements: string[]
  warnings: DdlWarning[]
} {
  const warnings: DdlWarning[] = []
  if (table.columns.filter((column) => column.name.trim()).length === 0) {
    warnings.push({ code: 'no_columns', target: table.name })
    return { statements: [], warnings }
  }
  const body = tableBody(table)
  const statements = [`CREATE TABLE ${quoteIdent(table.name)} (\n  ${body}\n)${tableOptions(table)};`]
  statements.push(...indexStatements(table, mapping))
  if (primaryKeyColumns(table).length === 0) warnings.push({ code: 'no_primary_key', target: table.name })
  for (const constraint of table.constraints) {
    if (constraint.kind === 'unknown') {
      warnings.push({ code: 'unknown_constraint_preserved', target: `${table.name}: ${constraint.raw}` })
    }
  }
  if (table.withoutRowid && primaryKeyColumns(table).length === 0) {
    warnings.push({ code: 'without_rowid_without_primary_key', target: table.name })
  }
  return { statements, warnings }
}

function matchesTable(sql: string | null | undefined, tableName: string): boolean {
  if (!sql) return false
  return new RegExp(`\\b${tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sql)
}

function intersectRemoved(sql: string, removed: string[]): string[] {
  if (removed.length === 0) return []
  const removedByLower = new Map(removed.map((column) => [column.toLowerCase(), column]))
  const hits = new Set<string>()
  for (const identifier of extractSqlIdentifiers(sql)) {
    const match = removedByLower.get(identifier.toLowerCase())
    if (match) hits.add(match)
  }
  return [...hits]
}

function constraintReferences(constraint: DiagramConstraint, columns: string[]): string[] {
  const source = constraint.kind === 'check'
    ? (constraint.expression ?? '')
    : [
        ...(constraint.columns ?? []),
        ...(constraint.uniqueColumns ?? []),
        ...(constraint.refColumns ?? []),
      ].join(', ')
  return intersectRemoved(source, columns)
}

function rebuildStatements(
  original: ParsedTable,
  draft: DiagramTable,
  objects: RebuildObjects,
): { statements: string[]; warnings: DdlWarning[] } {
  const warnings: DdlWarning[] = []
  const alive = draft.columns.filter((column) => column.name.trim())
  if (alive.length === 0) {
    warnings.push({ code: 'no_columns', target: draft.name })
    return { statements: [], warnings }
  }

  const originalColumns = new Map(original.columns.map((column) => [column.name.toLowerCase(), column]))
  const sourceNames = new Set(
    draft.columns
      .map((column) => column.sourceName?.toLowerCase())
      .filter((value): value is string => Boolean(value)),
  )
  const removed = original.columns
    .filter((column) => !sourceNames.has(column.name.toLowerCase()))
    .map((column) => column.name)
  const renamed = new Map<string, string>()
  const identifierMapping = new Map<string, string>()
  if (original.name !== draft.name) identifierMapping.set(original.name.toLowerCase(), draft.name)
  for (const column of draft.columns) {
    const source = column.sourceName
    if (!source) continue
    if (column.name !== source) {
      renamed.set(source.toLowerCase(), column.name)
      identifierMapping.set(source.toLowerCase(), column.name)
    }
  }
  for (const column of removed) {
    warnings.push({ code: 'data_loss_drop_column', target: `${draft.name}.${column}` })
  }

  const constraints: string[] = []
  for (const constraint of draft.constraints) {
    const referenced = constraintReferences(constraint, removed)
    if (referenced.length > 0) {
      warnings.push({
        code: 'constraint_references_removed_column',
        target: `${draft.name}: ${constraint.raw || serializeConstraint(constraint)}`,
        columns: referenced,
      })
      continue
    }
    if (constraint.kind === 'unknown') {
      warnings.push({ code: 'unknown_constraint_preserved', target: `${draft.name}: ${constraint.raw}` })
    }
    constraints.push(serializeConstraint(constraint))
  }

  const keyColumns = primaryKeyColumns(draft)
  const inlinePrimaryKey = keyColumns.length === 1
  const definitions = alive.map((column) => columnDefinition(column, inlinePrimaryKey))
  if (keyColumns.length > 1) {
    definitions.push(`PRIMARY KEY (${keyColumns.map((column) => quoteIdent(column.name)).join(', ')})`)
  }
  definitions.push(...constraints)

  const temporary = quoteIdent(`${draft.name}__rebuild`)
  const dependentViews = (objects.views ?? []).filter((view) => matchesTable(view.sql, original.name))
  const statements: string[] = [
    ...dependentViews.map((view) => `DROP VIEW ${quoteIdent(view.name)};`),
    `CREATE TABLE ${temporary} (\n  ${definitions.join(',\n  ')}\n)${tableOptions(draft)};`,
  ]

  const copyColumns = alive.filter((column) => {
    const source = column.sourceName
    if (!source) return false
    const originalColumn = originalColumns.get(source.toLowerCase())
    return Boolean(originalColumn) && !originalColumn?.generated
  })
  if (copyColumns.length > 0) {
    const targets = copyColumns.map((column) => quoteIdent(column.name)).join(', ')
    const sources = copyColumns.map((column) => quoteIdent(column.sourceName!)).join(', ')
    statements.push(`INSERT INTO ${temporary} (${targets}) SELECT ${sources} FROM ${quoteIdent(original.name)};`)
  }

  statements.push(
    `DROP TABLE ${quoteIdent(original.name)};`,
    `ALTER TABLE ${temporary} RENAME TO ${quoteIdent(draft.name)};`,
  )

  for (const view of dependentViews) {
    statements.push(withSemicolon(rewriteSqlIdentifiers(view.sql, identifierMapping)))
  }

  for (const index of draft.indexes) {
    if (index.columns.length === 0) {
      if (index.raw) statements.push(withSemicolon(rewriteSqlIdentifiers(index.raw, identifierMapping)))
      continue
    }
    const referenced = intersectRemoved(index.columns.join(', '), removed)
    if (referenced.length > 0) {
      warnings.push({
        code: 'index_references_removed_column',
        target: index.name,
        columns: referenced,
      })
      continue
    }
    const columns = index.columns.map((column) => renamed.get(column.toLowerCase()) ?? column)
    statements.push(
      `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(index.name)} ` +
      `ON ${quoteIdent(draft.name)} (${columns.map(quoteIdent).join(', ')});`,
    )
  }

  for (const trigger of (objects.triggers ?? []).filter((entry) => matchesTable(entry.sql, original.name))) {
    const referenced = intersectRemoved(trigger.sql, removed)
    if (referenced.length > 0) {
      warnings.push({
        code: 'trigger_references_removed_column',
        target: trigger.name,
        columns: referenced,
      })
    }
    statements.push(withSemicolon(rewriteSqlIdentifiers(trigger.sql, identifierMapping)))
  }

  if (keyColumns.length === 0) warnings.push({ code: 'no_primary_key', target: draft.name })
  if (draft.withoutRowid && keyColumns.length === 0) {
    warnings.push({ code: 'without_rowid_without_primary_key', target: draft.name })
  }

  return { statements, warnings }
}

function affinity(type: string): string {
  const upper = type.toUpperCase()
  if (upper.includes('INT')) return 'INTEGER'
  if (upper.includes('CHAR') || upper.includes('CLOB') || upper.includes('TEXT')) return 'TEXT'
  if (upper.includes('BLOB') || upper.trim() === '') return 'BLOB'
  if (upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB')) return 'REAL'
  return 'NUMERIC'
}

function columnByName(table: DiagramTable | null, name: string): DiagramColumn | null {
  if (!table) return null
  return table.columns.find((column) => column.name.toLowerCase() === name.toLowerCase()) ?? null
}

function checkRelationships(draft: DiagramDraft, warnings: DdlWarning[]): void {
  for (const relationship of draft.relationships) {
    const start = findTable(draft, relationship.startTableId)
    const end = findTable(draft, relationship.endTableId)
    if (!start || !end) continue

    if (relationship.endColumns.length > 0) {
      if (!isUniqueKey(end, relationship.endColumns)) {
        warnings.push({
          code: 'fk_target_not_key',
          target: `${start.name} (${relationship.startColumns.join(', ')}) → ${end.name} (${relationship.endColumns.join(', ')})`,
        })
      }
      for (let index = 0; index < relationship.startColumns.length; index += 1) {
        const local = columnByName(start, relationship.startColumns[index] ?? '')
        const remoteName = relationship.endColumns[index]
        const remote = remoteName ? columnByName(end, remoteName) : null
        if (!local || !remote) continue
        if (affinity(local.type) !== affinity(remote.type)) {
          warnings.push({
            code: 'fk_type_mismatch',
            target: `${start.name}.${local.name} (${local.type}) → ${end.name}.${remote.name} (${remote.type})`,
          })
        }
      }
    }
  }

  const adjacency = new Map<string, string[]>()
  for (const relationship of draft.relationships) {
    if (!findTable(draft, relationship.startTableId) || !findTable(draft, relationship.endTableId)) continue
    const next = adjacency.get(relationship.startTableId)
    if (next) next.push(relationship.endTableId)
    else adjacency.set(relationship.startTableId, [relationship.endTableId])
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const seenEdges = new Set<string>()
  const visit = (tableId: string): void => {
    if (visiting.has(tableId)) return
    if (visited.has(tableId)) return
    visiting.add(tableId)
    for (const target of adjacency.get(tableId) ?? []) {
      if (target === tableId) continue
      if (visiting.has(target)) {
        const edge = [tableId, target].sort().join('\u0000')
        if (!seenEdges.has(edge)) {
          seenEdges.add(edge)
          warnings.push({ code: 'fk_cycle', target: `${tableId} ↔ ${target}` })
        }
        continue
      }
      visit(target)
    }
    visiting.delete(tableId)
    visited.add(tableId)
  }
  for (const table of draft.tables) visit(table.id)
}

function originalIndexesFor(schema: SchemaModel, tableName: string): DiagramIndex[] {
  return schema.indexes
    .filter((index) => index.table === tableName)
    .map((index) => ({
      id: `orig-index:${index.name}`,
      name: index.name,
      unique: index.unique,
      columns: [...index.columns],
      raw: index.sql,
    }))
}

function indexDefinition(index: DiagramIndex): string {
  return JSON.stringify([index.unique, index.columns.map((column) => column.toLowerCase()), index.raw ?? ''])
}

function indexDiffStatements(
  originalTable: DiagramTable,
  draftTable: DiagramTable,
): { statements: string[]; created: number; dropped: number } {
  const statements: string[] = []
  const originalByName = new Map(originalTable.indexes.map((index) => [index.name, index]))
  const draftByName = new Map(draftTable.indexes.map((index) => [index.name, index]))
  let created = 0
  let dropped = 0

  for (const index of draftTable.indexes) {
    const existing = originalByName.get(index.name)
    if (existing && indexDefinition(existing) === indexDefinition(index)) continue
    if (existing) {
      statements.push(`DROP INDEX ${quoteIdent(index.name)};`)
      dropped += 1
    }
    if (index.columns.length > 0) {
      statements.push(
        `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(index.name)} ` +
        `ON ${quoteIdent(draftTable.name)} (${index.columns.map(quoteIdent).join(', ')});`,
      )
      created += 1
    } else if (index.raw) {
      statements.push(withSemicolon(index.raw))
      created += 1
    }
  }

  for (const index of originalTable.indexes) {
    if (draftByName.has(index.name)) continue
    statements.push(`DROP INDEX ${quoteIdent(index.name)};`)
    dropped += 1
  }

  return { statements, created, dropped }
}

export function buildDiagramDdl(
  original: SchemaModel,
  draft: DiagramDraft,
  objects: RebuildObjects = {},
): DiagramDdlPlan {
  const warnings: DdlWarning[] = []
  const body: string[] = []
  const summary: DiagramDdlSummary = {
    createdTables: 0,
    rebuiltTables: 0,
    droppedTables: 0,
    createdIndexes: 0,
    droppedIndexes: 0,
  }

  const originalByName = new Map(original.tables.map((table) => [table.name, table]))
  const originalDraftByName = new Map(
    original.tables.map((table) => [
      table.name,
      parsedTableToDiagramTable(table, originalIndexesFor(original, table.name)),
    ]),
  )
  const renameSource = new Map<string, string>()
  for (const entry of draft.renames ?? []) renameSource.set(entry.to, entry.from)
  const oldToNew = new Map<string, string>()
  for (const entry of draft.renames ?? []) oldToNew.set(entry.from, entry.to)

  const normalizedOriginal = (table: DiagramTable): DiagramTable => ({
    ...table,
    constraints: table.constraints.map((constraint) => (
      constraint.refTable && oldToNew.has(constraint.refTable)
        ? { ...constraint, refTable: oldToNew.get(constraint.refTable)! }
        : constraint
    )),
  })

  const seenOriginal = new Set<string>()
  const created: DiagramTable[] = []
  const renamedOnly: { from: string; to: string }[] = []
  const rebuilt: { original: ParsedTable; draft: DiagramTable }[] = []
  const indexDiffs: { original: DiagramTable; draft: DiagramTable }[] = []

  for (const table of draft.tables) {
    const sourceName = renameSource.get(table.id) ?? table.id
    const originalTable = originalByName.get(sourceName)
    if (!originalTable) {
      created.push(table)
      continue
    }
    seenOriginal.add(originalTable.name)
    const originalDiagram = originalDraftByName.get(originalTable.name)!
    const normalized = normalizedOriginal(originalDiagram)
    if (tableStructureSignature(normalized) === tableStructureSignature(table)) {
      if (originalTable.name !== table.name) renamedOnly.push({ from: originalTable.name, to: table.name })
      indexDiffs.push({ original: originalDiagram, draft: table })
      continue
    }
    rebuilt.push({ original: originalTable, draft: table })
  }

  const dropped = original.tables.filter((table) => !seenOriginal.has(table.name))

  for (const table of created) {
    const result = createTableStatements(table)
    body.push(...result.statements)
    warnings.push(...result.warnings)
    summary.createdTables += 1
    summary.createdIndexes += table.indexes.length
  }

  for (const rename of renamedOnly) {
    body.push(`ALTER TABLE ${quoteIdent(rename.from)} RENAME TO ${quoteIdent(rename.to)};`)
  }

  for (const entry of rebuilt) {
    const result = rebuildStatements(entry.original, entry.draft, objects)
    body.push(...result.statements)
    warnings.push(...result.warnings)
    summary.rebuiltTables += 1
    summary.createdIndexes += entry.draft.indexes.length
  }

  for (const table of dropped) {
    warnings.push({ code: 'data_loss_drop_table', target: table.name })
    const dependents = (objects.views ?? []).filter((view) => matchesTable(view.sql, table.name))
    if (dependents.length > 0) {
      warnings.push({
        code: 'dropped_table_has_dependents',
        target: table.name,
        columns: dependents.map((view) => view.name),
      })
    }
    body.push(`DROP TABLE ${quoteIdent(table.name)};`)
    summary.droppedTables += 1
  }

  for (const entry of indexDiffs) {
    const result = indexDiffStatements(entry.original, entry.draft)
    body.push(...result.statements)
    summary.createdIndexes += result.created
    summary.droppedIndexes += result.dropped
  }

  checkRelationships(draft, warnings)

  const statements = body.length > 0
    ? ['PRAGMA foreign_keys = OFF;', 'BEGIN;', ...body, 'COMMIT;', 'PRAGMA foreign_keys = ON;']
    : []
  return { statements, warnings, summary }
}

export function relationshipsForTable(draft: DiagramDraft, tableId: string): DiagramRelationship[] {
  return draft.relationships.filter(
    (relationship) => relationship.startTableId === tableId || relationship.endTableId === tableId,
  )
}

export function constraintForRelationship(
  table: DiagramTable,
  relationship: DiagramRelationship,
): DiagramConstraint | null {
  return table.constraints.find((constraint) => constraint.id === relationship.constraintId) ?? null
}

export function indexColumnsFromSql(sql: string | null): string[] {
  if (!sql) return []
  return parseCreateIndex(sql)?.columns ?? []
}