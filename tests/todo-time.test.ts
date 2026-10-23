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

/**
 * R1-1, the time ledger's data layer.
 *
 * The ledger is one row per timed interval, and three rules decide whether it can be trusted: at
 * most one row per account runs at any instant (the partial unique index, not client discipline);
 * a day's total lands on the account's own calendar even across midnight and DST; and the server
 * refuses a client clock that writes an impossible interval rather than clamping it. Every gate
 * here is the ledger's reason for existing, so each one is pinned at the door that must hold it —
 * the schema, the store, the HTTP surface, the sync stream and the backup file.
 */

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

// ---------------------------------------------------------------- the schema

describe('the time entry table', () => {
  async function bootFresh(): Promise<DatabaseSync> {
    const fresh = new DatabaseSync(':memory:')
    fresh.exec('PRAGMA journal_mode = OFF')
    await initializeDatabase(testBindings(makeD1(fresh)))
    return fresh
  }

  it('is created by a fresh boot with its indexes, and listed as required', async () => {
    const fresh = await bootFresh()
    const columns = fresh.prepare(`SELECT name FROM pragma_table_info('todos_time_entries')`).all()
      .map((row) => (row as { name: string }).name)
    expect(columns).toEqual(['user_id', 'id', 'task_id', 'start_at', 'end_at', 'day', 'source', 'created_at', 'updated_at'])
    expect(TODOS_REQUIRED_COLUMNS.todos_time_entries).toEqual(columns)
    expect(TODOS_REQUIRED_TABLES).toContain('todos_time_entries')
    for (const index of ['ux_todos_time_open', 'idx_todos_time_task', 'idx_todos_time_day']) {
      const names = fresh.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all()
        .map((row) => (row as { name: string }).name)
      expect(names).toContain(index)
      expect(TODOS_REQUIRED_INDEXES).toContain(index)
    }
    fresh.close()
  })

  it('permits one open row per account and no more', async () => {
    const fresh = await bootFresh()
    const insert = fresh.prepare(
      `INSERT INTO todos_time_entries (user_id, id, task_id, start_at, end_at, day, source, created_at, updated_at)
       VALUES (?, ?, ?, 1, NULL, '2026-01-09', 'timer', 1, 1)`,
    )
    insert.run(USER, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'task-1')
    expect(() => insert.run(USER, 'bbbbbbbbbbbbbbbbbbbbbbbbbb', 'task-2')).toThrow()
    // Closed rows and other accounts are untouched by the partial predicate.
    expect(() => fresh.prepare(
      `INSERT INTO todos_time_entries (user_id, id, task_id, start_at, end_at, day, source, created_at, updated_at)
       VALUES (?, ?, 'task-1', 2, 3, '2026-01-09', 'timer', 1, 1)`,
    ).run(USER, 'cccccccccccccccccccccccccc')).not.toThrow()
    expect(() => insert.run(OTHER, 'dddddddddddddddddddddddddd', 'task-9')).not.toThrow()
    fresh.close()
  })

  it('carries the estimate column from version 148 on a database that predates it', async () => {
    const fresh = await bootFresh()
    const created = fresh.prepare(`SELECT name FROM pragma_table_info('todos_tasks')`).all()
      .map((row) => (row as { name: string }).name)
    expect(created).toContain('time_estimate_ms')
    expect(TODOS_REQUIRED_COLUMNS.todos_tasks).toContain('time_estimate_ms')

    fresh.exec(`ALTER TABLE todos_tasks DROP COLUMN time_estimate_ms`)
    fresh.exec(`DELETE FROM schema_migrations WHERE version = 148`)
    fresh.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
    await initializeDatabase(testBindings(makeD1(fresh)))

    const after = fresh.prepare(`SELECT name FROM pragma_table_info('todos_tasks')`).all()
      .map((row) => (row as { name: string }).name)
    expect(after).toContain('time_estimate_ms')
    expect(fresh.prepare(`SELECT version FROM schema_migrations WHERE version = 148`).all())
      .toEqual([{ version: 148 }])
    fresh.close()
  })
})
