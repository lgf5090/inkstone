// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { REQUIRED_COLUMNS, REQUIRED_INDEXES, REQUIRED_TABLES, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import {
  SUBSCRIPTIONS_REQUIRED_COLUMNS,
  SUBSCRIPTIONS_REQUIRED_INDEXES,
  SUBSCRIPTIONS_REQUIRED_TABLES,
} from '../src/worker/subscriptions/schema'

let sqlite: DatabaseSync

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
})

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

describe('the subscription tables', () => {
  it('are created by the schema every boot runs', () => {
    const present = tables()
    for (const table of SUBSCRIPTIONS_REQUIRED_TABLES) expect(present.has(table)).toBe(true)
  })

  it('are registered as required, so a half-built database fails loudly', () => {
    for (const table of SUBSCRIPTIONS_REQUIRED_TABLES) expect(REQUIRED_TABLES).toContain(table)
    for (const index of SUBSCRIPTIONS_REQUIRED_INDEXES) expect(REQUIRED_INDEXES).toContain(index)
    for (const table of SUBSCRIPTIONS_REQUIRED_TABLES) expect(REQUIRED_COLUMNS[table]).toBeDefined()
  })

  it('create every index they claim', () => {
    const present = indexes()
    for (const index of SUBSCRIPTIONS_REQUIRED_INDEXES) expect(present.has(index)).toBe(true)
  })

  it('carry every column the boot checks for', () => {
    for (const [table, required] of Object.entries(SUBSCRIPTIONS_REQUIRED_COLUMNS)) {
      const present = columns(table)
      for (const column of required) expect(present.has(column)).toBe(true)
    }
  })

  it('scope every row to an account', () => {
    for (const table of SUBSCRIPTIONS_REQUIRED_TABLES) expect(columns(table).has('user_id')).toBe(true)
  })

  it('keep one row per channel kind per account', () => {
    const insert = sqlite.prepare(
      `INSERT INTO sub_channel (user_id, id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
    insert.run('u1', 'a', 'telegram', 1, 1)
    expect(() => insert.run('u1', 'b', 'telegram', 1, 1)).toThrow()
    expect(() => insert.run('u2', 'c', 'telegram', 1, 1)).not.toThrow()
  })

  it('allow a subscription with no price and no start date', () => {
    sqlite.prepare(
      `INSERT INTO sub_item (user_id, id, name, expiry_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('u1', 'sub-1', 'Domain', Date.UTC(2026, 5, 1), 1, 1)
    const row = sqlite.prepare(`SELECT amount, start_date FROM sub_item WHERE id = 'sub-1'`).get() as {
      amount: number | null
      start_date: number | null
    }
    expect(row.amount).toBeNull()
    expect(row.start_date).toBeNull()
  })
})
