import { describe, expect, it } from 'vitest'
import type { ParsedColumn, ParsedTable } from '../src/shared/development/database/types'
import {
  buildErdLayout,
  ERD_COLUMN_GAP,
  ERD_NODE_HEADER_HEIGHT,
  ERD_NODE_PADDING,
  ERD_NODE_ROW_HEIGHT,
  ERD_NODE_WIDTH,
  erdNodeHeight,
  extractForeignKeys,
  layoutExplainTree,
  type FlowNodeLayout,
} from '../src/client/features/development/database/flow-layout'

function column(name: string, type = 'TEXT', extra: Partial<ParsedColumn> = {}): ParsedColumn {
  return {
    name,
    type,
    notNull: false,
    pk: false,
    pkPosition: 0,
    default: null,
    unique: false,
    autoIncrement: false,
    ...extra,
  }
}

function table(name: string, columns: ParsedColumn[], tableConstraints: string[] = []): ParsedTable {
  return { name, sql: '', columns, tableConstraints, withoutRowid: false, strict: false }
}

function nodeById(nodes: FlowNodeLayout[], id: string): FlowNodeLayout {
  const node = nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`missing node ${id}`)
  return node
}

function overlap(left: FlowNodeLayout, right: FlowNodeLayout): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  )
}

describe('buildErdLayout', () => {
  it('puts referenced tables on the left and labels edges with the source column', () => {
    const users = table('users', [column('id', 'INTEGER', { pk: true, pkPosition: 1 })])
    const orders = table('orders', [
      column('id', 'INTEGER', { pk: true, pkPosition: 1 }),
      column('user_id', 'INTEGER', { references: { table: 'users', column: 'id' } }),
    ])
    const items = table('order_items', [
      column('id', 'INTEGER', { pk: true, pkPosition: 1 }),
      column('order_id', 'INTEGER', { references: { table: 'orders', column: 'id' } }),
    ])

    const layout = buildErdLayout([items, orders, users])

    expect(layout.levels.get('users')).toBe(0)
    expect(layout.levels.get('orders')).toBe(1)
    expect(layout.levels.get('order_items')).toBe(2)
    expect(nodeById(layout.nodes, 'users').x).toBe(0)
    expect(nodeById(layout.nodes, 'orders').x).toBe(ERD_COLUMN_GAP)
    expect(nodeById(layout.nodes, 'order_items').x).toBe(ERD_COLUMN_GAP * 2)
    expect(layout.edges.map((edge) => [edge.source, edge.target, edge.label])).toEqual([
      ['order_items', 'orders', 'order_id'],
      ['orders', 'users', 'user_id'],
    ])
    expect([...layout.fkColumns.get('orders') ?? []]).toEqual(['user_id'])
    expect([...layout.fkColumns.get('order_items') ?? []]).toEqual(['order_id'])
  })

  it('keeps node height aligned with the header, rows and padding', () => {
    const layout = buildErdLayout([
      table('users', [column('id'), column('name')]),
    ])
    const node = nodeById(layout.nodes, 'users')
    expect(node.width).toBe(ERD_NODE_WIDTH)
    expect(node.height).toBe(ERD_NODE_HEADER_HEIGHT + 2 * ERD_NODE_ROW_HEIGHT + ERD_NODE_PADDING)
    expect(node.height).toBe(erdNodeHeight(2))
    expect(erdNodeHeight(0)).toBe(erdNodeHeight(1))
  })

  it('turns a composite foreign key into one edge per source column', () => {
    const parent = table('parent', [
      column('a', 'INTEGER', { pk: true, pkPosition: 1 }),
      column('b', 'INTEGER', { pk: true, pkPosition: 2 }),
    ])
    const child = table(
      'child',
      [column('x', 'INTEGER'), column('y', 'INTEGER')],
      ['FOREIGN KEY ("x", "y") REFERENCES "parent" ("a", "b")'],
    )

    const layout = buildErdLayout([parent, child])

    expect(layout.edges).toHaveLength(2)
    expect(layout.edges.map((edge) => edge.label)).toEqual(['x', 'y'])
    expect(layout.edges.every((edge) => edge.target === 'parent')).toBe(true)
    expect([...layout.fkColumns.get('child') ?? []].sort()).toEqual(['x', 'y'])
  })

  it('extracts quoted identifiers, spaces and commas from table constraints', () => {
    const child = table('child', [column('a,b'), column('c')], [
      'CONSTRAINT "fk name" FOREIGN KEY ("a,b", [c]) REFERENCES "parent table" ("x,y", "z")',
    ])

    expect(extractForeignKeys(child)).toEqual([
      { from: 'a,b', toTable: 'parent table', toColumn: 'x,y' },
      { from: 'c', toTable: 'parent table', toColumn: 'z' },
    ])
  })

  it('deduplicates a column reference that a table constraint repeats', () => {
    const parent = table('parent', [column('id', 'INTEGER', { pk: true, pkPosition: 1 })])
    const child = table(
      'child',
      [column('parent_id', 'INTEGER', { references: { table: 'parent', column: 'id' } })],
      ['FOREIGN KEY (parent_id) REFERENCES parent (id)'],
    )

    expect(extractForeignKeys(child)).toHaveLength(1)
    expect(buildErdLayout([parent, child]).edges).toHaveLength(1)
  })

  it('falls back to finite levels for circular references and keeps self references on their table', () => {
    const left = table('left', [
      column('id', 'INTEGER', { pk: true, pkPosition: 1 }),
      column('right_id', 'INTEGER', { references: { table: 'right', column: 'id' } }),
    ])
    const right = table('right', [
      column('id', 'INTEGER', { pk: true, pkPosition: 1 }),
      column('left_id', 'INTEGER', { references: { table: 'left', column: 'id' } }),
    ])
    const selfRef = table('node', [
      column('id', 'INTEGER', { pk: true, pkPosition: 1 }),
      column('parent_id', 'INTEGER', { references: { table: 'node', column: 'id' } }),
    ])

    const layout = buildErdLayout([left, right, selfRef])

    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true)
      expect(Number.isFinite(node.y)).toBe(true)
    }
    for (const [name, level] of layout.levels) {
      expect(level, name).toBeGreaterThanOrEqual(0)
      expect(level, name).toBeLessThanOrEqual(layout.nodes.length)
    }
    expect(layout.edges).toHaveLength(3)
    expect(layout.levels.get('node')).toBe(0)
    expect(nodeById(layout.nodes, 'node').x).toBe(0)
    for (let index = 0; index < layout.nodes.length; index += 1) {
      for (let other = index + 1; other < layout.nodes.length; other += 1) {
        expect(overlap(layout.nodes[index], layout.nodes[other])).toBe(false)
      }
    }
  })

  it('ignores edges to tables that are not part of the schema', () => {
    const child = table('child', [
      column('external_id', 'INTEGER', { references: { table: 'external', column: 'id' } }),
    ])

    const layout = buildErdLayout([child])

    expect(layout.edges).toHaveLength(0)
    expect([...layout.fkColumns.get('child') ?? []]).toEqual(['external_id'])
    expect(nodeById(layout.nodes, 'child').x).toBe(0)
  })
})

describe('layoutExplainTree', () => {
  it('lays out parents to the left of their children and centres parents on their subtree', () => {
    const layout = layoutExplainTree([
      { id: 0, parent: 0, notused: 0, detail: 'SCAN users' },
      { id: 1, parent: 0, notused: 0, detail: 'SEARCH orders' },
      { id: 2, parent: 1, notused: 0, detail: 'SCAN items' },
      { id: 3, parent: 1, notused: 0, detail: 'TEMP B-TREE' },
    ])

    expect(layout.nodes).toHaveLength(4)
    expect(layout.edges).toHaveLength(3)
    expect(nodeById(layout.nodes, '0').x).toBe(0)
    expect(nodeById(layout.nodes, '1').x).toBe(300)
    expect(nodeById(layout.nodes, '2').x).toBe(600)
    expect(nodeById(layout.nodes, '3').x).toBe(600)
    expect(nodeById(layout.nodes, '1').y).toBe(
      (nodeById(layout.nodes, '2').y + nodeById(layout.nodes, '3').y) / 2,
    )
    expect(nodeById(layout.nodes, '0').y).toBe(nodeById(layout.nodes, '1').y)
  })

  it('breaks parent cycles and keeps ids unique', () => {
    const layout = layoutExplainTree([
      { id: 1, parent: 2, notused: 0, detail: 'SCAN a' },
      { id: 2, parent: 1, notused: 0, detail: 'SCAN b' },
      { id: 3, parent: 99, notused: 0, detail: 'SCAN c' },
      { id: 3, parent: 3, notused: 0, detail: 'duplicate' },
    ])

    expect(layout.nodes).toHaveLength(3)
    expect(layout.edges).toHaveLength(0)
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true)
      expect(Number.isFinite(node.y)).toBe(true)
    }
  })
})
