// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes, WRITE_BUDGET_PER_MINUTE } from '../src/worker/routes/todos'
import { todoFeedRoutes } from '../src/worker/routes/todo-feeds'
import { localDate, parseLocalTime } from '../src/shared/assistant-time'
import { LIMITS } from '../src/shared/constants'
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
  instance.route('/feeds', todoFeedRoutes)
  return instance
}

async function send(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = { method }
  const merged = { ...headers }
  if (body !== undefined) {
    merged['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  if (Object.keys(merged).length) init.headers = merged
  return app().request(`/api/todos${path}`, init, env)
}

/** The public half: what a calendar polls after the owner copied the address. */
async function fetchFeed(path: string): Promise<Response> {
  return app().request(`http://localhost/feeds${path}`, { method: 'GET' }, env)
}

interface FeedAnswer {
  slug: string
  url: string
  hasPassword: boolean
  expiresAt: number | null
  createdAt: number
}

/** A list as the routes serialise one: the shared shape plus where it sits and whether it is put away. */
interface ListAnswer extends TaskList {
  archivedAt: number | null
  parentId: string | null
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

describe('list position validation', () => {
  // The case spends a caller of its own: the write budget is module-wide and keyed by whoever is
  // signed in, and six refusals plus two lands are not what the shared account's later cases signed
  // up for.
  let caller = 0

  beforeEach(() => {
    caller += 1
    mocks.userId = `listpos${String(caller).padStart(19, '0')}`
  })

  it('refuses a list position that is not a whole non-negative number', async () => {
    const list = await json<{ list: TaskList }>(await send('POST', '/lists', { name: 'Sort' })).then((body) => body.list)
    // The store only truncates what it is handed before binding it to the INTEGER column, and
    // `Math.trunc(NaN)` is NaN — so the route is the trust boundary that says no. JSON has no NaN:
    // stringified it arrives as null, and that reads as the same refusal, as do a fraction, a
    // negative and an unbounded number.
    expect((await send('PATCH', `/lists/${list.id}`, { position: NaN })).status).toBe(400)
    expect((await send('PATCH', `/lists/${list.id}`, { position: -1 })).status).toBe(400)
    expect((await send('PATCH', `/lists/${list.id}`, { position: 1.5 })).status).toBe(400)
    expect((await send('PATCH', `/lists/${list.id}`, { position: Infinity })).status).toBe(400)
    // A whole non-negative number still lands, and an absent field is not a move: the row keeps the
    // position the last move left it.
    const moved = await json<{ list: TaskList }>(await send('PATCH', `/lists/${list.id}`, { position: 2000 }))
    expect(moved.list.position).toBe(2000)
    const untouched = await json<{ list: TaskList }>(await send('PATCH', `/lists/${list.id}`, { name: 'Sorted' }))
    expect(untouched.list.position).toBe(2000)
  })
})

describe('list archiving and grouping', () => {
  // Each case spends a caller of its own: the write budget is module-wide and keyed by whoever is
  // signed in, and these cases must not eat into what the list cases above already spent.
  let caller = 0

  beforeEach(() => {
    caller += 1
    mocks.userId = `listorgan${String(caller).padStart(15, '0')}`
  })

  it('hides an archived list and its tasks from the counts until the archive is asked for', async () => {
    const list = await json<{ list: ListAnswer }>(await send('POST', '/lists', { name: 'Work' })).then((body) => body.list)
    await create({ title: 'Still there', listId: list.id })

    const archived = await json<{ list: ListAnswer }>(await send('PATCH', `/lists/${list.id}`, { archived: true }))
    expect(archived.list.archivedAt).toBeGreaterThan(0)
    expect((await json<{ lists: ListAnswer[] }>(await send('GET', '/lists'))).lists.map((entry) => entry.id))
      .not.toContain(list.id)
    expect((await json<{ lists: ListAnswer[] }>(await send('GET', '/lists?archived=1'))).lists.map((entry) => entry.id))
      .toEqual([list.id])
    // Archiving is a statement about the list, not about the rows it holds: nothing is deleted, which is
    // why un-archiving below brings the very same task back. What does change is visibility — the
    // put-away list's rows leave every listing, badge, board card and feed. Pinning only the badge is
    // what let a badge of 0 and a row set of 1 live in the same answer.
    const filed = await json<{ tasks: TodoTask[], total: number }>(await send('GET', `?list=${list.id}`))
    expect(filed.tasks).toEqual([])
    expect(filed.total).toBe(0)
    // Every count that reads the account's open work leaves the put-away list out.
    expect((await json<{ counts: TaskCounts }>(await send('GET', ''))).counts.all).toBe(0)

    const restored = await json<{ list: ListAnswer }>(await send('PATCH', `/lists/${list.id}`, { archived: false }))
    expect(restored.list.archivedAt).toBeNull()
    expect((await json<{ lists: ListAnswer[] }>(await send('GET', '/lists'))).lists.map((entry) => entry.id))
      .toEqual([list.id])
    expect((await json<{ lists: ListAnswer[] }>(await send('GET', '/lists?archived=1'))).lists).toEqual([])
    expect((await json<{ counts: TaskCounts }>(await send('GET', ''))).counts.all).toBe(1)
  })

  it('keeps one visibility rule across the badge, the row set, the board card and the feed', async () => {
    const shelf = (await json<{ list: ListAnswer }>(await send('POST', '/lists', { name: 'Shelf' }))).list
    const desk = (await json<{ list: ListAnswer }>(await send('POST', '/lists', { name: 'Desk' }))).list
    const tag = (await json<{ tag: TaskTag }>(await send('POST', '/tags', { name: 'Home' }))).tag
    const soon = Date.now() + 60 * 60 * 1000
    await create({ title: 'On the shelf', listId: shelf.id, dueAt: soon, tags: ['Home'] })
    await create({ title: 'Also shelved', listId: shelf.id })
    const visible = await create({ title: 'On the desk', listId: desk.id, dueAt: soon, tags: ['Home'] })

    // The subscription is one of the four surfaces, so it is read before the shelf is put away: a feed
    // a third-party calendar already holds has to lose the row on the next poll, not keep it forever.
    const feed = (await json<{ feed: FeedAnswer }>(await send('POST', '/feed', {}))).feed
    const before = await (await fetchFeed(`/${feed.slug}.ics`)).text()
    expect(before).toContain('On the shelf')
    expect(before).toContain('On the desk')

    await send('PATCH', `/lists/${shelf.id}`, { archived: true })

    // The equality that was missing: the badge a screen prints and the rows that same screen draws are
    // the same number, because both read the same predicate.
    const open = await json<{ tasks: TodoTask[], total: number, counts: TaskCounts }>(await send('GET', '?view=open'))
    expect(open.tasks.map((task) => task.id)).toEqual([visible.id])
    expect(open.total).toBe(1)
    expect(open.counts.all).toBe(open.tasks.length)
    // The board card for a put-away list shows no work at all, and the shelf keeps its own number out.
    expect(open.counts.byList[shelf.id]).toBeUndefined()
    expect(open.counts.byList[desk.id]).toEqual({ open: 1, done: 0 })
    expect((await json<{ tasks: TodoTask[] }>(await send('GET', `?list=${shelf.id}`))).tasks).toEqual([])
    expect((await json<{ tasks: TodoTask[] }>(await send('GET', `?list=${desk.id}`))).tasks).toHaveLength(1)

    // A tag badge is the same promise on a different screen, and so is the tag's own row.
    const tagged = await json<{ tasks: TodoTask[], counts: TaskCounts }>(await send('GET', `?view=open&tag=${tag.id}`))
    expect(tagged.tasks.map((task) => task.id)).toEqual([visible.id])
    expect(tagged.counts.byTag[tag.id]).toEqual({ open: tagged.tasks.length, done: 0 })
    const tags = await json<{ tags: TaskTag[] }>(await send('GET', '/tags'))
    expect(tags.tags.find((entry) => entry.id === tag.id)?.openCount).toBe(tagged.tasks.length)

    const after = await (await fetchFeed(`/${feed.slug}.ics`)).text()
    expect(after).not.toContain('On the shelf')
    expect(after).toContain('On the desk')

    // Statistics are the one surface the ruling keeps open: "how much did I do" is about the work, not
    // about which shelf it sits on, so all three rows are still counted there.
    const stats = await json<{ summary: { open: number } }>(await send('GET', '/stats'))
    expect(stats.summary.open).toBe(3)
  })

  it('groups lists one level deep and refuses a loop or a grandchild', async () => {
    const parent = await json<{ list: ListAnswer }>(await send('POST', '/lists', { name: 'Travel' })).then((body) => body.list)
    const child = await json<{ list: ListAnswer }>(await send('POST', '/lists', { name: 'Booking' })).then((body) => body.list)
    const other = await json<{ list: ListAnswer }>(await send('POST', '/lists', { name: 'Work' })).then((body) => body.list)

    const grouped = await json<{ list: ListAnswer }>(await send('PATCH', `/lists/${child.id}`, { parentId: parent.id }))
    expect(grouped.list.parentId).toBe(parent.id)
    // The flat listing carries the pointer the organizer page groups by.
    expect((await json<{ lists: ListAnswer[] }>(await send('GET', '/lists'))).lists
      .find((entry) => entry.id === child.id)?.parentId).toBe(parent.id)

    // A list is not its own parent.
    expect((await send('PATCH', `/lists/${parent.id}`, { parentId: parent.id })).status).toBe(400)
    // The child cannot become the parent of its own parent.
    expect((await send('PATCH', `/lists/${parent.id}`, { parentId: child.id })).status).toBe(400)
    // A child cannot be used as a container, because that would be a second level.
    expect((await send('PATCH', `/lists/${other.id}`, { parentId: child.id })).status).toBe(400)
    // A container cannot itself move under another list.
    expect((await send('PATCH', `/lists/${parent.id}`, { parentId: other.id })).status).toBe(400)
    // An unknown parent is a bad request about the list, not a silent move to the top level.
    expect((await send('PATCH', `/lists/${other.id}`, { parentId: '0000000000abcdefghijklmnopqrzz' })).status).toBe(400)
    // A parent that belongs to somebody else is no parent in this account.
    const reader = mocks.userId
    mocks.userId = `${reader}elsewhere`
    const theirs = await json<{ list: ListAnswer }>(await send('POST', '/lists', { name: 'Elsewhere' })).then((body) => body.list)
    mocks.userId = reader
    expect((await send('PATCH', `/lists/${other.id}`, { parentId: theirs.id })).status).toBe(400)

    const cleared = await json<{ list: ListAnswer }>(await send('PATCH', `/lists/${child.id}`, { parentId: null }))
    expect(cleared.list.parentId).toBeNull()
  })

  it('does not archive or regroup another account’s list', async () => {
    const reader = mocks.userId
    const mine = await json<{ list: ListAnswer }>(await send('POST', '/lists', { name: 'Mine' })).then((body) => body.list)
    mocks.userId = `${reader}other`

    expect((await send('PATCH', `/lists/${mine.id}`, { archived: true })).status).toBe(404)
    expect((await send('PATCH', `/lists/${mine.id}`, { parentId: null })).status).toBe(404)

    mocks.userId = reader
    const list = (await json<{ lists: ListAnswer[] }>(await send('GET', '/lists'))).lists.find((entry) => entry.id === mine.id)
    expect(list).toMatchObject({ archivedAt: null, parentId: null })
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

describe('the step order', () => {
  // The write budget is module-wide and keyed by caller, so these cases spend a caller of their own
  // rather than the one every earlier case in this file shares.
  let caller = 0

  beforeEach(() => {
    caller += 1
    mocks.userId = `steporder${String(caller).padStart(15, '0')}`
  })

  async function stepsOf(taskId: string): Promise<TaskStep[]> {
    return (await json<{ steps: TaskStep[] }>(await send('GET', `/${taskId}`))).steps
  }

  const texts = (steps: TaskStep[]): string[] => steps.map((step) => step.text)

  it('moves a step to an index, before a sibling, and to the end', async () => {
    const task = await create({ title: 'Publish', steps: ['Write', 'Review', 'Ship'] })
    const [, review, ship] = await stepsOf(task.id)

    // `position` is the zero-based index the row lands on after the move.
    expect((await send('PATCH', `/${task.id}/steps/${ship!.id}`, { position: 0 })).status).toBe(200)
    expect(texts(await stepsOf(task.id))).toEqual(['Ship', 'Write', 'Review'])

    // `beforeStepId` anchors the row to a sibling, wherever that sibling currently sits.
    expect((await send('PATCH', `/${task.id}/steps/${ship!.id}`, { beforeStepId: review!.id })).status).toBe(200)
    expect(texts(await stepsOf(task.id))).toEqual(['Write', 'Ship', 'Review'])

    // A null anchor is the end, which is how the last "move down" lands.
    const [write] = await stepsOf(task.id)
    expect((await send('PATCH', `/${task.id}/steps/${write!.id}`, { beforeStepId: null })).status).toBe(200)
    expect(texts(await stepsOf(task.id))).toEqual(['Ship', 'Review', 'Write'])
  })

  it('keeps the order at both ends instead of running off them', async () => {
    const task = await create({ title: 'Edge', steps: ['First', 'Middle', 'Last'] })
    const steps = await stepsOf(task.id)
    const [first, , last] = steps

    // The ends a keyboard reaches and stops at: the row stays where it is.
    expect((await send('PATCH', `/${task.id}/steps/${first!.id}`, { position: 0 })).status).toBe(200)
    expect((await send('PATCH', `/${task.id}/steps/${last!.id}`, { position: 2 })).status).toBe(200)
    // An index past the end is the end, not a fourth place beyond the list.
    expect((await send('PATCH', `/${task.id}/steps/${last!.id}`, { position: 99 })).status).toBe(200)

    const after = await stepsOf(task.id)
    expect(texts(after)).toEqual(['First', 'Middle', 'Last'])
    // The stored order is still strictly ascending: clamping collapsed the index onto the end
    // instead of writing a position past every sibling.
    expect(after.map((step) => step.position)).toEqual([...after.map((step) => step.position)].sort((a, b) => a - b))
  })

  it('cannot reorder another account’s step', async () => {
    const mine = await create({ title: 'Mine', steps: ['One', 'Two'] })
    const [one] = await stepsOf(mine.id)
    mocks.userId = `${mocks.userId}other`

    expect((await send('PATCH', `/${mine.id}/steps/${one!.id}`, { position: 1 })).status).toBe(404)
    expect((await send('PATCH', `/${mine.id}/steps/${one!.id}`, { beforeStepId: null })).status).toBe(404)
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

  it('appends the rows a batch moves to the end of the destination list', async () => {
    const source = (await json<{ list: TaskList }>(await send('POST', '/lists', { name: 'Source' }))).list
    const target = (await json<{ list: TaskList }>(await send('POST', '/lists', { name: 'Target' }))).list
    const t1 = await create({ title: 'T1', listId: target.id })
    const t2 = await create({ title: 'T2', listId: target.id })
    const s1 = await create({ title: 'S1', listId: source.id })
    const s2 = await create({ title: 'S2', listId: source.id })

    // Both lists get a hand-made order, so every row in the way carries a place of its own.
    expect((await send('POST', `/${t2.id}/move`, { beforeId: t1.id })).status).toBe(200)
    expect((await send('POST', `/${s2.id}/move`, { beforeId: s1.id })).status).toBe(200)
    const lastPlace = (sqlite.prepare('SELECT MAX(position) AS p FROM todos_tasks WHERE list_id = ?')
      .get(target.id) as { p: number }).p!

    const response = await send('POST', '/batch', { ids: [s2.id], op: 'move', value: target.id })
    expect(response.status).toBe(200)
    expect(await json<TaskBatchResult>(response)).toEqual({ done: [s2.id], failed: [] })

    // A batch move means the same thing a card drop means: the end of the destination. Keeping the old
    // place from the source list is how a row slid into the middle of an order nobody put it in.
    const order = (await json<{ tasks: TodoTask[] }>(await send('GET', `?list=${target.id}`))).tasks
      .map((task) => task.title)
    expect(order).toEqual(['T2', 'T1', 'S2'])
    const movedPlace = (sqlite.prepare('SELECT position AS p FROM todos_tasks WHERE id = ?')
      .get(s2.id) as { p: number }).p!
    expect(movedPlace).toBeGreaterThan(lastPlace)
    // The source list keeps the order the rest of its rows had.
    expect((await json<{ tasks: TodoTask[] }>(await send('GET', `?list=${source.id}`))).tasks
      .map((task) => task.title)).toEqual(['S1'])
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

  it('moves overdue rows to the end of today without touching their plan', async () => {
    const overdue = await create({ title: 'Late invoice', dueAt: Date.parse('2020-01-01T09:00:00Z') })
    expect((await send('POST', `/${overdue.id}/plan`, { date: '2026-10-20' })).status).toBe(200)

    const response = await send('POST', '/batch', { ids: [overdue.id], op: 'due' })
    expect(response.status).toBe(200)
    expect(await json<TaskBatchResult>(response)).toEqual({ done: [overdue.id], failed: [] })

    const detail = await json<{ task: TodoTask }>(await send('GET', `/${overdue.id}`))
    // The plan is a separate fact: shifting the due date must not move the row into or out of today.
    expect(detail.task.plannedFor).toBe('2026-10-20')
    const today = localDate(Date.now(), 'UTC')
    expect(detail.task.dueAt).toBe(parseLocalTime(today, 'UTC'))
  })

  it('takes an explicit day for a due batch', async () => {
    const task = await create({ title: 'Later', dueAt: Date.parse('2020-01-01T09:00:00Z') })
    expect((await send('POST', '/batch', { ids: [task.id], op: 'due', value: '2030-01-02' })).status).toBe(200)
    const detail = await json<{ task: TodoTask }>(await send('GET', `/${task.id}`))
    expect(detail.task.dueAt).toBe(parseLocalTime('2030-01-02', 'UTC'))
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

describe('calendar subscriptions', () => {
  const DAY = 24 * 60 * 60 * 1000
  // Each case spends a caller of its own: the write budget is module-wide and keyed by whoever is
  // signed in, and these cases must not eat into what the task cases above already spent.
  let caller = 0

  beforeEach(() => {
    caller += 1
    mocks.userId = `feedroute${String(caller).padStart(14, '0')}`
  })

  async function createFeed(body: Record<string, unknown> = {}): Promise<FeedAnswer> {
    const response = await send('POST', '/feed', body)
    expect(response.status).toBe(201)
    return (await json<{ feed: FeedAnswer }>(response)).feed
  }

  it('mints, lists, serves and soft-revokes one feed without reusing its slug', async () => {
    const before = Date.now()
    const feed = await createFeed({ expiresIn: 7 * DAY })

    expect(feed.slug).toMatch(/^[0-9a-hjkmnp-tv-z]{20}$/)
    expect(feed.url).toBe(`http://localhost/feeds/${feed.slug}.ics`)
    expect(feed.hasPassword).toBe(false)
    expect(feed.expiresAt).toBeGreaterThanOrEqual(before + 7 * DAY - 1_000)
    expect(feed.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * DAY)
    expect(feed.createdAt).toBeGreaterThanOrEqual(before)

    const listed = await json<{ feeds: FeedAnswer[] }>(await send('GET', '/feed'))
    expect(listed.feeds).toEqual([feed])
    expect((await fetchFeed(`/${feed.slug}.ics`)).status).toBe(200)

    expect(await json<{ ok: true }>(await send('DELETE', `/feed/${feed.slug}`))).toEqual({ ok: true })
    // Revocation is a stamp, not a deletion: the row survives so the address can never be minted again.
    const row = sqlite.prepare('SELECT revoked_at FROM todos_feeds WHERE slug = ?').get(feed.slug) as {
      revoked_at: number | null
    }
    expect(row.revoked_at).toBeGreaterThan(0)

    expect((await json<{ feeds: FeedAnswer[] }>(await send('GET', '/feed'))).feeds).toEqual([])
    expect((await fetchFeed(`/${feed.slug}.ics`)).status).toBe(404)
    // Deleting a dead address again is a 404 rather than a success the caller could read as "still live".
    expect((await send('DELETE', `/feed/${feed.slug}`)).status).toBe(404)
  })

  it('stores a passcode hash, returns only the marker, and never puts the passcode in the URL', async () => {
    const password = 'correct horse battery'
    const feed = await createFeed({ password })

    expect(feed.hasPassword).toBe(true)
    expect(feed.url).not.toContain(password)
    expect(feed.url).not.toContain('key=')
    const created = JSON.stringify(feed)
    expect(created).not.toContain(password)
    expect(created).not.toContain('scrypt')

    const stored = sqlite.prepare('SELECT password_hash FROM todos_feeds WHERE slug = ?').get(feed.slug) as {
      password_hash: string
    }
    expect(stored.password_hash).toMatch(/^scrypt\$/)
    expect(stored.password_hash).not.toContain(password)

    const listText = await (await send('GET', '/feed')).text()
    expect(listText).not.toContain(password)
    expect(listText).not.toContain('scrypt')

    expect((await fetchFeed(`/${feed.slug}.ics`)).status).toBe(401)
    expect((await fetchFeed(`/${feed.slug}.ics?key=${encodeURIComponent(password)}`)).status).toBe(200)
  })

  it('keeps one account’s feeds out of another account’s list and revoke', async () => {
    const owner = mocks.userId
    const feed = await createFeed()
    const intruder = `${owner}other`

    mocks.userId = intruder
    expect((await json<{ feeds: FeedAnswer[] }>(await send('GET', '/feed'))).feeds).toEqual([])
    expect((await send('DELETE', `/feed/${feed.slug}`)).status).toBe(404)

    mocks.userId = owner
    expect((await json<{ feeds: FeedAnswer[] }>(await send('GET', '/feed'))).feeds.map((entry) => entry.slug)).toEqual([feed.slug])
    expect((await fetchFeed(`/${feed.slug}.ics`)).status).toBe(200)
  })

  it('refuses an expiry or a passcode it cannot honour, and writes nothing', async () => {
    for (const expiresIn of [-1, 'week', true]) {
      expect((await send('POST', '/feed', { expiresIn })).status).toBe(400)
    }
    for (const password of ['short', 'x'.repeat(LIMITS.passwordMaxLength + 1), 42]) {
      expect((await send('POST', '/feed', { password })).status).toBe(400)
    }
    expect((await send('DELETE', '/feed/short')).status).toBe(404)
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM todos_feeds').get() as { n: number }
    expect(count.n).toBe(0)
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

describe('a conditional write', () => {
  // The write budget is module-wide and keyed by caller, so each case spends a caller of its own.
  let caller = 0

  beforeEach(() => {
    caller += 1
    mocks.userId = `revcase${String(caller).padStart(19, '0')}`
    mocks.settingsRaw = '{}'
  })

  it('refuses an edit that names a revision the row has moved past, and writes nothing', async () => {
    const task = await create({ title: 'Draft' })
    expect(task.rev).toBe(1)

    const first = await send('PATCH', `/${task.id}`, { title: 'First edit' }, { 'If-Match': '"1"' })
    expect(first.status).toBe(200)
    const saved = (await json<{ task: TodoTask }>(first)).task
    // The write moves the revision on and hands the new one back, so the caller can guard its next save.
    expect(saved.rev).toBe(2)
    expect((await json<{ task: TodoTask }>(await send('GET', `/${task.id}`))).task.rev).toBe(2)

    const stale = await send('PATCH', `/${task.id}`, { title: 'Second edit' }, { 'If-Match': '1' })
    expect(stale.status).toBe(409)
    const conflict = await json<{ error: { code: string, details: { id: string, rev: number } } }>(stale)
    expect(conflict.error.code).toBe('conflict')
    // The revision that really stands rides in the refusal, so a client can retry without a second read.
    expect(conflict.error.details).toEqual({ id: task.id, rev: 2 })

    // A refused write is zero writes: the first edit is still the only content.
    const detail = await json<{ task: TodoTask }>(await send('GET', `/${task.id}`))
    expect(detail.task.title).toBe('First edit')
    expect(detail.task.rev).toBe(2)
  })

  it('reads a body revision when no header is sent, and lets the header win when both are', async () => {
    const task = await create({ title: 'Draft' })

    const viaBody = await send('PATCH', `/${task.id}`, { title: 'Body edit', rev: 1 })
    expect(viaBody.status).toBe(200)
    expect((await json<{ task: TodoTask }>(viaBody)).task.rev).toBe(2)

    // The header and the body disagree; the header is the guard that is honoured.
    const guarded = await send('PATCH', `/${task.id}`, { title: 'Body wins?', rev: 2 }, { 'If-Match': '1' })
    expect(guarded.status).toBe(409)
    expect((await json<{ task: TodoTask }>(await send('GET', `/${task.id}`))).task.title).toBe('Body edit')

    // A guard this route cannot read is a refusal rather than an unconditional write.
    expect((await send('PATCH', `/${task.id}`, { title: 'Unguarded' }, { 'If-Match': 'soon' })).status).toBe(400)
  })

  it('refuses a stale pick, move and snooze and leaves the row as it was', async () => {
    const anchor = await create({ title: 'Anchor' })
    const task = await create({ title: 'Plan me' })
    const planned = await send('POST', `/${task.id}/plan`, { date: '2026-10-21', rev: 1 })
    expect(planned.status).toBe(200)
    expect((await json<{ task: TodoTask }>(planned)).task.plannedFor).toBe('2026-10-21')

    const stalePlan = await send('POST', `/${task.id}/plan`, { date: null, rev: 1 })
    expect(stalePlan.status).toBe(409)
    expect((await json<{ task: TodoTask }>(await send('GET', `/${task.id}`))).task.plannedFor).toBe('2026-10-21')

    // A move is the other write the app makes without naming a column: its place came from a listing,
    // and a row that moved since that listing is not the reader's to re-place.
    const staleMove = await send('POST', `/${task.id}/move`, { beforeId: anchor.id, rev: 1 })
    expect(staleMove.status).toBe(409)
    expect((await json<{ error: { details: { rev: number } } }>(staleMove)).error.details.rev).toBe(2)

    const fresh = (await json<{ task: TodoTask }>(await send('GET', `/${task.id}`))).task
    const moved = await send('POST', `/${task.id}/move`, { beforeId: anchor.id, rev: fresh.rev })
    expect(moved.status).toBe(200)
    const afterMove = (await json<{ task: TodoTask }>(await send('GET', `/${task.id}`))).task
    expect(afterMove.rev).toBe(fresh.rev! + 1)

    const snoozed = await send('POST', `/${task.id}/snooze`, { minutes: 10, rev: afterMove.rev })
    expect(snoozed.status).toBe(200)
    const staleSnooze = await send('POST', `/${task.id}/snooze`, { minutes: 10, rev: afterMove.rev })
    expect(staleSnooze.status).toBe(409)
    // The refused snooze appended nothing: one reminder, not two.
    expect((await json<{ task: TodoTask }>(await send('GET', `/${task.id}`))).task.reminders).toHaveLength(1)
  })

  it('answers a stale revision per row instead of failing the whole batch', async () => {
    const fresh = await create({ title: 'Fresh' })
    const moved = await create({ title: 'Moved' })
    await send('PATCH', `/${moved.id}`, { title: 'Moved elsewhere' })
    expect((await json<{ task: TodoTask }>(await send('GET', `/${moved.id}`))).task.rev).toBe(2)

    const response = await send('POST', '/batch', {
      ids: [fresh.id, moved.id],
      op: 'star',
      revs: { [fresh.id]: 1, [moved.id]: 1 },
    })
    expect(response.status).toBe(200)
    // A batch is still not all-or-nothing: the row that matched changed, the stale one is named.
    expect(await json<TaskBatchResult>(response)).toEqual({
      done: [fresh.id],
      failed: [{ id: moved.id, reason: 'conflict' }],
    })

    expect((await json<{ task: TodoTask }>(await send('GET', `/${fresh.id}`))).task.starred).toBe(true)
    expect((await json<{ task: TodoTask }>(await send('GET', `/${moved.id}`))).task.starred).toBe(false)
  })
})

/**
 * Manual order: one column, one anchor and the half-fold every drag lands on.
 *
 * The contract pinned here is the one the client draws against: a row is placed before the row it
 * names (or at the end), a position is folded between its two neighbours when the gap allows it, and
 * a listing read without a sort answers in that manual order first while rows nobody has placed keep
 * the order the view has always used. An explicit sort is the reader's chosen reading and ignores the
 * stored position entirely.
 */
describe('the task order', () => {
  // The write budget is module-wide and keyed by caller, so these cases spend a caller of their own.
  let caller = 0

  beforeEach(() => {
    caller += 1
    mocks.userId = `taskorder${String(caller).padStart(14, '0')}`
  })

  async function order(path = ''): Promise<string[]> {
    return (await json<{ tasks: TodoTask[] }>(await send('GET', path))).tasks.map((task) => task.title)
  }

  async function positionOf(id: string): Promise<number | null> {
    const row = sqlite.prepare('SELECT position FROM todos_tasks WHERE id = ?').get(id) as { position: number | null }
    return row.position
  }

  it('lands a row before an anchor and folds its position between the neighbours', async () => {
    const a = await create({ title: 'A' })
    const b = await create({ title: 'B' })
    await create({ title: 'C' })

    // The first move makes the list's current order explicit, then puts C in front of A.
    const first = await send('POST', `/${(await json<{ tasks: TodoTask[] }>(await send('GET', ''))).tasks[2]!.id}/move`, { beforeId: a.id })
    expect(first.status).toBe(200)
    expect(await order()).toEqual(['C', 'A', 'B'])

    // B between C (0) and A (1000) is the folded midpoint, not an appended integer.
    const moved = await send('POST', `/${b.id}/move`, { beforeId: a.id })
    expect(moved.status).toBe(200)
    expect(await order()).toEqual(['C', 'B', 'A'])
    const cPosition = await positionOf((await json<{ tasks: TodoTask[] }>(await send('GET', ''))).tasks[0]!.id)
    const bPosition = await positionOf(b.id)
    const aPosition = await positionOf(a.id)
    expect(bPosition).toBeGreaterThan(cPosition!)
    expect(bPosition).toBeLessThan(aPosition!)
    expect(bPosition! - cPosition!).toBe(500)
  })

  it('keeps both ends when a row moves to the front or the end', async () => {
    const a = await create({ title: 'A' })
    const b = await create({ title: 'B' })
    const c = await create({ title: 'C' })

    expect((await send('POST', `/${c.id}/move`, { beforeId: a.id })).status).toBe(200)
    expect(await order()).toEqual(['C', 'A', 'B'])

    // A null anchor is the end, which is how the last "move down" lands.
    expect((await send('POST', `/${a.id}/move`, { beforeId: null })).status).toBe(200)
    expect(await order()).toEqual(['C', 'B', 'A'])

    // And the front is an anchor rather than an index, so it does not depend on the row's old slot.
    expect((await send('POST', `/${a.id}/move`, { beforeId: c.id })).status).toBe(200)
    expect(await order()).toEqual(['A', 'C', 'B'])
    // The stored places are strictly ascending in the order the list now reads.
    const ordered = (await json<{ tasks: TodoTask[] }>(await send('GET', ''))).tasks
    const positions = await Promise.all(ordered.map((task) => positionOf(task.id)))
    expect(positions).toEqual([...positions].sort((left, right) => left! - right!))
  })

  it('moves a task between lists and writes the destination with its place', async () => {
    const source = await json<{ list: TaskList }>(await send('POST', '/lists', { name: 'Source' })).then((body) => body.list)
    const target = await json<{ list: TaskList }>(await send('POST', '/lists', { name: 'Target' })).then((body) => body.list)
    const one = await create({ title: 'One', listId: source.id })
    await create({ title: 'Two', listId: target.id })
    const three = await create({ title: 'Three', listId: target.id })

    const moved = await json<{ task: TodoTask }>(await send('POST', `/${one.id}/move`, {
      beforeId: three.id,
      listId: target.id,
    }))
    expect(moved.task.listId).toBe(target.id)
    expect(await order(`?list=${target.id}`)).toEqual(['Two', 'One', 'Three'])
    expect(await order(`?list=${source.id}`)).toEqual([])
  })

  it('refuses an anchor outside the destination, itself, and a body with no anchor field', async () => {
    const mine = await create({ title: 'Mine' })
    const sibling = await create({ title: 'Sibling' })
    const otherList = await json<{ list: TaskList }>(await send('POST', '/lists', { name: 'Other' })).then((body) => body.list)
    const elsewhere = await create({ title: 'Elsewhere', listId: otherList.id })

    expect((await send('POST', `/${mine.id}/move`, { beforeId: mine.id })).status).toBe(400)
    expect((await send('POST', `/${mine.id}/move`, { beforeId: elsewhere.id })).status).toBe(400)
    expect((await send('POST', `/${mine.id}/move`, {})).status).toBe(400)
    expect((await send('POST', `/${mine.id}/move`, { beforeId: sibling.id, listId: '0000000000abcdefghijklmnopqrzz' })).status).toBe(400)
    // A refused move writes nothing: the list still reads in the order it had.
    expect(await order(`?list=${otherList.id}`)).toEqual(['Elsewhere'])
    expect((await json<{ tasks: TodoTask[] }>(await send('GET', '?list=none'))).tasks.map((task) => task.title))
      .toEqual(['Mine', 'Sibling'])
  })

  it('cannot reorder another account’s task', async () => {
    const mine = await create({ title: 'Mine' })
    mocks.userId = `${mocks.userId}other`
    expect((await send('POST', `/${mine.id}/move`, { beforeId: null })).status).toBe(404)
  })

  it('reads manual order by default and leaves an explicit sort alone', async () => {
    const list = await json<{ list: TaskList }>(await send('POST', '/lists', { name: 'Dated' })).then((body) => body.list)
    const a = await create({ title: 'A', listId: list.id, dueAt: Date.parse('2026-10-01T09:00:00Z') })
    const b = await create({ title: 'B', listId: list.id, dueAt: Date.parse('2026-10-02T09:00:00Z') })
    const c = await create({ title: 'C', listId: list.id, dueAt: Date.parse('2026-10-03T09:00:00Z') })

    expect((await send('POST', `/${c.id}/move`, { beforeId: a.id })).status).toBe(200)
    expect(await order(`?list=${list.id}`)).toEqual(['C', 'A', 'B'])
    // The sort control is the reader's own reading: a stored place does not overrule it.
    expect(await order(`?list=${list.id}&sort=due`)).toEqual(['A', 'B', 'C'])

    // A row nobody dragged carries no position, so it follows the placed rows in the view's order.
    await create({ title: 'D', listId: list.id, dueAt: Date.parse('2026-09-01T09:00:00Z') })
    expect(await order(`?list=${list.id}`)).toEqual(['C', 'A', 'B', 'D'])
    expect(b.id).toBeTruthy()
  })
})
