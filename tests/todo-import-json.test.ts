// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/worker/app'
import { AssistantStore } from '../src/worker/assistant/store'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { newId } from '../src/worker/lib/id'
import { errorResponse } from '../src/worker/lib/errors'
import {
  MAX_TODO_JSON_IMPORT_TASKS,
  todoImportJsonRoutes,
} from '../src/worker/routes/todo-import-json'
import type { TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const NOW = Date.parse('2026-01-02T03:04:05.000Z')

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/worker/middleware/auth')>()
  return {
    ...actual,
    requireAuth: async (
      c: { set: (key: string, value: string) => void },
      next: () => Promise<void>,
    ) => {
      c.set('userId', mocks.userId)
      await next()
    },
  }
})

interface ImportAnswer {
  total: number
  created: number
  skipped: number
  failed: number
  partial: boolean
  imported: Array<{ row: number, sourceId: string, taskId: string }>
  errors: Array<{ row: number, sourceId: string | null, reason: string, taskId?: string }>
  warnings: Array<{ row: number, sourceId: string, reason: string }>
}

let sqlite: DatabaseSync
let env: Env

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos/import-json', todoImportJsonRoutes)
  return instance
}

async function importJson(
  document: unknown,
  options: { conflict?: 'skip' | 'duplicate', idempotencyKey?: string, raw?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (!options.raw) headers['Content-Type'] = 'application/json'
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
  return await app().request(
    `/api/todos/import-json${options.conflict ? `?conflict=${options.conflict}` : ''}`,
    { method: 'POST', headers, body: options.raw ? String(document) : JSON.stringify(document) },
    env,
  )
}

async function answer(response: Response): Promise<ImportAnswer> {
  return await response.json() as ImportAnswer
}

function rawTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: newId(),
    title: 'Imported task',
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    startAt: null,
    projectId: null,
    listId: null,
    parentId: null,
    tags: [],
    dependsOn: [],
    blocks: [],
    starred: false,
    repeat: null,
    reminders: [],
    remindAt: null,
    plannedFor: null,
    noteId: null,
    conversationId: null,
    archivedAt: null,
    timeEstimateMs: null,
    stepTotal: 0,
    stepDone: 0,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  }
}

function document(tasks: ReadonlyArray<object>, overrides: Record<string, unknown> = {}) {
  return {
    format: 'inkstone-todos',
    version: 1,
    exportedAt: NOW,
    timezone: 'Asia/Shanghai',
    total: tasks.length,
    truncated: false,
    tasks,
    ...overrides,
  }
}

function store(userId = USER): AssistantStore {
  return new AssistantStore(env.DB, userId, env)
}

async function tasksOf(userId = USER): Promise<TodoTask[]> {
  return await store(userId).listTasks({ status: 'all', archived: 'any', sort: 'created' })
}

beforeEach(() => {
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

afterEach(() => {
  vi.restoreAllMocks()
  sqlite.close()
})

describe('the JSON import route wiring', () => {
  it('owns /api/todos/import-json before the task router can read it as an id', () => {
    const routes = createApp().routes.map((route) => `${route.method} ${route.path}`)
    expect(routes).toContain('POST /api/todos/import-json')
    expect(routes.indexOf('POST /api/todos/import-json')).toBeLessThan(routes.indexOf('GET /api/todos/:id'))
  })
})

describe('the JSON todo import endpoint', () => {
  it('round-trips scheduling, tags, steps, repeats, parents and dependencies', async () => {
    const source = store()
    const list = await source.createTaskList({ name: 'Home' })
    const dueAt = Date.parse('2030-04-03T02:00:00.000Z')
    const startAt = Date.parse('2030-04-01T02:00:00.000Z')
    const parent = await source.createTask({
      title: 'Parent',
      description: 'Keep this note',
      status: 'in_progress',
      priority: 'high',
      dueAt,
      startAt,
      listId: list.id,
      starred: true,
      repeat: { freq: 'weekly', interval: 2, weekdays: [3], count: 8, produced: 2 },
      reminders: [dueAt - 60_000],
      timeEstimateMs: 90 * 60_000,
      plannedFor: '2030-04-01',
      tags: ['work', 'home'],
      steps: ['first', 'second'],
    })
    const parentSteps = await source.listSteps(parent.id)
    await source.updateStep(parent.id, parentSteps[1]!.id, { done: true })
    const blocker = await source.createTask({ title: 'Blocker', status: 'done' })
    const child = await source.createTask({
      title: 'Child',
      listId: list.id,
      parentId: parent.id,
      dependsOn: [blocker.id],
    })
    const sourceTasks = await source.listTasks({ status: 'all', sort: 'created' })
    const byId = new Map(sourceTasks.map((task) => [task.id, task]))
    // The current TodoExportDocument carries step counts, not step rows. The importer also accepts the
    // lossless step extension so a caller that has the rows can preserve their text and completion.
    const parentStepRows = (await source.listSteps(parent.id))
      .map((step) => ({ text: step.text, done: step.done }))
    const tasks = [child, parent, blocker].map((task) => ({
      ...byId.get(task.id)!,
      steps: task.id === parent.id ? parentStepRows : undefined,
    }))

    const response = await importJson(document(tasks), { conflict: 'duplicate' })

    expect(response.status).toBe(200)
    expect(await answer(response)).toMatchObject({ created: 3, skipped: 0, failed: 0, partial: false, errors: [], warnings: [] })
    const restored = await tasksOf()
    const restoredParent = restored.find((task) => task.title === 'Parent')!
    const restoredChild = restored.find((task) => task.title === 'Child')!
    const restoredBlocker = restored.find((task) => task.title === 'Blocker')!
    expect(restoredParent).toMatchObject({
      description: 'Keep this note',
      status: 'in_progress',
      priority: 'high',
      dueAt,
      startAt,
      listId: list.id,
      starred: true,
      repeat: { freq: 'weekly', interval: 2, weekdays: [3], count: 8, produced: 2 },
      reminders: [dueAt - 60_000],
      timeEstimateMs: 90 * 60_000,
      plannedFor: '2030-04-01',
      stepTotal: 2,
      stepDone: 1,
    })
    expect(restoredParent.tags.map((tag) => tag.name).sort()).toEqual(['home', 'work'])
    expect((await source.listSteps(restoredParent.id)).map((step) => [step.text, step.done])).toEqual([
      ['first', false],
      ['second', true],
    ])
    expect(restoredChild.parentId).toBe(restoredParent.id)
    expect(restoredChild.dependsOn.map((entry) => entry.id)).toEqual([restoredBlocker.id])
    expect(restoredParent.id).not.toBe(parent.id)

    const skipped = await answer(await importJson(document(tasks), { conflict: 'skip' }))
    expect(skipped).toMatchObject({ created: 0, skipped: 3, failed: 0 })
    expect(await tasksOf()).toHaveLength(6)
  })

  it('round-trips an all-day due date without confusing it with a timed 23:59 task', async () => {
    const response = await importJson(document([rawTask({
      title: 'All day',
      dueAt: Date.parse('2026-03-02T15:59:00.000Z'),
      dueAllDay: true,
      dueOn: '2026-03-02',
    })]), { conflict: 'duplicate' })

    expect(response.status).toBe(200)
    expect((await tasksOf())[0]).toMatchObject({ dueAllDay: true, dueOn: '2026-03-02' })
  })

  it('rejects malformed JSON and a damaged row without discarding a usable neighbour', async () => {
    const malformed = await importJson('{not json', { raw: true })
    expect(malformed.status).toBe(400)
    expect(await tasksOf()).toHaveLength(0)

    const wrongFormat = await importJson(document([rawTask()], { format: 'another-app' }))
    expect(wrongFormat.status).toBe(400)

    const response = await importJson(document([
      rawTask({ title: 'Good' }),
      rawTask({ title: 'Bad', status: 'finished' }),
      rawTask({ title: 'Also good' }),
    ]))
    expect(response.status).toBe(200)
    expect(await answer(response)).toMatchObject({
      created: 2,
      failed: 1,
      partial: true,
      errors: [{ row: 2, reason: 'task.status must be todo, in_progress, done or cancelled' }],
    })
    expect((await tasksOf()).map((task) => task.title).sort()).toEqual(['Also good', 'Good'])
  })

  it('refuses a truncated document before writing anything', async () => {
    const response = await importJson(document([rawTask()], { truncated: true }))

    expect(response.status).toBe(400)
    expect((await response.json() as { error: { message: string } }).error.message).toContain('truncated')
    expect(await tasksOf()).toHaveLength(0)
  })

  it('refuses a list belonging to another account instead of relinking or dropping it', async () => {
    const foreignList = await store(OTHER).createTaskList({ name: 'Private' })
    const response = await importJson(document([rawTask({ listId: foreignList.id })]))

    expect(response.status).toBe(200)
    expect(await answer(response)).toMatchObject({
      created: 0,
      failed: 1,
      errors: [{ row: 1, reason: 'The referenced list does not belong to this account' }],
    })
    expect(await tasksOf()).toHaveLength(0)
    expect(await store(USER).listTaskLists()).toEqual([])
    expect((await store(OTHER).listTaskLists()).map((list) => list.id)).toEqual([foreignList.id])
  })

  it('refuses more than the documented task ceiling before writing anything', async () => {
    expect(MAX_TODO_JSON_IMPORT_TASKS).toBe(500)
    const tasks = Array.from({ length: MAX_TODO_JSON_IMPORT_TASKS + 1 }, (_, index) => rawTask({ title: `Task ${index}` }))

    const response = await importJson(document(tasks))

    expect(response.status).toBe(400)
    expect((await response.json() as { error: { message: string } }).error.message).toContain('500')
    expect(await tasksOf()).toHaveLength(0)
  })

  it('keeps successful rows when another row fails validation', async () => {
    const response = await importJson(document([
      rawTask({ title: 'First' }),
      rawTask({ title: 'Broken', priority: 'critical' }),
      rawTask({ title: 'Last' }),
    ]))

    expect(response.status).toBe(200)
    expect(await answer(response)).toMatchObject({
      total: 3,
      created: 2,
      skipped: 0,
      failed: 1,
      partial: true,
      errors: [{ row: 2, sourceId: expect.any(String), reason: 'task.priority must be low, medium, high or urgent' }],
    })
    expect((await tasksOf()).map((task) => task.title).sort()).toEqual(['First', 'Last'])
  })

  it('validates timestamps and tag references row by row', async () => {
    const response = await importJson(document([
      rawTask({ title: 'Bad time', dueAt: 'tomorrow' }),
      rawTask({ title: 'Bad tag', tags: [{ id: 'not-an-id', name: 'work' }] }),
      rawTask({ title: 'Good' }),
    ]))

    expect(response.status).toBe(200)
    expect(await answer(response)).toMatchObject({
      created: 1,
      failed: 2,
      errors: [
        { row: 1, reason: 'task.dueAt must be a supported millisecond timestamp' },
        { row: 2, reason: 'tag.id must be an id' },
      ],
    })
    expect((await tasksOf()).map((task) => task.title)).toEqual(['Good'])
  })

  it('names the created task when a later step write fails', async () => {
    vi.spyOn(AssistantStore.prototype, 'updateStep').mockResolvedValueOnce(null)
    const response = await importJson(document([rawTask({
      title: 'Partly written',
      steps: [{ text: 'only step', done: true }],
      stepTotal: 1,
      stepDone: 1,
    })]))

    expect(response.status).toBe(200)
    expect(await answer(response)).toMatchObject({
      created: 0,
      failed: 1,
      partial: true,
      errors: [{ row: 1, taskId: expect.any(String), reason: 'A step could not be marked complete' }],
    })
    expect((await tasksOf()).map((task) => task.title)).toEqual(['Partly written'])
  })

  it('reports unavailable step text rather than claiming a lossless restore', async () => {
    const source = store()
    const task = await source.createTask({ title: 'Has steps', steps: ['one', 'two'] })
    const response = await importJson(document([task]), { conflict: 'duplicate' })

    expect(response.status).toBe(200)
    expect(await answer(response)).toMatchObject({
      created: 1,
      failed: 0,
      partial: true,
      warnings: [{ row: 1, reason: expect.stringContaining('step text') }],
    })
    const restored = (await tasksOf()).find((entry) => entry.title === 'Has steps')!
    expect(restored.stepTotal).toBe(0)
    expect(await source.listSteps(restored.id)).toEqual([])
  })

  it('replays an idempotency key and refuses to reuse it for another document', async () => {
    const doc = document([rawTask({ title: 'Once' })])
    const options = { conflict: 'duplicate' as const, idempotencyKey: 'todo-import-2026-01' }

    const first = await answer(await importJson(doc, options))
    const second = await answer(await importJson(doc, options))

    expect(first).toMatchObject({ created: 1, failed: 0 })
    expect(second).toEqual(first)
    expect(await tasksOf()).toHaveLength(1)

    const changed = await importJson(document([rawTask({ title: 'Different' })]), options)
    expect(changed.status).toBe(409)
    expect(await tasksOf()).toHaveLength(1)
  })
})
