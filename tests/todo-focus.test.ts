// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import { focusRunProblem, loadFocusStats, recordFocusRun } from '../src/worker/todos/focus'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = 'user-a'
const TASK = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'
const MINUTE = 60_000

async function database(): Promise<D1Database> {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  await initializeDatabase(testBindings(makeD1(sqlite)))
  return makeD1(sqlite)
}

async function withTask(db: D1Database): Promise<void> {
  await db.prepare(
    `INSERT INTO todos_tasks (user_id, id, title, status, priority, created_at, updated_at)
     VALUES (?1, ?2, 'Write the report', 'todo', 'high', 1, 1)`,
  ).bind(USER, TASK).run()
}

describe('the focus history', () => {
  it('records work and breaks and reports them by day and by task', async () => {
    const db = await database()
    await withTask(db)
    const end = Date.UTC(2026, 10, 5, 10, 0, 0)
    const timezone = 'UTC'

    await recordFocusRun(db, USER, {
      taskId: TASK, kind: 'work', startedAt: end - 25 * MINUTE, endedAt: end,
      plannedMs: 25 * MINUTE, actualMs: 25 * MINUTE, completed: true,
    }, timezone)
    await recordFocusRun(db, USER, {
      taskId: TASK, kind: 'short_break', startedAt: end, endedAt: end + 5 * MINUTE,
      plannedMs: 5 * MINUTE, actualMs: 5 * MINUTE, completed: true,
    }, timezone)
    await recordFocusRun(db, USER, {
      taskId: TASK, kind: 'work', startedAt: end + 5 * MINUTE, endedAt: end + 15 * MINUTE,
      plannedMs: 25 * MINUTE, actualMs: 10 * MINUTE, completed: false,
    }, timezone)
    await recordFocusRun(db, USER, {
      taskId: null, kind: 'long_break', startedAt: end + 15 * MINUTE, endedAt: end + 20 * MINUTE,
      plannedMs: 15 * MINUTE, actualMs: 5 * MINUTE, completed: false,
    }, timezone)

    const stats = await loadFocusStats(db, USER, {
      from: '2026-11-05', to: '2026-11-05', timezone, now: end,
    })

    expect(stats.workMs).toBe(35 * MINUTE)
    expect(stats.breakMs).toBe(10 * MINUTE)
    expect(stats.workRounds).toBe(2)
    expect(stats.completedRounds).toBe(1)
    expect(stats.today).toEqual({ day: '2026-11-05', workMs: 35 * MINUTE, rounds: 2 })
    expect(stats.byDay).toEqual([{ day: '2026-11-05', workMs: 35 * MINUTE, rounds: 2 }])
    expect(stats.byTask).toEqual([{ taskId: TASK, title: 'Write the report', workMs: 35 * MINUTE, rounds: 2 }])
    expect(stats.truncatedTasks).toBe(0)
  })

  it('keeps a record without a task and fills days the window did not touch', async () => {
    const db = await database()
    const end = Date.UTC(2026, 10, 5, 12, 0, 0)
    await recordFocusRun(db, USER, {
      taskId: null, kind: 'work', startedAt: end - 40 * MINUTE, endedAt: end,
      plannedMs: 40 * MINUTE, actualMs: 40 * MINUTE, completed: true,
    }, 'UTC')

    const stats = await loadFocusStats(db, USER, {
      from: '2026-11-04', to: '2026-11-05', timezone: 'UTC', now: end,
    })
    expect(stats.byDay).toEqual([
      { day: '2026-11-04', workMs: 0, rounds: 0 },
      { day: '2026-11-05', workMs: 40 * MINUTE, rounds: 1 },
    ])
    expect(stats.byTask).toEqual([])
  })

  it('refuses a phase that runs backwards or leaves the calendar', () => {
    expect(focusRunProblem({
      taskId: null, kind: 'work', startedAt: 2, endedAt: 1, plannedMs: 1, actualMs: 1, completed: true,
    })).toContain('cannot end before')
    expect(focusRunProblem({
      taskId: null, kind: 'work', startedAt: 1, endedAt: 2, plannedMs: 1, actualMs: 25 * 60 * MINUTE, completed: true,
    })).toContain('outside')
    expect(focusRunProblem({
      taskId: 'not an id', kind: 'work', startedAt: 1, endedAt: 2, plannedMs: 1, actualMs: 1, completed: true,
    })).toContain('invalid task id')
    expect(focusRunProblem({
      taskId: null, kind: 'work', startedAt: 1, endedAt: 2, plannedMs: 1, actualMs: 1, completed: true,
    })).toBeNull()
  })
})
