import { describe, expect, it } from 'vitest'
import type { ParsedTable, SchemaModel } from '../src/shared/development/database/types'
import {
  buildRelationships,
  clampPosition,
  diagramSignature,
  diagramTableToParsedTable,
  findTable,
  nextTablePosition,
  relationshipCardinality,
  renameTableInDraft,
  schemaToDiagram,
  syncRelationships,
} from '../src/client/features/development/database/diagram'
import { parseCreateTable } from '../src/client/features/development/database/schema-parse'

function table(sql: string): ParsedTable {
  const parsed = parseCreateTable(sql)
  if (!parsed) throw new Error(`could not parse ${sql}`)
  return parsed
}

const USERS = table('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)')
const ORDERS = table(
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id) ON DELETE CASCADE, code TEXT, CONSTRAINT uq_code UNIQUE (code))',
)
const TENANTS = table('CREATE TABLE tenants (id INTEGER PRIMARY KEY)')
const MEMBERSHIPS = table(
  'CREATE TABLE memberships (user_id INTEGER, tenant_id INTEGER, role TEXT, FOREIGN KEY (user_id, tenant_id) REFERENCES tenants (id, id))',
)

function schema(): SchemaModel {
  return {
    tables: [USERS, ORDERS, TENANTS, MEMBERSHIPS],
    views: [],
    triggers: [],
    indexes: [
      { name: 'idx_orders_code', unique: false, columns: ['code'], origin: 'c', sql: 'CREATE INDEX idx_orders_code ON orders (code)', table: 'orders' },
    ],
  }
}

describe('schemaToDiagram', () => {
  it('maps tables, columns, constraints and indexes', () => {
    const draft = schemaToDiagram(schema())
    expect(draft.tables).toHaveLength(4)
    const orders = findTable(draft, 'orders')
    expect(orders).not.toBeNull()
    expect(orders!.columns.map((column) => column.name)).toEqual(['id', 'user_id', 'code'])
    expect(orders!.indexes).toEqual([
      expect.objectContaining({ name: 'idx_orders_code', unique: false, columns: ['code'] }),
    ])
    expect(orders!.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unique', uniqueColumns: ['code'] }),
        expect.objectContaining({ kind: 'foreign-key', columns: ['user_id'], refTable: 'users', onDelete: 'CASCADE' }),
      ]),
    )
  })

  it('builds relationships from column and table foreign keys', () => {
    const draft = schemaToDiagram(schema())
    expect(draft.relationships).toHaveLength(2)
    expect(draft.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ startTableId: 'orders', startColumns: ['user_id'], endTableId: 'users', endColumns: ['id'], onDelete: 'CASCADE' }),
        expect.objectContaining({ startTableId: 'memberships', startColumns: ['user_id', 'tenant_id'], endTableId: 'tenants', endColumns: ['id', 'id'] }),
      ]),
    )
  })

  it('deduplicates column and table foreign keys that describe the same relation', () => {
    const duplicate = table(
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id), FOREIGN KEY (user_id) REFERENCES users (id))',
    )
    const draft = schemaToDiagram({ tables: [USERS, duplicate], views: [], triggers: [], indexes: [] })
    expect(draft.relationships).toHaveLength(1)
  })

  it('applies stored positions and falls back to the layered layout', () => {
    const draft = schemaToDiagram(schema(), { orders: { x: 480, y: 96 } })
    const orders = findTable(draft, 'orders')
    expect(orders).toMatchObject({ x: 480, y: 96, width: 200 })
    const users = findTable(draft, 'users')
    expect(typeof users!.y).toBe('number')
    expect(typeof users!.x).toBe('number')
  })

  it('clamps invalid positions', () => {
    const draft = schemaToDiagram(schema(), { orders: { x: Number.NaN, y: Number.POSITIVE_INFINITY } })
    const orders = findTable(draft, 'orders')
    expect(orders).toMatchObject({ x: 0, y: 0 })
    expect(clampPosition(1_000_000_000)).toBe(1_000_000)
    expect(clampPosition(-1_000_000_000)).toBe(-1_000_000)
    expect(clampPosition(12.6)).toBe(13)
  })
})

describe('diagramSignature', () => {
  it('ignores node positions but tracks structure', () => {
    const draft = schemaToDiagram(schema())
    const moved = {
      ...draft,
      tables: draft.tables.map((table) => ({ ...table, x: table.x + 10, y: table.y + 10 })),
    }
    expect(diagramSignature(moved)).toBe(diagramSignature(draft))
    const edited = {
      ...draft,
      tables: draft.tables.map((table) => (
        table.id === 'orders'
          ? { ...table, columns: table.columns.map((column) => (column.name === 'code' ? { ...column, notNull: true } : column)) }
          : table
      )),
    }
    expect(diagramSignature(edited)).not.toBe(diagramSignature(draft))
  })
})

describe('renameTableInDraft', () => {
  it('renames the table and rewrites foreign key targets and relationships', () => {
    const draft = schemaToDiagram(schema())
    const renamed = renameTableInDraft(draft, 'users', 'accounts')
    expect(findTable(renamed, 'accounts')?.name).toBe('accounts')
    expect(findTable(renamed, 'users')).toBeNull()
    const orders = findTable(renamed, 'orders')
    expect(orders!.constraints).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'foreign-key', refTable: 'accounts' })]),
    )
    expect(renamed.relationships.every((relationship) => relationship.endTableId === 'accounts' || relationship.startTableId !== 'users')).toBe(true)
    expect(renamed.relationships.some((relationship) => relationship.endTableId === 'accounts')).toBe(true)
  })

  it('ignores empty names', () => {
    const draft = schemaToDiagram(schema())
    expect(renameTableInDraft(draft, 'users', '   ')).toBe(draft)
  })
})

describe('diagramTableToParsedTable', () => {
  it('serializes structured constraints back to SQL text', () => {
    const draft = schemaToDiagram(schema())
    const orders = diagramTableToParsedTable(findTable(draft, 'orders')!)
    expect(orders.tableConstraints).toEqual(
      expect.arrayContaining([
        'CONSTRAINT "uq_code" UNIQUE ("code")',
        expect.stringContaining('FOREIGN KEY ("user_id") REFERENCES "users" ("id")'),
      ]),
    )
  })
})

describe('relationships helpers', () => {
  it('derives one-to-one when the source columns are a primary or unique key', () => {
    const draft = schemaToDiagram({
      tables: [
        USERS,
        table('CREATE TABLE profiles (user_id INTEGER PRIMARY KEY REFERENCES users (id))'),
      ],
      views: [],
      triggers: [],
      indexes: [],
    })
    const relationship = draft.relationships[0]!
    expect(relationshipCardinality(draft, relationship)).toBe('1:1')
  })

  it('derives many-to-one otherwise', () => {
    const draft = schemaToDiagram(schema())
    const relationship = draft.relationships.find((entry) => entry.startTableId === 'orders')!
    expect(relationshipCardinality(draft, relationship)).toBe('N:1')
  })

  it('rebuilds relationships after constraint edits', () => {
    const draft = schemaToDiagram(schema())
    const tables = draft.tables.map((table) => (
      table.id === 'orders'
        ? { ...table, constraints: table.constraints.filter((constraint) => constraint.kind !== 'foreign-key') }
        : table
    ))
    const synced = syncRelationships({ tables, relationships: [] })
    expect(synced.relationships).toHaveLength(1)
    expect(synced.relationships[0]!.startTableId).toBe('memberships')
  })

  it('places new tables to the right of the draft', () => {
    const draft = schemaToDiagram(schema())
    const position = nextTablePosition(draft)
    const maxX = Math.max(...draft.tables.map((table) => table.x + table.width))
    expect(position).toEqual({ x: maxX + 40, y: 0 })
    expect(nextTablePosition({ tables: [], relationships: [] })).toEqual({ x: 0, y: 0 })
  })

  it('rebuilds relationships when tables are passed directly', () => {
    const draft = schemaToDiagram(schema())
    expect(buildRelationships(draft.tables)).toEqual(draft.relationships)
  })
})