// @vitest-environment node
/**
 * What a status change owes the event table, and what only a purge takes back.
 *
 * The table is the app's own history, so the rule is one event per real transition, written in the
 * same batch as the row it explains: a completed task whose completion event was lost would replay
 * as work that vanished from the flow. What is pinned here: the birth a task opens with, the three
 * transitions a reader actually makes, the silence of a patch that names the status the row already
 * has, the next occurrence's own birth, the trash's promise to keep the history, and the purge's
 * promise to take it.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = 'user-alice'

interface TaskEventRow {
  kind: string
  from_status: string | null
  to_status: string
  at: number
  on_day: string
}

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  // MEMORY, not the house's usual OFF: the atomicity test below leans on a batch's ROLLBACK,
  // and journal_mode OFF writes no journal for the rollback to undo. MEMORY is this database's
  // default mode anyway, so the one test that needs a real transaction costs nothing.
  sqlite.exec('PRAGMA journal_mode = MEMORY')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
})

/** The instants and days the row itself records, which is what the events are checked against. */
function taskRow(id: string): {
  status: string
  created_at: number
  created_on: string
  completed_at: number | null
  completed_on: string | null
  updated_at: number
} {
  return sqlite.prepare(
    `SELECT status, created_at, created_on, completed_at, completed_on, updated_at FROM todos_tasks WHERE id = ?`,
  ).get(id) as ReturnType<typeof taskRow>
}

function eventsOf(taskId: string): TaskEventRow[] {
  return sqlite.prepare(
    `SELECT kind, from_status, to_status, at, on_day FROM todos_task_events
      WHERE task_id = ?1 ORDER BY at, kind`,
  ).all(taskId) as unknown as TaskEventRow[]
}

/** `localDate(instant, 'UTC')` for the zone every write here names. */
function utcDay(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10)
}

describe("a task's birth", () => {
  it('is recorded with the instant and the day the row was written under', async () => {
    const task = await store.createTask({ title: 'File the return' }, 'UTC')
    const row = taskRow(task.id)

    expect(eventsOf(task.id)).toEqual([
      { kind: 'born', from_status: null, to_status: 'todo', at: row.created_at, on_day: row.created_on },
    ])
  })

  it('carries the status it was born in when a task is logged already finished', async () => {
    const task = await store.createTask({ title: 'Already done', status: 'done' }, 'UTC')
    const row = taskRow(task.id)

    expect(eventsOf(task.id)).toEqual([
      { kind: 'born', from_status: null, to_status: 'done', at: row.created_at, on_day: row.created_on },
    ])
  })
})

describe('a status change', () => {
  it('records one event per transition, on the instant the row records', async () => {
    const task = await store.createTask({ title: 'Ship it' }, 'UTC')
    const born = taskRow(task.id)

    await store.updateTask(task.id, { status: 'in_progress' }, 'UTC')
    const started = taskRow(task.id)

    // Finished through `completeTask`, the one door that writes a completion; the patch refuses it.
    await store.completeTask(task.id, 'UTC')
    const done = taskRow(task.id)

    await store.updateTask(task.id, { status: 'todo' }, 'UTC')
    const reopened = taskRow(task.id)

    expect(eventsOf(task.id)).toEqual([
      { kind: 'born', from_status: null, to_status: 'todo', at: born.created_at, on_day: born.created_on },
      { kind: 'status', from_status: 'todo', to_status: 'in_progress', at: started.updated_at, on_day: utcDay(started.updated_at) },
      { kind: 'status', from_status: 'in_progress', to_status: 'done', at: done.completed_at, on_day: done.completed_on },
      { kind: 'status', from_status: 'done', to_status: 'todo', at: reopened.updated_at, on_day: utcDay(reopened.updated_at) },
    ])
  })

  it('records nothing when the patch names the status the row already has', async () => {
    const task = await store.createTask({ title: 'Still open' }, 'UTC')

    const same = await store.updateTask(task.id, { status: 'todo' }, 'UTC')

    expect(same?.status).toBe('todo')
    // The birth alone: a patch that moved nothing owes the history nothing.
    expect(eventsOf(task.id)).toHaveLength(1)
  })

  it('leaves no task behind when its birth cannot be recorded', async () => {
    sqlite.exec(`CREATE TRIGGER refuse_events BEFORE INSERT ON todos_task_events
                 BEGIN SELECT RAISE(ABORT, 'the event table is closed'); END`)

    await expect(store.createTask({ title: 'Never' }, 'UTC')).rejects.toThrow()

    // One batch, one transaction: the row and its history arrive together or not at all.
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM todos_tasks`).get()).toEqual({ n: 0 })
  })
})

describe('a repeating task', () => {
  it('opens the next occurrence with a birth of its own', async () => {
    const task = await store.createTask({
      title: 'Weekly report',
      dueAt: Date.parse('2026-10-20T09:00:00Z'),
      repeat: { freq: 'weekly', interval: 1 },
    }, 'UTC')

    const done = await store.completeTask(task.id, 'UTC')

    expect(done?.next).toBeTruthy()
    const row = taskRow(done!.next!.id)
    expect(eventsOf(done!.next!.id)).toEqual([
      { kind: 'born', from_status: null, to_status: 'todo', at: row.created_at, on_day: row.created_on },
    ])
    // And the row it was copied from keeps both of its own events.
    expect(eventsOf(task.id)).toHaveLength(2)
  })
})

describe('the trash and the purge', () => {
  it('keeps the history through the trash and takes it only on a purge', async () => {
    const task = await store.createTask({ title: 'Filed away' }, 'UTC')
    await store.completeTask(task.id, 'UTC')

    await store.deleteTask(task.id)
    // A trashed task still happened: the history stays for the day it comes back.
    expect(eventsOf(task.id)).toHaveLength(2)

    await store.purgeTask(task.id)
    expect(eventsOf(task.id)).toEqual([])
  })

  it('keeps a restored task’s history when a stale id reaches the purge', async () => {
    const task = await store.createTask({ title: 'Restored mid-purge' }, 'UTC')
    await store.completeTask(task.id, 'UTC')
    await store.deleteTask(task.id)

    // The race the trash predicate exists for: the purge reads a trashed row, and a restore lands
    // before its batch runs. The task delete refuses the stale id; the history delete must refuse
    // it too, or the task would come back with its past erased.
    const base = env.DB as D1Database
    let restored = false
    const racing = {
      ...base,
      async batch(statements: D1PreparedStatement[]) {
        if (!restored) {
          restored = true
          sqlite.prepare(`UPDATE todos_tasks SET deleted_at = NULL WHERE id = ?`).run(task.id)
        }
        return base.batch(statements)
      },
    } as unknown as D1Database

    await new AssistantStore(racing, USER, env).purgeTask(task.id)

    const row = sqlite.prepare(`SELECT deleted_at FROM todos_tasks WHERE id = ?`).get(task.id) as {
      deleted_at: number | null
    }
    expect(row.deleted_at).toBeNull()
    expect(eventsOf(task.id)).toHaveLength(2)
  })
})
