// @vitest-environment node
/**
 * The one-shot backfill that seeds `todos_task_events` from the tasks a database already holds.
 *
 * What is pinned: every task gets the birth it never had recorded, a completion is filed only for
 * the tasks that are done now (the ones that were reopened before the table existed leave no trace
 * to reconstruct, which is the approximation the flow chart's `trackedSince` line exists to say),
 * a second boot has nothing left to write, a partly filled table is completed rather than doubled,
 * and a boot that cannot land the rows stops with the tasks untouched.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { initializeDatabase, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { computeTodoFlow } from '../src/worker/todos/stats'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = '0123456789abcdefghjkmnpqrs'
const DONE = '0123456789abcdefghjkmnpqrt'
const TODO = '0123456789abcdefghjkmnpqrv'
const RUNNING = '0123456789abcdefghjkmnpqrw'
const CREATED_AT = Date.parse('2026-10-01T00:00:00Z')
const COMPLETED_AT = Date.parse('2026-10-02T09:00:00Z')

/** A database with the whole current schema — the shape a deploy lands its code on. */
function database(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  return sqlite
}

/**
 * Tasks written the way the old code wrote them: no history at all, the day columns already filed
 * under the account's zone. The event table is then dropped, which is the database this backfill
 * exists for — one built before the table did.
 */
function seedLegacyTasks(sqlite: DatabaseSync): void {
  const rows: [string, string, string, number | null, string | null][] = [
    [DONE, 'done', '2026-10-01', COMPLETED_AT, '2026-10-02'],
    [TODO, 'todo', '2026-10-03', null, null],
    [RUNNING, 'in_progress', '2026-10-04', null, null],
  ]
  for (const [id, status, createdOn, completedAt, completedOn] of rows) {
    sqlite.prepare(
      `INSERT INTO todos_tasks (user_id, id, title, status, created_at, updated_at, created_on, completed_at, completed_on)
       VALUES (?1, ?2, ?2, ?3, ?4, ?4, ?5, ?6, ?7)`,
    ).run(USER, id, status, CREATED_AT, createdOn, completedAt, completedOn)
  }
  sqlite.exec('DROP TABLE todos_task_events')
}

function eventRows(sqlite: DatabaseSync, taskId: string): {
  kind: string
  from_status: string | null
  to_status: string
  at: number
  on_day: string
  id: string
}[] {
  return sqlite.prepare(
    `SELECT kind, from_status, to_status, at, on_day, id FROM todos_task_events
      WHERE task_id = ?1 ORDER BY at, kind`,
  ).all(taskId) as {
    kind: string
    from_status: string | null
    to_status: string
    at: number
    on_day: string
    id: string
  }[]
}

describe('the task event backfill', () => {
  it('creates the task index before probing the event table', async () => {
    const sqlite = database()
    seedLegacyTasks(sqlite)
    const statements: string[] = []
    const inner = makeD1(sqlite)
    const db = {
      ...inner,
      prepare(sql: string) {
        statements.push(sql)
        return inner.prepare(sql)
      },
    } as D1Database

    await initializeDatabase(testBindings(db))

    // Each "has this task a birth" answer is a lookup only once the index exists; prepared before
    // it, the same question walks the whole history for every task.
    const indexAt = statements.findIndex((sql) =>
      sql.includes('CREATE INDEX IF NOT EXISTS idx_todos_task_events_task'))
    const probeAt = statements.findIndex((sql) => sql.includes('FROM todos_task_events e'))
    expect(indexAt).toBeGreaterThanOrEqual(0)
    expect(probeAt).toBeGreaterThan(indexAt)
  })

  it('files every task its birth and a completion for the ones done now', async () => {
    const sqlite = database()
    seedLegacyTasks(sqlite)

    await initializeDatabase(testBindings(makeD1(sqlite)))

    expect(eventRows(sqlite, DONE)).toEqual([
      { kind: 'born', from_status: null, to_status: 'todo', at: CREATED_AT, on_day: '2026-10-01', id: expect.stringMatching(/^[0-9a-f]{26}$/) },
      { kind: 'status', from_status: 'todo', to_status: 'done', at: COMPLETED_AT, on_day: '2026-10-02', id: expect.stringMatching(/^[0-9a-f]{26}$/) },
    ])
    // A task that is open now gets only its birth, filed as todo: the birth is the one event the
    // table can state without guessing, and a birth that carried a later status would be counted
    // twice once the transition beside it replays.
    expect(eventRows(sqlite, TODO)).toEqual([
      { kind: 'born', from_status: null, to_status: 'todo', at: CREATED_AT, on_day: '2026-10-03', id: expect.stringMatching(/^[0-9a-f]{26}$/) },
    ])
    expect(eventRows(sqlite, RUNNING)).toEqual([
      { kind: 'born', from_status: null, to_status: 'todo', at: CREATED_AT, on_day: '2026-10-04', id: expect.stringMatching(/^[0-9a-f]{26}$/) },
    ])
  })

  it('replays a finished task as one, not as a birth and a completion added together', async () => {
    const sqlite = database()
    seedLegacyTasks(sqlite)
    await initializeDatabase(testBindings(makeD1(sqlite)))

    // The bug this pins: a birth filed under `done` plus the completion beside it would put two
    // finished tasks on the chart for one row. The seed is zero, so the replay is the whole story.
    const events = eventRows(sqlite, DONE).map((row) => ({
      kind: row.kind === 'born' ? 'born' as const : 'status' as const,
      fromStatus: row.from_status as 'todo' | 'done' | null,
      toStatus: row.to_status as 'todo' | 'done',
      at: row.at,
      onDay: row.on_day,
    }))
    const points = computeTodoFlow(
      { createdBefore: 0, doneBefore: 0, cancelledBefore: 0, inProgressNow: 0 },
      events,
      { from: '2026-10-01', to: '2026-10-02', bucket: 'day' },
    )

    expect(points.at(-1)).toEqual({ day: '2026-10-02', todo: 0, inProgress: 0, done: 1 })
  })

  it('has nothing left to write on a second boot, and says nothing while finding out', async () => {
    const sqlite = database()
    seedLegacyTasks(sqlite)
    await initializeDatabase(testBindings(makeD1(sqlite)))
    const before = eventRows(sqlite, DONE)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The stored fingerprint would short-circuit a real reboot; clearing it makes this second
      // boot walk every repair again, which is the no-op that has to hold.
      sqlite.prepare(`DELETE FROM app_meta WHERE key = 'database-state-v1'`).run()
      await initializeDatabase(testBindings(makeD1(sqlite)))
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('Schema repair'))).toEqual([])
    } finally {
      warn.mockRestore()
    }

    expect(eventRows(sqlite, DONE)).toEqual(before)
  })

  it('completes a table a previous boot only partly filled, instead of doubling it', async () => {
    const sqlite = database()
    // A boot that died between the two inserts — or a restore that carried some rows — leaves the
    // birth of one task behind. The guard is per row, so the rest still arrives exactly once.
    const kept = '0123456789abcdefghjkmnpqrx'
    sqlite.prepare(
      `INSERT INTO todos_tasks (user_id, id, title, status, created_at, updated_at, created_on, completed_at, completed_on)
       VALUES (?1, ?2, 'Done once', 'done', ?3, ?3, '2026-10-01', ?4, '2026-10-02')`,
    ).run(USER, DONE, CREATED_AT, COMPLETED_AT)
    sqlite.prepare(
      `INSERT INTO todos_task_events (user_id, id, task_id, at, on_day, kind, from_status, to_status)
       VALUES (?1, ?2, ?3, ?4, '2026-10-01', 'born', NULL, 'todo')`,
    ).run(USER, kept, DONE, CREATED_AT)

    await initializeDatabase(testBindings(makeD1(sqlite)))

    const rows = eventRows(sqlite, DONE)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.id).toBe(kept)
    expect(rows[1]).toMatchObject({ kind: 'status', from_status: 'todo', to_status: 'done' })
  })

  it('writes nothing and stops the boot when the insert cannot land', async () => {
    const sqlite = database()
    sqlite.prepare(
      `INSERT INTO todos_tasks (user_id, id, title, status, created_at, updated_at, created_on, completed_at, completed_on)
       VALUES (?1, ?2, 'Done once', 'done', ?3, ?3, '2026-10-01', ?4, '2026-10-02')`,
    ).run(USER, DONE, CREATED_AT, COMPLETED_AT)
    sqlite.exec(`CREATE TRIGGER refuse_events BEFORE INSERT ON todos_task_events
                 BEGIN SELECT RAISE(ABORT, 'the event table is closed'); END`)

    await expect(initializeDatabase(testBindings(makeD1(sqlite)))).rejects.toThrow()

    // The batch is one transaction: no event half-landed, and the task is exactly as the old code
    // left it for the next boot to read again.
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM todos_task_events`).get()).toEqual({ n: 0 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM todos_tasks`).get()).toEqual({ n: 1 })
  })
})
