// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * What a deploy does to the subscriptions database that is already on the server.
 *
 * Four columns arrived after these tables first shipped: `sub_category.icon`, `sub_category.color`,
 * `sub_settings.base_currency` and `sub_item.deleted_at`. A fresh boot gets them from the `CREATE TABLE`
 * and never exercises the `ALTER`s, so the suite that builds an empty database proves nothing about the
 * one case that matters — an account with real subscriptions whose ledger says it is already up to date.
 *
 * So this file builds the *older* shape by hand, puts a row in it, and requires the boot to arrive at
 * the current shape without disturbing that row. A default that silently differs from what the reader
 * had been seeing is a bug these tests can actually catch, which is more than "the column exists" does.
 */

const OLD_SUB_CATEGORY = `CREATE TABLE sub_category (
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
)`

const OLD_SUB_SETTINGS = `CREATE TABLE sub_settings (
  user_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  notification_hours TEXT NOT NULL DEFAULT '[]',
  show_lunar INTEGER NOT NULL DEFAULT 0,
  payment_history_limit INTEGER NOT NULL DEFAULT 100,
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  inbound_token_hash TEXT NOT NULL DEFAULT '',
  inbound_token_hint TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
)`

const OLD_SUB_ITEM = `CREATE TABLE sub_item (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  custom_type TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  amount REAL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  start_date INTEGER,
  expiry_date INTEGER NOT NULL,
  period_value INTEGER NOT NULL DEFAULT 1,
  period_unit TEXT NOT NULL DEFAULT 'month',
  subscription_mode TEXT NOT NULL DEFAULT 'cycle',
  use_lunar INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  last_payment_date INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
)`

function columnsOf(sqlite: DatabaseSync, table: string): string[] {
  return sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table)
    .map((row) => (row as { name: string }).name)
}

let sqlite: DatabaseSync

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  // Build a complete *current* database from the raw statements — not through `initializeDatabase`,
  // which would record the state marker this scenario has to be missing — then wind the three tables
  // this branch changed back to the shape they had before it, with a row in each.
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.exec('DROP TABLE sub_category')
  sqlite.exec('DROP TABLE sub_settings')
  sqlite.exec('DROP TABLE sub_item')
  // The registry this branch adds did not exist at all in a database of that age.
  sqlite.exec('DROP TABLE sub_type')
  sqlite.exec(OLD_SUB_CATEGORY)
  sqlite.exec(OLD_SUB_SETTINGS)
  sqlite.exec(OLD_SUB_ITEM)
  sqlite.exec(`INSERT INTO sub_category VALUES ('u1', '娱乐', 1)`)
  sqlite.exec(`INSERT INTO sub_settings VALUES ('u1', 'Asia/Shanghai', '["08","20"]', 1, 250, 'zh-CN', 'hash', 'abcd', 1)`)
  sqlite.exec(`INSERT INTO sub_item (user_id, id, name, expiry_date, created_at, updated_at) VALUES ('u1', 's1', 'Netflix', 2, 1, 1)`)
  // The ledger has to be as old as the tables, or the boot correctly concludes the work is done.
  sqlite.exec('DELETE FROM schema_migrations WHERE version BETWEEN 110 AND 114')
  sqlite.exec(`DELETE FROM app_meta WHERE key = 'database-state-v1'`)
})

async function boot(): Promise<void> {
  await initializeDatabase(testBindings(makeD1(sqlite)))
}

describe('an existing subscriptions database', () => {
  it('gains the identity columns and keeps the name that was already registered', async () => {
    expect(columnsOf(sqlite, 'sub_category')).not.toContain('icon')
    await boot()
    const columns = columnsOf(sqlite, 'sub_category')
    expect(columns).toContain('icon')
    expect(columns).toContain('color')
    const row = sqlite.prepare(`SELECT icon, color FROM sub_category WHERE name = '娱乐'`).get() as { icon: string; color: string }
    // Empty, not a guessed default: "nobody chose" has to stay distinguishable from "chose the default",
    // or a preset change could never reach the accounts that never picked.
    expect(row).toEqual({ icon: '', color: '' })
  })

  it('gains the base currency without disturbing the timezone or the window already saved', async () => {
    await boot()
    expect(columnsOf(sqlite, 'sub_settings')).toContain('base_currency')
    const row = sqlite.prepare(`SELECT timezone, notification_hours, payment_history_limit, inbound_token_hint, base_currency
      FROM sub_settings WHERE user_id = 'u1'`).get() as Record<string, string | number>
    expect(row).toEqual({
      timezone: 'Asia/Shanghai',
      notification_hours: '["08","20"]',
      payment_history_limit: 250,
      inbound_token_hint: 'abcd',
      base_currency: 'CNY',
    })
  })

  it('gains the trash column with every existing row still live', async () => {
    await boot()
    expect(columnsOf(sqlite, 'sub_item')).toContain('deleted_at')
    const row = sqlite.prepare(`SELECT deleted_at, name FROM sub_item WHERE id = 's1'`).get() as { deleted_at: number | null; name: string }
    // NULL means live. A default of `0` would have put every existing subscription in the trash.
    expect(row.deleted_at).toBeNull()
    expect(row.name).toBe('Netflix')
  })

  it('creates the type registry a database of this age has never heard of', async () => {
    const before = sqlite.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sub_type'`)
      .get() as { n: number }
    expect(before.n).toBe(0)
    await boot()
    expect(columnsOf(sqlite, 'sub_type')).toEqual(['user_id', 'name', 'icon', 'color', 'created_at'])
  })

  it('settles into the same shape twice, so a second boot changes nothing', async () => {
    await boot()
    const first = ['sub_category', 'sub_settings', 'sub_item', 'sub_type'].map((table) => columnsOf(sqlite, table))
    await boot()
    const second = ['sub_category', 'sub_settings', 'sub_item', 'sub_type'].map((table) => columnsOf(sqlite, table))
    expect(second).toEqual(first)
    const versions = sqlite.prepare(`SELECT version FROM schema_migrations WHERE version BETWEEN 110 AND 114`)
      .all() as Array<{ version: number }>
    expect(versions).toHaveLength(5)
  })
})
