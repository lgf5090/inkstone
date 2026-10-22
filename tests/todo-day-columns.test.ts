// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS, initializeDatabase } from '../src/worker/db/schema'
import { TODOS_REQUIRED_COLUMNS, TODOS_REQUIRED_INDEXES } from '../src/worker/todos/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { normalizeAssistantSettings } from '@shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * The two day columns the statistics stand on.
 *
 * `created_on` / `completed_on` hold the reader's calendar day (`YYYY-MM-DD`), not a UTC date derived
 * when the statistics run: a fixed offset drifts across DST and files a task under the wrong day.
 * These tests pin the shape a fresh database gets, the backfill that gives older rows a day, the
 * cross-zone and DST readings that motivated the columns, and the refusal to leave a half-filled
 * table when a row cannot be dated.
 */

const USER = 'user-alice'
const OTHER = 'user-bob'

function columnsOf(sqlite: DatabaseSync, table: string): string[] {
  return sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table)
    .map((row) => (row as { name: string }).name)
}

function indexesOf(sqlite: DatabaseSync): string[] {
  return sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all()
    .map((row) => (row as { name: string }).name)
}

async function boot(sqlite: DatabaseSync): Promise<void> {
  await initializeDatabase(testBindings(makeD1(sqlite)))
}

/** A boot whose stored fingerprint still matches returns early, so a reboot drops that note first. */
async function reboot(sqlite: DatabaseSync): Promise<void> {
  sqlite.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
  await boot(sqlite)
}

/**
 * A database built before the day columns: the columns and their index are dropped, and the ledger
 * entries that would have skipped their migration are removed — the shape a deploy from before S1
 * lands on.
 */
async function legacyDatabase(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  await boot(sqlite)
  sqlite.exec('DROP INDEX idx_todos_tasks_completed_on')
  sqlite.exec('ALTER TABLE todos_tasks DROP COLUMN created_on')
  sqlite.exec('ALTER TABLE todos_tasks DROP COLUMN completed_on')
  sqlite.exec('DELETE FROM schema_migrations WHERE version IN (131, 132, 133)')
  sqlite.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
  return sqlite
}

/** The account's stored scheduling zone, as `chat_settings` holds it. */
function seedZone(sqlite: DatabaseSync, userId: string, timezone: string): void {
  sqlite.prepare(`INSERT INTO chat_settings (user_id, config, updated_at) VALUES (?, ?, 1)`)
    .run(userId, JSON.stringify({ timezone }))
}

function seedTask(
  sqlite: DatabaseSync,
  row: {
    user: string
    id: string
    title?: string
    createdAt: number
    completedAt?: number | null
  },
): void {
  sqlite.prepare(
    `INSERT INTO todos_tasks (user_id, id, title, status, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.user,
    row.id,
    row.title ?? row.id,
    row.completedAt === null || row.completedAt === undefined ? 'todo' : 'done',
    row.createdAt,
    row.createdAt,
    row.completedAt ?? null,
  )
}

function dayOf(sqlite: DatabaseSync, id: string): { created_on: string | null, completed_on: string | null } {
  return sqlite.prepare(`SELECT created_on, completed_on FROM todos_tasks WHERE id = ?`).get(id) as {
    created_on: string | null
    completed_on: string | null
  }
}

describe('a fresh database', () => {
  it('carries both day columns and the index the statistics read', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')
    await boot(sqlite)

    const columns = columnsOf(sqlite, 'todos_tasks')
    expect(columns).toContain('created_on')
    expect(columns).toContain('completed_on')
    expect(TODOS_REQUIRED_COLUMNS.todos_tasks).toContain('created_on')
    expect(TODOS_REQUIRED_COLUMNS.todos_tasks).toContain('completed_on')
    expect(indexesOf(sqlite)).toContain('idx_todos_tasks_completed_on')
    expect(TODOS_REQUIRED_INDEXES).toContain('idx_todos_tasks_completed_on')
    const indexed = sqlite.prepare(`SELECT name FROM pragma_index_info('idx_todos_tasks_completed_on') ORDER BY seqno`).all()
      .map((row) => (row as { name: string }).name)
    expect(indexed).toEqual(['user_id', 'completed_on'])
  })
})

describe('backfilling an older database', () => {
  it('adds the columns and files existing rows under the account’s zone', async () => {
    const sqlite = await legacyDatabase()
    seedZone(sqlite, USER, 'Asia/Shanghai')
    seedTask(sqlite, {
      user: USER,
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      createdAt: Date.parse('2026-03-08T04:30:00Z'),
      completedAt: Date.parse('2026-03-08T05:30:00Z'),
    })
    seedTask(sqlite, {
      user: USER,
      id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
      createdAt: Date.parse('2026-03-08T05:30:00Z'),
    })

    await boot(sqlite)

    expect(columnsOf(sqlite, 'todos_tasks')).toEqual(expect.arrayContaining(['created_on', 'completed_on']))
    expect(dayOf(sqlite, 'aaaaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({
      created_on: '2026-03-08',
      completed_on: '2026-03-08',
    })
    expect(dayOf(sqlite, 'bbbbbbbbbbbbbbbbbbbbbbbbbb')).toEqual({
      created_on: '2026-03-08',
      completed_on: null,
    })
  })

  it('fills a second boot with nothing to do, and never rewrites a recorded day', async () => {
    const sqlite = await legacyDatabase()
    seedZone(sqlite, USER, 'Asia/Shanghai')
    seedTask(sqlite, { user: USER, id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', createdAt: Date.parse('2026-03-08T04:30:00Z') })

    await boot(sqlite)
    expect(dayOf(sqlite, 'aaaaaaaaaaaaaaaaaaaaaaaaaa').created_on).toBe('2026-03-08')
    sqlite.exec(`UPDATE todos_tasks SET created_on = '2000-01-01' WHERE id = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'`)

    await reboot(sqlite)

    expect(dayOf(sqlite, 'aaaaaaaaaaaaaaaaaaaaaaaaaa').created_on).toBe('2000-01-01')
  })

  it('reads the same instant as different days in two accounts’ zones', async () => {
    const sqlite = await legacyDatabase()
    seedZone(sqlite, USER, 'Asia/Shanghai')
    seedZone(sqlite, OTHER, 'America/New_York')
    const instant = Date.parse('2026-03-08T04:30:00Z')
    seedTask(sqlite, { user: USER, id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', createdAt: instant, completedAt: instant })
    seedTask(sqlite, { user: OTHER, id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', createdAt: instant, completedAt: instant })

    await boot(sqlite)

    expect(dayOf(sqlite, 'aaaaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({
      created_on: '2026-03-08',
      completed_on: '2026-03-08',
    })
    expect(dayOf(sqlite, 'bbbbbbbbbbbbbbbbbbbbbbbbbb')).toEqual({
      created_on: '2026-03-07',
      completed_on: '2026-03-07',
    })
  })

  it('keeps both sides of a DST boundary on the day the reader lived through', async () => {
    // America/New_York jumps from 02:00 EST to 03:00 EDT on 2026-03-08. Midnight at the start of the
    // day and 23:30 at its end are one local day, even though a fixed offset would put them apart.
    const sqlite = await legacyDatabase()
    seedZone(sqlite, USER, 'America/New_York')
    seedTask(sqlite, { user: USER, id: 'before-jump', createdAt: Date.parse('2026-03-08T05:30:00Z') })
    seedTask(sqlite, { user: USER, id: 'after-jump', createdAt: Date.parse('2026-03-09T03:30:00Z') })

    await boot(sqlite)

    expect(dayOf(sqlite, 'before-jump').created_on).toBe('2026-03-08')
    expect(dayOf(sqlite, 'after-jump').created_on).toBe('2026-03-08')
  })

  it('falls back to UTC for an account with no zone or an unusable one', async () => {
    const sqlite = await legacyDatabase()
    sqlite.prepare(`INSERT INTO chat_settings (user_id, config, updated_at) VALUES (?, ?, 1)`)
      .run(USER, JSON.stringify({ timezone: 'Mars/Shady' }))
    seedTask(sqlite, { user: USER, id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', createdAt: Date.parse('2026-03-08T04:30:00Z') })
    seedTask(sqlite, { user: OTHER, id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', createdAt: Date.parse('2026-03-08T04:30:00Z') })

    await boot(sqlite)

    expect(dayOf(sqlite, 'aaaaaaaaaaaaaaaaaaaaaaaaaa').created_on).toBe('2026-03-08')
    expect(dayOf(sqlite, 'bbbbbbbbbbbbbbbbbbbbbbbbbb').created_on).toBe('2026-03-08')
  })

  it('refuses the boot rather than leaving a half-filled table when a row cannot be dated', async () => {
    const sqlite = await legacyDatabase()
    seedZone(sqlite, USER, 'Asia/Shanghai')
    seedTask(sqlite, { user: USER, id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', createdAt: Date.parse('2026-03-08T04:30:00Z') })
    // A hand-edited or restored row can hold text where the schema expects milliseconds. SQLite's
    // dynamic typing keeps it, and the backfill has to say so instead of writing a day it invented.
    sqlite.prepare(
      `INSERT INTO todos_tasks (user_id, id, title, status, created_at, updated_at) VALUES (?, ?, 'Broken', 'todo', ?, 1)`,
    ).run(USER, 'bbbbbbbbbbbbbbbbbbbbbbbbbb', 'not-a-date')

    await expect(boot(sqlite)).rejects.toThrow(
      /task bbbbbbbbbbbbbbbbbbbbbbbbbb of account user-alice has a timestamp that is not a date/,
    )

    const filled = sqlite.prepare(
      `SELECT COUNT(*) AS n FROM todos_tasks WHERE created_on IS NOT NULL OR completed_on IS NOT NULL`,
    ).get() as { n: number }
    expect(filled.n).toBe(0)
  })
})

describe('writing the day columns', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function storeOn(sqlite: DatabaseSync): AssistantStore {
    const env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
    return new AssistantStore(env.DB, USER, env)
  }

  it('files the created day on create, and both days when a repeating task is completed', async () => {
    // 23:30 on 2026-03-08 in New York: after the spring-forward jump, still the same local day.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-09T03:30:00Z'))
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')
    sqlite.exec(SCHEMA_STATEMENTS.join(';'))
    const store = storeOn(sqlite)
    await store.saveSettings(normalizeAssistantSettings({ timezone: 'America/New_York' }))

    const task = await store.createTask({
      title: 'Weekly report',
      dueAt: Date.parse('2026-03-08T09:00:00Z'),
      repeat: { freq: 'weekly', interval: 1 },
    })
    expect(dayOf(sqlite, task.id)).toEqual({ created_on: '2026-03-08', completed_on: null })

    const result = await store.completeTask(task.id, 'America/New_York')

    expect(dayOf(sqlite, task.id)).toEqual({ created_on: '2026-03-08', completed_on: '2026-03-08' })
    expect(result?.next).not.toBeNull()
    expect(dayOf(sqlite, result!.next!.id)).toEqual({ created_on: '2026-03-08', completed_on: null })
  })

  it('clears the completed day when the reader reopens the task', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')
    sqlite.exec(SCHEMA_STATEMENTS.join(';'))
    const store = storeOn(sqlite)

    const task = await store.createTask({ title: 'One off' })
    await store.completeTask(task.id, 'UTC')
    const reopened = await store.updateTask(task.id, { status: 'todo' }, 'UTC')

    expect(reopened?.status).toBe('todo')
    expect(dayOf(sqlite, task.id).completed_on).toBeNull()
  })
})
