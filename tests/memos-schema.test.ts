// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  REQUIRED_COLUMNS,
  REQUIRED_INDEXES,
  REQUIRED_TABLES,
  SCHEMA_MIGRATIONS,
  initializeDatabase,
} from '../src/worker/db/schema'
import {
  MEMOS_REQUIRED_COLUMNS,
  MEMOS_REQUIRED_INDEXES,
  MEMOS_REQUIRED_TABLES,
  MEMOS_SCHEMA_STATEMENTS,
} from '../src/worker/memos/schema'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const MEMOS_MIGRATION_VERSION = 145

function tablesOf(sqlite: DatabaseSync): Set<string> {
  const rows = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function indexesOf(sqlite: DatabaseSync): Set<string> {
  const rows = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function columnsOf(sqlite: DatabaseSync, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

async function boot(sqlite: DatabaseSync): Promise<void> {
  await initializeDatabase(testBindings(makeD1(sqlite)))
}

async function installed(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  await boot(sqlite)
  return sqlite
}

function reboot(sqlite: DatabaseSync): Promise<void> {
  sqlite.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
  return boot(sqlite)
}

function migrationVersions(sqlite: DatabaseSync): number[] {
  return (sqlite.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{ version: number }>)
    .map((row) => row.version)
}

describe('the memos tables', () => {
  it('are created by the schema every boot runs', async () => {
    const sqlite = await installed()
    const tables = tablesOf(sqlite)
    for (const table of MEMOS_REQUIRED_TABLES) expect(tables.has(table)).toBe(true)
    expect(tables.has('memos')).toBe(false)
  })

  it('create every index they claim', async () => {
    const sqlite = await installed()
    const indexes = indexesOf(sqlite)
    for (const index of MEMOS_REQUIRED_INDEXES) expect(indexes.has(index)).toBe(true)
  })

  it('carry every column the boot checks for', async () => {
    const sqlite = await installed()
    for (const [table, required] of Object.entries(MEMOS_REQUIRED_COLUMNS)) {
      const present = columnsOf(sqlite, table)
      for (const column of required) expect(present.has(column)).toBe(true)
    }
  })

  it('are registered as required, so a half-built database fails loudly', () => {
    for (const table of MEMOS_REQUIRED_TABLES) expect(REQUIRED_TABLES).toContain(table)
    for (const index of MEMOS_REQUIRED_INDEXES) expect(REQUIRED_INDEXES).toContain(index)
    for (const table of MEMOS_REQUIRED_TABLES) expect(REQUIRED_COLUMNS[table]).toBeDefined()
  })

  it('declare migration 145 with the same statements the boot creates', () => {
    const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === MEMOS_MIGRATION_VERSION)
    expect(migration).toBeDefined()
    expect(migration?.statements).toEqual(MEMOS_SCHEMA_STATEMENTS)
    expect(migration?.skipIfColumnExists).toBeUndefined()
  })
})

describe('migration 145', () => {
  it('builds the memos schema on its own', () => {
    const sqlite = new DatabaseSync(':memory:')
    const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === MEMOS_MIGRATION_VERSION)
    for (const statement of migration?.statements ?? []) sqlite.exec(statement)

    const tables = tablesOf(sqlite)
    for (const table of MEMOS_REQUIRED_TABLES) expect(tables.has(table)).toBe(true)
    const indexes = indexesOf(sqlite)
    for (const index of MEMOS_REQUIRED_INDEXES) expect(indexes.has(index)).toBe(true)
  })

  it('replays without changing the shape and records itself once', async () => {
    const sqlite = await installed()
    const tables = [...tablesOf(sqlite)].sort()
    const indexes = [...indexesOf(sqlite)].sort()
    expect(migrationVersions(sqlite)).toContain(MEMOS_MIGRATION_VERSION)

    for (let pass = 0; pass < 2; pass++) {
      sqlite.exec(`DELETE FROM schema_migrations WHERE version = ${MEMOS_MIGRATION_VERSION}`)
      await reboot(sqlite)
      expect(migrationVersions(sqlite).filter((version) => version === MEMOS_MIGRATION_VERSION)).toHaveLength(1)
      expect([...tablesOf(sqlite)].sort()).toEqual(tables)
      expect([...indexesOf(sqlite)].sort()).toEqual(indexes)
    }
  })

  it('restores a memos table the ledger already claims was created', async () => {
    const sqlite = await installed()
    sqlite.exec('DROP TABLE memos_items')
    expect(tablesOf(sqlite).has('memos_items')).toBe(false)
    expect(indexesOf(sqlite).has('idx_memos_user_created')).toBe(false)

    await reboot(sqlite)

    expect(tablesOf(sqlite).has('memos_items')).toBe(true)
    expect(columnsOf(sqlite, 'memos_items').has('content_search')).toBe(true)
    for (const index of MEMOS_REQUIRED_INDEXES.filter((name) => name.startsWith('idx_memos_user_') || name === 'idx_memos_parent' || name === 'idx_memos_public')) {
      expect(indexesOf(sqlite).has(index)).toBe(true)
    }
    expect(migrationVersions(sqlite).filter((version) => version === MEMOS_MIGRATION_VERSION)).toHaveLength(1)
  })

  it('keeps the visibility, state, storage and reaction constraints', async () => {
    const sqlite = await installed()
    const insertMemo = sqlite.prepare(`INSERT INTO memos_items (id, user_id, content, visibility, state, created_at, updated_at)
      VALUES (?, 'u1', '', ?, ?, 1, 1)`)
    expect(() => insertMemo.run('m1', 'shared', 'normal')).toThrow()
    expect(() => insertMemo.run('m2', 'private', 'deleted')).toThrow()
    expect(() => insertMemo.run('m3', 'public', 'archived')).not.toThrow()

    expect(() => sqlite.prepare(`INSERT INTO memos_attachments (id, user_id, filename, mime, size, storage, storage_key, created_at, updated_at)
      VALUES ('a1', 'u1', 'a.png', 'image/png', 1, 's3', 'k', 1, 1)`).run()).toThrow()

    const insertReaction = sqlite.prepare(`INSERT INTO memos_reactions (id, user_id, memo_id, type, created_at) VALUES (?, 'u1', 'm3', 'like', 1)`)
    insertReaction.run('r1')
    expect(() => insertReaction.run('r2')).toThrow()
  })
})
