// @vitest-environment node
/**
 * A task's own face: an icon and a colour that override the list's.
 *
 * The two columns are the task's own answer to "what does this look like", and null is how a task
 * says "wear my list's" — the fallback the inbox has always had. So the route has to carry both
 * through a create and a patch, clear them on an explicit null, and refuse a colour outside the
 * palette or an icon name past the ceiling rather than storing a face no picker could produce again.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import type { TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'

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

beforeEach(() => {
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite))
})

describe('the icon and colour on a task', () => {
  it('keeps the face a create spelled out, and leaves it null when it named neither', async () => {
    const faced = await create({ title: 'One', icon: 'lucide:Star', color: '#dc2626' })
    expect(faced.icon).toBe('lucide:Star')
    expect(faced.color).toBe('#dc2626')

    const plain = await create({ title: 'Two' })
    expect(plain.icon).toBeNull()
    expect(plain.color).toBeNull()

    const detail = await json<{ task: TodoTask }>(await send('GET', `/${faced.id}`))
    expect(detail.task.icon).toBe('lucide:Star')
    expect(detail.task.color).toBe('#dc2626')
  })

  it('refuses a colour outside the palette and an icon name past the ceiling', async () => {
    expect((await send('POST', '', { title: 'x', color: 'not-a-colour' })).status).toBe(400)
    expect((await send('POST', '', { title: 'x', icon: 'x'.repeat(41) })).status).toBe(400)
  })

  it('sets a face through a patch, and clears it again with an explicit null', async () => {
    const task = await create({ title: 'One' })

    const faced = await json<{ task: TodoTask }>(await send('PATCH', `/${task.id}`, { icon: 'lucide:Star', color: '#dc2626' }))
    expect(faced.task.icon).toBe('lucide:Star')
    expect(faced.task.color).toBe('#dc2626')

    // null is the clear: the task wears its list's face again, and the write itself still answers 200.
    const cleared = await json<{ task: TodoTask }>(await send('PATCH', `/${task.id}`, { icon: null, color: null }))
    expect(cleared.task.icon).toBeNull()
    expect(cleared.task.color).toBeNull()
  })

  it('refuses an unusable face on a patch the same way a create does', async () => {
    const task = await create({ title: 'One' })
    expect((await send('PATCH', `/${task.id}`, { color: 'not-a-colour' })).status).toBe(400)
    expect((await send('PATCH', `/${task.id}`, { icon: 'x'.repeat(41) })).status).toBe(400)
  })
})
