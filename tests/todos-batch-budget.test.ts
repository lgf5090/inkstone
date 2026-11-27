// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import { AssistantStore } from '../src/worker/assistant/store'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = 'batchbudget00000000000000'
const OTHER = 'batchbudget11111111111111'

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

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  return app().request(`/api/todos${path}`, init, env)
}

/** The D1 double with a tally of the statements that actually execute. */
function countingD1(inner: D1Database): { db: D1Database; count: () => number } {
  let statements = 0
  const db = {
    prepare(sql: string) {
      const statement = inner.prepare(sql)
      const wrapped = {
        bind(...values: unknown[]) {
          statement.bind(...values)
          return wrapped
        },
        async first<T>() { statements++; return statement.first<T>() },
        async all<T>() { statements++; return statement.all<T>() },
        async run<T>() { statements++; return statement.run<T>() },
        async raw<T>() { statements++; return statement.raw<T>() },
      }
      return wrapped
    },
    async batch(prepared: D1PreparedStatement[]) {
      return inner.batch(prepared as never)
    },
  } as unknown as D1Database
  return { db, count: () => statements }
}

async function seed(count: number): Promise<string[]> {
  const store = new AssistantStore(env.DB, USER, env)
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const task = await store.createTask({ title: `Task ${index}` }, 'UTC')
    ids.push(task.id)
  }
  return ids
}

/** One batch against a counting database, so the statements it spends are the ones measured. */
async function batchCounted(ids: string[], body: Record<string, unknown>): Promise<{ response: Response; count: () => number }> {
  const { db, count } = countingD1(env.DB)
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  const response = await instance.request('/api/todos/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, ...body }),
  }, { ...env, DB: db } as unknown as Env)
  return { response, count }
}

beforeEach(() => {
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

describe('what one batch costs', () => {
  it('reads a hundred rows once and sets their priority in a bounded number of statements', async () => {
    const ids = await seed(100)
    const { response, count } = await batchCounted(ids, { op: 'priority', value: 'urgent' })

    expect(response.status).toBe(200)
    const body = await response.json() as { done: { id: string }[], failed: unknown[] }
    expect(body.done).toHaveLength(100)
    expect(body.failed).toEqual([])
    // The hundred rows are read in chunked statements — two pages of rows and four of their details —
    // and each write is one guarded update, with no read-back: the batch already holds the rows it is
    // changing. The old path spent three statements per row before the first write, about a thousand
    // for this gesture.
    expect(count()).toBeLessThanOrEqual(150)
    const rows = await new AssistantStore(env.DB, USER, env).getTasks(ids)
    for (const task of rows.values()) expect(task.priority).toBe('urgent')
  })

  it('finishes a hundred rows without a round trip per row', async () => {
    const ids = await seed(100)
    const { response, count } = await batchCounted(ids, { op: 'complete' })

    expect(response.status).toBe(200)
    const body = await response.json() as { done: { id: string, next: unknown }[], failed: unknown[] }
    expect(body.done).toHaveLength(100)
    expect(body.failed).toEqual([])
    // Every completion still goes through `completeTask`, the one door that files a repeating task's
    // next occurrence, and that door reads its row back so the answer carries the finished row.
    expect(count()).toBeLessThanOrEqual(800)
    const store = new AssistantStore(env.DB, USER, env)
    for (const id of ids) expect((await store.getTask(id))?.status).toBe('done')
  })

  it('keeps answering per row for the rows a batch cannot reach', async () => {
    const ids = await seed(2)
    const response = await send('POST', '/batch', { ids: [...ids, '0123456789abcdefghjkmnpqs'], op: 'star' })

    expect(response.status).toBe(200)
    const body = await response.json() as { done: { id: string }[], failed: { id: string, reason: string }[] }
    expect(body.done.map((entry) => entry.id)).toEqual(ids)
    expect(body.failed).toEqual([{ id: '0123456789abcdefghjkmnpqs', reason: 'not found' }])
  })

  it('refuses a row whose revision moved, and lands the rest', async () => {
    const ids = await seed(3)
    const store = new AssistantStore(env.DB, USER, env)
    const first = await store.getTask(ids[0]!)
    await store.updateTask(ids[0]!, { title: 'Moved under the caller' })

    const response = await send('POST', '/batch', { ids, op: 'priority', value: 'high', revs: { [ids[0]!]: first!.rev } })

    expect(response.status).toBe(200)
    const body = await response.json() as { done: { id: string }[], failed: { id: string, reason: string }[] }
    expect(body.done.map((entry) => entry.id)).toEqual([ids[1], ids[2]])
    expect(body.failed).toEqual([{ id: ids[0], reason: 'conflict' }])
    expect((await store.getTask(ids[0]!))?.priority).toBe('medium')
  })

  it('answers another account\'s id the same way it answers a missing one', async () => {
    const ids = await seed(1)
    const stolen = await new AssistantStore(env.DB, OTHER, env).createTask({ title: 'Not yours' }, 'UTC')

    const response = await send('POST', '/batch', { ids: [...ids, stolen.id], op: 'complete' })

    const body = await response.json() as { done: { id: string }[], failed: { id: string, reason: string }[] }
    expect(body.done.map((entry) => entry.id)).toEqual(ids)
    expect(body.failed).toEqual([{ id: stolen.id, reason: 'not found' }])
  })
})
