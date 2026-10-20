// @vitest-environment node
/**
 * "My Day": the tasks a reader picked into today, beside the ones already owed today.
 *
 * "Today" is two questions in one screen — what is due by the end of the day, and what the reader
 * chose to work on — and the badge has to answer both at once. The day itself is a stored
 * `YYYY-MM-DD` in the account's zone rather than a flag that has to be cleared at midnight: a row
 * planned for yesterday simply stops equalling today when the calendar moves, which is why no cron
 * is involved. These cases pin that rollover, the pick and the clear, the date the route refuses,
 * and the rows that were in today before planning existed.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase, SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { TODOS_REQUIRED_COLUMNS, TODOS_REQUIRED_INDEXES } from '../src/worker/todos/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import { AssistantStore } from '../src/worker/assistant/store'
import type { TaskCounts, TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
/** Noon UTC on the day these cases call today, so midnight on either side is unambiguous. */
const NOON = Date.parse('2026-10-20T12:00:00Z')
const TODAY = '2026-10-20'
const YESTERDAY = '2026-10-19'
const HOUR = 60 * 60 * 1000

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let env: Env

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  return instance
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return app().request(`/api/todos${path}`, init, env)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

interface Page {
  tasks: TodoTask[]
  total: number
  counts: TaskCounts
  dayEnd: number
  timezone: string
}

async function page(query = '?view=today'): Promise<Page> {
  const response = await send('GET', query)
  expect(response.status).toBe(200)
  return await json<Page>(response)
}

function store(userId = USER): AssistantStore {
  return new AssistantStore(env.DB as D1Database, userId, env)
}

async function plan(taskId: string, date: string | null): Promise<Response> {
  return await send('POST', `/${taskId}/plan`, { date })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOON))
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the today view', () => {
  it('leaves a task planned for yesterday behind when the calendar moves, without clearing it', async () => {
    const s = store()
    const carried = await s.createTask({ title: 'Carry the thread' })
    const planned = await s.planTask(carried.id, YESTERDAY)
    expect(planned?.plannedFor).toBe(YESTERDAY)

    const today = await page()
    expect(today.tasks.map((task) => task.id)).not.toContain(carried.id)
    expect(today.counts.today).toBe(0)
    // The row did not vanish with the day: it is still an open task, and the stored day still says
    // which day it was picked for.
    const open = await page('?view=open')
    expect(open.tasks.map((task) => task.id)).toContain(carried.id)
    expect((await s.getTask(carried.id))?.plannedFor).toBe(YESTERDAY)
  })

  it('moves a picked task and the badge into today together', async () => {
    const s = store()
    const task = await s.createTask({ title: 'Renew the lease' })
    const before = await page()
    expect(before.tasks).toHaveLength(0)
    expect(before.counts.today).toBe(0)

    const response = await plan(task.id, TODAY)
    expect(response.status).toBe(200)
    const picked = await json<{ task: TodoTask }>(response)
    expect(picked.task.plannedFor).toBe(TODAY)

    const after = await page()
    expect(after.tasks.map((entry) => entry.id)).toEqual([task.id])
    expect(after.total).toBe(1)
    // A badge that disagrees with the page it opens is the failure this pins: one predicate, one count.
    expect(after.counts.today).toBe(after.tasks.length)
    expect(after.counts.today).toBe(1)
  })

  it('clears a plan with a null day, taking the task back out of today', async () => {
    const s = store()
    const task = await s.createTask({ title: 'Renew the lease' })
    await plan(task.id, TODAY)
    expect((await page()).tasks.map((entry) => entry.id)).toEqual([task.id])

    const cleared = await plan(task.id, null)
    expect(cleared.status).toBe(200)
    expect((await json<{ task: TodoTask }>(cleared)).task.plannedFor).toBeNull()

    const after = await page()
    expect(after.tasks.map((entry) => entry.id)).not.toContain(task.id)
    expect(after.counts.today).toBe(0)
  })

  it('accepts a day in the past, because a backfilled record is still a record', async () => {
    const s = store()
    const task = await s.createTask({ title: 'Filed late' })

    const response = await plan(task.id, YESTERDAY)

    expect(response.status).toBe(200)
    expect((await json<{ task: TodoTask }>(response)).task.plannedFor).toBe(YESTERDAY)
    // It is not shown in today, which is what the plan means; the row and the day are kept.
    expect((await page()).tasks.map((entry) => entry.id)).not.toContain(task.id)
  })

  it('refuses a day that is not a calendar date', async () => {
    const s = store()
    const task = await s.createTask({ title: 'Renew the lease' })

    for (const date of ['2026-02-30', '20-10-2026', 'tomorrow', '', 20261020, undefined]) {
      const response = await send('POST', `/${task.id}/plan`, { date })
      expect(response.status, `date ${String(date)} was accepted`).toBe(400)
    }
    expect((await s.getTask(task.id))?.plannedFor).toBeNull()
  })

  it('refuses to plan another account’s task', async () => {
    const foreign = await store(OTHER).createTask({ title: 'Not yours' })

    expect((await plan(foreign.id, TODAY)).status).toBe(404)
    expect((await store(OTHER).getTask(foreign.id))?.plannedFor).toBeNull()
  })

  it('keeps due-today and overdue rows in today even when nothing was planned', async () => {
    const s = store()
    const dueToday = await s.createTask({ title: 'Send the invoice', dueAt: NOON - HOUR })
    const overdue = await s.createTask({ title: 'Book the dentist', dueAt: NOON - 26 * HOUR })
    const undated = await s.createTask({ title: 'Someday' })

    const today = await page()

    expect(today.tasks.map((entry) => entry.id)).toEqual(expect.arrayContaining([dueToday.id, overdue.id]))
    expect(today.tasks.map((entry) => entry.id)).not.toContain(undated.id)
    expect(today.counts.today).toBe(today.tasks.length)
    expect(today.counts.today).toBe(2)
  })
})

describe('the planned day column', () => {
  function columnsOf(database: DatabaseSync): string[] {
    return database.prepare(`SELECT name FROM pragma_table_info('todos_tasks')`).all()
      .map((row) => (row as { name: string }).name)
  }

  function indexesOf(database: DatabaseSync): string[] {
    return database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all()
      .map((row) => (row as { name: string }).name)
  }

  it('ships in a fresh database and is named in the migration ledger', async () => {
    const fresh = new DatabaseSync(':memory:')
    fresh.exec('PRAGMA journal_mode = OFF')
    await initializeDatabase(testBindings(makeD1(fresh)))

    expect(columnsOf(fresh)).toContain('planned_for')
    expect(indexesOf(fresh)).toContain('idx_todos_tasks_planned')
    expect(TODOS_REQUIRED_COLUMNS.todos_tasks).toContain('planned_for')
    expect(TODOS_REQUIRED_INDEXES).toContain('idx_todos_tasks_planned')

    expect(SCHEMA_MIGRATIONS.find((migration) => migration.version === 117)).toMatchObject({
      skipIfColumnExists: { table: 'todos_tasks', column: 'planned_for' },
      statements: [`ALTER TABLE todos_tasks ADD COLUMN planned_for TEXT`],
    })
    expect(SCHEMA_MIGRATIONS.find((migration) => migration.version === 118)).toMatchObject({
      statements: [expect.stringMatching(/CREATE INDEX IF NOT EXISTS idx_todos_tasks_planned\s+ON todos_tasks\(user_id, planned_for\)/)],
    })
  })

  it('adds the column and its index to a database built before they existed', async () => {
    await initializeDatabase(testBindings(makeD1(sqlite)))
    sqlite.exec('DROP INDEX idx_todos_tasks_planned')
    sqlite.exec('ALTER TABLE todos_tasks DROP COLUMN planned_for')
    sqlite.exec('DELETE FROM schema_migrations WHERE version IN (117, 118)')
    sqlite.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)

    await initializeDatabase(testBindings(makeD1(sqlite)))

    expect(columnsOf(sqlite)).toContain('planned_for')
    expect(indexesOf(sqlite)).toContain('idx_todos_tasks_planned')
  })
})
