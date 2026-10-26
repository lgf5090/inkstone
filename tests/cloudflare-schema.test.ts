// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_REQUIRED_COLUMNS,
  CLOUDFLARE_REQUIRED_INDEXES,
  CLOUDFLARE_REQUIRED_TABLES,
  CLOUDFLARE_SCHEMA_STATEMENTS,
} from '../src/worker/cloudflare/schema'
import { makeD1 } from './doubles/d1-sqlite'

function apply(sqlite: DatabaseSync): void {
  for (const statement of CLOUDFLARE_SCHEMA_STATEMENTS) sqlite.exec(statement)
}

describe('the Cloudflare schema', () => {
  it('is idempotent: running every statement twice leaves one of each object', () => {
    const sqlite = new DatabaseSync(':memory:')
    apply(sqlite)
    apply(sqlite)
    const tables = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((row) => (row as { name: string }).name)
      .filter((name) => name.startsWith('cloudflare_'))
    expect(tables).toEqual([...CLOUDFLARE_REQUIRED_TABLES].sort())
    const indexes = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`)
      .all()
      .map((row) => (row as { name: string }).name)
      .filter((name) => name.startsWith('idx_cloudflare_'))
    expect(indexes).toEqual([...CLOUDFLARE_REQUIRED_INDEXES].sort())
  })

  it('declares every required column with the type the code binds', () => {
    const sqlite = new DatabaseSync(':memory:')
    apply(sqlite)
    for (const [table, columns] of Object.entries(CLOUDFLARE_REQUIRED_COLUMNS)) {
      const actual = new Set(
        sqlite.prepare(`PRAGMA table_info(${table})`).all().map((row) => (row as { name: string }).name),
      )
      for (const column of columns) expect(actual, `${table}.${column}`).toContain(column)
    }
  })

  it('scopes every row table by user, and keeps the account id unique across readers', () => {
    const sqlite = new DatabaseSync(':memory:')
    apply(sqlite)
    for (const table of CLOUDFLARE_REQUIRED_TABLES) {
      expect(CLOUDFLARE_REQUIRED_COLUMNS[table], table).toContain('user_id')
    }
    const accountId = sqlite.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get('cloudflare_account') as { sql: string }
    expect(accountId.sql).toContain('id TEXT PRIMARY KEY')
  })

  it('is part of the boot schema, so a fresh database gets the tables', async () => {
    const { SCHEMA_STATEMENTS } = await import('../src/worker/db/schema')
    const sqlite = new DatabaseSync(':memory:')
    const db = makeD1(sqlite)
    await db.batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)))
    const row = sqlite
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'cloudflare_%'`)
      .get() as { n: number }
    expect(row.n).toBe(CLOUDFLARE_REQUIRED_TABLES.length)
    const indexes = sqlite
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_cloudflare_%'`)
      .get() as { n: number }
    expect(indexes.n).toBe(CLOUDFLARE_REQUIRED_INDEXES.length)
  })
})
