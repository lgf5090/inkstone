import { describe, expect, it } from 'vitest'
import type { ParsedTable, SchemaModel } from '../src/shared/development/database/types'
import {
  buildRelationships,
  findTable,
  renameTableInDraft,
  schemaToDiagram,
  syncRelationships,
  type DiagramDraft,
} from '../src/client/features/development/database/diagram'
import { buildDiagramDdl } from '../src/client/features/development/database/diagram-ddl'
import type { DiagramConstraint } from '../src/client/features/development/database/constraints'
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
const TAGS = table('CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT)')

function schema(overrides: Partial<SchemaModel> = {}): SchemaModel {
  return {
    tables: [USERS, ORDERS, TAGS],
    views: [],
    triggers: [],
    indexes: [
      { name: 'idx_orders_code', unique: false, columns: ['code'], origin: 'c', sql: 'CREATE INDEX idx_orders_code ON orders (code)', table: 'orders' },
    ],
    ...overrides,
  }
}

function draftOf(base: SchemaModel = schema()): DiagramDraft {
  return schemaToDiagram(base)
}

function updateTable(draft: DiagramDraft, name: string, update: (table: NonNullable<ReturnType<typeof findTable>>) => NonNullable<ReturnType<typeof findTable>>): DiagramDraft {
  const tables = draft.tables.map((table) => (table.id === name ? update(table) : table))
  return syncRelationships({ tables, relationships: [], ...(draft.renames ? { renames: draft.renames } : {}) })
}

describe('buildDiagramDdl', () => {
  it('returns no statements when the draft matches the schema', () => {
    const plan = buildDiagramDdl(schema(), draftOf())
    expect(plan.statements).toEqual([])
    expect(plan.warnings).toEqual([])
    expect(plan.summary).toEqual({
      createdTables: 0,
      rebuiltTables: 0,
      droppedTables: 0,
      createdIndexes: 0,
      droppedIndexes: 0,
    })
  })

  it('creates new tables with foreign keys and indexes', () => {
    const base = schema({ tables: [USERS, ORDERS] })
    const draft = draftOf(schema())
    const tables = draft.tables.filter((table) => table.id !== 'tags')
    const tags = findTable(draft, 'tags')!
    tables.push({
      ...tags,
      constraints: [{
        id: 'new-fk',
        kind: 'foreign-key',
        raw: '',
        columns: ['id'],
        refTable: 'users',
        refColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'SET NULL',
      }],
      indexes: [{ id: 'new-index', name: 'idx_tags_id', unique: true, columns: ['id'], raw: null }],
    })
    const next = syncRelationships({ tables, relationships: [] })
    const plan = buildDiagramDdl(base, next)
    expect(plan.statements).toContain('BEGIN;')
    expect(plan.statements.some((statement) => statement.includes('CREATE TABLE "tags"'))).toBe(true)
    expect(plan.statements.some((statement) => statement.includes('FOREIGN KEY ("id") REFERENCES "users" ("id") ON DELETE SET NULL'))).toBe(true)
    expect(plan.statements).toContain('CREATE UNIQUE INDEX "idx_tags_id" ON "tags" ("id");')
    expect(plan.summary.createdTables).toBe(1)
  })

  it('drops tables and warns about dependent views', () => {
    const base = schema({
      views: [{ name: 'order_view', sql: 'CREATE VIEW order_view AS SELECT * FROM orders', table: 'orders' }],
    })
    const draft = draftOf(base)
    const next = syncRelationships({ tables: draft.tables.filter((table) => table.id !== 'orders'), relationships: [] })
    const plan = buildDiagramDdl(base, next, { views: base.views })
    expect(plan.statements).toContain('DROP TABLE "orders";')
    expect(plan.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'data_loss_drop_table', target: 'orders' }),
      expect.objectContaining({ code: 'dropped_table_has_dependents', target: 'orders' }),
    ]))
    expect(plan.summary.droppedTables).toBe(1)
  })

  it('rebuilds modified tables through a temporary table', () => {
    const draft = updateTable(draftOf(), 'users', (table) => ({
      ...table,
      columns: table.columns.map((column) => (column.name === 'email' ? { ...column, notNull: false } : column)),
    }))
    const plan = buildDiagramDdl(schema(), draft)
    expect(plan.statements.some((statement) => statement.includes('CREATE TABLE "users__rebuild"'))).toBe(true)
    expect(plan.statements.some((statement) => statement.includes('INSERT INTO "users__rebuild" ("id", "email") SELECT "id", "email" FROM "users";'))).toBe(true)
    expect(plan.statements).toContain('DROP TABLE "users";')
    expect(plan.statements).toContain('ALTER TABLE "users__rebuild" RENAME TO "users";')
    expect(plan.summary.rebuiltTables).toBe(1)
  })

  it('adds and drops indexes without rebuilding the table', () => {
    const added = updateTable(draftOf(), 'tags', (table) => ({
      ...table,
      indexes: [{ id: 'i', name: 'idx_tags_name', unique: false, columns: ['name'], raw: null }],
    }))
    const addPlan = buildDiagramDdl(schema(), added)
    expect(addPlan.statements).toContain('CREATE INDEX "idx_tags_name" ON "tags" ("name");')
    expect(addPlan.statements.some((statement) => statement.includes('__rebuild'))).toBe(false)
    expect(addPlan.summary.createdIndexes).toBe(1)

    const removed = updateTable(draftOf(), 'orders', (table) => ({ ...table, indexes: [] }))
    const dropPlan = buildDiagramDdl(schema(), removed)
    expect(dropPlan.statements).toContain('DROP INDEX "idx_orders_code";')
    expect(dropPlan.summary.droppedIndexes).toBe(1)
  })

  it('renames a table without rebuilding it', () => {
    const draft = renameTableInDraft(draftOf(), 'users', 'accounts')
    const plan = buildDiagramDdl(schema(), draft)
    expect(plan.statements).toContain('ALTER TABLE "users" RENAME TO "accounts";')
    expect(plan.statements.some((statement) => statement.includes('__rebuild'))).toBe(false)
    expect(plan.statements.some((statement) => statement.includes('CREATE TABLE'))).toBe(false)
  })

  it('rebuilds a renamed table with structure changes and copies from the old name', () => {
    const renamed = renameTableInDraft(draftOf(), 'users', 'accounts')
    const draft = updateTable(renamed, 'accounts', (table) => ({
      ...table,
      columns: table.columns.map((column) => (column.name === 'email' ? { ...column, notNull: false } : column)),
    }))
    const plan = buildDiagramDdl(schema(), draft)
    expect(plan.statements.some((statement) => statement.includes('CREATE TABLE "accounts__rebuild"'))).toBe(true)
    expect(plan.statements.some((statement) => statement.includes('FROM "users";'))).toBe(true)
    expect(plan.statements).toContain('ALTER TABLE "accounts__rebuild" RENAME TO "accounts";')
  })

  it('drops columns with a data loss warning and skips constraints that reference them', () => {
    const draft = updateTable(draftOf(), 'orders', (table) => ({
      ...table,
      columns: table.columns.filter((column) => column.name !== 'user_id'),
    }))
    const plan = buildDiagramDdl(schema(), draft)
    expect(plan.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'data_loss_drop_column', target: 'orders.user_id' }),
      expect.objectContaining({ code: 'constraint_references_removed_column' }),
    ]))
    expect(plan.statements.some((statement) => statement.includes('FOREIGN KEY ("user_id")'))).toBe(false)
    expect(plan.statements.some((statement) => statement.includes('"user_id" INTEGER'))).toBe(false)
  })

  it('renames columns and maps indexes and copied data', () => {
    const draft = updateTable(draftOf(), 'users', (table) => ({
      ...table,
      columns: table.columns.map((column) => (column.name === 'email' ? { ...column, name: 'mail' } : column)),
    }))
    const plan = buildDiagramDdl(schema(), draft)
    expect(plan.statements.some((statement) => statement.includes('INSERT INTO "users__rebuild" ("id", "mail") SELECT "id", "email" FROM "users";'))).toBe(true)
  })

  it('preserves unknown constraints verbatim', () => {
    const unknown: DiagramConstraint = { id: 'unknown', kind: 'unknown', raw: 'EXCLUDE USING gist (room WITH =)' }
    const draft = updateTable(draftOf(), 'tags', (table) => ({
      ...table,
      columns: table.columns.map((column) => (column.name === 'name' ? { ...column, notNull: true } : column)),
      constraints: [...table.constraints, unknown],
    }))
    const plan = buildDiagramDdl(schema(), draft)
    expect(plan.statements.some((statement) => statement.includes('EXCLUDE USING gist'))).toBe(true)
    expect(plan.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unknown_constraint_preserved' }),
    ]))
  })

  it('warns when a foreign key target is not a key or the types do not match', () => {
    const draft = draftOf()
    const users = findTable(draft, 'users')!
    const tables = draft.tables.map((table) => (
      table.id === 'tags'
        ? {
            ...table,
            columns: table.columns.map((column) => (column.name === 'name' ? { ...column, type: 'INTEGER' } : column)),
            constraints: [{
              id: 'bad-fk',
              kind: 'foreign-key' as const,
              raw: '',
              columns: ['name'],
              refTable: 'users',
              refColumns: ['email'],
            }],
          }
        : table
    ))
    const next = syncRelationships({ tables, relationships: [] })
    expect(users).toBeTruthy()
    const plan = buildDiagramDdl(schema(), next)
    expect(plan.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'fk_target_not_key' }),
      expect.objectContaining({ code: 'fk_type_mismatch' }),
    ]))
  })

  it('reports foreign key cycles', () => {
    const draft = draftOf()
    const tables = draft.tables.map((table) => {
      if (table.id === 'users') {
        return {
          ...table,
          constraints: [...table.constraints, {
            id: 'cycle-fk',
            kind: 'foreign-key' as const,
            raw: '',
            columns: ['id'],
            refTable: 'orders',
            refColumns: ['id'],
          }],
        }
      }
      return table
    })
    const plan = buildDiagramDdl(schema(), syncRelationships({ tables, relationships: [] }))
    expect(plan.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'fk_cycle' })]))
  })

  it('creates tables without a primary key with a warning', () => {
    const draft = draftOf()
    const tables = draft.tables.map((table) => (
      table.id === 'tags'
        ? { ...table, columns: table.columns.map((column) => ({ ...column, pk: false })) }
        : table
    ))
    const plan = buildDiagramDdl(schema(), syncRelationships({ tables, relationships: [] }))
    expect(plan.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'no_primary_key', target: 'tags' })]))
  })

  it('recreates dependent views and triggers when a table is rebuilt', () => {
    const base = schema({
      views: [{ name: 'user_view', sql: 'CREATE VIEW user_view AS SELECT id FROM users', table: 'users' }],
      triggers: [{ name: 'user_trigger', sql: 'CREATE TRIGGER user_trigger AFTER INSERT ON users BEGIN SELECT 1; END', table: 'users' }],
    })
    const draft = updateTable(draftOf(base), 'users', (table) => ({
      ...table,
      columns: table.columns.map((column) => (column.name === 'email' ? { ...column, notNull: false } : column)),
    }))
    const plan = buildDiagramDdl(base, draft, { views: base.views, triggers: base.triggers })
    expect(plan.statements).toContain('DROP VIEW "user_view";')
    expect(plan.statements.some((statement) => statement.includes('CREATE VIEW user_view'))).toBe(true)
    expect(plan.statements.some((statement) => statement.includes('CREATE TRIGGER user_trigger'))).toBe(true)
  })

  it('rebuilds relationships from table constraints after edits', () => {
    const draft = draftOf()
    const tags = findTable(draft, 'tags')!
    expect(buildRelationships(draft.tables).length).toBe(1)
    expect(tags.constraints).toHaveLength(0)
  })
})