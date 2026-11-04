// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import {
  TODOS_REQUIRED_COLUMNS,
  TODOS_REQUIRED_INDEXES,
  TODOS_REQUIRED_TABLES,
} from '../src/worker/todos/schema'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const NEW_VERSIONS = [273, 274, 275]

function columnsOf(sqlite: DatabaseSync, table: string): string[] {
  return sqlite.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => (row as { name: string }).name)
}

function tablesOf(sqlite: DatabaseSync): string[] {
  return sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((row) => (row as { name: string }).name)
}

function indexesOf(sqlite: DatabaseSync): string[] {
  return sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map((row) => (row as { name: string }).name)
}

function migrationsOf(sqlite: DatabaseSync): number[] {
  return sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => (row as { version: number }).version)
}

async function boot(sqlite: DatabaseSync): Promise<void> {
  await initializeDatabase(testBindings(makeD1(sqlite)))
}

async function reboot(sqlite: DatabaseSync): Promise<void> {
  sqlite.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
  await boot(sqlite)
}

async function installed(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  await boot(sqlite)
  return sqlite
}

describe('the matrix columns and focus history', () => {
  it('exist on a fresh database and are demanded by the boot', async () => {
    const sqlite = await installed()

    expect(columnsOf(sqlite, 'todos_tasks')).toContain('matrix_important')
    expect(columnsOf(sqlite, 'todos_tasks')).toContain('matrix_urgent')
    expect(TODOS_REQUIRED_COLUMNS.todos_tasks).toContain('matrix_important')
    expect(TODOS_REQUIRED_COLUMNS.todos_tasks).toContain('matrix_urgent')

    expect(tablesOf(sqlite)).toContain('todos_focus_runs')
    expect(TODOS_REQUIRED_TABLES).toContain('todos_focus_runs')
    expect(TODOS_REQUIRED_COLUMNS.todos_focus_runs).toEqual(columnsOf(sqlite, 'todos_focus_runs'))
    for (const index of ['idx_todos_focus_day', 'idx_todos_focus_task']) {
      expect(indexesOf(sqlite)).toContain(index)
      expect(TODOS_REQUIRED_INDEXES).toContain(index)
    }
    for (const version of NEW_VERSIONS) expect(migrationsOf(sqlite)).toContain(version)
  })

  it('restores the shape on a database whose ledger has the numbers but not the work', async () => {
    const sqlite = await installed()
    sqlite.exec(`INSERT INTO todos_tasks
      (user_id, id, title, status, priority, created_at, updated_at)
      VALUES ('u1', 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Keep me', 'todo', 'high', 1, 1)`)
    sqlite.exec('ALTER TABLE todos_tasks DROP COLUMN matrix_important')
    sqlite.exec('ALTER TABLE todos_tasks DROP COLUMN matrix_urgent')
    sqlite.exec('DROP TABLE todos_focus_runs')
    sqlite.exec('DELETE FROM schema_migrations WHERE version IN (273, 274, 275)')

    await reboot(sqlite)

    expect(columnsOf(sqlite, 'todos_tasks')).toContain('matrix_important')
    expect(columnsOf(sqlite, 'todos_tasks')).toContain('matrix_urgent')
    expect(tablesOf(sqlite)).toContain('todos_focus_runs')
    expect(sqlite.prepare(`SELECT title, matrix_important, matrix_urgent FROM todos_tasks WHERE id = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'`).get())
      .toEqual({ title: 'Keep me', matrix_important: null, matrix_urgent: null })
  })

  it('leaves rows and the ledger identical when the migrations run a second time', async () => {
    const sqlite = await installed()
    sqlite.exec(`INSERT INTO todos_tasks
      (user_id, id, title, status, priority, matrix_important, matrix_urgent, created_at, created_on, updated_at)
      VALUES ('u1', 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Important, not urgent', 'todo', 'high', 1, 0, 1, '2026-11-05', 1)`)
    sqlite.exec(`INSERT INTO todos_focus_runs
      (user_id, id, task_id, kind, started_at, ended_at, planned_ms, actual_ms, completed, day, created_at)
      VALUES ('u1', 'bbbbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'work', 1, 1, 1, 1, 1, '2026-11-05', 1)`)

    const beforeTask = sqlite.prepare(`SELECT * FROM todos_tasks WHERE id = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'`).get()
    const beforeFocus = sqlite.prepare(`SELECT * FROM todos_focus_runs WHERE id = 'bbbbbbbbbbbbbbbbbbbbbbbbbb'`).get()
    const beforeMigrations = migrationsOf(sqlite)

    await reboot(sqlite)

    expect(sqlite.prepare(`SELECT * FROM todos_tasks WHERE id = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'`).get()).toEqual(beforeTask)
    expect(sqlite.prepare(`SELECT * FROM todos_focus_runs WHERE id = 'bbbbbbbbbbbbbbbbbbbbbbbbbb'`).get()).toEqual(beforeFocus)
    expect(migrationsOf(sqlite)).toEqual(beforeMigrations)
    expect(migrationsOf(sqlite).filter((version) => NEW_VERSIONS.includes(version))).toHaveLength(NEW_VERSIONS.length)
  })
})
