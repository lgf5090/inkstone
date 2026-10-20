// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes, WRITE_BUDGET_PER_MINUTE } from '../src/worker/routes/todos'
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

  it('files the next occurrence when a repeating task is finished from the app', async () => {
    const due = Date.parse('2026-10-21T02:00:00Z')
    const task = await create({ title: 'Weekly report', dueAt: due, repeat: { freq: 'weekly', interval: 1 }, steps: ['Draft'] })

    const patched = await json<{ task: TodoTask, next?: TodoTask }>(await send('PATCH', `/${task.id}`, { status: 'done' }))

    expect(patched.task.status).toBe('done')
    // The same press means the same thing here as it does in the chat: finishing a repeating task files
    // the next one, and the answer carries it so the list can show it without a reload.
    expect(patched.next).toBeDefined()
    expect(patched.next!.status).toBe('todo')
    expect(patched.next!.dueAt).toBe(due + 7 * 24 * 60 * 60 * 1000)
    expect(patched.next!.stepTotal).toBe(1)
    expect(patched.next!.stepDone).toBe(0)

    const open = await json<{ tasks: TodoTask[] }>(await send('GET', '?status=open'))
    expect(open.tasks.map((entry) => entry.id)).toEqual([patched.next!.id])
  })

  it('does not file a second occurrence when the finished task is finished again', async () => {
    const task = await create({ title: 'Weekly report', dueAt: Date.now(), repeat: { freq: 'weekly', interval: 1 } })
    await send('PATCH', `/${task.id}`, { status: 'done' })

    const again = await json<{ task: TodoTask, next?: TodoTask }>(await send('PATCH', `/${task.id}`, { status: 'done' }))
    expect(again.next).toBeUndefined()
    expect((await json<{ tasks: TodoTask[] }>(await send('GET', '?status=open'))).tasks).toHaveLength(1)
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

describe('reminders', () => {
  const AT = Date.parse('2026-10-20T09:00:00Z')

  it('stores up to five absolute instants, ascending and deduplicated', async () => {
    const task = await create({
      title: 'Five alarms',
      reminders: [AT + 4 * 60_000, AT, AT + 2 * 60_000, AT, AT + 60_000, AT + 3 * 60_000],
    })
    expect(task.reminders).toEqual([AT, AT + 60_000, AT + 2 * 60_000, AT + 3 * 60_000, AT + 4 * 60_000])

    const patched = await json<{ task: TodoTask }>(await send('PATCH', `/${task.id}`, {
      reminders: [AT + 9 * 60_000],
    }))
    expect(patched.task.reminders).toEqual([AT + 9 * 60_000])
  })

  it('refuses a sixth reminder and any value that is not a timestamp', async () => {
    const six = Array.from({ length: 6 }, (_, index) => AT + index * 60_000)
    expect((await send('POST', '', { title: 'Too many', reminders: six })).status).toBe(400)
    expect((await send('POST', '', { title: 'Wrong shape', reminders: 'later' })).status).toBe(400)
    expect((await send('POST', '', { title: 'Not a number', reminders: [AT, 'soon'] })).status).toBe(400)

    const task = await create({ title: 'One' })
    expect((await send('PATCH', `/${task.id}`, { reminders: six })).status).toBe(400)
  })

  it('clears the list with an empty array', async () => {
    const task = await create({ title: 'One', reminders: [AT] })
    const cleared = await json<{ task: TodoTask }>(await send('PATCH', `/${task.id}`, { reminders: [] }))
    expect(cleared.task.reminders).toEqual([])
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

describe('the write budget', () => {
  // The budget is held in the route module, keyed by caller, and it rolls with the wall clock rather
  // than with a test — so a case that burns a minute of writes would answer 429 for every later case
  // that shares the caller. Each case takes a caller nobody else uses, and counts its own writes
  // instead of adding up request numbers by hand.
  let caller = 0
  let spent = 0

  // The bucket rolls with the wall clock, and a 60-write fill takes a fraction of a second — enough for
  // a slow machine to cross a minute boundary in the middle of one case and watch the budget reset under
  // it. Holding the clock still for these cases makes "the write past the budget" the same fact every run.
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function freshCaller(): string {
    caller += 1
    spent = 0
    mocks.userId = `budgetrate${String(caller).padStart(16, '0')}`
    return mocks.userId
  }

  /** Sends as the current caller, remembering that a write was spent. */
  async function write(method: string, path: string, body?: unknown): Promise<Response> {
    spent += 1
    return await send(method, path, body)
  }

  async function createTask(title: string): Promise<TodoTask> {
    const response = await write('POST', '', { title })
    expect(response.status).toBe(201)
    return (await json<{ task: TodoTask }>(response)).task
  }

  /** Fills the rest of the caller's minute with task creates, each of which has to be let through. */
  async function fillBudget(): Promise<void> {
    while (spent < WRITE_BUDGET_PER_MINUTE) {
      // A guard against a threshold someone raises past the point this fill is cheap, not a test of its own.
      expect(spent, 'the fill is not running away').toBeLessThan(1_000)
      expect((await write('POST', '', { title: `Filler ${spent + 1}` })).status).toBe(201)
    }
  }

  it('answers the write past the minute with the shape every other rejection uses', async () => {
    freshCaller()
    // A rejection from the validators, taken while the budget still has room: once the caller is
    // blocked nothing but a 429 comes back, and this is the body the 429 has to look like.
    const rejected = await json<{ error: Record<string, unknown> }>(await write('POST', '', {}))
    const task = await createTask('One')
    const list = (await json<{ list: TaskList }>(await write('POST', '/lists', { name: 'Work' }))).list
    expect((await write('PATCH', `/lists/${list.id}`, { name: 'Job' })).status).toBe(200)
    expect((await write('POST', '/tags', { name: 'Focus' })).status).toBe(201)
    const step = (await json<{ step: TaskStep }>(await write('POST', `/${task.id}/steps`, { text: 'Collect' }))).step
    expect((await write('PATCH', `/${task.id}/steps/${step.id}`, { done: true })).status).toBe(200)
    // Those writes went through tasks, lists, tags and steps and still came off one budget: the tier is
    // about how fast a client pushes, not about which endpoint it pushes through.
    await fillBudget()

    const blocked = await write('DELETE', `/${task.id}`)
    expect(blocked.status).toBe(429)
    const payload = await json<{ error: Record<string, unknown> }>(blocked)
    expect(Object.keys(payload)).toEqual(['error'])
    expect(Object.keys(payload.error).sort()).toEqual(Object.keys(rejected.error).sort())
    expect(payload.error.code).toBe('too_many_attempts')
    expect(String(payload.error.message)).toMatch(/minute/i)
  })

  it('leaves the reads running after the writes are spent', async () => {
    freshCaller()
    const task = await createTask('One')
    const list = (await json<{ list: TaskList }>(await write('POST', '/lists', { name: 'Work' }))).list
    const tag = (await json<{ tag: TaskTag }>(await write('POST', '/tags', { name: 'Focus' }))).tag
    await fillBudget()
    expect((await write('POST', '', { title: 'One write too many' })).status).toBe(429)

    expect((await send('GET', '')).status).toBe(200)
    expect((await send('GET', `/${task.id}`)).status).toBe(200)
    expect((await send('GET', '/lists')).status).toBe(200)
    expect((await send('GET', '/tags')).status).toBe(200)
    expect((await send('GET', `?list=${list.id}`)).status).toBe(200)
    expect((await send('GET', `?tag=${tag.id}`)).status).toBe(200)
  })

  it('counts one caller’s burst against no one else', async () => {
    const burst = freshCaller()
    await fillBudget()
    expect((await write('POST', '', { title: 'One write too many' })).status).toBe(429)

    const other = freshCaller()
    expect(other).not.toBe(burst)
    expect((await write('POST', '', { title: 'A different account' })).status).toBe(201)
    expect((await write('POST', '/lists', { name: 'Unblocked' })).status).toBe(201)

    // The block belongs to whoever burst, and it stands for the rest of that minute.
    mocks.userId = burst
    expect((await send('POST', '', { title: 'Still blocked' })).status).toBe(429)
  })
})
