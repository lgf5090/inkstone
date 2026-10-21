// @vitest-environment node
/**
 * A task's start date: when it may be begun, beside when it is due.
 *
 * The two are independent facts — a report can start on the first and be due on the last — so the
 * route has to carry the start without moving the due, clear it on request, and the plan view has to
 * file a not-yet-due row under the future by the day it starts rather than the day it is owed.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import { parseLocalTime } from '../src/shared/assistant-time'
import type { TodoTask } from '../src/shared/todos/model'
import { groupByPlan } from '../src/client/features/todos/task-groups'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-19T10:00:00Z')
const DAY_END = Date.parse('2026-10-19T23:59:59Z')

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { get: (key: string) => unknown; set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    c.set('user', { id: mocks.userId, username: mocks.userId, settingsRaw: '{}' })
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

async function create(body: Record<string, unknown>): Promise<TodoTask> {
  const response = await send('POST', '', body)
  expect(response.status).toBe(201)
  return (await json<{ task: TodoTask }>(response)).task
}

function task(id: string, patch: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title: id,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    projectId: null,
    listId: null,
    tags: [],
    starred: false,
    repeat: null,
    remindAt: null,
    remindedAt: null,
    plannedFor: null,
    noteId: null,
    conversationId: null,
    stepTotal: 0,
    stepDone: 0,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...patch,
  }
}

beforeEach(() => {
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite))
})

describe('the start date on a task', () => {
  it('is written beside the due date without moving it', async () => {
    const task = await create({
      title: 'Plan the quarter',
      startAt: '2026-12-01T09:00',
      dueAt: '2026-12-31T18:00',
    })
    expect(task.startAt).toBe(parseLocalTime('2026-12-01T09:00', 'UTC'))
    expect(task.dueAt).toBe(parseLocalTime('2026-12-31T18:00', 'UTC'))

    const listed = await json<{ tasks: TodoTask[] }>(await send('GET', '?status=open'))
    expect(listed.tasks[0]!.startAt).toBe(task.startAt)
  })

  it('is cleared by a null and refused when it cannot be read', async () => {
    const task = await create({ title: 'One', startAt: '2026-12-01' })
    const cleared = await json<{ task: TodoTask }>(await send('PATCH', `/${task.id}`, { startAt: null }))
    expect(cleared.task.startAt).toBeNull()
    expect(cleared.task.dueAt).toBeNull()

    expect((await send('PATCH', `/${task.id}`, { startAt: 'not a day' })).status).toBe(400)
  })
})

describe('the plan view and a start date', () => {
  it('files a future task by the day it starts, falling back to the due date', () => {
    const groups = groupByPlan([
      task('starts-this-week', { dueAt: DAY_END + 30 * DAY, startAt: DAY_END + 2 * DAY }),
      task('no-start', { dueAt: DAY_END + 30 * DAY }),
      task('starts-later', { dueAt: DAY_END + 30 * DAY, startAt: DAY_END + 20 * DAY }),
    ], { dayEnd: DAY_END, now: NOW })

    expect(groups.map((group) => [group.key, group.tasks.map((entry) => entry.id)])).toEqual([
      ['upcoming', ['starts-this-week']],
      ['later', ['no-start', 'starts-later']],
    ])
  })
})
