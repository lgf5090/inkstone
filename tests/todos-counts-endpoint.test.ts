// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import { localDate } from '../src/shared/assistant-time'
import { addDays } from '../src/worker/todos/stats'
import { AssistantStore } from '../src/worker/assistant/store'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = 'countsendpoint00000000000'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    c.set('user', { id: mocks.userId, username: mocks.userId, login: mocks.userId, name: '', avatarUrl: '', role: 'member', createdAt: 1, settingsRaw: '{}' })
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

async function get(path: string): Promise<Response> {
  return await app().request(`/api/todos${path}`, { method: 'GET' }, env)
}

beforeEach(() => {
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

describe('the counts door', () => {
  it('answers the badges and the day they are measured against, without a page of tasks', async () => {
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const today = localDate(Date.now(), 'UTC')
    await store.createTask({ title: 'Owed', dueAt: Date.now() + 3_600_000 })
    await store.createTask({ title: 'Done' }).then((task) => store.completeTask(task.id, 'UTC'))

    const response = await get('/counts')

    expect(response.status).toBe(200)
    const body = await response.json() as { counts: { all: number, completed: number }, dayEnd: number, timezone: string }
    expect(body.counts.all).toBe(1)
    expect(body.counts.completed).toBe(1)
    expect(body.timezone).toBe('UTC')
    // The day the counts are measured against, so a screen that kept yesterday's page can tell.
    expect(localDate(body.dayEnd - 1, 'UTC')).toBe(today)
  })
})

describe('the statistics window', () => {
  it('refuses a range wider than a year and a day', async () => {
    const response = await get('/stats?from=1900-01-01&to=2100-01-01')
    expect(response.status).toBe(400)
    expect((await response.json() as { error: { message: string } }).error.message)
      .toContain('366')
  })

  it('answers a range of exactly a year and a day', async () => {
    const today = localDate(Date.now(), 'UTC')
    const response = await get(`/stats?from=${addDays(today, -365)}&to=${today}`)
    expect(response.status).toBe(200)
  })

  it('holds the worklog and the ledger to the same ceiling', async () => {
    expect((await get('/worklog?from=1900-01-01&to=2100-01-01')).status).toBe(400)
    expect((await get('/time?from=1900-01-01&to=2100-01-01')).status).toBe(400)
    const today = localDate(Date.now(), 'UTC')
    expect((await get(`/worklog?from=${addDays(today, -365)}&to=${today}`)).status).toBe(200)
    expect((await get(`/time?from=${addDays(today, -365)}&to=${today}`)).status).toBe(200)
  })
})
