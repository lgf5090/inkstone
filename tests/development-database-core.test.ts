// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { parseCreateTable, parseCreateIndex } from '../src/client/features/development/database/schema-parse'
import { buildRebuildSql } from '../src/client/features/development/database/ddl'
import { buildTableDataSql, loadSchema } from '../src/client/features/development/database/schema-utils'
import { buildDistinctSql } from '../src/client/features/development/database/distinct-ops'
import { buildDataSearchSql, searchableColumns } from '../src/client/features/development/database/data-search'
import { buildRowInsert, chunkRows, transferInsertStatements } from '../src/client/features/development/database/transfer-ops'
import { generateRows } from '../src/client/features/development/database/data-generate'
import { diagnoseSql } from '../src/client/features/development/database/sql-diagnostics'
import { computeColumnWidths } from '../src/client/features/development/database/snapshot'
import { diffSchemas, schemaStatements } from '../src/client/features/development/database/schema-diff'
import { diffRows } from '../src/client/features/development/database/data-diff'
import { inferColumnType, parseCsv } from '../src/client/features/development/database/csv-parse'
import { projectColumns, toCsv, toMarkdown, toSchemaSql } from '../src/client/features/development/database/export-utils'
import { transformValue } from '../src/client/features/development/database/transform-value'
import { INKSTONE_BLOB_KEY } from '../src/shared/development/database/types'
import { blobBytes, blobFileName, hexDump, imageSource } from '../src/client/features/development/database/blob-view'
import { buildWhere } from '../src/client/features/development/database/filter-ops'
import { SCHEMA_PROMPT_BUDGET_CHARS, buildSchemaPrompt } from '../src/client/features/development/database/schema-prompt'
import { buildInsert, buildUpdate, fromTemporalInput, rowKeyOf, temporalKind, toTemporalInput } from '../src/client/features/development/database/row-ops'
import type { StudioDriver } from '../src/client/features/development/database/drivers'
import { findPlaceholders, replacePlaceholders } from '../src/client/features/development/database/placeholders'
import { isDestructiveSql, isSchemaChangeSql, splitSqlStatements } from '../src/shared/development/database/sql-utils'

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

  it('detects statements that change the schema', () => {
    expect(isSchemaChangeSql('CREATE TABLE t (id INTEGER PRIMARY KEY)')).toBe(true)
    expect(isSchemaChangeSql('drop table if exists t')).toBe(true)
    expect(isSchemaChangeSql('ALTER TABLE t ADD COLUMN x TEXT')).toBe(true)
    expect(isSchemaChangeSql('SELECT "CREATE TABLE" FROM sqlite_master')).toBe(false)
    expect(isSchemaChangeSql('INSERT INTO t VALUES (1)')).toBe(false)
  })

  it('flags only irreversible statements for the confirmation', () => {
    expect(isDestructiveSql('DROP TABLE users')).toBe(true)
    expect(isDestructiveSql('truncate table t')).toBe(true)
    expect(isDestructiveSql('DELETE FROM users')).toBe(true)
    expect(isDestructiveSql('DELETE FROM users WHERE id = 1')).toBe(false)
    expect(isDestructiveSql('UPDATE users SET name = "x"')).toBe(true)
    expect(isDestructiveSql('UPDATE users SET name = "x" WHERE id = 1')).toBe(false)
    expect(isDestructiveSql('-- drop the old rows\nSELECT 1')).toBe(false)
    expect(isDestructiveSql("SELECT * FROM sqlite_master WHERE name LIKE 'drop%'")).toBe(false)
    expect(isDestructiveSql("SELECT sql FROM sqlite_master WHERE sql LIKE '%DROP TABLE%'")).toBe(false)
    expect(isDestructiveSql("SELECT * FROM notes WHERE body LIKE '%truncate%'")).toBe(false)
    expect(isDestructiveSql('/* DELETE FROM t */ INSERT INTO t VALUES (1)')).toBe(false)
  })

  it('builds a distinct-value query only for known columns', () => {
    const sql = buildDistinctSql('orders', 'status', ['id', 'status'])
    expect(sql).toContain('SELECT "status" AS value, COUNT(*) AS occurrences FROM "orders"')
    expect(sql).toContain('GROUP BY 1 ORDER BY occurrences DESC, value ASC LIMIT 50')
    expect(buildDistinctSql('orders', 'missing', ['id', 'status'])).toBeNull()
    expect(buildDistinctSql('t', 'a"b', ['a"b'])).toContain('"a""b"')
  })

  it('transforms cell values without touching the source', () => {
    expect(transformValue('  Hi  ', { kind: 'trim' })).toEqual({ ok: true, text: 'Hi' })
    expect(transformValue('{"a":1}', { kind: 'json' })).toEqual({ ok: true, text: '{\n  "a": 1\n}' })
    expect(transformValue('0', { kind: 'unixToDate', unit: 's' })).toEqual({ ok: true, text: '1970-01-01 00:00:00.000 UTC' })
    expect(transformValue('2023-11-14T22:13:20Z', { kind: 'dateToUnix' })).toEqual({ ok: true, text: '1700000000' })
    expect(transformValue('ff', { kind: 'baseConvert', fromBase: 16, toBase: 10 })).toEqual({ ok: true, text: '255' })
    expect(transformValue('-ff', { kind: 'baseConvert', fromBase: 16, toBase: 2 })).toEqual({ ok: true, text: '-11111111' })
    expect(transformValue('zz', { kind: 'baseConvert', fromBase: 10, toBase: 16 })).toEqual({ ok: false, error: 'invalid_number' })
    expect(transformValue('not json', { kind: 'json' })).toEqual({ ok: false, error: 'invalid_json' })
    expect(transformValue('x', { kind: 'dateToUnix' })).toEqual({ ok: false, error: 'invalid_date' })
  })

  it('renders markdown tables with escaped pipes and flattened newlines', () => {
    expect(toMarkdown(['a', 'b'], [['x|y', 'line\nbreak']])).toBe('| a | b |\n| --- | --- |\n| x\\|y | line break |')
  })

  it('reads blobs, dumps hex and recognises image sources', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41])
    const encoded = Buffer.from(bytes).toString('base64')
    expect(blobBytes({ [INKSTONE_BLOB_KEY]: encoded })).toEqual(bytes)
    expect(blobBytes(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]))
    expect(blobBytes('plain')).toBeNull()
    const dump = hexDump(bytes)
    expect(dump.text.split('\n')[0]).toContain('00000000  89 50 4e 47')
    expect(dump.truncated).toBe(false)
    expect(hexDump(new Uint8Array(5000)).truncated).toBe(true)
    expect(imageSource('data:image/png;base64,AAAA')).toBeTruthy()
    expect(imageSource('https://example.com/a.jpg?x=1')).toBeTruthy()
    expect(imageSource('https://example.com/a.txt')).toBeNull()
    expect(blobFileName('avatar', bytes)).toBe('avatar.png')
  })

  it('maps temporal column types to inputs and back', () => {
    expect(temporalKind('DATE')).toBe('date')
    expect(temporalKind('DATETIME')).toBe('datetime')
    expect(temporalKind('TIMESTAMP')).toBe('datetime')
    expect(temporalKind('TIME')).toBe('time')
    expect(temporalKind('TEXT')).toBeNull()
    expect(toTemporalInput('2024-05-01 08:30:00', 'datetime')).toBe('2024-05-01T08:30')
    expect(toTemporalInput('2024-05-01', 'date')).toBe('2024-05-01')
    expect(toTemporalInput('08:30:00', 'time')).toBe('08:30')
    expect(fromTemporalInput('2025-01-02T10:15', 'datetime')).toBe('2025-01-02 10:15:00')
    expect(fromTemporalInput('10:15', 'time')).toBe('10:15:00')
    expect(fromTemporalInput('2025-01-02', 'date')).toBe('2025-01-02')
  })

  it('builds data search SQL over text columns only', () => {
    const columns = searchableColumns([
      { name: 'id', type: 'INTEGER' },
      { name: 'avatar', type: 'BLOB' },
      { name: 'email', type: 'TEXT' },
    ])
    expect(columns).toEqual(['id', 'email'])
    const built = buildDataSearchSql('users', columns, 'bob', 500)
    expect(built?.sql).toContain('FROM "users" WHERE instr(lower(coalesce(cast("id" as text)')
    expect(built?.sql).toContain('LIMIT 100')
    expect(built?.params).toEqual(['bob', 'bob'])
    expect(buildDataSearchSql('users', [], 'bob', 10)).toBeNull()
    expect(buildDataSearchSql('users', columns, '   ', 10)).toBeNull()
  })

  it('parses CSV with quotes, escaped quotes and semicolon detection', () => {
    const parsed = parseCsv('name;note\r\n"a;b";"say ""hi"""\r\nplain;"line\nnext"\r\n')
    expect(parsed.delimiter).toBe(';')
    expect(parsed.headers).toEqual(['name', 'note'])
    expect(parsed.rows).toEqual([['a;b', 'say "hi"'], ['plain', 'line\nnext']])
    expect(parseCsv('1,2\n3,4', { hasHeader: false }).headers).toEqual(['column_1', 'column_2'])
    expect(inferColumnType(['1', '2', '3'])).toBe('INTEGER')
    expect(inferColumnType(['1', '2.5'])).toBe('REAL')
    expect(inferColumnType(['1', 'x'])).toBe('TEXT')
    expect(inferColumnType([])).toBe('TEXT')
  })

  it('chunks transfer rows and quotes INSERT literals', () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(buildRowInsert('t', ['a', 'b'], ["x'y", null])).toBe(`INSERT INTO "t" ("a", "b") VALUES ('x''y', NULL)`)
    expect(transferInsertStatements('t', ['a'], [[1], [2]])).toEqual([
      'INSERT INTO "t" ("a") VALUES (1);',
      'INSERT INTO "t" ("a") VALUES (2);',
    ])
  })

  it('generates deterministic rows for each generator kind', () => {
    const columns = [
      { name: 'id', config: { kind: 'sequence' as const, start: 100, step: 5 } },
      { name: 'score', config: { kind: 'integer' as const, min: 1, max: 10 } },
      { name: 'ratio', config: { kind: 'real' as const, min: 0, max: 1, decimals: 3 } },
      { name: 'name', config: { kind: 'text' as const, length: 5 } },
      { name: 'mail', config: { kind: 'email' as const } },
      { name: 'ip', config: { kind: 'ip' as const } },
      { name: 'day', config: { kind: 'date' as const } },
      { name: 'flag', config: { kind: 'bool' as const } },
      { name: 'kind', config: { kind: 'enum' as const, values: ['a', 'b'] } },
      { name: 'skip', config: { kind: 'skip' as const } },
    ]
    const first = generateRows(columns, 3, 7)
    const second = generateRows(columns, 3, 7)
    expect(first).toEqual(second)
    expect(first[0]?.[0]).toBe(100)
    expect(first[2]?.[0]).toBe(110)
    expect(Number(first[0]?.[1])).toBeGreaterThanOrEqual(1)
    expect(Number(first[0]?.[1])).toBeLessThanOrEqual(10)
    expect(String(first[0]?.[3])).toMatch(/^[a-z]{5}$/)
    expect(String(first[0]?.[4])).toMatch(/@example\.com$/)
    expect(String(first[0]?.[5])).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    expect(String(first[0]?.[6])).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(['a', 'b']).toContain(first[0]?.[8])
    expect(first[0]).toHaveLength(9)
    expect(generateRows([], 2)).toEqual([[], []])
  })

  it('diffs schemas and emits only additive statements', () => {
    const source = [
      { name: 'users', sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)', columns: [
        { name: 'id', type: 'INTEGER', notNull: false, pk: true },
        { name: 'email', type: 'TEXT', notNull: false, pk: false },
        { name: 'age', type: 'INTEGER', notNull: false, pk: false },
      ] },
      { name: 'fresh', sql: 'CREATE TABLE fresh (id INTEGER)', columns: [{ name: 'id', type: 'INTEGER', notNull: false, pk: false }] },
    ]
    const target = [
      { name: 'users', sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, legacy TEXT)', columns: [
        { name: 'id', type: 'INTEGER', notNull: false, pk: true },
        { name: 'email', type: 'BLOB', notNull: false, pk: false },
        { name: 'legacy', type: 'TEXT', notNull: false, pk: false },
      ] },
      { name: 'stale', sql: 'CREATE TABLE stale (id INTEGER)', columns: [] },
    ]
    const diffs = diffSchemas(source, target)
    const users = diffs.find((diff) => diff.table === 'users')!
    expect(users.addedColumns.map((column) => column.name)).toEqual(['age'])
    expect(users.removedColumns).toEqual(['legacy'])
    expect(users.typeChanges).toEqual([{ column: 'email', from: 'BLOB', to: 'TEXT' }])
    expect(diffs.find((diff) => diff.table === 'fresh')?.missingInTarget).toBe(true)
    expect(diffs.find((diff) => diff.table === 'stale')?.missingInSource).toBe(true)
    const statements = schemaStatements(diffs, source)
    expect(statements).toContain('CREATE TABLE fresh (id INTEGER);')
    expect(statements).toContain('ALTER TABLE "users" ADD COLUMN "age" INTEGER;')
    expect(statements.some((statement) => statement.startsWith('DROP'))).toBe(false)
  })

  it('diffs rows into insert/update/delete statements', () => {
    const result = diffRows({
      table: 't',
      keyColumns: ['id'],
      sourceColumns: ['id', 'name', 'note'],
      sourceRows: [[1, 'a', 'x'], [2, 'b', null], [4, 'd', 'z']],
      targetColumns: ['id', 'name', 'note', 'extra'],
      targetRows: [[1, 'a', 'y'], [3, 'c', 'q']],
    })
    expect(result.inserts).toEqual([
      `INSERT INTO "t" ("id", "name", "note") VALUES (2, 'b', NULL);`,
      `INSERT INTO "t" ("id", "name", "note") VALUES (4, 'd', 'z');`,
    ])
    expect(result.updates).toEqual([`UPDATE "t" SET "note" = 'x' WHERE "id" = 1;`])
    expect(result.deletes).toEqual([`DELETE FROM "t" WHERE "id" = 3;`])
    expect(diffRows({ table: 't', keyColumns: ['missing'], sourceColumns: ['id'], sourceRows: [[1]], targetColumns: ['id'], targetRows: [] })).toEqual({ inserts: [], updates: [], deletes: [] })
  })

  it('diagnoses missing tables and unknown qualified columns', () => {
    const schema = {
      tables: [
        { name: 'users', columns: [{ name: 'id' }, { name: 'email' }] },
        { name: 'orders', columns: [{ name: 'id' }, { name: 'user_id' }] },
      ],
      views: [{ name: 'user_totals' }],
    }
    expect(diagnoseSql('SELECT * FROM missing_table', schema)).toEqual([{ kind: 'missing_table', name: 'missing_table' }])
    expect(diagnoseSql('SELECT u.nope FROM users u', schema)).toEqual([{ kind: 'unknown_column', table: 'users', column: 'nope' }])
    expect(diagnoseSql('SELECT u.email FROM users AS u', schema)).toEqual([])
    expect(diagnoseSql('WITH fresh AS (SELECT 1) SELECT * FROM fresh', schema)).toEqual([])
    expect(diagnoseSql('SELECT * FROM sqlite_master', schema)).toEqual([])
    expect(diagnoseSql("SELECT 'from ghosts' AS text FROM user_totals", schema)).toEqual([])
  })

  it('sizes snapshot columns between the bounds', () => {
    const widths = computeColumnWidths(['id', 'name'], [['1', 'Alice'], ['2', 'a'.repeat(200)]])
    expect(widths[0]).toBe(64)
    expect(widths[1]).toBe(320)
    expect(computeColumnWidths(['x'], [])[0]).toBe(64)
  })

  it('quotes CSV cells containing separators and newlines', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'line\nbreak']], { bom: false })).toBe('a,b\r\n"x,y","line\nbreak"')
  })

  it('dumps schema objects in dependency order with single terminators', () => {
    const sql = toSchemaSql({
      tables: [{ sql: 'CREATE TABLE a (id INTEGER);' }],
      indexes: [{ sql: 'CREATE INDEX i ON a (id)' }, { sql: null }],
      views: [{ sql: 'CREATE VIEW v AS SELECT * FROM a' }],
      triggers: [{ sql: 'CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END' }],
    })
    expect(sql).toBe([
      'CREATE TABLE a (id INTEGER);',
      'CREATE INDEX i ON a (id);',
      'CREATE VIEW v AS SELECT * FROM a;',
      'CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;',
    ].join('\n\n') + '\n')
    expect(toSchemaSql({ tables: [], indexes: [], views: [], triggers: [] })).toBe('')
  })

  it('builds multi-column ORDER BY and drops unknown columns', () => {
    const { sql } = buildTableDataSql('t', {
      limit: 10,
      offset: 0,
      sort: [
        { column: 'a', dir: 'ASC' },
        { column: 'b', dir: 'DESC' },
        { column: 'missing', dir: 'ASC' },
      ],
    }, ['a', 'b'])
    expect(sql).toContain('ORDER BY "a" ASC, "b" DESC')
    expect(sql).not.toContain('missing')
    expect(sql).not.toContain('ORDER BY "a" DESC')
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
