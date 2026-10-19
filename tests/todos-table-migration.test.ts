// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The task table moved from `chat_tasks` to `todos_tasks`.
 *
 * A rename is the one schema change that can destroy data, because the old table has to be dropped
 * for the new name to be the only one. These tests pin the two properties that make it safe: every
 * row lands in the new table, and the old one is only dropped once that has happened.
 */

const LEGACY_TABLE = `CREATE TABLE chat_tasks (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  due_at INTEGER,
  project_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (user_id, id)
)`

function hasTable(sqlite: DatabaseSync, name: string): boolean {
  return Boolean(sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name))
}

function count(sqlite: DatabaseSync, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

function legacyRow(sqlite: DatabaseSync, id: string, title: string, userId = 'user-a'): void {
  sqlite.prepare(
    `INSERT INTO chat_tasks (user_id, id, title, description, status, priority, due_at, project_id, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, '', 'todo', 'high', NULL, NULL, 1, 1, NULL)`,
  ).run(userId, id, title)
}

async function boot(sqlite: DatabaseSync): Promise<void> {
  await initializeDatabase({ DB: makeD1(sqlite) } as never)
}

/** A boot whose stored fingerprint still matches returns early, so a reboot drops that note first. */
async function reboot(sqlite: DatabaseSync): Promise<void> {
  sqlite.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
  await boot(sqlite)
}

describe('moving the task table', () => {
  it('copies an older database’s tasks and drops the old table', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')
    sqlite.exec(LEGACY_TABLE)
    legacyRow(sqlite, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'File the return')
    legacyRow(sqlite, 'bbbbbbbbbbbbbbbbbbbbbbbbbb', 'Call the plumber')
    legacyRow(sqlite, 'cccccccccccccccccccccccccc', 'Book the dentist', 'user-b')

    await boot(sqlite)

    expect(hasTable(sqlite, 'chat_tasks')).toBe(false)
    expect(count(sqlite, 'todos_tasks')).toBe(3)
    const titles = sqlite.prepare(`SELECT title FROM todos_tasks ORDER BY title`).all().map((row) => (row as { title: string }).title)
    expect(titles).toEqual(['Book the dentist', 'Call the plumber', 'File the return'])
  })

  it('keeps the columns the old table did not have at their defaults', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')
    sqlite.exec(LEGACY_TABLE)
    legacyRow(sqlite, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'One task')

    await boot(sqlite)

    const row = sqlite.prepare(`SELECT starred, list_id, repeat_rule, remind_at FROM todos_tasks`).get() as {
      starred: number
      list_id: string | null
      repeat_rule: string | null
      remind_at: number | null
    }
    expect(row).toEqual({ starred: 0, list_id: null, repeat_rule: null, remind_at: null })
  })

  it('is a no-op on a database that has already been moved', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')
    sqlite.exec(LEGACY_TABLE)
    legacyRow(sqlite, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Only once')

    await boot(sqlite)
    await reboot(sqlite)

    expect(hasTable(sqlite, 'chat_tasks')).toBe(false)
    expect(count(sqlite, 'todos_tasks')).toBe(1)
  })

  it('creates the new table empty on a database that never had the old one', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')

    await boot(sqlite)

    expect(hasTable(sqlite, 'chat_tasks')).toBe(false)
    expect(count(sqlite, 'todos_tasks')).toBe(0)
  })
})
