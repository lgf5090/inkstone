// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes, WRITE_BUDGET_PER_MINUTE } from '../src/worker/routes/todos'
import { AssistantStore } from '../src/worker/assistant/store'
import {
  MAX_BATCH_TASKS,
  type TaskBatchResult,
  type TaskCounts,
  type TaskList,
  type TaskStep,
  type TaskTag,
  type TodoTask,
} from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

const mocks = vi.hoisted(() => ({ userId: '', settingsRaw: '{}' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { get: (key: string) => unknown; set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    c.set('user', {
      id: mocks.userId,
      username: mocks.userId,
      login: mocks.userId,
      name: '',
      avatarUrl: '',
      role: 'member',
      createdAt: 1,
      settingsRaw: mocks.settingsRaw,
    })
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
  mocks.settingsRaw = '{}'
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

describe('a batch of tasks', () => {
  // The write budget is module-wide and keyed by caller, so these cases spend a caller of their own
  // rather than the one every later case in this file shares.
  let caller = 0

  beforeEach(() => {
    caller += 1
    mocks.userId = `batchroute${String(caller).padStart(14, '0')}`
  })

  it('completes each row and files the next occurrence of a repeating one', async () => {
    const due = Date.parse('2026-10-21T02:00:00Z')
    const weekly = await create({ title: 'Weekly report', dueAt: due, repeat: { freq: 'weekly', interval: 1 } })
    const plain = await create({ title: 'Plain' })

    const response = await send('POST', '/batch', { ids: [weekly.id, plain.id], op: 'complete' })
    expect(response.status).toBe(200)
    expect(await json<TaskBatchResult>(response)).toEqual({ done: [weekly.id, plain.id], failed: [] })

    // The same press means the same thing here as it does on one card: the occurrence the repeat
    // files is a real row, not a status the batch wrote by hand.
    const open = await json<{ tasks: TodoTask[] }>(await send('GET', '?status=open'))
    expect(open.tasks).toHaveLength(1)
    expect(open.tasks[0]!.title).toBe('Weekly report')
    expect(open.tasks[0]!.id).not.toBe(weekly.id)
    expect(open.tasks[0]!.dueAt).toBe(due + 7 * 24 * 60 * 60 * 1000)
    const finished = await json<{ tasks: TodoTask[] }>(await send('GET', '?view=completed'))
    expect(finished.tasks.map((task) => task.id).sort()).toEqual([weekly.id, plain.id].sort())
  })

  it('keeps the rows it changed and names the ones it could not', async () => {
    const reader = mocks.userId
    const mine = await create({ title: 'Mine' })
    mocks.userId = OTHER
    const theirs = await create({ title: 'Theirs' })
    mocks.userId = reader

    const response = await send('POST', '/batch', {
      ids: [mine.id, theirs.id, 'not-a-task'],
      op: 'priority',
      value: 'urgent',
    })
    expect(response.status).toBe(200)
    expect(await json<TaskBatchResult>(response)).toEqual({
      done: [mine.id],
      failed: [
        { id: theirs.id, reason: 'not found' },
        { id: 'not-a-task', reason: 'not found' },
      ],
    })
    expect((await json<{ task: TodoTask }>(await send('GET', `/${mine.id}`))).task.priority).toBe('urgent')

    // Another account's row was not touched just because this batch could not see it.
    mocks.userId = OTHER
    expect((await json<{ task: TodoTask }>(await send('GET', `/${theirs.id}`))).task.priority).toBe('medium')
  })

  it('refuses more than a hundred ids, an empty list and an operation it does not know', async () => {
    const tooMany = Array.from({ length: MAX_BATCH_TASKS + 1 }, (_, index) => `batch-task-${index}`)
    expect((await send('POST', '/batch', { ids: tooMany, op: 'complete' })).status).toBe(400)
    expect((await send('POST', '/batch', { ids: [], op: 'complete' })).status).toBe(400)
    expect((await send('POST', '/batch', { ids: ['x'], op: 'archive' })).status).toBe(400)
    expect((await send('POST', '/batch', { ids: ['x'], op: 'move' })).status).toBe(400)
    expect((await send('POST', '/batch', { ids: ['x'], op: 'priority', value: 'someday' })).status).toBe(400)
  })

  it('moves, prioritises, stars and tags the rows it names', async () => {
    const list = await json<{ list: TaskList }>(await send('POST', '/lists', { name: 'Work' })).then((body) => body.list)
    const task = await create({ title: 'One', tags: ['Home'] })

    expect((await send('POST', '/batch', { ids: [task.id], op: 'move', value: list.id })).status).toBe(200)
    expect((await send('POST', '/batch', { ids: [task.id], op: 'priority', value: 'urgent' })).status).toBe(200)
    expect((await send('POST', '/batch', { ids: [task.id], op: 'star', value: 'true' })).status).toBe(200)
    expect((await send('POST', '/batch', { ids: [task.id], op: 'tag', value: 'Work' })).status).toBe(200)

    const detail = await json<{ task: TodoTask }>(await send('GET', `/${task.id}`))
    expect(detail.task).toMatchObject({ listId: list.id, priority: 'urgent', starred: true })
    // Tagging adds the word instead of replacing the vocabulary the row already carried.
    expect(detail.task.tags.map((tag) => tag.name).sort()).toEqual(['Home', 'Work'])
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

describe('the default reminder', () => {
  const DUE = Date.parse('2026-11-10T09:00:00Z')
  // The write budget is module-wide and keyed by caller; these cases spend their own minute so the
  // cases above and below keep the one the fixture gave them.
  let caller = 0

  beforeEach(() => {
    caller += 1
    mocks.userId = `defaultremind${String(caller).padStart(14, '0')}`
  })

  it('adds one at the account default offset to a new task with a due date', async () => {
    mocks.settingsRaw = JSON.stringify({ todo: { defaultRemind: 'due' } })
    const task = await create({ title: 'Renew the lease', dueAt: DUE })
    expect(task.reminders).toEqual([DUE])
  })

  it('does not override a reminder list the request spelled out', async () => {
    mocks.settingsRaw = JSON.stringify({ todo: { defaultRemind: 'due' } })
    const task = await create({ title: 'Mine', dueAt: DUE, reminders: [DUE - 15 * 60_000] })
    expect(task.reminders).toEqual([DUE - 15 * 60_000])
  })

  it('takes an explicit none as no reminder', async () => {
    mocks.settingsRaw = JSON.stringify({ todo: { defaultRemind: 'due' } })
    const cleared = await create({ title: 'Empty list', dueAt: DUE, reminders: [] })
    const offsetNone = await create({ title: 'Offset none', dueAt: DUE, remind: 'none' })
    expect(cleared.reminders).toEqual([])
    expect(offsetNone.reminders).toEqual([])
  })

  it('reads a remind offset the request sent instead of a list', async () => {
    mocks.settingsRaw = JSON.stringify({ todo: { defaultRemind: 'due' } })
    const task = await create({ title: 'Quarter hour', dueAt: DUE, remind: '15m' })
    expect(task.reminders).toEqual([DUE - 15 * 60_000])
  })

  it('does nothing for a task without a due date', async () => {
    mocks.settingsRaw = JSON.stringify({ todo: { defaultRemind: '1h' } })
    const task = await create({ title: 'Someday' })
    expect(task.reminders).toEqual([])
  })

  it('applies a changed default to the next task only', async () => {
    mocks.settingsRaw = JSON.stringify({ todo: { defaultRemind: 'due' } })
    const first = await create({ title: 'First', dueAt: DUE })
    mocks.settingsRaw = JSON.stringify({ todo: { defaultRemind: '1h' } })
    const second = await create({ title: 'Second', dueAt: DUE })

    expect(first.reminders).toEqual([DUE])
    expect(second.reminders).toEqual([DUE - 60 * 60_000])
  })
})

describe('snooze', () => {
  const AT = Date.parse('2026-10-20T09:00:00Z')
  const before = Date.now()

  it('appends a reminder and keeps the ones the task already had', async () => {
    const task = await create({ title: 'Snooze me', reminders: [AT] })

    const response = await send('POST', `/${task.id}/snooze`, { minutes: 10 })
    expect(response.status).toBe(200)
    const body = await json<{ task: TodoTask, reminders: number[] }>(response)

    expect(body.reminders).toHaveLength(2)
    // The original instant is still there: a snooze is a second chance, not a cancellation.
    expect(body.reminders).toContain(AT)
    const added = body.reminders.find((entry) => entry !== AT)!
    expect(added).toBeGreaterThanOrEqual(before + 10 * 60_000)
    expect(added).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
    expect(body.task.reminders).toEqual(body.reminders)
  })

  it('refuses a duration that is not one of the four steps', async () => {
    const task = await create({ title: 'One' })
    expect((await send('POST', `/${task.id}/snooze`, { minutes: 30 })).status).toBe(400)
    expect((await send('POST', `/${task.id}/snooze`, { minutes: '10' })).status).toBe(400)
    expect((await send('POST', `/${task.id}/snooze`, { until: new Date().toISOString() })).status).toBe(400)
  })

  it('refuses a finished task and a sixth reminder', async () => {
    const done = await create({ title: 'Done' })
    await send('PATCH', `/${done.id}`, { status: 'done' })
    expect((await send('POST', `/${done.id}/snooze`, { minutes: 10 })).status).toBe(400)

    const full = await create({ title: 'Full', reminders: [1, 2, 3, 4, 5].map((index) => AT + index * 60_000) })
    expect((await send('POST', `/${full.id}/snooze`, { minutes: 10 })).status).toBe(400)
  })

  it('cannot snooze another account\'s task', async () => {
    const task = await create({ title: 'Mine' })
    mocks.userId = OTHER
    expect((await send('POST', `/${task.id}/snooze`, { minutes: 10 })).status).toBe(404)
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

  it('spends one write per batch call, whatever the batch touches', async () => {
    freshCaller()
    const first = await createTask('One')
    const second = await createTask('Two')
    const third = await createTask('Three')
    while (spent < WRITE_BUDGET_PER_MINUTE - 1) {
      expect(spent, 'the fill is not running away').toBeLessThan(1_000)
      expect((await write('POST', '', { title: `Filler ${spent + 1}` })).status).toBe(201)
    }

    // The batch is the minute's sixtieth spend even though it changes three rows: a batch is one call
    // by the client, so it is one spend on the same bucket every other write already uses — not a
    // hundred, and not an unmetered door.
    expect((await write('POST', '/batch', {
      ids: [first.id, second.id, third.id], op: 'priority', value: 'high',
    })).status).toBe(200)
    expect((await write('DELETE', `/${first.id}`)).status).toBe(429)
  })
})
