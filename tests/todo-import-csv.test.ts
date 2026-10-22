// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { createApp } from '../src/worker/app'
import { todoImportRoutes } from '../src/worker/routes/todo-import'
import { AssistantStore } from '../src/worker/assistant/store'
import type { TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import {
  MAX_TODO_CSV_BYTES,
  MAX_TODO_CSV_ROWS,
  TodoCsvError,
  parseTodoCsv,
} from '../src/worker/todos/import-csv'

const ZONE = 'Asia/Shanghai'

/** The instant a bare `YYYY-MM-DD` means in the account's zone: the end of that local day. */
function endOfDay(day: string): number {
  return Date.parse(`${day}T23:59:00+08:00`)
}

describe('the CSV reader', () => {
  it('reads a BOM, CRLF, doubled quotes and a line break inside a quoted cell', () => {
    const csv = '\uFEFFtitle,notes,due,priority,list,tags,completed\r\n'
      + '"Plan, ""2027""","line one\r\nline two",2027-01-05 09:30,P1,Work,home;errand;home,true\r\n'
      + 'Second,,2027-02-01,4,,,false\r\n'

    const parsed = parseTodoCsv(csv, ZONE)

    expect(parsed.errors).toEqual([])
    expect(parsed.rows).toHaveLength(2)
    const [first, second] = parsed.rows
    expect(first).toMatchObject({
      line: 2,
      title: 'Plan, "2027"',
      notes: 'line one\nline two',
      dueAt: Date.parse('2027-01-05T01:30:00Z'),
      priority: 'urgent',
      listName: 'Work',
      tags: ['home', 'errand'],
      completed: true,
    })
    expect(second).toMatchObject({
      line: 4,
      title: 'Second',
      notes: '',
      dueAt: endOfDay('2027-02-01'),
      priority: 'low',
      listName: null,
      tags: [],
      completed: false,
    })
  })

  it('keeps the good rows and reports bad ones by their source line', () => {
    const csv = [
      'title,due',
      'Good,2027-01-05',
      ',2027-01-06',
      'Bad date,next week',
      'Last,',
    ].join('\n')

    const parsed = parseTodoCsv(csv, ZONE)

    expect(parsed.rows.map((row) => row.title)).toEqual(['Good', 'Last'])
    expect(parsed.rows.map((row) => row.line)).toEqual([2, 5])
    expect(parsed.errors).toEqual([
      { line: 3, reason: 'title is required' },
      { line: 4, reason: 'due date "next week" is not a date this app can read' },
    ])
  })

  it('reports an unterminated quoted field without losing the rows before it', () => {
    const parsed = parseTodoCsv('title\nFirst\n"unterminated', ZONE)

    expect(parsed.rows.map((row) => row.title)).toEqual(['First'])
    expect(parsed.errors).toEqual([{ line: 3, reason: 'unterminated quoted field' }])
  })

  it('finds the columns by lower-case name and reads description as notes', () => {
    const parsed = parseTodoCsv(
      'Title,Description,Priority,Tags,Completed\nRead,From the library,P2,#focus; deep work,Yes',
      ZONE,
    )

    expect(parsed.errors).toEqual([])
    expect(parsed.rows[0]).toMatchObject({
      title: 'Read',
      notes: 'From the library',
      priority: 'high',
      tags: ['focus', 'deep work'],
      completed: true,
    })
  })

  it('maps every priority spelling to one of the four levels', () => {
    const rows = ['1', '2', 'P3', 'low', 'urgent', 'medium', 'high', 'P4', '1', 'nonsense']
      .map((priority) => `Task,${priority}`)
      .join('\n')
    const parsed = parseTodoCsv(`title,priority\n${rows}`, ZONE)

    expect(parsed.errors).toEqual([])
    expect(parsed.rows.map((row) => row.priority)).toEqual([
      'urgent', 'high', 'medium', 'low', 'urgent', 'medium', 'high', 'low', 'urgent', 'medium',
    ])
  })

  it('leaves completion alone when the file has no completed column', () => {
    const withoutColumn = parseTodoCsv('title\nNo column', ZONE)
    const withColumn = parseTodoCsv('title,completed\nEmpty,\nNo,0\nDone,yes', ZONE)

    expect(withoutColumn.errors).toEqual([])
    expect(withoutColumn.rows[0]!.completed).toBeNull()
    expect(withColumn.errors).toEqual([])
    expect(withColumn.rows.map((row) => row.completed)).toEqual([false, false, true])
  })

  it('reads a date-only due as the end of that local day and a full instant as itself', () => {
    const parsed = parseTodoCsv(
      'title,due\nDate only,2027-01-05\nInstant,2027-01-05T01:30:00Z',
      ZONE,
    )

    expect(parsed.errors).toEqual([])
    expect(parsed.rows[0]!.dueAt).toBe(endOfDay('2027-01-05'))
    expect(parsed.rows[1]!.dueAt).toBe(Date.parse('2027-01-05T01:30:00Z'))
  })

  it('counts a bad row after a multiline cell on the line the row starts', () => {
    const parsed = parseTodoCsv('title,notes\n"two\nlines",x\n,broken', ZONE)

    expect(parsed.rows.map((row) => row.line)).toEqual([2])
    expect(parsed.errors).toEqual([{ line: 4, reason: 'title is required' }])
  })

  it('refuses a file with no title column or no rows at all', () => {
    expect(() => parseTodoCsv('name,notes\nTask,x', ZONE)).toThrow(TodoCsvError)
    expect(() => parseTodoCsv('\uFEFF\r\n', ZONE)).toThrow(TodoCsvError)
  })
})

describe('the CSV import ceilings', () => {
  it('names a 5000-row and a 2 MiB ceiling', () => {
    expect(MAX_TODO_CSV_ROWS).toBe(5000)
    expect(MAX_TODO_CSV_BYTES).toBe(2 * 1024 * 1024)
  })
})

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

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
  created: number
  updated: number
  skipped: number
  invalid: number
  missingLists: number
  total: number
  errors: Array<{ line: number; reason: string }>
}

let sqlite: DatabaseSync
let env: Env

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos/import', todoImportRoutes)
  return instance
}

async function importCsv(text: string, options: { conflict?: string; name?: string } = {}): Promise<Response> {
  const form = new FormData()
  form.append('file', new File([text], options.name ?? 'todos.csv', { type: 'text/csv' }))
  if (options.conflict !== undefined) form.append('conflict', options.conflict)
  return await app().request('/api/todos/import', { method: 'POST', body: form }, env)
}

async function answer(response: Response): Promise<ImportAnswer> {
  return await response.json() as ImportAnswer
}

async function tasksOf(userId: string): Promise<TodoTask[]> {
  return await new AssistantStore(env.DB, userId, env).listTasks({ status: 'all', sort: 'created' })
}

beforeEach(async () => {
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  const store = new AssistantStore(env.DB, USER, env)
  await store.saveSettings({ ...(await store.getSettings()), timezone: ZONE })
})

afterEach(() => {
  sqlite.close()
})

describe('the import route wiring', () => {
  it('owns /api/todos/import before the task router can read it as an id', () => {
    const routes = createApp().routes.map((route) => `${route.method} ${route.path}`)

    expect(routes).toContain('POST /api/todos/import')
    expect(routes.indexOf('POST /api/todos/import')).toBeLessThan(routes.indexOf('GET /api/todos/:id'))
  })
})

describe('the CSV import endpoint', () => {
  it('writes the good rows with their list, tags, priority and due date', async () => {
    const home = await new AssistantStore(env.DB, USER, env).createTaskList({ name: 'Home' })
    const csv = [
      'title,notes,due,priority,list,tags,completed',
      'Pay rent,January,2027-01-05 09:00,high,Home,home;money,false',
      '"Plan, ""2027""",,2027-02-01,1,,,',
    ].join('\n')

    const response = await importCsv(csv)

    expect(response.status).toBe(200)
    expect(await answer(response)).toMatchObject({
      created: 2,
      updated: 0,
      skipped: 0,
      invalid: 0,
      missingLists: 0,
      total: 2,
    })
    const tasks = await tasksOf(USER)
    const rent = tasks.find((task) => task.title === 'Pay rent')!
    expect(rent.description).toBe('January')
    expect(rent.dueAt).toBe(Date.parse('2027-01-05T01:00:00Z'))
    expect(rent.priority).toBe('high')
    expect(rent.listId).toBe(home.id)
    expect(rent.tags.map((tag) => tag.name).sort()).toEqual(['home', 'money'])
    const plan = tasks.find((task) => task.title === 'Plan, "2027"')!
    expect(plan.dueAt).toBe(endOfDay('2027-02-01'))
    expect(plan.priority).toBe('urgent')
    expect(plan.status).toBe('todo')
    expect(plan.listId).toBeNull()
  })

  it('keeps the good rows when other rows cannot be read', async () => {
    const response = await importCsv('title,due\nGood,2027-01-05\n,2027-01-06\nBad date,next week')

    expect(response.status).toBe(200)
    expect(await answer(response)).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      invalid: 2,
      missingLists: 0,
      total: 3,
      errors: [
        { line: 3, reason: 'title is required' },
        { line: 4, reason: 'due date "next week" is not a date this app can read' },
      ],
    })
    expect((await tasksOf(USER)).map((task) => task.title)).toEqual(['Good'])
  })

  it('imports a task without a list when the named list does not exist, and never reaches another account', async () => {
    const other = new AssistantStore(env.DB, OTHER, env)
    await other.createTaskList({ name: 'Shared' })
    const otherTask = await other.createTask({ title: 'Shared task', dueAt: endOfDay('2027-01-05') })

    const response = await importCsv('title,due,list,tags\nShared task,2027-01-05,Shared,SharedTag', {
      conflict: 'skip',
    })

    expect(response.status).toBe(200)
    expect(await answer(response)).toMatchObject({ created: 1, skipped: 0, missingLists: 1 })
    const mine = await tasksOf(USER)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.listId).toBeNull()
    expect(mine[0]!.tags.map((tag) => tag.name)).toEqual(['SharedTag'])
    expect(await new AssistantStore(env.DB, USER, env).listTaskLists()).toEqual([])
    expect((await tasksOf(OTHER)).map((task) => task.id)).toEqual([otherTask.id])
  })

  it('refuses more than 5000 rows before writing anything', async () => {
    const csv = ['title', ...Array.from({ length: MAX_TODO_CSV_ROWS + 1 }, (_, index) => `Task ${index}`)].join('\n')

    const response = await importCsv(csv)

    expect(response.status).toBe(400)
    expect((await response.json() as { error: { message: string } }).error.message).toContain('5000')
    expect(await tasksOf(USER)).toHaveLength(0)
  })

  it('refuses a file larger than 2 MiB', async () => {
    const response = await importCsv(`title\n"${'x'.repeat(MAX_TODO_CSV_BYTES)}"`)

    expect(response.status).toBe(413)
    expect(await tasksOf(USER)).toHaveLength(0)
  })

  it('does not duplicate a file imported twice with conflict skip', async () => {
    const csv = 'title,due,completed\nOne,2027-01-05,false\nTwo,,true'

    const first = await importCsv(csv, { conflict: 'skip' })
    const second = await importCsv(csv, { conflict: 'skip' })

    expect(await answer(first)).toMatchObject({ created: 2, skipped: 0 })
    expect(await answer(second)).toMatchObject({ created: 0, updated: 0, skipped: 2 })
    const tasks = await tasksOf(USER)
    expect(tasks).toHaveLength(2)
    expect(tasks.find((task) => task.title === 'Two')!.status).toBe('done')
  })

  it('treats a newer import as the source of truth and skips it when nothing changed', async () => {
    const first = await importCsv('title,due,notes\nOne,2027-01-05,first', { conflict: 'newer' })
    const unchanged = await importCsv('title,due,notes\nOne,2027-01-05,first', { conflict: 'newer' })
    const changed = await importCsv('title,due,notes\nOne,2027-01-05,second', { conflict: 'newer' })

    expect(await answer(first)).toMatchObject({ created: 1 })
    expect(await answer(unchanged)).toMatchObject({ created: 0, updated: 0, skipped: 1 })
    expect(await answer(changed)).toMatchObject({ created: 0, updated: 1, skipped: 0 })
    const tasks = await tasksOf(USER)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.description).toBe('second')
  })

  it('creates every row again with conflict duplicate', async () => {
    const csv = 'title\nOne\nTwo'

    await importCsv(csv, { conflict: 'duplicate' })
    const second = await importCsv(csv, { conflict: 'duplicate' })

    expect(await answer(second)).toMatchObject({ created: 2, updated: 0, skipped: 0 })
    expect(await tasksOf(USER)).toHaveLength(4)
  })

  it('refuses a file without a title column, an unknown conflict and a missing attachment', async () => {
    expect((await importCsv('name\nx')).status).toBe(400)
    expect((await importCsv('title\nx', { conflict: 'merge' })).status).toBe(400)

    const form = new FormData()
    form.append('conflict', 'skip')
    const response = await app().request('/api/todos/import', { method: 'POST', body: form }, env)
    expect(response.status).toBe(400)
  })
})
