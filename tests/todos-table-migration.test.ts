// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import { TODOS_REQUIRED_COLUMNS, TODOS_REQUIRED_INDEXES } from '../src/worker/todos/schema'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

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
  await initializeDatabase(testBindings(makeD1(sqlite)))
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

/**
 * The two orders the list gained, `sort=created` and `sort=completed`, read `created_at` and
 * `completed_at`; without an index leading with the account, a large shelf sorts in full on every page.
 * The index has to exist on a fresh install and be demanded by the boot, or the next schema drift
 * would silently take it back.
 */
describe('the sort indexes', () => {
  function indexedColumns(sqlite: DatabaseSync, index: string): string[] {
    return sqlite.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`).all(index)
      .map((row) => (row as { name: string }).name)
  }

  it('creates both on a fresh database and lists them as required', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')

    await boot(sqlite)

    expect(indexedColumns(sqlite, 'idx_todos_tasks_created')).toEqual(['user_id', 'created_at'])
    expect(indexedColumns(sqlite, 'idx_todos_tasks_completed')).toEqual(['user_id', 'completed_at'])
    expect(TODOS_REQUIRED_INDEXES).toContain('idx_todos_tasks_created')
    expect(TODOS_REQUIRED_INDEXES).toContain('idx_todos_tasks_completed')
  })
})

/**
 * The row version a guarded edit names. A fresh install has to create it and the boot has to demand
 * it, or a database that never got the column would serve edits no guard could see.
 */
describe('the task row version', () => {
  it('is created by a fresh boot and listed as required', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')

    await boot(sqlite)

    const columns = sqlite.prepare(`SELECT name FROM pragma_table_info('todos_tasks')`).all()
      .map((row) => (row as { name: string }).name)
    expect(columns).toContain('rev')
    expect(TODOS_REQUIRED_COLUMNS.todos_tasks).toContain('rev')
  })
})

/**
 * The day a task may begin. A fresh install creates it and the boot demands it; a database built
 * before the column existed gets it from version 123 and records that number, so the next boot does
 * not replay the statement.
 */
describe('the task start date', () => {
  it('is created by a fresh boot and listed as required', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')

    await boot(sqlite)

    const columns = sqlite.prepare(`SELECT name FROM pragma_table_info('todos_tasks')`).all()
      .map((row) => (row as { name: string }).name)
    expect(columns).toContain('start_at')
    expect(TODOS_REQUIRED_COLUMNS.todos_tasks).toContain('start_at')
  })

  it('arrives under version 123 on a database that predates it', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')
    await boot(sqlite)
    sqlite.exec('ALTER TABLE todos_tasks DROP COLUMN start_at')
    sqlite.exec('DELETE FROM schema_migrations WHERE version = 123')

    await reboot(sqlite)

    const columns = sqlite.prepare(`SELECT name FROM pragma_table_info('todos_tasks')`).all()
      .map((row) => (row as { name: string }).name)
    expect(columns).toContain('start_at')
    expect(sqlite.prepare(`SELECT version FROM schema_migrations WHERE version = 123`).all())
      .toEqual([{ version: 123 }])
  })
})
