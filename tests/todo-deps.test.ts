// @vitest-environment node
/**
 * Which task waits on which, and what the app is allowed to say about it.
 *
 * A dependency is a reason, not a filter: a blocked row stays on the board, in the badges, on the
 * calendar and in the statistics exactly where it would be with none, because hiding it would make the
 * counts disagree with the rows a reader can see. What the link buys is the sentence "this is waiting",
 * and the sentence has to be true at the moment it is read — which is why the blocker's *live* status
 * travels on the ref rather than a stored verdict, and why finishing a blocker needs no write to its
 * dependents.
 *
 * The refusals are the other half of the contract. SQLite will not stop a cycle on insert, and a cycle
 * would mean a set of tasks no reader could ever finish; an id belonging to another account must not be
 * confirmable as existing; and a task must not be able to wait on itself.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { AssistantStore } from '../src/worker/assistant/store'
import { todoRoutes } from '../src/worker/routes/todos'
import { taskIsBlocked } from '../src/shared/todos/model'
import type { TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import type { Env } from '../src/worker/env'

const USER = '0123456789abcdefghjkmndeps1'
const OTHER = '0123456789abcdefghjkmnothr1'

const mocks = vi.hoisted(() => ({ userId: '' }))

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

let env: Env
let sqlite: DatabaseSync

function app(): Hono {
  const instance = new Hono()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  return instance
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  // The collection is `/api/todos` — the spelling the app's own client uses. This router does not accept
  // a trailing slash on it, so a bare '/' joins as nothing rather than as '/'.
  const url = path === '/' ? '/api/todos' : `/api/todos${path}`
  return app().request(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }, env)
}

function store(userId: string = USER): AssistantStore {
  return new AssistantStore(env.DB as D1Database, userId, env)
}

async function create(title: string, dependsOn?: string[]): Promise<TodoTask> {
  const response = await send('POST', '/', { title, ...(dependsOn ? { dependsOn } : {}) })
  expect(response.status, await response.clone().text()).toBe(201)
  return (await response.json() as { task: TodoTask }).task
}

beforeEach(async () => {
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

describe('writing a dependency set', () => {
  it('carries both ends on every read', async () => {
    const blocker = await create('写报告')
    const dependent = await create('发出去', [blocker.id])

    expect(dependent.dependsOn).toEqual([{ id: blocker.id, title: '写报告', status: 'todo' }])
    // A row nobody named waits on nothing, and that is not the same as the field being missing.
    expect(blocker.dependsOn).toEqual([])
    // The other end is restated where it lives: the blocker, read again, says somebody waits on it.
    // Its own create response could not have said so — the row at the other end did not exist yet.
    const reread = await send('GET', `/${blocker.id}`)
    expect((await reread.json() as { task: TodoTask }).task.blocks)
      .toEqual([{ id: dependent.id, title: '发出去', status: 'todo' }])
  })

  it('refuses a task waiting on itself', async () => {
    const one = await create('独白')
    const response = await send('PATCH', `/${one.id}`, { dependsOn: [one.id] })
    expect(response.status).toBe(400)
    expect((await response.json() as { error: { message: string } }).error.message).toMatch(/itself/)
  })

  it('refuses the two edges that would close a circle, and says which', async () => {
    const a = await create('A')
    const b = await create('B', [a.id])
    const response = await send('PATCH', `/${a.id}`, { dependsOn: [b.id] })
    expect(response.status).toBe(400)
    expect((await response.json() as { error: { message: string } }).error.message)
      .toMatch(/wait on each other/)
    // Refused means unchanged: A must not end up half-linked.
    const reread = await send('GET', `/${a.id}`)
    expect((await reread.json() as { task: TodoTask }).task.dependsOn).toEqual([])
  })

  it('refuses a three-edge circle too, not only the direct one', async () => {
    const a = await create('环A')
    const b = await create('环B', [a.id])
    const c = await create('环C', [b.id])
    const response = await send('PATCH', `/${a.id}`, { dependsOn: [c.id] })
    expect(response.status).toBe(400)
  })

  it('refuses an id that is not this account’s task without saying whether it exists', async () => {
    const foreign = await store(OTHER).createTask({ title: '别人的' }, 'UTC')
    const mine = await create('我的')
    const response = await send('PATCH', `/${mine.id}`, { dependsOn: [foreign.id] })
    expect(response.status).toBe(400)
    const message = (await response.json() as { error: { message: string } }).error.message
    // The same sentence for somebody else's id and for an id nothing ever wrote.
    expect(message).toMatch(/this account/)
    expect(message).not.toContain(foreign.id)
  })

  it('refuses a value that is not a list of ids', async () => {
    const one = await create('形状')
    for (const body of [{ dependsOn: 'nope' }, { dependsOn: [1] }, { dependsOn: ['not-an-id'] }]) {
      const response = await send('PATCH', `/${one.id}`, body)
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('replaces the whole set rather than adding to it, and an empty list clears it', async () => {
    const a = await create('前置A')
    const b = await create('前置B')
    const dependent = await create('等', [a.id])
    expect(dependent.dependsOn).toHaveLength(1)

    const replaced = await send('PATCH', `/${dependent.id}`, { dependsOn: [a.id, b.id] })
    expect((await replaced.json() as { task: TodoTask }).task.dependsOn).toHaveLength(2)

    const cleared = await send('PATCH', `/${dependent.id}`, { dependsOn: [] })
    const task = (await cleared.json() as { task: TodoTask }).task
    expect(task.dependsOn).toEqual([])
    const rereadA = await send('GET', `/${a.id}`)
    expect((await rereadA.json() as { task: TodoTask }).task.blocks).toEqual([])
  })

  it('leaves the set alone when a patch does not name it', async () => {
    const a = await create('不动')
    const dependent = await create('等它', [a.id])
    const renamed = await send('PATCH', `/${dependent.id}`, { title: '改名了' })
    expect((await renamed.json() as { task: TodoTask }).task.dependsOn).toHaveLength(1)
  })
})

describe('what a blocked row means on screen', () => {
  it('is waiting while its blocker is owed, and free the moment it is not', async () => {
    const blocker = await create('先做这个')
    const dependent = await create('后做这个', [blocker.id])
    expect(taskIsBlocked(dependent)).toBe(true)

    await send('PATCH', `/${blocker.id}`, { status: 'done' })
    const reread = await send('GET', `/${dependent.id}`)
    const fresh = (await reread.json() as { task: TodoTask }).task
    // The blocker's finished status travels on the ref; nothing had to be written to the dependent.
    expect(fresh.dependsOn[0]!.status).toBe('done')
    expect(taskIsBlocked(fresh)).toBe(false)
  })

  it('stays in the listing and in the counts while it waits', async () => {
    const blocker = await create('占位')
    await create('被挡住', [blocker.id])
    const page = await send('GET', '?view=all&limit=100')
    const body = await page.json() as { tasks: TodoTask[]; total: number; counts: { all: number } }
    expect(body.tasks).toHaveLength(2)
    expect(body.total).toBe(2)
    expect(body.counts.all).toBe(2)
  })
})
