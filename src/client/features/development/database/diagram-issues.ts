import type { DiagramDraft, DiagramRelationship, DiagramTable } from './diagram'

export type DiagramIssueSeverity = 'error' | 'warning' | 'info'

export type DiagramIssueCode =
  | 'table_empty_name'
  | 'table_duplicate_name'
  | 'column_empty_name'
  | 'column_duplicate_name'
  | 'no_primary_key'
  | 'fk_missing_table'
  | 'fk_missing_column'
  | 'fk_arity_mismatch'
  | 'fk_duplicate_columns'
  | 'fk_target_not_key'
  | 'fk_duplicate_name'
  | 'fk_circular'
  | 'index_empty_name'
  | 'index_duplicate_name'
  | 'index_no_columns'
  | 'unique_empty_name'
  | 'unique_duplicate_name'
  | 'unique_no_columns'
  | 'constraint_unknown'

export interface DiagramIssue {
  id: string
  severity: DiagramIssueSeverity
  code: DiagramIssueCode
  tableId?: string
  column?: string
  relationshipId?: string
  params?: Record<string, string | number>
}

type DiagramIssueDraft = Omit<DiagramIssue, 'id'>

const KEY_SEPARATOR = '\u0000'

function normalizeName(value: string): string {
  return value.trim().toLowerCase()
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const groupKey = key(item)
    const group = groups.get(groupKey)
    if (group) group.push(item)
    else groups.set(groupKey, [item])
  }
  return groups
}

function createIdFactory(): (issue: DiagramIssueDraft, slot: string | number) => string {
  const counts = new Map<string, number>()
  return (issue, slot) => {
    const base = [
      issue.code,
      issue.tableId ?? '',
      issue.column ?? '',
      issue.relationshipId ?? '',
      String(slot),
    ].join(':')
    const count = (counts.get(base) ?? 0) + 1
    counts.set(base, count)
    return count === 1 ? base : `${base}:${count}`
  }
}

function resolveTable(draft: DiagramDraft, idOrName: string): DiagramTable | null {
  const direct = draft.tables.find((table) => table.id === idOrName)
  if (direct) return direct
  const key = normalizeName(idOrName)
  return draft.tables.find((table) => normalizeName(table.name) === key) ?? null
}

function hasColumn(table: DiagramTable, name: string): boolean {
  const key = normalizeName(name)
  return table.columns.some((column) => normalizeName(column.name) === key)
}

function keyColumnSets(table: DiagramTable): string[][] {
  const keys: string[][] = []
  const primary = table.columns
    .filter((column) => column.pk)
    .sort((left, right) => left.pkPosition - right.pkPosition)
    .map((column) => normalizeName(column.name))
  if (primary.length > 0) keys.push(primary)
  for (const column of table.columns) {
    if (column.unique) keys.push([normalizeName(column.name)])
  }
  for (const constraint of table.constraints) {
    const columns = constraint.uniqueColumns
    if (constraint.kind === 'unique' && columns && columns.length > 0) {
      keys.push(columns.map(normalizeName))
    }
  }
  for (const index of table.indexes) {
    if (index.unique && index.columns.length > 0) keys.push(index.columns.map(normalizeName))
  }
  return keys
}

function isKeyColumns(table: DiagramTable, columns: string[]): boolean {
  const target = columns.map(normalizeName).join(KEY_SEPARATOR)
  return keyColumnSets(table).some((key) => key.join(KEY_SEPARATOR) === target)
}

function repeatedColumns(columns: string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const column of columns) {
    const key = normalizeName(column)
    if (seen.has(key)) repeated.add(key)
    seen.add(key)
  }
  return [...repeated].map((key) => columns.find((column) => normalizeName(column) === key) ?? key)
}

function cyclicGroups(nodes: string[], edges: Map<string, Set<string>>): string[][] {
  const order = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const groups: string[][] = []
  let next = 0

  const visit = (node: string): void => {
    const index = next
    order.set(node, index)
    low.set(node, index)
    next += 1
    stack.push(node)
    onStack.add(node)

    let lowLink = index
    for (const target of edges.get(node) ?? []) {
      if (!order.has(target)) {
        visit(target)
        lowLink = Math.min(lowLink, low.get(target) ?? index)
      } else if (onStack.has(target)) {
        lowLink = Math.min(lowLink, order.get(target) ?? index)
      }
    }
    low.set(node, lowLink)
    if (lowLink !== index) return

    const group: string[] = []
    for (;;) {
      const member = stack.pop()
      if (member === undefined) break
      onStack.delete(member)
      group.push(member)
      if (member === node) break
    }
    groups.push(group)
  }

  for (const node of nodes) {
    if (!order.has(node)) visit(node)
  }
  return groups.filter((group) => (
    group.length > 1 || (edges.get(group[0])?.has(group[0]) ?? false)
  ))
}

function validateTableNames(
  draft: DiagramDraft,
  tableGroups: Map<string, DiagramTable[]>,
  add: (issue: DiagramIssueDraft, slot: string | number) => void,
): void {
  draft.tables.forEach((table, tableIndex) => {
    if (normalizeName(table.name) === '') {
      add({ severity: 'error', code: 'table_empty_name', tableId: table.id, params: { index: tableIndex + 1 } }, tableIndex)
    }
    if ((tableGroups.get(normalizeName(table.name))?.length ?? 0) > 1) {
      add({
        severity: 'error',
        code: 'table_duplicate_name',
        tableId: table.id,
        params: { table: table.name },
      }, tableIndex)
    }
  })
}

function validateColumns(
  table: DiagramTable,
  add: (issue: DiagramIssueDraft, slot: string | number) => void,
): void {
  const groups = groupBy(table.columns, (column) => normalizeName(column.name))
  table.columns.forEach((column, columnIndex) => {
    if (normalizeName(column.name) === '') {
      add({
        severity: 'error',
        code: 'column_empty_name',
        tableId: table.id,
        params: { table: table.name, index: columnIndex + 1 },
      }, columnIndex)
    }
    if ((groups.get(normalizeName(column.name))?.length ?? 0) > 1) {
      add({
        severity: 'error',
        code: 'column_duplicate_name',
        tableId: table.id,
        column: column.name,
        params: { table: table.name, column: column.name },
      }, columnIndex)
    }
  })
  if (!table.columns.some((column) => column.pk)) {
    add({ severity: 'warning', code: 'no_primary_key', tableId: table.id, params: { table: table.name } }, 0)
  }
}

function validateIndexes(
  table: DiagramTable,
  add: (issue: DiagramIssueDraft, slot: string | number) => void,
): void {
  const groups = groupBy(table.indexes, (index) => normalizeName(index.name))
  table.indexes.forEach((index, indexPosition) => {
    if (normalizeName(index.name) === '') {
      add({
        severity: 'error',
        code: 'index_empty_name',
        tableId: table.id,
        params: { table: table.name, index: indexPosition + 1 },
      }, indexPosition)
    }
    if ((groups.get(normalizeName(index.name))?.length ?? 0) > 1) {
      add({
        severity: 'error',
        code: 'index_duplicate_name',
        tableId: table.id,
        params: { table: table.name, name: index.name },
      }, indexPosition)
    }
    if (index.columns.length === 0 && !(index.raw ?? '').trim()) {
      add({
        severity: 'error',
        code: 'index_no_columns',
        tableId: table.id,
        params: { table: table.name, name: index.name },
      }, indexPosition)
    }
  })
}

function validateConstraints(
  table: DiagramTable,
  add: (issue: DiagramIssueDraft, slot: string | number) => void,
): void {
  const named = table.constraints.filter((constraint) => (
    constraint.kind === 'unique' && normalizeName(constraint.name ?? '') !== ''
  ))
  const groups = groupBy(named, (constraint) => normalizeName(constraint.name ?? ''))
  table.constraints.forEach((constraint, constraintPosition) => {
    if (constraint.kind === 'unique') {
      if (constraint.name === '') {
        add({
          severity: 'error',
          code: 'unique_empty_name',
          tableId: table.id,
          params: { table: table.name, index: constraintPosition + 1 },
        }, constraintPosition)
      }
      const name = constraint.name ?? ''
      if ((groups.get(normalizeName(name))?.length ?? 0) > 1) {
        add({
          severity: 'error',
          code: 'unique_duplicate_name',
          tableId: table.id,
          params: { table: table.name, name },
        }, constraintPosition)
      }
      if ((constraint.uniqueColumns?.length ?? 0) === 0) {
        add({
          severity: 'error',
          code: 'unique_no_columns',
          tableId: table.id,
          params: { table: table.name, name },
        }, constraintPosition)
      }
    }
    if (constraint.kind === 'unknown') {
      add({
        severity: 'info',
        code: 'constraint_unknown',
        tableId: table.id,
        params: { table: table.name, raw: constraint.raw },
      }, constraintPosition)
    }
  })
}

function validateRelationship(
  draft: DiagramDraft,
  relationship: DiagramRelationship,
  relationshipIndex: number,
  relationshipNameGroups: Map<string, DiagramRelationship[]>,
  add: (issue: DiagramIssueDraft, slot: string | number) => void,
): void {
  const source = resolveTable(draft, relationship.startTableId)
  const target = resolveTable(draft, relationship.endTableId)
  const localColumns = relationship.startColumns ?? []
  const remoteColumns = relationship.endColumns ?? []
  const name = relationship.name ?? ''

  if (normalizeName(name) !== '') {
    const key = `${relationship.startTableId}${KEY_SEPARATOR}${normalizeName(name)}`
    if ((relationshipNameGroups.get(key)?.length ?? 0) > 1) {
      add({
        severity: 'warning',
        code: 'fk_duplicate_name',
        tableId: relationship.startTableId,
        relationshipId: relationship.id,
        params: { table: source?.name ?? relationship.startTableId, name },
      }, relationshipIndex)
    }
  }

  if (!source) return

  if (!target) {
    add({
      severity: 'error',
      code: 'fk_missing_table',
      tableId: source.id,
      relationshipId: relationship.id,
      params: { table: source.name, column: localColumns.join(', '), target: relationship.endTableId },
    }, relationshipIndex)
    return
  }

  const missingColumns = (columns: string[], holder: DiagramTable, side: 'local' | 'target'): void => {
    const seen = new Set<string>()
    for (const column of columns) {
      const key = normalizeName(column)
      if (seen.has(key) || hasColumn(holder, column)) continue
      seen.add(key)
      add({
        severity: 'error',
        code: 'fk_missing_column',
        tableId: source.id,
        column,
        relationshipId: relationship.id,
        params: { table: source.name, column, target: target.name, side },
      }, relationshipIndex)
    }
  }
  missingColumns(localColumns, source, 'local')
  missingColumns(remoteColumns, target, 'target')

  if (remoteColumns.length > 0 && localColumns.length !== remoteColumns.length) {
    add({
      severity: 'error',
      code: 'fk_arity_mismatch',
      tableId: source.id,
      relationshipId: relationship.id,
      params: {
        table: source.name,
        target: target.name,
        localCount: localColumns.length,
        targetCount: remoteColumns.length,
      },
    }, relationshipIndex)
  }

  for (const column of repeatedColumns(localColumns)) {
    add({
      severity: 'error',
      code: 'fk_duplicate_columns',
      tableId: source.id,
      column,
      relationshipId: relationship.id,
      params: { table: source.name, column, target: target.name },
    }, relationshipIndex)
  }

  const remoteKnown = remoteColumns.every((column) => hasColumn(target, column))
  if (
    remoteColumns.length > 0
    && localColumns.length === remoteColumns.length
    && remoteKnown
    && !isKeyColumns(target, remoteColumns)
  ) {
    add({
      severity: 'warning',
      code: 'fk_target_not_key',
      tableId: source.id,
      relationshipId: relationship.id,
      params: { table: source.name, target: target.name, columns: remoteColumns.join(', ') },
    }, relationshipIndex)
  }
}

function validateCycles(
  draft: DiagramDraft,
  add: (issue: DiagramIssueDraft, slot: string | number) => void,
): void {
  const edges = new Map<string, Set<string>>()
  for (const table of draft.tables) edges.set(table.id, new Set())
  for (const relationship of draft.relationships) {
    const source = resolveTable(draft, relationship.startTableId)
    const target = resolveTable(draft, relationship.endTableId)
    if (!source || !target) continue
    edges.get(source.id)?.add(target.id)
  }

  const groups = cyclicGroups(draft.tables.map((table) => table.id), edges)
    .map((group) => group
      .map((id) => draft.tables.find((table) => table.id === id))
      .filter((table): table is DiagramTable => table !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name)))
    .filter((group) => group.length > 0)
    .sort((left, right) => left[0].name.localeCompare(right[0].name))

  const seen = new Set<string>()
  for (const group of groups) {
    const names = group.map((table) => table.name)
    const key = names.map(normalizeName).join(KEY_SEPARATOR)
    if (seen.has(key)) continue
    seen.add(key)
    add({
      severity: 'info',
      code: 'fk_circular',
      tableId: group[0].id,
      params: { tables: names.join(', ') },
    }, seen.size - 1)
  }
}

export function validateDiagram(draft: DiagramDraft): DiagramIssue[] {
  const issues: DiagramIssue[] = []
  const nextId = createIdFactory()
  const add = (issue: DiagramIssueDraft, slot: string | number): void => {
    issues.push({ ...issue, id: nextId(issue, slot) })
  }

  const tableGroups = groupBy(draft.tables, (table) => normalizeName(table.name))
  validateTableNames(draft, tableGroups, add)
  for (const table of draft.tables) {
    validateColumns(table, add)
    validateIndexes(table, add)
    validateConstraints(table, add)
  }

  const relationshipNameGroups = groupBy(
    draft.relationships.filter((relationship) => normalizeName(relationship.name ?? '') !== ''),
    (relationship) => `${relationship.startTableId}${KEY_SEPARATOR}${normalizeName(relationship.name ?? '')}`,
  )
  draft.relationships.forEach((relationship, relationshipIndex) => {
    validateRelationship(draft, relationship, relationshipIndex, relationshipNameGroups, add)
  })

  validateCycles(draft, add)
  return issues
}