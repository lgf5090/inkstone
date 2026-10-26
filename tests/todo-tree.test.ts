// @vitest-environment node
/**
 * Which task sits under which, and what the app is allowed to do about it.
 *
 * A parent is a place on a page, not a kind of row: a child keeps its own list, status, due date and
 * hours, is listed and counted exactly where it would be with no parent, and the parent's completion says
 * nothing about it. What the column buys is the gutter the grouped listings draw — which is why nothing
 * here is derived at write time and why no reverse field has to be restated: `childCount` is read off the
 * rows already on the page.
 *
 * The refusals are the other half. A task nested inside itself would be a row no listing can place; a
 * chain buried past the depth the screens indent would be a lie drawn as a gutter; and an id of another
 * account's task is refused with the same sentence as an id nothing ever wrote.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { MAX_TASK_TREE_DEPTH } from '../src/worker/assistant/store'
import { AssistantStore } from '../src/worker/assistant/store'
import { todoRoutes } from '../src/worker/routes/todos'
import type { TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import type { Env } from '../src/worker/env'

const USER = '0123456789abcdefghjkmntree1'
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
  // The collection is `/api/todos`, the spelling the app's own client uses; this router does not read a
  // trailing slash as the same route.
  const url = path === '/' ? '/api/todos' : `/api/todos${path}`
  return app().request(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }, env)
}

function store(userId: string = USER): AssistantStore {
  return new AssistantStore(env.DB as D1Database, userId, env)
}

async function read(id: string): Promise<TodoTask> {
  const response = await send('GET', `/${id}`)
  expect(response.status).toBe(200)
  return (await response.json() as { task: TodoTask }).task
}

async function create(title: string, parentId?: string | null): Promise<TodoTask> {
  const response = await send('POST', '/', { title, ...(parentId === undefined ? {} : { parentId }) })
  expect(response.status, await response.clone().text()).toBe(201)
  return (await response.json() as { task: TodoTask }).task
}

async function refuse(id: string, parentId: string | null): Promise<string> {
  const response = await send('PATCH', `/${id}`, { parentId })
  expect(response.status, await response.clone().text()).toBe(400)
  return (await response.json() as { error: { message: string } }).error.message
}

beforeEach(async () => {
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

describe('placing a row in a tree', () => {
  it('carries the parent on the row and changes nothing about either row', async () => {
    const parent = await create('写报告')
    const child = await create('发出去', parent.id)

    expect(child.parentId).toBe(parent.id)
    // The parent is not a summary of its children: it keeps its own status and hours, and a child that
    // finishes does not finish it.
    expect((await read(parent.id)).status).toBe('todo')
    expect((await read(child.id)).status).toBe('todo')
  })

  it('counts a child in the listing and in the numbers beside it, parent or no parent', async () => {
    const parent = await create('写报告')
    const child = await create('发出去', parent.id)
    const page = await send('GET', '?view=all&limit=100')
    const body = await page.json() as { tasks: TodoTask[]; total: number; counts: { all: number } }
    expect(body.tasks.map((task) => task.id).sort()).toEqual([parent.id, child.id].sort())
    expect(body.total).toBe(2)
    expect(body.counts.all).toBe(2)
  })

  it('puts a row back at the top when the field says null, and leaves it alone when the field is absent', async () => {
    const parent = await create('顶层')
    const child = await create('下面', parent.id)

    const renamed = await send('PATCH', `/${child.id}`, { title: '改名了' })
    expect((await renamed.json() as { task: TodoTask }).task.parentId).toBe(parent.id)

    const cleared = await send('PATCH', `/${child.id}`, { parentId: null })
    expect((await cleared.json() as { task: TodoTask }).task.parentId).toBeNull()
  })
})

describe('what a place in the tree may not be', () => {
  it('refuses a task nested inside itself', async () => {
    const one = await create('独白')
    expect(await refuse(one.id, one.id)).toMatch(/itself/)
    expect((await read(one.id)).parentId).toBeNull()
  })

  it('refuses the two edges that would close a loop, and says which', async () => {
    const a = await create('环A')
    const b = await create('环B', a.id)
    expect(await refuse(a.id, b.id)).toMatch(/by a route/)
    expect((await read(a.id)).parentId).toBeNull()
    expect((await read(b.id)).parentId).toBe(a.id)
  })

  it('refuses a chain that would bury the row past the depth the listings indent', async () => {
    const top = await create('一层')
    const second = await create('二层', top.id)
    const third = await create('三层', second.id)
    const fourth = await create('四层', third.id)
    // The last level the screen can draw is still a place a reader can reach.
    expect((await read(fourth.id)).parentId).toBe(third.id)

    const fifth = await create('五层待试')
    const message = await refuse(fifth.id, fourth.id)
    expect(message).toContain(String(MAX_TASK_TREE_DEPTH))
    expect((await read(fifth.id)).parentId).toBeNull()
  })

  it('refuses a task that is not this account’s live row, in the same words either way', async () => {
    const mine = await create('我的')
    const foreign = await store(OTHER).createTask({ title: '别人的' }, 'UTC')
    const trashed = await create('已删')
    await send('DELETE', `/${trashed.id}`)

    const foreignMessage = await refuse(mine.id, foreign.id)
    const trashedMessage = await refuse(mine.id, trashed.id)
    // Well-formed and never written: `isValidId` lets it through, the table has no such row.
    const missingMessage = await refuse(mine.id, 'z'.repeat(26))
    expect(foreignMessage).toMatch(/live task in this account/)
    expect(trashedMessage).toBe(foreignMessage)
    // A stranger's id and an id nothing ever wrote are the same answer: nothing here confirms that a
    // task the reader does not hold exists.
    expect(missingMessage).toBe(foreignMessage)
    expect(foreignMessage).not.toContain(foreign.id)
  })

  it('refuses a value that is not a task id', async () => {
    const one = await create('形状')
    for (const body of [{ parentId: 7 }, { parentId: {} }, { parentId: 'not-an-id' }]) {
      const response = await send('PATCH', `/${one.id}`, body)
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
  })
})

describe('what happens to a child when its parent goes', () => {
  it('leaves the pair alone while the parent is only in the trash, and promotes the child when it is purged', async () => {
    const parent = await create('写报告')
    const child = await create('发出去', parent.id)

    await send('DELETE', `/${parent.id}`)
    // A trashed parent is still the parent: restoring it brings the nesting back with it.
    expect((await read(child.id)).parentId).toBe(parent.id)

    const purged = await send('DELETE', `/${parent.id}/purge`, {})
    expect(purged.status).toBe(200)
    const promoted = await read(child.id)
    expect(promoted.parentId).toBeNull()
    // Promotion is not deletion: the child is the reader's own work and stays on the page.
    expect(promoted.title).toBe('发出去')
  })
})
