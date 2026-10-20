// @vitest-environment node
/**
 * The one-shot move from the single reminder columns to `todos_reminders`.
 *
 * What is pinned: every legacy `remind_at` becomes one row with the instant it named, an already
 * announced reminder keeps that fact (`fired_at`), a second boot has nothing left to do, and a boot
 * that cannot land the rows stops with the old columns untouched rather than losing the reminder.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = '0123456789abcdefghjkmnpqrs'
const TASK = '0123456789abcdefghjkmnpqrt'
const REMIND_AT = Date.parse('2026-10-20T09:00:00Z')
const REMINDED_AT = Date.parse('2026-10-19T08:00:00Z')

function database(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  return sqlite
}

/** A task written the way the old code wrote it: one instant on the row, maybe already announced. */
function seedLegacy(sqlite: DatabaseSync, options: { remindAt?: number | null; remindedAt?: number | null } = {}): void {
  sqlite.prepare(
    `INSERT INTO todos_tasks (user_id, id, title, created_at, updated_at, remind_at, reminded_at)
     VALUES (?1, ?2, 'File the return', ?3, ?3, ?4, ?5)`,
  ).run(
    USER, TASK, Date.parse('2026-10-01T00:00:00Z'),
    'remindAt' in options ? options.remindAt : REMIND_AT,
    options.remindedAt ?? null,
  )
}

function reminderRows(sqlite: DatabaseSync): { task_id: string; remind_at: number; fired_at: number | null }[] {
  return sqlite.prepare(`SELECT task_id, remind_at, fired_at FROM todos_reminders ORDER BY remind_at`).all() as {
    task_id: string
    remind_at: number
    fired_at: number | null
  }[]
}

function legacyColumns(sqlite: DatabaseSync): { remind_at: number | null; reminded_at: number | null } {
  return sqlite.prepare(`SELECT remind_at, reminded_at FROM todos_tasks WHERE id = ?1`).get(TASK) as {
    remind_at: number | null
    reminded_at: number | null
  }
}

describe('the reminder table migration', () => {
  it('moves the old single reminder into the table and keeps its announced fact', async () => {
    const sqlite = database()
    seedLegacy(sqlite, { remindedAt: REMINDED_AT })

    await initializeDatabase(testBindings(makeD1(sqlite)))

    expect(reminderRows(sqlite)).toEqual([{ task_id: TASK, remind_at: REMIND_AT, fired_at: REMINDED_AT }])
    expect(legacyColumns(sqlite)).toEqual({ remind_at: null, reminded_at: null })
  })

  it('has nothing left to do on a second boot', async () => {
    const sqlite = database()
    seedLegacy(sqlite)

    await initializeDatabase(testBindings(makeD1(sqlite)))
    // The stored fingerprint would short-circuit a real reboot; clearing it makes this second boot
    // walk every repair again, which is the no-op that has to hold.
    sqlite.prepare(`DELETE FROM app_meta WHERE key = 'database-state-v1'`).run()
    await initializeDatabase(testBindings(makeD1(sqlite)))

    expect(reminderRows(sqlite)).toEqual([{ task_id: TASK, remind_at: REMIND_AT, fired_at: null }])
  })

  it('keeps the old columns and writes nothing when the move cannot land', async () => {
    const sqlite = database()
    seedLegacy(sqlite)
    sqlite.exec(`CREATE TRIGGER refuse_reminder BEFORE INSERT ON todos_reminders
                 BEGIN SELECT RAISE(ABORT, 'the reminder table is closed'); END`)

    await expect(initializeDatabase(testBindings(makeD1(sqlite)))).rejects.toThrow()

    // The batch is one transaction: the row the insert would have landed never exists, and the
    // columns the old code wrote are still there for the next boot to try again.
    expect(reminderRows(sqlite)).toEqual([])
    expect(legacyColumns(sqlite)).toEqual({ remind_at: REMIND_AT, reminded_at: null })
  })

  it('leaves a task with no reminder alone', async () => {
    const sqlite = database()
    seedLegacy(sqlite, { remindAt: null })

    await initializeDatabase(testBindings(makeD1(sqlite)))

    expect(reminderRows(sqlite)).toEqual([])
  })
})
