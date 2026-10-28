// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { ensureInknoteSeed } from '../src/worker/inknote/seed'
import { INKNOTE_REQUIRED_INDEXES, INKNOTE_REQUIRED_TABLES, INKNOTE_SCHEMA_STATEMENTS } from '../src/worker/inknote/schema'
import { makeD1 } from './doubles/d1-sqlite'

function open(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  return sqlite
}

describe('the inknote schema', () => {
  it('creates every declared table and index', () => {
    const sqlite = open()
    const tables = new Set((sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((row) => row.name))
    for (const table of INKNOTE_REQUIRED_TABLES) expect(tables.has(table), table).toBe(true)
    const indexes = new Set((sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]).map((row) => row.name))
    for (const index of INKNOTE_REQUIRED_INDEXES) expect(indexes.has(index), index).toBe(true)
    expect(INKNOTE_SCHEMA_STATEMENTS.length).toBeGreaterThan(INKNOTE_REQUIRED_TABLES.length)
  })

  it('converges an existing database without a migration number', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY)`)
    for (const statement of SCHEMA_STATEMENTS.filter((entry) => /^\s*CREATE TABLE IF NOT EXISTS/.test(entry))) sqlite.exec(statement)
    for (const statement of SCHEMA_STATEMENTS.filter((entry) => /^\s*CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/.test(entry))) sqlite.exec(statement)
    const tables = new Set((sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((row) => row.name))
    for (const table of INKNOTE_REQUIRED_TABLES) expect(tables.has(table), table).toBe(true)
  })

  it('seeds one subject and notebook exactly once', async () => {
    const sqlite = open()
    const db = makeD1(sqlite)
    await ensureInknoteSeed(db, 'u1', 100)
    await ensureInknoteSeed(db, 'u1', 200)
    await ensureInknoteSeed(db, 'u2', 300)
    const subjects = sqlite.prepare(`SELECT user_id, COUNT(*) AS n FROM inknote_subjects GROUP BY user_id`).all() as { user_id: string, n: number }[]
    expect(subjects).toEqual([{ user_id: 'u1', n: 1 }, { user_id: 'u2', n: 1 }])
    const notebooks = sqlite.prepare(`SELECT user_id, COUNT(*) AS n FROM inknote_notebooks GROUP BY user_id`).all() as { user_id: string, n: number }[]
    expect(notebooks).toEqual([{ user_id: 'u1', n: 1 }, { user_id: 'u2', n: 1 }])
  })
})
