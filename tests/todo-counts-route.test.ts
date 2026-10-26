// @vitest-environment node
/**
 * M-07a: `GET /api/todos/counts`, the sidebar's three numbers without a task row.
 *
 * The app refreshed its badges after every create, update, delete and list archive by asking for a
 * listing of one task — the page read, its total read, the aggregate, and a whole serialised row, all to
 * pick three fields off the answer. This endpoint runs the same aggregate `GET /api/todos` runs, through
 * the same `s.taskCounts`, and returns `counts`, `dayEnd` and `timezone` and nothing else.
 *
 * The cases below pin the shape (no rows, no `total`), the pairing with the listing's own numbers, that
 * `counts` is read as a route rather than as a task id, that it sits behind the session like every other
 * read in this file, and that it stays off the write budget.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { localDayBounds } from '../src/shared/assistant-time'
import { AssistantStore } from '../src/worker/assistant/store'
import { todoRoutes, WRITE_BUDGET_PER_MINUTE } from '../src/worker/routes/todos'
import type { TaskCounts, TaskPage } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import type { AppBindings, Env } from '../src/worker/env'

const USER = '0123456789abcdefghjkmncnt1'
const DAY = 24 * 60 * 60 * 1000

const mocks = vi.hoisted(() => ({ userId: '' }))

/**
 * The session, as every other to-do route test stands it up — except that an account nobody named is
 * refused with the real middleware's 401, which is what the unauthenticated case below checks.
 */
vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    if (!mocks.userId) {
      const { ApiError } = await import('../src/worker/lib/errors')
      throw ApiError.unauthenticated('Please sign in first')
    }
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let env: Env

/** Every statement prepared while recording is on; seeding happens with it off. */
let statements: string[] = []
let recording = false

function countedD1(inner: D1Database): D1Database {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (recording) statements.push(sql)
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  return instance
}

async function send(method: string, path: string): Promise<Response> {
  return app().request(`/api/todos${path}`, { method }, env)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

interface CountsAnswer {
  counts: TaskCounts
  dayEnd: number
  timezone: string
}

async function counts(): Promise<CountsAnswer> {
  const response = await send('GET', '/counts')
  expect(response.status, await response.clone().text()).toBe(200)
  return json<CountsAnswer>(response)
}

function store(): AssistantStore {
  return new AssistantStore(env.DB as D1Database, USER, env)
}

beforeEach(() => {
  mocks.userId = USER
  statements = []
  recording = false
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(countedD1(makeD1(sqlite)), { PUBLIC_URL: 'http://localhost' })
})

describe('the answer', () => {
  it('carries the three scalars and no task rows', async () => {
    const answer = await counts()

    expect(Object.keys(answer).sort()).toEqual(['counts', 'dayEnd', 'timezone'])
    expect(answer.counts).toMatchObject({ inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0 })
    expect(answer.counts.byList).toEqual({})
    expect(answer.counts.byTag).toEqual({})
    expect(answer.dayEnd).toBeGreaterThan(Date.now())
    expect(answer.timezone).toBe('UTC')
  })

  it('counts what the account holds, in the same shape the listing reports', async () => {
    const s = store()
    await s.createTask({ title: 'In the inbox' }, 'UTC')
    const done = await s.createTask({ title: 'Finished', dueAt: Date.now() - DAY }, 'UTC')
    await s.completeTask(done.id, 'UTC')

    const page = await json<TaskPage>(await send('GET', '?limit=1'))

    expect(page.tasks).toHaveLength(1)
    expect(await counts()).toMatchObject({ counts: page.counts })
  })

  it('answers with the account\'s own day boundary, the way the listing does', async () => {
    const s = store()
    await s.saveSettings({ ...(await s.getSettings()), timezone: 'Asia/Shanghai' })

    const answer = await counts()

    expect(answer.timezone).toBe('Asia/Shanghai')
    expect(answer.dayEnd).toBe(localDayBounds('Asia/Shanghai').end)
  })

  it('reads only the aggregate, on fewer statements than the page it replaced', async () => {
    await store().createTask({ title: 'One' }, 'UTC')

    recording = true
    const answer = await send('GET', '/counts')
    const counted = [...statements]
    statements = []
    const page = await send('GET', '?limit=1')
    const pageReads = [...statements]
    recording = false

    expect(answer.status).toBe(200)
    expect(page.status).toBe(200)
    expect(counted.length).toBeGreaterThan(0)
    expect(counted.length).toBeLessThan(pageReads.length)
    // The listing's own row read — the page this route exists to avoid — is not among these statements.
    expect(pageReads.join(' ')).toMatch(/LIMIT \?/i)
    expect(counted.join(' ')).not.toMatch(/LIMIT \?/i)
  })
})

describe('the route, not a task id', () => {
  it('is matched as a static path before /:id', async () => {
    expect((await counts()).counts).toBeDefined()
    expect((await send('GET', '/not-a-task-id')).status).toBe(404)
  })
})

describe('the guard', () => {
  it('refuses a caller with no session', async () => {
    mocks.userId = ''
    const response = await send('GET', '/counts')

    expect(response.status).toBe(401)
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe('unauthenticated')
  })

  it('spends no write budget, because it changes nothing', async () => {
    for (let index = 0; index < WRITE_BUDGET_PER_MINUTE + 5; index += 1) {
      expect((await send('GET', '/counts')).status, `read ${index}`).toBe(200)
    }

    // The budget is still whole: a write after sixty reads is refused for nobody.
    const response = await app().request('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'After the reads' }),
    }, env)
    expect(response.status).toBe(201)
  })
})
