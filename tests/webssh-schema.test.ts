// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase, SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import {
  WEBSSH_FORWARD_SCHEMA_STATEMENTS,
  WEBSSH_REQUIRED_COLUMNS,
  WEBSSH_REQUIRED_INDEXES,
  WEBSSH_REQUIRED_TABLES,
  WEBSSH_SCHEMA_STATEMENTS,
} from '../src/worker/webssh/schema'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

let sqlite: DatabaseSync

function tables(): Set<string> {
  const rows = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function indexes(): Set<string> {
  const rows = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function columns(table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  await initializeDatabase(testBindings(makeD1(sqlite)))
})

describe('the WebSSH tables', () => {
  it('are owned by migration 298 and not duplicated in the boot statements', () => {
    const migration = SCHEMA_MIGRATIONS.find((candidate) => candidate.version === 298)
    expect(migration?.statements).toEqual(WEBSSH_SCHEMA_STATEMENTS)
    for (const statement of WEBSSH_SCHEMA_STATEMENTS) {
      expect(SCHEMA_STATEMENTS.some((candidate) => candidate.includes(statement.slice(0, 60)))).toBe(false)
    }
  })

  it('are extended by migration 304 with the forward rule table', () => {
    const migration = SCHEMA_MIGRATIONS.find((candidate) => candidate.version === 304)
    expect(migration?.statements).toEqual(WEBSSH_FORWARD_SCHEMA_STATEMENTS)
  })

  it('create every declared table', () => {
    const present = tables()
    for (const table of WEBSSH_REQUIRED_TABLES) expect(present.has(table)).toBe(true)
    expect(WEBSSH_REQUIRED_TABLES).toHaveLength(13)
  })

  it('create every declared index', () => {
    const present = indexes()
    for (const index of WEBSSH_REQUIRED_INDEXES) expect(present.has(index)).toBe(true)
  })

  it('carry every column the boot checks for', () => {
    for (const [table, required] of Object.entries(WEBSSH_REQUIRED_COLUMNS)) {
      const present = columns(table)
      for (const column of required) expect(present.has(column), `${table}.${column}`).toBe(true)
    }
  })

  it('scope every tenant-owned table to a user', () => {
    for (const table of WEBSSH_REQUIRED_TABLES) {
      expect(columns(table).has('user_id'), table).toBe(true)
    }
  })

  it('keeps two accounts from reading the same host rows', () => {
    const insert = sqlite.prepare(
      `INSERT INTO webssh_hosts (
         user_id, id, name, name_folded, host, port, username, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 22, 'root', 1, 1)`,
    )
    insert.run('user-a', 'host-a', 'Alpha', 'alpha', 'alpha.example.com')
    insert.run('user-b', 'host-b', 'Beta', 'beta', 'beta.example.com')
    const count = (userId: string) => sqlite
      .prepare(`SELECT COUNT(*) AS n FROM webssh_hosts WHERE user_id = ?`)
      .get(userId) as { n: number }
    expect(count('user-a').n).toBe(1)
    expect(count('user-b').n).toBe(1)
    const ids = sqlite
      .prepare(`SELECT id FROM webssh_hosts WHERE user_id = ? ORDER BY id`)
      .all('user-a') as Array<{ id: string }>
    expect(ids.map((row) => row.id)).toEqual(['host-a'])
  })

  it('keeps the numbered ledger unique and every lane migration represented once', () => {
    const versions = SCHEMA_MIGRATIONS.map((migration) => migration.version)
    expect(new Set(versions).size).toBe(versions.length)
    expect(Math.max(...versions)).toBe(317)
    expect(versions.filter((version) => version === 298)).toHaveLength(1)
    for (const version of [301, 304, 313, 314, 315, 316, 317]) {
      expect(versions.filter((entry) => entry === version)).toHaveLength(1)
    }
  })
})
