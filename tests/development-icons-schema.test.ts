// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  assertUniqueSchemaMigrations,
  initializeDatabase,
  SCHEMA_MIGRATIONS,
} from '../src/worker/db/schema'
import {
  DEVELOPMENT_ICONS_REQUIRED_INDEXES,
  DEVELOPMENT_ICONS_REQUIRED_TABLES,
} from '../src/worker/development/icons/schema'
import { makeD1 } from './doubles/d1-sqlite'

function tablesOf(sqlite: DatabaseSync): string[] {
  return sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((row) => (row as { name: string }).name)
}

function indexesOf(sqlite: DatabaseSync): string[] {
  return sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map((row) => (row as { name: string }).name)
}

function versionsOf(sqlite: DatabaseSync): number[] {
  return sqlite.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all().map((row) => (row as { version: number }).version)
}

async function installed(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  await initializeDatabase({ DB: makeD1(sqlite) } as never)
  return sqlite
}

describe('development icons schema', () => {
  it('declares 320, 321, 327 and 328 exactly once', () => {
    const versions = SCHEMA_MIGRATIONS.map((migration) => migration.version)
    for (const version of [320, 321, 327, 328]) {
      expect(versions.filter((entry) => entry === version)).toHaveLength(1)
    }
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('keeps every development_icons_ statement inside the icon migrations', () => {
    const owners = SCHEMA_MIGRATIONS
      .filter((migration) => migration.statements.some((statement) => statement.includes('development_icons_')))
      .map((migration) => migration.version)
    expect(owners).toEqual([320, 321, 327, 328])
  })

  it('creates every required table and index and records every migration', async () => {
    const sqlite = await installed()
    const tables = tablesOf(sqlite)
    const indexes = indexesOf(sqlite)
    for (const table of DEVELOPMENT_ICONS_REQUIRED_TABLES) expect(tables).toContain(table)
    for (const index of DEVELOPMENT_ICONS_REQUIRED_INDEXES) expect(indexes).toContain(index)
    expect(tables).toContain('development_icons_fts')
    for (const version of [320, 321, 327, 328]) expect(versionsOf(sqlite)).toContain(version)
  })

  it('boots twice without changing the shape', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')
    await initializeDatabase({ DB: makeD1(sqlite) } as never)
    const before = tablesOf(sqlite).sort()
    await initializeDatabase({ DB: makeD1(sqlite) } as never)
    expect(tablesOf(sqlite).sort()).toEqual(before)
    for (const version of [320, 321, 327, 328]) {
      expect(versionsOf(sqlite).filter((entry) => entry === version)).toHaveLength(1)
    }
  })

  it('refuses duplicate migration versions', () => {
    expect(() => assertUniqueSchemaMigrations([{ version: 320 }, { version: 320 }])).toThrow('Duplicate schema migration version 320')
    expect(() => assertUniqueSchemaMigrations([{ version: 321 }, { version: 321 }])).toThrow('Duplicate schema migration version 321')
    expect(() => assertUniqueSchemaMigrations([{ version: 327 }, { version: 327 }])).toThrow('Duplicate schema migration version 327')
  })
})
