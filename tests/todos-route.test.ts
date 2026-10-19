// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import { AssistantStore } from '../src/worker/assistant/store'
import type { TaskCounts, TaskList, TaskStep, TaskTag, TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

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
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

describe('the task endpoints', () => {
  it('creates a task with a local due date read in the reader timezone', async () => {
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    await store.saveSettings({ ...(await store.getSettings()), timezone: 'Asia/Shanghai' })

    const task = await create({ title: 'File the return', dueAt: '2026-12-31T23:30' })

    expect(new Date(task.dueAt!).toISOString()).toBe('2026-12-31T15:30:00.000Z')
  })

  it('keeps a completed task out of the open list and in the completed one', async () => {
    const task = await create({ title: 'Call the plumber' })
    const patched = await json<{ task: TodoTask }>(await send('PATCH', `/${task.id}`, { status: 'done' }))
    expect(patched.task.status).toBe('done')

    const open = await json<{ tasks: TodoTask[] }>(await send('GET', '?status=open'))
    expect(open.tasks.map((entry) => entry.id)).not.toContain(task.id)
    const done = await json<{ tasks: TodoTask[] }>(await send('GET', '?view=completed'))
    expect(done.tasks.map((entry) => entry.id)).toContain(task.id)
  })

  it('returns the task, its steps and the counts in one read', async () => {
    const task = await create({ title: 'Ship it', steps: ['Write', 'Review'] })
    const detail = await json<{ task: TodoTask, steps: TaskStep[] }>(await send('GET', `/${task.id}`))
    expect(detail.task.id).toBe(task.id)
    expect(detail.steps.map((step) => step.text)).toEqual(['Write', 'Review'])

    const page = await json<{ counts: TaskCounts, dayEnd: number }>(await send('GET', ''))
    expect(page.counts.all).toBe(1)
    expect(page.dayEnd).toBeGreaterThan(0)
  })

  it('filters by list, tag, priority and star', async () => {
    const list = await json<{ list: TaskList }>(await send('POST', '/lists', { name: 'Work' })).then((body) => body.list)
    const starred = await create({ title: 'Important', starred: true, listId: list.id, priority: 'urgent', tags: ['Focus'] })
    await create({ title: 'Later' })

    const byList = await json<{ tasks: TodoTask[] }>(await send('GET', `?list=${list.id}`))
    expect(byList.tasks.map((task) => task.id)).toEqual([starred.id])
    const byStar = await json<{ tasks: TodoTask[] }>(await send('GET', '?starred=1'))
    expect(byStar.tasks.map((task) => task.id)).toEqual([starred.id])
    const byPriority = await json<{ tasks: TodoTask[] }>(await send('GET', '?priority=urgent'))
    expect(byPriority.tasks.map((task) => task.id)).toEqual([starred.id])
    const tag = (await json<{ tags: TaskTag[] }>(await send('GET', '/tags'))).tags[0]!
    const byTag = await json<{ tasks: TodoTask[] }>(await send('GET', `?tag=${tag.id}`))
    expect(byTag.tasks.map((task) => task.id)).toEqual([starred.id])
  })

  it('refuses a project, a list or a colour that does not exist', async () => {
    expect((await send('POST', '', { title: 'x', projectId: '0000000000abcdefghijklmnopqrzz' })).status).toBe(400)
    expect((await send('POST', '', { title: 'x', listId: '0000000000abcdefghijklmnopqrzz' })).status).toBe(400)
    expect((await send('POST', '/lists', { name: 'Work', color: 'not-a-colour' })).status).toBe(400)
  })

  it('refuses a task without a title, and an unknown status', async () => {
    expect((await send('POST', '', {})).status).toBe(400)
    expect((await send('POST', '', { title: '   ' })).status).toBe(400)
    const task = await create({ title: 'One' })
    expect((await send('PATCH', `/${task.id}`, { status: 'someday' })).status).toBe(400)
  })

  it('deletes a task', async () => {
    const task = await create({ title: 'One' })
    expect((await send('DELETE', `/${task.id}`)).status).toBe(200)
    expect((await send('GET', `/${task.id}`)).status).toBe(404)
  })
})

describe('lists', () => {
  it('creates, renames and deletes one, moving its tasks to the inbox', async () => {
    const created = await json<{ list: TaskList }>(await send('POST', '/lists', { name: 'Work', icon: 'Briefcase' }))
    expect(created.list.icon).toBe('Briefcase')
    const renamed = await json<{ list: TaskList }>(await send('PATCH', `/lists/${created.list.id}`, { name: 'Job' }))
    expect(renamed.list.name).toBe('Job')

    const task = await create({ title: 'One', listId: created.list.id })
    expect((await send('DELETE', `/lists/${created.list.id}`)).status).toBe(200)
    const detail = await json<{ task: TodoTask }>(await send('GET', `/${task.id}`))
    expect(detail.task.listId).toBeNull()
  })

  it('answers a duplicate name with the list that already has it', async () => {
    const first = await json<{ list: TaskList }>(await send('POST', '/lists', { name: 'Work' }))
    const again = await json<{ list: TaskList }>(await send('POST', '/lists', { name: 'work' }))
    expect(again.list.id).toBe(first.list.id)
  })
})

describe('tags', () => {
  it('creates one, renames it and removes it from its tasks', async () => {
    const created = await json<{ tag: TaskTag }>(await send('POST', '/tags', { name: 'Focus', color: '#2563eb' }))
    expect(created.tag.color).toBe('#2563eb')
    const task = await create({ title: 'One', tags: ['Focus'] })
    expect(task.tags.map((tag) => tag.id)).toEqual([created.tag.id])

    const renamed = await json<{ tag: TaskTag }>(await send('PATCH', `/tags/${created.tag.id}`, { name: 'Deep work' }))
    expect(renamed.tag.name).toBe('Deep work')
    expect((await send('DELETE', `/tags/${created.tag.id}`)).status).toBe(200)
    const detail = await json<{ task: TodoTask }>(await send('GET', `/${task.id}`))
    expect(detail.task.tags).toEqual([])
  })
})

describe('steps', () => {
  it('adds, checks and removes one', async () => {
    const task = await create({ title: 'One' })
    const added = await json<{ step: TaskStep }>(await send('POST', `/${task.id}/steps`, { text: 'Collect receipts' }))
    expect(added.step.done).toBe(false)

    const checked = await json<{ step: TaskStep }>(await send('PATCH', `/${task.id}/steps/${added.step.id}`, { done: true }))
    expect(checked.step.done).toBe(true)
    const detail = await json<{ task: TodoTask }>(await send('GET', `/${task.id}`))
    expect(detail.task).toMatchObject({ stepTotal: 1, stepDone: 1 })

    expect((await send('DELETE', `/${task.id}/steps/${added.step.id}`)).status).toBe(200)
    expect((await send('PATCH', `/${task.id}/steps/${added.step.id}`, { done: true })).status).toBe(404)
  })
})

describe('another account', () => {
  it('cannot read or write a task by its id', async () => {
    const task = await create({ title: 'Mine' })
    mocks.userId = OTHER

    expect((await send('GET', `/${task.id}`)).status).toBe(404)
    expect((await send('PATCH', `/${task.id}`, { title: 'Stolen' })).status).toBe(404)
    expect((await send('DELETE', `/${task.id}`)).status).toBe(404)
    const page = await json<{ tasks: TodoTask[] }>(await send('GET', ''))
    expect(page.tasks).toEqual([])
  })
})
