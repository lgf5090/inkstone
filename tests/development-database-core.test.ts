// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseCreateTable, parseCreateIndex } from '../src/client/features/development/database/schema-parse'
import { buildRebuildSql } from '../src/client/features/development/database/ddl'
import { toCsv } from '../src/client/features/development/database/export-utils'
import { buildWhere } from '../src/client/features/development/database/filter-ops'
import { buildUpdate, rowKeyOf } from '../src/client/features/development/database/row-ops'
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

  it('quotes CSV cells containing separators and newlines', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'line\nbreak']], { bom: false })).toBe('a,b\r\n"x,y","line\nbreak"')
  })

  it('uses one search parameter and parameterises filter values', () => {
    const where = buildWhere([{ id: '1', column: 'name', op: 'contains', value: 'ali' }], 'bob', ['name', 'email'])
    expect(where?.params).toHaveLength(2)
    expect(where?.sql).toContain('instr(lower(coalesce(cast("name" as text)')
    expect(where?.sql).toContain('LIKE ? ESCAPE')
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
