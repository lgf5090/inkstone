// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { parseCreateTable, parseCreateIndex } from '../src/client/features/development/database/schema-parse'
import { buildRebuildSql } from '../src/client/features/development/database/ddl'
import { loadSchema } from '../src/client/features/development/database/schema-utils'
import { projectColumns, toCsv } from '../src/client/features/development/database/export-utils'
import { buildWhere } from '../src/client/features/development/database/filter-ops'
import { SCHEMA_PROMPT_BUDGET_CHARS, buildSchemaPrompt } from '../src/client/features/development/database/schema-prompt'
import { buildInsert, buildUpdate, rowKeyOf } from '../src/client/features/development/database/row-ops'
import type { StudioDriver } from '../src/client/features/development/database/drivers'
import { findPlaceholders, replacePlaceholders } from '../src/client/features/development/database/placeholders'
import { splitSqlStatements } from '../src/shared/development/database/sql-utils'

describe('development database core', () => {
  it('parses composite keys, constraints and index columns', () => {
    const table = parseCreateTable(`CREATE TABLE "t" (
      "a" INTEGER NOT NULL,
      "b" TEXT COLLATE NOCASE DEFAULT ('x,y'),
      "c" REAL,
      PRIMARY KEY ("a", "b"),
      UNIQUE ("b")
    ) WITHOUT ROWID STRICT`)
    expect(table?.columns.map((column) => column.name)).toEqual(['a', 'b', 'c'])
    expect(table?.columns[0]?.notNull).toBe(true)
    expect(table?.columns[0]?.pk).toBe(true)
    expect(table?.columns[1]?.pk).toBe(true)
    expect(table?.columns[1]?.default).toBe(`('x,y')`)
    expect(table?.withoutRowid).toBe(true)
    expect(table?.strict).toBe(true)

    const index = parseCreateIndex('CREATE INDEX "i" ON "t" ("a" COLLATE NOCASE DESC)')
    expect(index?.columns).toEqual(['a'])
  })

  it('splits trigger bodies without losing inner semicolons', () => {
    const statements = splitSqlStatements(`CREATE TRIGGER tr AFTER INSERT ON t BEGIN
      INSERT INTO log VALUES (1);
      INSERT INTO log VALUES (2);
    END;
    SELECT 1;`)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain('INSERT INTO log VALUES (2);')
  })

  it('finds placeholders outside strings and comments and types values', () => {
    const sql = `SELECT ':no', "a:no" FROM t WHERE id = :id -- :comment\n AND n = :n`
    expect(findPlaceholders(sql)).toEqual(['id', 'n'])
    expect(replacePlaceholders('SELECT * FROM t LIMIT :n', { n: '10' })).toBe('SELECT * FROM t LIMIT 10')
    expect(replacePlaceholders('SELECT :s', { s: "a'b" })).toBe("SELECT 'a''b'")
  })

  it('rebuilds a table copying only shared columns and restoring views/indexes', () => {
    const table = parseCreateTable(`CREATE TABLE "t" ("id" INTEGER PRIMARY KEY, "name" TEXT)`)!
    const result = buildRebuildSql(
      table,
      [
        { id: '1', name: 'id', type: 'INTEGER', notNull: false, pk: true, unique: false, default: '', original: table.columns[0] },
        { id: '2', name: 'name', type: 'TEXT', notNull: false, pk: false, unique: false, default: '', original: table.columns[1] },
        { id: '3', name: 'added', type: 'TEXT', notNull: false, pk: false, unique: false, default: '', isNew: true },
      ],
      {
        indexes: [{ name: 'idx_t_name', columns: ['name'], sql: 'CREATE INDEX idx_t_name ON t(name)' }],
        views: [{ name: 'v_t', sql: 'CREATE VIEW v_t AS SELECT name FROM t' }],
      },
    )
    expect(result.sql).toContain('DROP VIEW "v_t";')
    expect(result.sql).toContain('INSERT INTO "t__rebuild" ("id", "name") SELECT "id", "name" FROM "t";')
    expect(result.sql).not.toContain('"added") SELECT')
    expect(result.sql).toContain('CREATE VIEW v_t AS SELECT name FROM t;')
    expect(result.sql).toContain('CREATE INDEX idx_t_name ON t(name);')
  })

  it('projects columns and row values together when a column is hidden', () => {
    const projected = projectColumns(
      ['id', 'name', 'email', 'age'],
      [[1, 'Alice', 'alice@example.com', 30]],
      new Set([2]),
    )
    expect(projected.columns).toEqual(['id', 'name', 'age'])
    expect(projected.rows).toEqual([[1, 'Alice', 30]])
    expect(toCsv(projected.columns, projected.rows, { bom: false })).toBe('id,name,age\r\n1,Alice,30')
  })

  it('omits untouched insert columns so defaults apply', () => {
    const insert = buildInsert('users', [['name', 'NewGuy']])
    expect(insert?.sql).toBe('INSERT INTO "users" ("name") VALUES (?)')
    expect(insert?.params).toEqual(['NewGuy'])
    expect(buildInsert('t', [])).toEqual({ sql: 'INSERT INTO "t" DEFAULT VALUES', params: [] })
    expect(buildInsert('t', [['created_at', null]])?.params).toEqual([null])
  })

  it('hides SQLite and D1 internal objects from the schema model', async () => {
    const driver: StudioDriver = {
      type: 'sqlite',
      label: 'fake',
      close: () => {},
      query: async () => ({
        columns: ['type', 'name', 'tbl_name', 'sql'],
        rows: [
          ['table', 'users', 'users', 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)'],
          ['table', 'sqlite_sequence', 'sqlite_sequence', 'CREATE TABLE sqlite_sequence(name,seq)'],
          ['table', '_cf_KV', '_cf_KV', 'CREATE TABLE _cf_KV(key TEXT PRIMARY KEY, value BLOB)'],
          ['index', 'idx_users_name', 'users', 'CREATE INDEX idx_users_name ON users(name)'],
          ['view', 'v_users', 'v_users', 'CREATE VIEW v_users AS SELECT name FROM users'],
          ['trigger', 'trg_users', 'users', 'CREATE TRIGGER trg_users AFTER INSERT ON users BEGIN SELECT 1; END'],
        ],
        durationMs: 0,
      }),
    }
    const model = await loadSchema(driver)
    expect(model.tables.map((table) => table.name)).toEqual(['users'])
    expect(model.views.map((view) => view.name)).toEqual(['v_users'])
    expect(model.triggers.map((trigger) => trigger.name)).toEqual(['trg_users'])
  })

  it('keeps the AI schema prompt inside its budget and leads with mentioned tables', () => {
    const wide = Array.from({ length: 50 }, (_, index) => ({
      name: `t${index}`,
      columns: Array.from({ length: 40 }, (_, column) => ({
        name: `col_${index}_${column}`.padEnd(30, 'x'),
        type: 'TEXT',
      })),
    }))
    const mentioned = { name: 'zzz_users', columns: [{ name: 'id', type: 'INTEGER' }] }
    const built = buildSchemaPrompt([...wide, mentioned], 'select id from zzz_users')
    expect(built.text.length).toBeLessThanOrEqual(SCHEMA_PROMPT_BUDGET_CHARS)
    expect(built.omitted, 'a 68k-char schema cannot fit the budget').toBeGreaterThan(0)
    expect(built.text.split('\n')[0]).toContain('zzz_users')

    const small = buildSchemaPrompt([mentioned, { name: 'orders', columns: [{ name: 'id', type: 'INTEGER' }] }], '')
    expect(small.omitted).toBe(0)
    expect(small.text).toBe('- zzz_users(id INTEGER)\n- orders(id INTEGER)')
  })

  it('quotes CSV cells containing separators and newlines', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'line\nbreak']], { bom: false })).toBe('a,b\r\n"x,y","line\nbreak"')
  })

  it('uses one search parameter per searched column and parameterises filter values', () => {
    const where = buildWhere([{ id: '1', column: 'name', op: 'contains', value: 'ali' }], 'bob', ['name', 'email'])
    expect(where?.params).toHaveLength(3)
    expect(where?.sql).toContain('instr(lower(coalesce(cast("name" as text)')
    expect(where?.sql).toContain('LIKE ? ESCAPE')

    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE t (id INTEGER, name TEXT, email TEXT);
      INSERT INTO t VALUES (1, 'Alice', 'alice@example.com'), (2, 'Bob', 'bob@example.com'), (3, 'Bobby', 'b@example.com');`)
    const search = buildWhere([], 'bob', ['name', 'email'])!
    const rows = db.prepare(`SELECT name FROM t WHERE ${search.sql} ORDER BY id`).all(...search.params as string[])
    expect(rows.map((row) => row.name)).toEqual(['Bob', 'Bobby'])
    const combined = buildWhere([{ id: '1', column: 'name', op: 'contains', value: 'Bob' }], 'bob', ['name', 'email'])!
    const filtered = db.prepare(`SELECT name FROM t WHERE ${combined.sql} ORDER BY id`).all(...combined.params as string[])
    expect(filtered.map((row) => row.name)).toEqual(['Bob', 'Bobby'])
    db.close()
  })

  it('builds composite-key and rowid updates', () => {
    const pk = rowKeyOf([1, 'a'], ['id', 'name'], ['id', 'name'])
    const update = buildUpdate('t', pk, [['email', 'x@example.com']])
    expect(update?.sql).toBe('UPDATE "t" SET "email" = ? WHERE "id" = ? AND "name" = ?')
    expect(update?.params).toEqual(['x@example.com', 1, 'a'])

    const rowid = rowKeyOf([5], ['id'], [], 9)
    expect(buildUpdate('t', rowid, [['id', 6]])?.sql).toBe('UPDATE "t" SET "id" = ? WHERE rowid = ?')
  })
})
