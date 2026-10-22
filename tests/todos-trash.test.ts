// @vitest-environment node
/**
 * The task trash: soft delete, restore, purge, its retention sweep and what a backup carries.
 *
 * Deleting a task used to remove the row. It now only stamps `deleted_at`, so every read that used to
 * see the row has to say otherwise in exactly the same way — the listing, its counts, the detail read,
 * the statistics, the calendar feed and the reminder sweep. The cases below pin the visible half of
 * that rule and the two ways out of the trash: restore puts the same row back (not a new one), while
 * purge removes it together with its steps, tags and reminders and nothing can bring it back.
 *
 * A backup is a snapshot of what the account still has, so a trashed task and everything hanging off
 * it are left out. The retention sweep is the one reader that spans accounts: it purges only rows
 * older than the window, oldest first, and at most the per-fire ceiling.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import {
  AssistantStore,
  purgeExpiredTodoTrash,
  TODO_TRASH_PURGE_LIMIT,
} from '../src/worker/assistant/store'
import { sweepTaskReminders } from '../src/worker/assistant/tasks'
import { exportAssistant } from '../src/worker/assistant/backup'
import { loadFeedTasks } from '../src/worker/todos/feeds'
import {
  TODO_TRASH_RETENTION_DAYS,
  TRASH_PAGE_SIZE,
  type TaskCounts,
  type TodoStats,
  type TodoTask,
} from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const mocks = vi.hoisted(() => ({ userId: '' }))

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
      settingsRaw: '{}',
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

function store(user = USER): AssistantStore {
  return new AssistantStore(env.DB as D1Database, user, env)
}

async function create(body: Record<string, unknown>, user = USER): Promise<TodoTask> {
  mocks.userId = user
  const response = await send('POST', '', body)
  expect(response.status, await response.clone().text()).toBe(201)
  return (await json<{ task: TodoTask }>(response)).task
}

async function listing(user = USER): Promise<{ tasks: TodoTask[]; total: number; counts: TaskCounts }> {
  mocks.userId = user
  const response = await send('GET', '')
  expect(response.status).toBe(200)
  return await json(response)
}

async function stats(user = USER): Promise<TodoStats> {
  mocks.userId = user
  const response = await send('GET', '/stats')
  expect(response.status, await response.clone().text()).toBe(200)
  return await json(response)
}

async function trashPage(query = '', user = USER): Promise<{ tasks: TodoTask[]; total: number }> {
  mocks.userId = user
  const response = await send('GET', `/trash${query}`)
  expect(response.status, await response.clone().text()).toBe(200)
  return await json(response)
}

async function deleteTask(id: string, user = USER): Promise<Response> {
  mocks.userId = user
  return await send('DELETE', `/${id}`)
}

function storedRow(id: string, user = USER): { deleted_at: number | null } | undefined {
  return sqlite.prepare(`SELECT deleted_at FROM todos_tasks WHERE user_id = ?1 AND id = ?2`)
    .get(user, id) as { deleted_at: number | null } | undefined
}

function countIn(table: string, taskId: string): number {
  return Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ?1`).get(taskId) as { n: number }).n)
}

/** A valid 26-character id for a row seeded straight into the table rather than created by the app. */
function trashedId(value: number): string {
  return String(value + 1).padStart(26, '0')
}

beforeEach(() => {
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

describe('a soft-deleted task', () => {
  it('keeps its row but leaves the listing, the counts, the detail, the statistics and the feed', async () => {
    const done = await create({ title: 'Done and gone', status: 'done', tags: ['Archive'], steps: ['One'] })
    const open = await create({ title: 'Open and gone', dueAt: Date.now() + HOUR, reminders: [Date.now() + HOUR] })
    expect((await listing()).counts.completed).toBe(1)
    expect((await stats()).summary.completed).toBe(1)
    expect((await stats()).summary.open).toBe(1)

    expect((await deleteTask(done.id)).status).toBe(200)
    expect((await deleteTask(open.id)).status).toBe(200)

    // The rows are still there, stamped, rather than deleted.
    expect(storedRow(done.id)?.deleted_at).toBeGreaterThan(0)
    expect(storedRow(open.id)?.deleted_at).toBeGreaterThan(0)

    const page = await listing()
    expect(page.tasks).toEqual([])
    expect(page.total).toBe(0)
    // `TaskCounts` names the open total `all`; there is no separate `open` key on the page's counts.
    expect(page.counts).toMatchObject({ all: 0, completed: 0, inbox: 0, today: 0, upcoming: 0, overdue: 0, starred: 0 })

    expect((await send('GET', `/${done.id}`)).status).toBe(404)

    const measured = await stats()
    expect(measured.summary.completed).toBe(0)
    expect(measured.summary.open).toBe(0)

    const feed = await loadFeedTasks(env.DB as D1Database, USER, Date.now() + 7 * DAY)
    expect(feed.map((task) => task.id)).not.toContain(open.id)
  })

  it('is what a batch delete writes, so its undo can restore the same rows', async () => {
    const first = await create({ title: 'One' })
    const second = await create({ title: 'Two' })
    mocks.userId = USER
    const answer = await send('POST', '/batch', { op: 'delete', ids: [first.id, second.id] })
    expect(answer.status).toBe(200)

    expect(storedRow(first.id)?.deleted_at).toBeGreaterThan(0)
    expect(storedRow(second.id)?.deleted_at).toBeGreaterThan(0)
    const page = await trashPage()
    expect(page.tasks.map((task) => task.id).sort()).toEqual([first.id, second.id].sort())
  })

  it('pages the trash newest-deleted first', async () => {
    const first = await create({ title: 'First' })
    const second = await create({ title: 'Second' })
    const third = await create({ title: 'Third' })
    await deleteTask(first.id)
    await deleteTask(second.id)
    await deleteTask(third.id)

    const page = await trashPage('?limit=2')
    expect(page.total).toBe(3)
    expect(page.tasks.map((task) => task.id)).toEqual([third.id, second.id])
    const rest = await trashPage('?limit=2&offset=2')
    expect(rest.tasks.map((task) => task.id)).toEqual([first.id])
    expect(rest.tasks[0]?.deletedAt).toBeGreaterThan(0)
  })

  it('answers a page that names no limit with the trash’s own page size', async () => {
    // One page size for one screen: the shared model names it, the trash page asks for it, and a
    // read that defaulted to the listing's ceiling instead would be a third number to keep in step.
    // The rows are seeded straight into the table because the account's write budget would refuse a
    // page of them; the read being pinned is still the route's own door over that table.
    for (let index = 0; index < TRASH_PAGE_SIZE + 1; index++) {
      sqlite.prepare(
        `INSERT INTO todos_tasks (user_id, id, title, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, 1, 1, ?)`,
      ).run(USER, trashedId(index), `Row ${index}`, 1_000 + index)
    }

    const page = await trashPage()
    expect(page.total).toBe(TRASH_PAGE_SIZE + 1)
    expect(page.tasks).toHaveLength(TRASH_PAGE_SIZE)
    // The newest deletion still leads the page, so the default changed the size and not the order.
    expect(page.tasks[0]?.title).toBe(`Row ${TRASH_PAGE_SIZE}`)
  })
})

describe('restoring a trashed task', () => {
  it('puts the same row back with its steps, tags and counts', async () => {
    const task = await create({ title: 'Bring me back', tags: ['Work'], steps: ['Draft', 'Review'] })
    expect((await deleteTask(task.id)).status).toBe(200)

    mocks.userId = USER
    const response = await send('POST', `/${task.id}/restore`)
    expect(response.status, await response.clone().text()).toBe(200)
    const restored = (await json<{ task: TodoTask }>(response)).task
    expect(restored.id).toBe(task.id)
    expect(restored.deletedAt).toBeNull()
    expect(restored.tags.map((tag) => tag.name)).toEqual(['Work'])
    expect(restored.stepTotal).toBe(2)

    expect(storedRow(task.id)?.deleted_at).toBeNull()
    const page = await listing()
    expect(page.tasks.map((entry) => entry.id)).toEqual([task.id])
    expect(page.counts.all).toBe(1)
    const detail = await json<{ steps: { text: string }[] }>(await send('GET', `/${task.id}`))
    expect(detail.steps.map((step) => step.text)).toEqual(['Draft', 'Review'])

    // Restoring a live row is a 404: it is not in the trash to come back from.
    expect((await send('POST', `/${task.id}/restore`)).status).toBe(404)
  })

  it('is the only row a restore creates, so a delete-then-undo cannot duplicate', async () => {
    const task = await create({ title: 'Only once' })
    await deleteTask(task.id)
    await send('POST', `/${task.id}/restore`)
    await send('POST', `/${task.id}/restore`)

    expect(await listing().then((page) => page.total)).toBe(1)
    const rows = sqlite.prepare(`SELECT COUNT(*) AS n FROM todos_tasks WHERE user_id = ?1`).get(USER) as { n: number }
    expect(rows.n).toBe(1)
  })

  it('does not bring back the reminders whose moment passed while the task was away', async () => {
    const now = Date.now()
    const s = store(USER)
    const task = await s.createTask({
      title: 'Away for a while',
      dueAt: now - DAY,
      reminders: [now - 2 * HOUR, now + DAY],
    })
    await s.deleteTask(task.id)

    // The sweep reads live tasks only, so both instants are still pending while the row is away.
    expect(await sweepTaskReminders(env, now)).toMatchObject({ sent: 0 })

    mocks.userId = USER
    const response = await send('POST', `/${task.id}/restore`)
    expect(response.status, await response.clone().text()).toBe(200)
    const body = await json<{ task: TodoTask, droppedReminders: number }>(response)
    expect(body.droppedReminders).toBe(1)
    expect(body.task.reminders).toEqual([now + DAY])

    // The one that came back is still in the future, so nothing goes off this minute either.
    expect(await sweepTaskReminders(env, now)).toMatchObject({ sent: 0 })
    expect(await sweepTaskReminders(env, now + DAY + HOUR)).toMatchObject({ sent: 1 })

    // A restore that never happened costs a live task nothing: the delete asks the trash the same
    // question the update does, so a row nobody put away keeps every reminder it had.
    const kept = await s.createTask({ title: 'Never left', reminders: [now - HOUR] })
    mocks.userId = USER
    expect((await send('POST', `/${kept.id}/restore`)).status).toBe(404)
    expect((await s.getTask(kept.id))?.reminders).toEqual([now - HOUR])
  })
})

describe('purging a trashed task', () => {
  it('removes the row and everything hanging off it, and cannot be restored', async () => {
    const task = await create({ title: 'Gone for good', tags: ['Old'], steps: ['One'], reminders: [Date.now() + HOUR] })
    await deleteTask(task.id)
    expect(countIn('todos_steps', task.id)).toBe(1)
    expect(countIn('todos_tag_links', task.id)).toBe(1)
    expect(countIn('todos_reminders', task.id)).toBe(1)

    mocks.userId = USER
    const response = await send('DELETE', `/${task.id}/purge`)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await json(response)).toEqual({ purged: true })

    expect(storedRow(task.id)).toBeUndefined()
    expect(countIn('todos_steps', task.id)).toBe(0)
    expect(countIn('todos_tag_links', task.id)).toBe(0)
    expect(countIn('todos_reminders', task.id)).toBe(0)
    expect((await trashPage()).tasks).toEqual([])
    expect((await send('POST', `/${task.id}/restore`)).status).toBe(404)
  })

  it('refuses a live task, so the endpoint is only the trash door', async () => {
    const task = await create({ title: 'Still here' })
    mocks.userId = USER
    expect((await send('DELETE', `/${task.id}/purge`)).status).toBe(404)
    expect(storedRow(task.id)?.deleted_at).toBeNull()
  })
})

describe('another account', () => {
  it('cannot see, restore or purge a trashed task and is answered 404', async () => {
    const task = await create({ title: 'Mine' })
    await deleteTask(task.id)

    mocks.userId = OTHER
    expect((await trashPage('', OTHER)).tasks).toEqual([])
    expect((await send('POST', `/${task.id}/restore`)).status).toBe(404)
    expect((await send('DELETE', `/${task.id}/purge`)).status).toBe(404)
    expect(storedRow(task.id)?.deleted_at).toBeGreaterThan(0)

    mocks.userId = USER
    expect((await send('POST', `/${task.id}/restore`)).status).toBe(200)
  })
})

describe('the reminder sweep', () => {
  it('never announces a reminder for a trashed task', async () => {
    const now = Date.parse('2026-10-20T09:00:00Z')
    const task = await store().createTask({ title: 'Deleted before due', reminders: [now - 60_000] })
    await deleteTask(task.id)

    const result = await sweepTaskReminders(env, now)
    expect(result).toMatchObject({ due: 0, sent: 0, claimed: 0, failed: 0 })
    const notifications = sqlite.prepare(`SELECT COUNT(*) AS n FROM chat_notifications WHERE user_id = ?1`)
      .get(USER) as { n: number }
    expect(notifications.n).toBe(0)
  })
})

describe('the 30-day retention sweep', () => {
  async function trashedAt(title: string, ageMs: number): Promise<{ id: string; deletedAt: number }> {
    const task = await create({ title, steps: [`${title} step`], reminders: [Date.now() + HOUR] })
    await deleteTask(task.id)
    const deletedAt = Date.now() - ageMs
    sqlite.prepare(`UPDATE todos_tasks SET deleted_at = ?3 WHERE user_id = ?1 AND id = ?2`)
      .run(USER, task.id, deletedAt)
    return { id: task.id, deletedAt }
  }

  it('purges only what has outlived the window, oldest first, and takes the children with it', async () => {
    const now = Date.now()
    const expired = await trashedAt('Expired', (TODO_TRASH_RETENTION_DAYS + 1) * DAY)
    const recent = await trashedAt('Recent', (TODO_TRASH_RETENTION_DAYS - 1) * DAY)

    expect(await purgeExpiredTodoTrash(env.DB as D1Database, now)).toBe(1)

    expect(storedRow(expired.id)).toBeUndefined()
    expect(storedRow(recent.id)?.deleted_at).toBe(recent.deletedAt)
    expect(countIn('todos_steps', expired.id)).toBe(0)
    expect(countIn('todos_reminders', expired.id)).toBe(0)
    expect(countIn('todos_steps', recent.id)).toBe(1)
    expect(TODO_TRASH_PURGE_LIMIT).toBe(200)
  })

  it('stops at the per-fire ceiling and leaves the rest for the next tick', async () => {
    const now = Date.now()
    const oldest = await trashedAt('Oldest', 40 * DAY)
    const next = await trashedAt('Next', 35 * DAY)
    const newest = await trashedAt('Newest', 31 * DAY)

    expect(await purgeExpiredTodoTrash(env.DB as D1Database, now, 2)).toBe(2)
    expect(storedRow(oldest.id)).toBeUndefined()
    expect(storedRow(next.id)).toBeUndefined()
    expect(storedRow(newest.id)?.deleted_at).toBeGreaterThan(0)
    expect(await purgeExpiredTodoTrash(env.DB as D1Database, now, 2)).toBe(1)
    expect(storedRow(newest.id)).toBeUndefined()
  })
})

describe('a backup', () => {
  it('leaves a trashed task and its steps, links and reminders out', async () => {
    const live = await create({ title: 'Still live', steps: ['Keep me'], tags: ['Keep'], reminders: [Date.now() + HOUR] })
    const gone = await create({ title: 'In the trash', steps: ['Drop me'], tags: ['Drop'], reminders: [Date.now() + HOUR] })
    await deleteTask(gone.id)

    const backup = await exportAssistant(store())
    const data = backup.data as Record<string, Record<string, unknown>[]>
    expect(data.tasks!.map((row) => row.id)).toEqual([live.id])
    expect(data.task_steps!.map((row) => row.task_id)).toEqual([live.id])
    const linked = new Set(data.task_tag_links!.map((row) => row.task_id))
    expect(linked.has(gone.id)).toBe(false)
    expect(data.tasks![0]).not.toHaveProperty('deleted_at')
  })
})
