// @vitest-environment node
/**
 * The one-shot move from the single reminder columns to `todos_reminders`, and the boot that drops
 * the columns once the move has landed.
 *
 * What is pinned: every legacy `remind_at` becomes one row with the instant it named, an already
 * announced reminder keeps that fact (`fired_at`), a second boot has nothing left to do, and a boot
 * that cannot land the rows stops with the old columns untouched rather than losing the reminder.
 *
 * The second half is the order those two facts depend on. `todos_tasks.remind_at` and `reminded_at`
 * are superseded columns, and migration 155 takes them away — so a boot that dropped them before the
 * move would delete a pending alarm out of the only place it was written. The failure case below is
 * therefore about the columns as much as about the rows: the move has to land first, and after 155 has
 * run the repair must be able to look at a table that no longer has either column and say "nothing to
 * do" rather than fail on a statement nothing can satisfy twice.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase, SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { TODOS_REQUIRED_COLUMNS, TODOS_REQUIRED_INDEXES } from '../src/worker/todos/schema'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = '0123456789abcdefghjkmnpqrs'
const TASK = '0123456789abcdefghjkmnpqrt'
const REMIND_AT = Date.parse('2026-10-20T09:00:00Z')
const REMINDED_AT = Date.parse('2026-10-19T08:00:00Z')
/** The version that takes the two superseded columns away. */
const DROP_VERSION = 155

/**
 * A database as the accounts that set reminders before `todos_reminders` exists have it: both columns
 * on the task table, the partial index over them, and a ledger that has never seen 155.
 */
function database(options: { withIndex?: boolean } = {}): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.exec('ALTER TABLE todos_tasks ADD COLUMN remind_at INTEGER')
  sqlite.exec('ALTER TABLE todos_tasks ADD COLUMN reminded_at INTEGER')
  // The index the old sweep read, partial over the column the old code wrote: the one thing that makes
  // `DROP COLUMN` fail, which is why the migration takes it down first. A database whose index was
  // dropped by hand leaves it out, and the same three statements have to survive that too.
  if (options.withIndex !== false) {
    sqlite.exec('CREATE INDEX idx_todos_tasks_remind ON todos_tasks(remind_at) WHERE remind_at IS NOT NULL')
  }
  return sqlite
}

/** A task written the way the old code wrote it: one instant on the row, maybe already announced. */
function seedLegacy(sqlite: DatabaseSync, options: { remindAt?: number | null; remindedAt?: number | null } = {}): void {
  const remindAt = Object.hasOwn(options, 'remindAt') ? options.remindAt ?? null : REMIND_AT
  sqlite.prepare(
    `INSERT INTO todos_tasks (user_id, id, title, created_at, updated_at, remind_at, reminded_at)
     VALUES (?1, ?2, 'File the return', ?3, ?3, ?4, ?5)`,
  ).run(USER, TASK, Date.parse('2026-10-01T00:00:00Z'), remindAt, options.remindedAt ?? null)
}

function reminderRows(sqlite: DatabaseSync): { task_id: string; remind_at: number; fired_at: number | null }[] {
  return sqlite.prepare(`SELECT task_id, remind_at, fired_at FROM todos_reminders ORDER BY remind_at`).all() as {
    task_id: string
    remind_at: number
    fired_at: number | null
  }[]
}

function columnNames(sqlite: DatabaseSync, table: string): string[] {
  return sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table)
    .map((row) => (row as { name: string }).name)
}

function indexNames(sqlite: DatabaseSync): string[] {
  return sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all()
    .map((row) => (row as { name: string }).name)
}

/** The two superseded columns, while they are still on the table. */
function legacyColumns(sqlite: DatabaseSync): { remind_at: number | null; reminded_at: number | null } | null {
  const columns = columnNames(sqlite, 'todos_tasks')
  if (!columns.includes('remind_at') || !columns.includes('reminded_at')) return null
  return sqlite.prepare(`SELECT remind_at, reminded_at FROM todos_tasks WHERE id = ?1`).get(TASK) as {
    remind_at: number | null
    reminded_at: number | null
  }
}

/** The stored fingerprint would short-circuit a real reboot; clearing it walks every repair again. */
async function reboot(sqlite: DatabaseSync): Promise<void> {
  sqlite.prepare(`DELETE FROM app_meta WHERE key = 'database-state-v1'`).run()
  await initializeDatabase(testBindings(makeD1(sqlite)))
}

describe('the reminder table migration', () => {
  it('moves the old single reminder into the table and keeps its announced fact', async () => {
    const sqlite = database()
    seedLegacy(sqlite, { remindedAt: REMINDED_AT })

    await initializeDatabase(testBindings(makeD1(sqlite)))

    expect(reminderRows(sqlite)).toEqual([{ task_id: TASK, remind_at: REMIND_AT, fired_at: REMINDED_AT }])
  })

  it('drops both columns and their index once the reminder has been moved', async () => {
    const sqlite = database()
    seedLegacy(sqlite, { remindedAt: REMINDED_AT })

    await initializeDatabase(testBindings(makeD1(sqlite)))

    expect(columnNames(sqlite, 'todos_tasks')).not.toContain('remind_at')
    expect(columnNames(sqlite, 'todos_tasks')).not.toContain('reminded_at')
    expect(indexNames(sqlite)).not.toContain('idx_todos_tasks_remind')
    expect(sqlite.prepare(`SELECT version FROM schema_migrations WHERE version = ?1`).all(DROP_VERSION))
      .toEqual([{ version: DROP_VERSION }])
    // The declared shape and the real one agree, which is what `assertFinalSchema` insists on: a list
    // that still named a dropped column would have stopped the boot above, not this assertion.
    expect(columnNames(sqlite, 'todos_tasks').sort()).toEqual([...TODOS_REQUIRED_COLUMNS.todos_tasks].sort())
    expect(TODOS_REQUIRED_COLUMNS.todos_tasks).not.toContain('remind_at')
    expect(TODOS_REQUIRED_INDEXES).not.toContain('idx_todos_tasks_remind')
  })

  it('keeps the old columns and writes nothing when the move cannot land', async () => {
    const sqlite = database()
    seedLegacy(sqlite)
    sqlite.exec(`CREATE TRIGGER refuse_reminder BEFORE INSERT ON todos_reminders
                 BEGIN SELECT RAISE(ABORT, 'the reminder table is closed'); END`)

    await expect(initializeDatabase(testBindings(makeD1(sqlite)))).rejects.toThrow()

    // The batch is one transaction: the row the insert would have landed never exists, and the
    // columns the old code wrote are still there for the next boot to try again. Dropping them first
    // would have deleted the reminder instead.
    expect(reminderRows(sqlite)).toEqual([])
    expect(legacyColumns(sqlite)).toEqual({ remind_at: REMIND_AT, reminded_at: null })
    expect(indexNames(sqlite)).toContain('idx_todos_tasks_remind')
  })

  it('has nothing left to do on a second boot, with or without the columns', async () => {
    const sqlite = database()
    seedLegacy(sqlite)

    await initializeDatabase(testBindings(makeD1(sqlite)))
    await reboot(sqlite)

    expect(reminderRows(sqlite)).toEqual([{ task_id: TASK, remind_at: REMIND_AT, fired_at: null }])
    expect(legacyColumns(sqlite)).toBeNull()
  })

  it('leaves a task with no reminder alone', async () => {
    const sqlite = database()
    seedLegacy(sqlite, { remindAt: null })

    await initializeDatabase(testBindings(makeD1(sqlite)))

    expect(reminderRows(sqlite)).toEqual([])
  })
})

/**
 * The migration that removes them is a `DROP`, not an `ADD`, so the guard the ledger already knows how
 * to ask about cannot be the one that protects it: a fresh database has neither column and would fail
 * `ALTER TABLE … DROP COLUMN` on its first boot. Both halves are pinned here.
 */
describe('the migration that drops the superseded columns', () => {
  function dropMigration(): { statements: readonly string[] } {
    const found = SCHEMA_MIGRATIONS.find((migration) => migration.version === DROP_VERSION)
    if (!found) throw new Error(`the ledger holds no version ${DROP_VERSION}`)
    return found
  }

  it('runs the index down before either column', () => {
    const order = dropMigration().statements.map((statement) => statement.replace(/\s+/g, ' ').trim())
    expect(order).toEqual([
      'DROP INDEX IF EXISTS idx_todos_tasks_remind',
      'ALTER TABLE todos_tasks DROP COLUMN remind_at',
      'ALTER TABLE todos_tasks DROP COLUMN reminded_at',
    ])
  })

  it('is skipped on a database that never had the columns', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')
    sqlite.exec(SCHEMA_STATEMENTS.join(';'))

    await initializeDatabase(testBindings(makeD1(sqlite)))

    expect(sqlite.prepare(`SELECT version FROM schema_migrations WHERE version = ?1`).all(DROP_VERSION))
      .toEqual([{ version: DROP_VERSION }])
    expect(columnNames(sqlite, 'todos_tasks')).not.toContain('remind_at')
  })

  it('drops the columns on an old database whose index is already gone', async () => {
    // `DROP INDEX IF EXISTS` is the whole answer here, but the case is the one the boot guard would
    // otherwise meet with an error: a database holding the pair and no index over either.
    const sqlite = database({ withIndex: false })
    seedLegacy(sqlite)

    await initializeDatabase(testBindings(makeD1(sqlite)))

    expect(reminderRows(sqlite)).toEqual([{ task_id: TASK, remind_at: REMIND_AT, fired_at: null }])
    expect(columnNames(sqlite, 'todos_tasks')).not.toContain('remind_at')
    expect(columnNames(sqlite, 'todos_tasks')).not.toContain('reminded_at')
    expect(sqlite.prepare(`SELECT version FROM schema_migrations WHERE version = ?1`).all(DROP_VERSION))
      .toEqual([{ version: DROP_VERSION }])
  })
})
