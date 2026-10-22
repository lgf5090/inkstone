// @vitest-environment node
/**
 * One action, five doors.
 *
 * Finishing a repeating task is not a status column: it files the next occurrence, and only
 * `AssistantStore.completeTask` has ever done that. The chat's `update_task`, a CSV import that says
 * `completed`, and any other caller that wrote `status = 'done'` through the general patch moved the
 * row and silently dropped the rhythm — defect A1 of `reports/super-productivity-port-plan.md`, the
 * same mistake the card's checkbox made before the route's `completing` branch existed.
 *
 * Every case below completes the same weekly task through one entry point and asserts the same three
 * facts: the row is finished, exactly one next occurrence exists, and its due date is one instant.
 * `expectFiled` also records that instant, so the last case proves the five doors really agree rather
 * than each being right on its own.
 *
 * The sixth case is the other half of the closing-off, and the reason the first five can be trusted:
 * `updateTask` now refuses a completion instead of writing a half-finished one.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { ApiError, errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import { todoImportRoutes } from '../src/worker/routes/todo-import'
import { AssistantStore, TaskCompletionRequiresCompleteTask } from '../src/worker/assistant/store'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/assistant'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import { completeMcpTask, type McpTodoContext } from '../src/worker/mcp/todos'
import { MCP_SCOPES } from '../src/worker/mcp/settings'
import type { TaskBatchResult, TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const ZONE = 'Asia/Shanghai'
const DAY = 24 * 60 * 60 * 1000
/** Wednesday 2026-10-21, 10:00 in the account's own zone. */
const DUE = Date.parse('2026-10-21T02:00:00Z')
/** A weekly rhythm counted from that instant, in a zone with no daylight saving to disagree about. */
const NEXT_DUE = DUE + 7 * DAY
const TITLE = 'Weekly report'

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
let userId: string
let store: AssistantStore

/** The door `routes/todo-import.ts` claims for itself: mounted before the router that reads `import` as an id. */
function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos/import', todoImportRoutes)
  instance.route('/api/todos', todoRoutes)
  return instance
}

async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
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

async function importCsv(text: string, options: { conflict?: string } = {}): Promise<Response> {
  const form = new FormData()
  form.append('file', new File([text], 'todos.csv', { type: 'text/csv' }))
  if (options.conflict !== undefined) form.append('conflict', options.conflict)
  return app().request('/api/todos/import', { method: 'POST', body: form }, env)
}

/** The chat's own door, with the context the runner builds for a turn. */
function toolContext(): ToolContext {
  return {
    store,
    env,
    ftsEnabled: false,
    origin: 'https://notes.test',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    timezone: ZONE,
    dayEnd: Date.now() + DAY,
    mode: 'chat',
    conversationId: 'c1',
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
  }
}

function mcpContext(): McpTodoContext {
  return { env, userId, scopes: [MCP_SCOPES.todoRead, MCP_SCOPES.todoWrite] }
}

/** The due dates every door filed, in declaration order: five doors, one instant. */
const filedDue: number[] = []

let caseNumber = 0

beforeEach(async () => {
  caseNumber += 1
  // The write budget is keyed by caller, so each door gets an account of its own.
  userId = `parity${String(caseNumber).padStart(20, '0')}`
  mocks.userId = userId
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, userId, env)
  await store.saveSettings({ ...(await store.getSettings()), timezone: ZONE })
})

afterEach(() => {
  sqlite.close()
})

async function weeklyTask(): Promise<TodoTask> {
  return await store.createTask({
    title: TITLE,
    dueAt: DUE,
    repeat: { freq: 'weekly', interval: 1 },
  }, ZONE)
}

/**
 * The revision a caller would read off the row it lists.
 *
 * `TodoTask.rev` is optional in the shared shape because a preview object may carry no row, while the
 * store writes one on every insert — so a fixture that means "the revision this read saw" says so here
 * rather than casting at each use.
 */
function revOf(task: TodoTask): number {
  expect(typeof task.rev).toBe('number')
  return task.rev as number
}

/**
 * What one completion owes the account: the row finished, exactly one next occurrence, and nothing else.
 *
 * `next` is what the door itself answered with, when the door answers with one at all; the listing is
 * read back from the store because a door that says nothing but writes a row still owes the same row.
 */
async function expectFiled(task: TodoTask, next?: TodoTask | Record<string, unknown> | null): Promise<void> {
  const rows = await store.listTasks({ status: 'all' })
  expect(rows.map((row) => row.title)).toEqual([TITLE, TITLE])

  const finished = rows.find((row) => row.id === task.id)
  expect(finished?.status).toBe('done')
  expect(finished?.completedAt).not.toBeNull()

  const filed = rows.filter((row) => row.id !== task.id)
  expect(filed).toHaveLength(1)
  const [occurrence] = filed
  expect(occurrence).toBeTruthy()
  expect(occurrence!.status).not.toBe('done')
  expect(occurrence!.dueAt).toBe(NEXT_DUE)
  expect(occurrence!.repeat).toEqual({ freq: 'weekly', interval: 1 })
  filedDue.push(occurrence!.dueAt as number)

  // A door that reports the occurrence has to report the one it wrote, not another date.
  if (next) {
    const due = 'dueAt' in next ? next.dueAt : (next as Record<string, unknown>).due_at
    expect(Number(due)).toBe(NEXT_DUE)
  }
}

describe('finishing a repeating task through every door', () => {
  it('① the app checkbox: PATCH /api/todos/:id with status done', async () => {
    const task = await weeklyTask()

    const response = await send('PATCH', `/${task.id}`, { status: 'done' })

    expect(response.status).toBe(200)
    const body = await json<{ task: TodoTask, next: TodoTask | null }>(response)
    expect(body.task.status).toBe('done')
    expect(body.next).toBeTruthy()
    await expectFiled(task, body.next)
  })

  it('② the chat tool: update_task with status done, and the model is told the new date', async () => {
    const task = await weeklyTask()
    const tools = new ToolExecutor(toolContext(), { maxToolCalls: 20 })

    const payload = await tools.execute('update_task', {
      task: task.id,
      status: 'done',
    }, 'call-1') as { updated: Record<string, unknown>, next?: Record<string, unknown> }

    // The occurrence has to be in the payload: a model that cannot see the date it just filed will
    // invent one in its reply to the reader.
    expect(payload.updated.status).toBe('done')
    expect(payload.next).toBeTruthy()
    await expectFiled(task, payload.next)
  })

  it('③ the agent door: MCP complete_todo', async () => {
    const task = await weeklyTask()

    const outcome = await completeMcpTask(mcpContext(), {
      operationId: 'parity-mcp-complete',
      taskId: task.id,
    })

    const body = outcome as { completed: Record<string, unknown>, next?: Record<string, unknown> }
    expect(body.completed.status).toBe('done')
    expect(body.next).toBeTruthy()
    await expectFiled(task, body.next)
  })

  it('④ the batch bar: POST /api/todos/batch with op complete', async () => {
    const task = await weeklyTask()

    const response = await send('POST', '/batch', { ids: [task.id], op: 'complete' })

    expect(response.status).toBe(200)
    expect(await json<TaskBatchResult>(response)).toEqual({ done: [task.id], failed: [] })
    await expectFiled(task)
  })

  it('⑤ the CSV import: a completed row meeting the task it describes', async () => {
    const task = await weeklyTask()

    const response = await importCsv(`title,due,completed\n${TITLE},2026-10-21 10:00,true`, {
      conflict: 'newer',
    })

    expect(response.status).toBe(200)
    expect(await json<{ created: number, updated: number, skipped: number }>(response))
      .toMatchObject({ created: 0, updated: 1, skipped: 0 })
    await expectFiled(task)
  })

  it('leaves one instant, not five readings of it', () => {
    expect(filedDue).toHaveLength(5)
    expect(new Set(filedDue)).toEqual(new Set([NEXT_DUE]))
  })
})

describe('the door that is no longer there', () => {
  it('refuses to finish a task through the general patch', async () => {
    const task = await weeklyTask()

    await expect(store.updateTask(task.id, { status: 'done' }, ZONE))
      .rejects.toBeInstanceOf(TaskCompletionRequiresCompleteTask)

    // Refused means nothing written: no finished row, and no next occurrence either.
    expect(await store.getTask(task.id)).toMatchObject({ status: 'todo', completedAt: null })
    expect(await store.listTasks({ status: 'all' })).toHaveLength(1)
  })

  it('names the task it refused, so a leaked caller is findable in the log', async () => {
    const task = await weeklyTask()

    const failure = await store.updateTask(task.id, { status: 'done' }, ZONE)
      .then(() => null)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(task.id)
    expect((failure as Error).message).toContain('completeTask')
  })

  it('still lets every other status through the general patch', async () => {
    const task = await weeklyTask()

    const started = await store.updateTask(task.id, { status: 'in_progress' }, ZONE)
    expect(started?.status).toBe('in_progress')
    const finished = await store.completeTask(task.id, ZONE)
    expect(finished?.task.status).toBe('done')
    // Reopening is not a completion: the patch owns that direction on its own.
    const reopened = await store.updateTask(task.id, { status: 'todo' }, ZONE)
    expect(reopened?.status).toBe('todo')
  })

  it('does not refuse a patch that names the status the row already has', async () => {
    const task = await store.createTask({ title: 'Already finished', status: 'done' }, ZONE)

    const same = await store.updateTask(task.id, { status: 'done' }, ZONE)

    expect(same?.status).toBe('done')
  })
})

describe('the guarded completion', () => {
  it('refuses a completion the caller read under a stale revision', async () => {
    const task = await weeklyTask()
    const read = revOf(task)
    await store.updateTask(task.id, { title: 'Renamed elsewhere' }, ZONE)

    const failure = await store.completeTask(task.id, ZONE, read)
      .then(() => null)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(409)
    expect((failure as ApiError).details).toEqual({ id: task.id, rev: read + 1 })
    // Nothing half-happened: the row is still open and no occurrence was filed.
    expect(await store.getTask(task.id)).toMatchObject({ status: 'todo' })
    expect(await store.listTasks({ status: 'all' })).toHaveLength(1)
  })

  it('completes when the caller names the revision it read', async () => {
    const task = await weeklyTask()

    const fresh = await store.getTask(task.id)
    const done = await store.completeTask(task.id, ZONE, fresh?.rev)

    expect(done?.task.status).toBe('done')
    expect(done?.next?.dueAt).toBe(NEXT_DUE)
  })

  it('refuses a stale row inside a batch instead of finishing it anyway', async () => {
    const task = await weeklyTask()
    await store.updateTask(task.id, { title: 'Renamed elsewhere' }, ZONE)

    const response = await send('POST', '/batch', {
      ids: [task.id],
      op: 'complete',
      revs: { [task.id]: revOf(task) },
    })

    expect(response.status).toBe(200)
    expect(await json<TaskBatchResult>(response)).toEqual({
      done: [],
      failed: [{ id: task.id, reason: 'conflict' }],
    })
    expect(await store.getTask(task.id)).toMatchObject({ status: 'todo' })
    expect(await store.listTasks({ status: 'all' })).toHaveLength(1)
  })

  it('files the occurrence once, whatever the door is pressed twice', async () => {
    const task = await weeklyTask()

    const first = await store.completeTask(task.id, ZONE)
    const second = await store.completeTask(task.id, ZONE)

    expect(first?.next?.dueAt).toBe(NEXT_DUE)
    expect(second?.next).toBeNull()
    expect(await store.listTasks({ status: 'all' })).toHaveLength(2)
  })
})
