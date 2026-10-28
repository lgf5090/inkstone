import type { ParsedTable } from '@shared/development/database/types'

export interface FlowNodeLayout {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface FlowEdgeDef {
  id: string
  source: string
  target: string
  label?: string
}

export interface ErdForeignKey {
  from: string
  toTable: string
  toColumn?: string
}

export interface ErdLayout {
  nodes: FlowNodeLayout[]
  edges: FlowEdgeDef[]
  fkColumns: Map<string, Set<string>>
  levels: Map<string, number>
}

export interface ExplainPlanRow {
  id: number
  parent: number
  notused: number
  detail: string
}

export interface ExplainFlowLayout {
  nodes: FlowNodeLayout[]
  edges: FlowEdgeDef[]
}

export const ERD_NODE_WIDTH = 200
export const ERD_NODE_HEADER_HEIGHT = 28
export const ERD_NODE_ROW_HEIGHT = 19
export const ERD_NODE_PADDING = 6
export const ERD_COLUMN_GAP = 300
export const ERD_ROW_GAP = 20

export const EXPLAIN_NODE_WIDTH = 240
export const EXPLAIN_NODE_HEIGHT = 58
export const EXPLAIN_COLUMN_GAP = 300
export const EXPLAIN_ROW_GAP = 26

const FOREIGN_KEY_RE =
  /FOREIGN\s+KEY\s*\(([\s\S]*?)\)\s*REFERENCES\s+((?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[^\s(]+))(?:\s*\(([\s\S]*?)\))?/i

function unquoteIdentifier(raw: string): string {
  const text = raw.trim()
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if (first === '"' && last === '"') return text.slice(1, -1).replace(/""/g, '"')
  if (first === '`' && last === '`') return text.slice(1, -1).replace(/``/g, '`')
  if (first === '[' && last === ']') return text.slice(1, -1)
  return text
}

function splitIdentifierList(input: string): string[] {
  const out: string[] = []
  let start = 0
  let quote: '"' | '`' | ']' | null = null
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quote) {
      if (quote === ']') {
        if (char === ']') quote = null
        continue
      }
      if (char === quote) {
        if (input[index + 1] === quote) {
          index += 1
          continue
        }
        quote = null
      }
      continue
    }
    if (char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '[') {
      quote = ']'
      continue
    }
    if (char === ',') {
      const piece = input.slice(start, index).trim()
      if (piece) out.push(unquoteIdentifier(piece))
      start = index + 1
    }
  }
  const tail = input.slice(start).trim()
  if (tail) out.push(unquoteIdentifier(tail))
  return out
}

export function extractForeignKeys(table: ParsedTable): ErdForeignKey[] {
  const out: ErdForeignKey[] = []
  const seen = new Set<string>()
  const push = (foreignKey: ErdForeignKey) => {
    const key = `${foreignKey.from}\u0000${foreignKey.toTable}\u0000${foreignKey.toColumn ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(foreignKey)
  }
  for (const column of table.columns) {
    if (!column.references?.table) continue
    push({
      from: column.name,
      toTable: unquoteIdentifier(column.references.table),
      toColumn: column.references.column ? unquoteIdentifier(column.references.column) : undefined,
    })
  }
  for (const constraint of table.tableConstraints) {
    const match = FOREIGN_KEY_RE.exec(constraint)
    if (!match) continue
    const fromColumns = splitIdentifierList(match[1] ?? '')
    if (fromColumns.length === 0) continue
    const toTable = unquoteIdentifier(match[2] ?? '')
    if (!toTable) continue
    const toColumns = splitIdentifierList(match[3] ?? '')
    fromColumns.forEach((from, index) => {
      push({ from, toTable, toColumn: toColumns[index] })
    })
  }
  return out
}

export function erdNodeHeight(columnCount: number): number {
  return ERD_NODE_HEADER_HEIGHT + Math.max(columnCount, 1) * ERD_NODE_ROW_HEIGHT + ERD_NODE_PADDING
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function computeLevels(metas: Map<string, ErdForeignKey[]>): Map<string, number> {
  const levels = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (name: string): number => {
    const known = levels.get(name)
    if (known !== undefined) return known
    if (visiting.has(name)) return 0
    visiting.add(name)
    let level = 0
    for (const foreignKey of metas.get(name) ?? []) {
      if (foreignKey.toTable === name || !metas.has(foreignKey.toTable)) continue
      level = Math.max(level, visit(foreignKey.toTable) + 1)
    }
    visiting.delete(name)
    levels.set(name, level)
    return level
  }
  for (const name of metas.keys()) visit(name)
  return levels
}

export function buildErdLayout(tables: ParsedTable[]): ErdLayout {
  const tableByName = new Map(tables.map((table) => [table.name, table]))
  const foreignKeys = new Map<string, ErdForeignKey[]>()
  const fkColumns = new Map<string, Set<string>>()
  for (const table of tables) {
    const keys = extractForeignKeys(table)
    foreignKeys.set(table.name, keys)
    fkColumns.set(table.name, new Set(keys.map((foreignKey) => foreignKey.from)))
  }

  const levels = computeLevels(foreignKeys)
  const byLevel = new Map<number, string[]>()
  for (const [name, level] of levels) {
    const names = byLevel.get(level)
    if (names) names.push(name)
    else byLevel.set(level, [name])
  }
  for (const names of byLevel.values()) names.sort(compareNames)

  const yByName = new Map<string, number>()
  for (const names of byLevel.values()) {
    let y = 0
    for (const name of names) {
      yByName.set(name, y)
      const table = tableByName.get(name)
      y += (table ? erdNodeHeight(table.columns.length) : erdNodeHeight(0)) + ERD_ROW_GAP
    }
  }

  const nodes: FlowNodeLayout[] = tables.map((table) => ({
    id: table.name,
    x: (levels.get(table.name) ?? 0) * ERD_COLUMN_GAP,
    y: yByName.get(table.name) ?? 0,
    width: ERD_NODE_WIDTH,
    height: erdNodeHeight(table.columns.length),
  }))

  const edges: FlowEdgeDef[] = []
  for (const table of tables) {
    for (const foreignKey of foreignKeys.get(table.name) ?? []) {
      if (!tableByName.has(foreignKey.toTable)) continue
      edges.push({
        id: `fk-${table.name}-${foreignKey.from}-${foreignKey.toTable}-${foreignKey.toColumn ?? ''}`,
        source: table.name,
        target: foreignKey.toTable,
        label: foreignKey.from,
      })
    }
  }

  return { nodes, edges, fkColumns, levels }
}

export function layoutExplainTree(rows: ExplainPlanRow[]): ExplainFlowLayout {
  const byId = new Map<number, ExplainPlanRow>()
  const order: number[] = []
  for (const row of rows) {
    if (!Number.isFinite(row.id) || byId.has(row.id)) continue
    byId.set(row.id, row)
    order.push(row.id)
  }

  const parentOf = new Map<number, number>()
  for (const id of order) {
    const row = byId.get(id)
    if (!row) continue
    const parent = row.parent
    if (parent === id || !byId.has(parent)) continue
    let cursor: number | undefined = parent
    const seen = new Set<number>([id])
    let valid = true
    while (cursor !== undefined && byId.has(cursor)) {
      if (seen.has(cursor)) {
        valid = false
        break
      }
      seen.add(cursor)
      const next: number | undefined = byId.get(cursor)?.parent
      cursor = next === cursor ? undefined : next
    }
    if (valid) parentOf.set(id, parent)
  }

  const children = new Map<number, number[]>()
  const roots: number[] = []
  for (const id of order) {
    const parent = parentOf.get(id)
    if (parent === undefined) {
      roots.push(id)
      continue
    }
    const siblings = children.get(parent)
    if (siblings) siblings.push(id)
    else children.set(parent, [id])
  }

  const nodes: FlowNodeLayout[] = []
  let nextLeaf = 0
  const place = (id: number, depth: number): number => {
    const childIds = children.get(id) ?? []
    const childYs = childIds.map((childId) => place(childId, depth + 1))
    const y =
      childYs.length > 0
        ? childYs.reduce((sum, value) => sum + value, 0) / childYs.length
        : nextLeaf++ * (EXPLAIN_NODE_HEIGHT + EXPLAIN_ROW_GAP)
    nodes.push({
      id: String(id),
      x: depth * EXPLAIN_COLUMN_GAP,
      y,
      width: EXPLAIN_NODE_WIDTH,
      height: EXPLAIN_NODE_HEIGHT,
    })
    return y
  }
  for (const root of roots) place(root, 0)

  const edges: FlowEdgeDef[] = []
  for (const id of order) {
    const parent = parentOf.get(id)
    if (parent === undefined) continue
    edges.push({ id: `e-${parent}-${id}`, source: String(parent), target: String(id) })
  }

  return { nodes, edges }
}
