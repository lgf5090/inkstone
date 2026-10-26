// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { syncRoutes } from '../src/worker/routes/sync'
import { SyncStore } from '../src/worker/sync/store'
import { AssistantStore } from '../src/worker/assistant/store'
import type { AppBindings, Env } from '../src/worker/env'
import type { SyncResponse, TodosSyncResponse } from '../src/shared/types'
import type { TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import { applyTodoSync, useTodos, type TaskListEntry } from '../src/client/features/todos/store'

const USER = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let db: D1Database
let app: Hono<AppBindings>

function insertTask(id: string, title: string, extra: {
  updatedAt?: number
  deletedAt?: number | null
  status?: string
  userId?: string
} = {}): void {
  const now = extra.updatedAt ?? Date.now()
  sqlite.prepare(
    `INSERT INTO todos_tasks
      (user_id, id, title, description, status, priority, due_at, completed_at, created_at, updated_at, rev, deleted_at)
     VALUES (?, ?, ?, '', ?, 'medium', NULL, NULL, ?, ?, 1, ?)`,
  ).run(extra.userId ?? USER, id, title, extra.status ?? 'todo', now, now, extra.deletedAt ?? null)
}

function insertTag(taskId: string, tagId: string, name: string): void {
  sqlite.prepare(
    `INSERT INTO todos_tags (user_id, id, name, color, created_at, updated_at) VALUES (?, ?, ?, NULL, 1, 1)`,
  ).run(USER, tagId, name)
  sqlite.prepare(
    `INSERT INTO todos_tag_links (user_id, task_id, tag_id, created_at) VALUES (?, ?, ?, 1)`,
  ).run(USER, taskId, tagId)
}

function insertStep(taskId: string, id: string, done: boolean): void {
  sqlite.prepare(
    `INSERT INTO todos_steps (user_id, id, task_id, text, done, position, created_at) VALUES (?, ?, ?, ?, ?, 0, 1)`,
  ).run(USER, id, taskId, id, done ? 1 : 0)
}

function insertReminder(taskId: string, id: string, at: number): void {
  sqlite.prepare(
    `INSERT INTO todos_reminders (user_id, id, task_id, remind_at, fired_at, created_at) VALUES (?, ?, ?, ?, NULL, 1)`,
  ).run(USER, id, taskId, at)
}

async function get(path: string): Promise<unknown> {
  const response = await app.fetch(new Request(`http://localhost${path}`), testBindings(db))
  return await response.json()
}

function row(id: string, title: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    remindedAt: null,
    plannedFor: null,
    completedAt: null,
    createdAt: 1,
    updatedAt: 1,
    listId: null,
    tags: [],
    parentId: null,
    dependsOn: [],
    blocks: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
    ...extra,
  }
}

const EMPTY_COUNTS = {
  inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {},
}

function listEntry(id: string, name: string): TaskListEntry {
  return {
    id, name, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1,
    openCount: 0, doneCount: 0, archivedAt: null, parentId: null,
  }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    await next()
  })
  app.route('/api/sync', syncRoutes)
  useTodos.setState({ tasks: [], completed: [], total: 0, completedTotal: 0, view: 'board' })
})

describe('the task delta', () => {
  it('sends live tasks with their tags, steps and reminders', async () => {
    insertTask('t1', 'Buy milk')
    insertTag('t1', 'tag-1', 'errands')
    insertStep('t1', 'step-1', true)
    insertStep('t1', 'step-2', false)
    insertReminder('t1', 'rem-1', 1_700_000_000_000)

    const body = await get('/api/sync/todos?since=0') as TodosSyncResponse
    expect(body.deleted).toEqual([])
    expect(body.todos).toHaveLength(1)
    expect(body.todos[0]).toMatchObject({
      id: 't1',
      title: 'Buy milk',
      tags: [{ id: 'tag-1', name: 'errands' }],
      stepTotal: 2,
      stepDone: 1,
    })
    expect(body.todos[0]!.reminders).toEqual([1_700_000_000_000])
    expect(body.cursor).toBeGreaterThan(0)
  })

  it('carries every status the vocabulary has, including the one a reader gives up with', async () => {
    // A status the decoder does not know used to arrive on the other device as `todo`: not dropped,
    // which would show up as a missing row, but rewritten — an abandoned task back on the list.
    for (const status of ['todo', 'in_progress', 'done', 'cancelled']) {
      insertTask(`s-${status}`, `A row that is ${status}`, { status })
    }

    const body = await get('/api/sync/todos?since=0') as TodosSyncResponse

    expect(body.todos.map((task) => [task.id, task.status]).sort())
      .toEqual([['s-cancelled', 'cancelled'], ['s-done', 'done'], ['s-in_progress', 'in_progress'], ['s-todo', 'todo']])
  })

  it('carries an updated row and a deletion stamped after the cursor', async () => {
    const past = Date.now() - 10_000
    insertTask('t1', 'Old title', { updatedAt: past })
    const first = await get(`/api/sync/todos?since=${past - 1}`) as TodosSyncResponse
    expect(first.todos.map((task) => task.title)).toEqual(['Old title'])

    sqlite.prepare(`UPDATE todos_tasks SET title = 'New title', updated_at = ?3, rev = rev + 1 WHERE user_id = ?1 AND id = ?2`)
      .run(USER, 't1', past + 5_000)
    insertTask('t2', 'Gone', { updatedAt: past + 6_000, deletedAt: past + 6_000 })

    const next = await get(`/api/sync/todos?since=${first.cursor}`) as TodosSyncResponse
    expect(next.todos.map((task) => [task.id, task.title])).toEqual([['t1', 'New title']])
    expect(next.deleted).toEqual(['t2'])
    expect(next.cursor).toBe(past + 6_000)
  })

  it('never carries another account’s task', async () => {
    insertTask('theirs', 'Not mine', { userId: OTHER })
    const body = await get('/api/sync/todos?since=0') as TodosSyncResponse
    expect(body.todos).toEqual([])
  })

  it('rides the main sync response when todosSince names the cursor', async () => {
    const past = Date.now() - 10_000
    insertTask('t1', 'In the note response', { updatedAt: past + 1_000 })
    const body = await get(`/api/sync?since=1&todosSince=${past}`) as SyncResponse
    expect(body.full).toBe(false)
    expect(body.todos?.map((task) => task.id)).toEqual(['t1'])
    expect(body.todosDeleted).toEqual([])
    expect(body.todosCursor).toBe(past + 1_000)
  })
})

describe('folding a task delta into the listing', () => {
  it('replaces a changed row and removes a deleted one', () => {
    useTodos.setState({
      tasks: [row('t1', 'Mine', { rev: 1 }), row('t2', 'Gone soon', { rev: 1 })],
      completed: [],
      total: 2,
      completedTotal: 0,
    })

    applyTodoSync({
      todos: [row('t1', 'Changed elsewhere', { rev: 4, updatedAt: 10 })],
      deleted: ['t2'],
    })

    const state = useTodos.getState()
    expect(state.tasks.map((task) => [task.id, task.title])).toEqual([['t1', 'Changed elsewhere']])
    expect(state.tasks[0]!.rev).toBe(4)
    expect(state.total).toBe(1)
  })

  it('asks for the directory again when a merged row names a list it has never seen', async () => {
    useTodos.setState({
      tasks: [],
      completed: [],
      total: 0,
      completedTotal: 0,
      lists: [],
      directoryKnown: true,
    })
    const paths: string[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      paths.push(path)
      const body = path.includes('/lists')
        ? { lists: [listEntry('l9', 'Elsewhere')] }
        : path.includes('/tags')
          ? { tags: [] }
          : { tasks: [], total: 0, counts: EMPTY_COUNTS, dayEnd: Date.now(), timezone: 'UTC' }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      applyTodoSync({ todos: [row('t1', 'Filed away elsewhere', { listId: 'l9' })], deleted: [] })
      await vi.waitFor(() => expect(paths.some((entry) => entry.includes('/api/todos/lists'))).toBe(true))
    } finally {
      globalThis.fetch = real
    }
  })

  it('leaves the directory alone when every merged row is already accounted for', async () => {
    useTodos.setState({
      tasks: [],
      completed: [],
      total: 0,
      completedTotal: 0,
      lists: [listEntry('l1', 'Mine')],
      directoryKnown: true,
    })
    const paths: string[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      paths.push(typeof input === 'string' ? input : String(input))
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    try {
      applyTodoSync({ todos: [row('t1', 'Same list', { listId: 'l1' })], deleted: [] })
      await new Promise((resolve) => { setTimeout(resolve, 40) })
    } finally {
      globalThis.fetch = real
    }

    expect(paths).toEqual([])
  })

  it('moves a finished row out of the open list and into the finished one', () => {
    useTodos.setState({
      tasks: [row('t1', 'Finish me', { rev: 2 })],
      completed: [],
      total: 1,
      completedTotal: 0,
      view: 'completed',
    })

    applyTodoSync({ todos: [row('t1', 'Finish me', { rev: 3, status: 'done' })], deleted: [] })

    const state = useTodos.getState()
    expect(state.tasks).toEqual([])
    expect(state.completed.map((task) => task.id)).toEqual(['t1'])
    expect(state.total).toBe(0)
    expect(state.completedTotal).toBe(1)
  })
})

describe('what the sync stream says about a row', () => {
  /**
   * The two task answers compared field by field on one row that carries everything.
   *
   * The stream used to keep a hand-written column list while the listing read `SELECT *`, and the list
   * had lost `position`, `start_at`, `time_estimate_ms` and the ledger's two rollups — so a second device
   * was shown a task with no start date, no place in the reader's order, and no stopwatch, with nothing
   * anywhere going red. Both answers now come from `toTask`, and this is the case that keeps them there:
   * a field one answer starts forgetting shows up here as a diff, not as a half-empty phone.
   */
  it('answers with every field the listing answers with', async () => {
    const store = new AssistantStore(db, USER, testBindings(db) as unknown as Env)
    const parent = await store.createTask({ title: '写报告' }, 'UTC')
    const blocker = await store.createTask({ title: '先校对' }, 'UTC')
    const task = await store.createTask({
      title: '发出去',
      parentId: parent.id,
      dependsOn: [blocker.id],
      startAt: 1_760_000_000_000,
      dueAt: 1_760_100_000_000,
      timeEstimateMs: 45 * 60_000,
      reminders: [1_760_050_000_000],
      tags: ['外发'],
      steps: ['写好正文'],
      repeat: { freq: 'weekly', interval: 1 },
    }, 'UTC')
    sqlite.prepare('UPDATE todos_tasks SET position = 7.5 WHERE id = ?').run(task.id)
    sqlite.prepare(
      `INSERT INTO todos_time_entries (id, task_id, user_id, start_at, end_at, day, source, created_at, updated_at)
       VALUES ('te-open', ?, ?, 1_759_900_000_000, NULL, '2026-10-08', 'timer', 1, 1)`,
    ).run(task.id, USER)

    const page = await new SyncStore(db, USER).todosSnapshot()
    const listed = await store.getTask(task.id)
    const syncTask = page.todos.find((entry) => entry.id === task.id)
    if (!syncTask || !listed) throw new Error('the row is in neither answer')
    const { timeEntries, ...syncRest } = syncTask

    expect(syncRest).toEqual(listed)
    // The ledger is the one thing the stream carries that the listing does not: intervals travel whole
    // so a device that was away can rebuild the day instead of trusting a sum.
    expect(timeEntries).toEqual([{
      id: 'te-open', taskId: task.id, startAt: 1_759_900_000_000, endAt: null, day: '2026-10-08', source: 'timer',
      createdAt: 1, updatedAt: 1,
    }])
    // The four fields the old list dropped, named here so a regression says which one it lost.
    expect(syncTask.position).toBe(7.5)
    expect(syncTask.startAt).toBe(1_760_000_000_000)
    expect(syncTask.timeEstimateMs).toBe(45 * 60_000)
    expect(syncTask.runningSince).toBe(1_759_900_000_000)
    expect(syncTask.parentId).toBe(parent.id)
    expect(syncTask.dependsOn.map((entry) => entry.id)).toEqual([blocker.id])
  })
})
