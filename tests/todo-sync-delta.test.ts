import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { syncRoutes } from '../src/worker/routes/sync'
import type { AppBindings } from '../src/worker/env'
import type { SyncResponse, TodosSyncResponse } from '../src/shared/types'
import type { TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { applyTodoSync, useTodos } from '../src/client/features/todos/store'

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
  const response = await app.fetch(new Request(`http://localhost${path}`), { DB: db } as never)
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
