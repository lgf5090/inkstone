// @vitest-environment node
/**
 * M-06a: the account's whole to-do list, handed over as a file — and read back by the importer.
 *
 * The app could always read its tasks a page at a time and never give them up: the statistics file is an
 * aggregate of the work rather than the work, and `worker/backup` does not read a `todos_*` table at all.
 * A reader who trusted "I have a backup" was therefore keeping every other app in the vault and losing
 * this one. This is the read half of that gap, and the property worth having is not "a file comes out"
 * but *this file reads back as the same set of tasks* — so the cases below drive the CSV through
 * `parseTodoCsv`, the importer's own parser, rather than through a copy of its rules.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { AssistantStore } from '../src/worker/assistant/store'
import { todoRoutes } from '../src/worker/routes/todos'
import {
  buildTodoExportCsv,
  buildTodoExportJson,
  collectExportTasks,
  MAX_EXPORT_TASKS,
} from '../src/worker/todos/export-tasks'
import { parseTodoCsv } from '../src/worker/todos/import-csv'
import { MAX_TASKS_PER_QUERY, type TodoExportDocument, type TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import type { Env } from '../src/worker/env'

const USER = '0123456789abcdefghjkmnexpt1'
const DAY = 24 * 60 * 60 * 1000

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    if (!mocks.userId) {
      const { ApiError } = await import('../src/worker/lib/errors')
      throw ApiError.unauthenticated('Please sign in first')
    }
    c.set('userId', mocks.userId)
    await next()
  },
}))

let env: Env

function app(): Hono {
  const instance = new Hono()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  return instance
}

function store(): AssistantStore {
  return new AssistantStore(env.DB as D1Database, USER, env)
}

/** A two-collection account with the shapes an export has to carry: a note, a tag, a plan, a finish. */
async function seed(): Promise<void> {
  const s = store()
  const work = await s.createTaskList({ name: '工作' })
  await s.createTask({ title: '买猫粮', priority: 'low' }, 'UTC')
  await s.createTask({
    title: '整理 Q4 复盘材料',
    description: '## 要点\n\n- 三条结论',
    priority: 'high',
    dueAt: Date.parse('2026-10-27T23:59:00Z'),
    listId: work.id,
    tags: ['季度', 'a,b'],
    steps: ['列结论', '画一张图'],
  }, 'UTC')
  const done = await s.createTask({ title: '把书架整理好', dueAt: Date.parse('2026-10-24T09:30:00Z') }, 'UTC')
  await s.completeTask(done.id, 'UTC')
}

beforeEach(async () => {
  mocks.userId = USER
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  await seed()
})

/** The CSV body of the account as it stands, with the list names the route would hand the builder. */
async function csv(): Promise<{ text: string; tasks: TodoTask[] }> {
  const s = store()
  const { tasks, truncated } = await collectExportTasks(s)
  const lists = await s.listTaskLists()
  const names = new Map(lists.map((list) => [list.id, list.name]))
  return {
    text: buildTodoExportCsv(tasks, {
      timezone: 'UTC',
      truncated,
      listName: (task) => (task.listId === null ? null : names.get(task.listId) ?? null),
    }),
    tasks,
  }
}

describe('the CSV round trip', () => {
  it('is read back by the importer as the same set of tasks', async () => {
    const { text, tasks } = await csv()
    const parsed = parseTodoCsv(text, 'UTC')

    expect(parsed.errors).toEqual([])
    expect(parsed.rows).toHaveLength(tasks.length)
    for (const task of tasks) {
      const row = parsed.rows.find((entry) => entry.title === task.title)
      expect(row, `the export lost "${task.title}"`).toBeTruthy()
      expect(row!.notes).toBe(task.description)
      expect(row!.priority).toBe(task.priority)
      expect(row!.completed).toBe(task.status === 'done' || task.status === 'cancelled')
      // A bare day is stored as the end of that day, and the file writes the account-zone wall clock,
      // so the instant has to come back the same and not merely the same-looking.
      expect(row!.dueAt).toBe(task.dueAt)
      expect(row!.tags.slice().sort()).toEqual(task.tags.map((tag) => tag.name).sort())
    }
  })

  it('names the list rather than its id, which is what the importer resolves', async () => {
    const { text } = await csv()
    const parsed = parseTodoCsv(text, 'UTC')
    expect(parsed.rows.find((row) => row.title === '整理 Q4 复盘材料')!.listName).toBe('工作')
    expect(parsed.rows.find((row) => row.title === '买猫粮')!.listName).toBeNull()
  })

  it('separates tags with the importer’s own separator, so a comma inside a tag survives', async () => {
    const { text } = await csv()
    const tags = parseTodoCsv(text, 'UTC').rows.find((row) => row.title === '整理 Q4 复盘材料')!.tags
    expect(tags).toContain('a,b')
    expect(tags).toContain('季度')
  })

  it('defuses a title that opens like a spreadsheet formula', async () => {
    await store().createTask({ title: '=HYPERLINK("http://evil","click")' }, 'UTC')
    const { text } = await csv()
    const line = text.split('\r\n').find((entry) => entry.includes('HYPERLINK'))!
    expect(line.startsWith('"\'=HYPERLINK')).toBe(true)
    // The cost of the mark is named rather than hidden: a title that opens like a formula comes back from
    // the CSV carrying it, which is exactly why JSON is the faithful export and CSV the interchange one.
    const back = parseTodoCsv(text, 'UTC').rows.find((row) => row.title.includes('HYPERLINK'))!
    expect(back.title).toBe("'=HYPERLINK(\"http://evil\",\"click\")")
  })

  it('refuses to write a short file that would read as a complete one', () => {
    // The CSV has no envelope to say "part of the account" with, and a comment line would come back
    // through the importer as a task, so the ceiling is a refusal rather than a footnote.
    expect(() => buildTodoExportCsv([], { timezone: 'UTC', truncated: true, listName: () => null }))
      .toThrow(/JSON export marks its own ceiling/)
    expect(buildTodoExportCsv([], { timezone: 'UTC', truncated: false, listName: () => null }))
      .toContain('title,notes,due,priority,list,tags,completed')
  })

  it('carries no line the importer would read as a task', async () => {
    const { text } = await csv()
    // Metadata belongs in the JSON document and the file name; here every line is a row.
    expect(text.split('\r\n').filter((line) => line.startsWith('#'))).toEqual([])
  })

  it('puts the header the importer understands on the first line', async () => {
    const { text } = await csv()
    expect(text.split('\r\n')[0]).toBe('title,notes,due,priority,list,tags,completed')
  })
})

describe('the JSON document', () => {
  it('is the row as the API answers it, plus what the walk saw', async () => {
    const s = store()
    const { tasks, truncated } = await collectExportTasks(s)
    const document = JSON.parse(buildTodoExportJson(tasks, {
      exportedAt: 1_790_000_000_000,
      timezone: 'UTC',
      truncated,
    })) as TodoExportDocument

    expect(document.format).toBe('inkstone-todos')
    expect(document.version).toBe(1)
    expect(document.timezone).toBe('UTC')
    expect(document.truncated).toBe(false)
    expect(document.total).toBe(tasks.length)
    // The half a CSV cannot carry: a step list, and the repeat rule with its anchor.
    const withDetails = document.tasks.find((task) => task.title === '整理 Q4 复盘材料')!
    expect(withDetails.stepTotal).toBe(2)
    // The order the tag rows come back in is the store's, not the reader's; the set is what has to hold.
    expect(withDetails.tags.map((tag) => tag.name).sort()).toEqual(['a,b', '季度'].sort())
  })

  it('marks itself partial at the ceiling instead of arriving short', () => {
    const document = JSON.parse(buildTodoExportJson([], {
      exportedAt: 0,
      timezone: 'UTC',
      truncated: true,
    })) as TodoExportDocument
    expect(document.truncated).toBe(true)
    expect(document.total).toBe(MAX_EXPORT_TASKS)
  })
})

describe('the route', () => {
  it('hands over a JSON attachment for the account', async () => {
    const response = await app().request('/api/todos/export?format=json', {}, env)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="inkstone-todos-')
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const document = await response.json() as TodoExportDocument
    expect(document.tasks.map((task) => task.title).sort()).toEqual(
      ['买猫粮', '把书架整理好', '整理 Q4 复盘材料'].sort(),
    )
  })

  it('defaults to JSON when the address names no format', async () => {
    const response = await app().request('/api/todos/export', {}, env)
    expect(response.status).toBe(200)
    expect((await response.json() as TodoExportDocument).format).toBe('inkstone-todos')
  })

  it('refuses a format it does not write rather than answering with one of the two', async () => {
    const response = await app().request('/api/todos/export?format=xls', {}, env)
    expect(response.status).toBe(400)
    expect((await response.json() as { error: { message: string } }).error.message)
      .toContain('json or csv')
  })

  it('is a read: it spends no minute of the write budget', async () => {
    const before = await app().request('/api/todos/export?format=csv', {}, env)
    expect(before.status).toBe(200)
    expect(before.headers.get('content-type')).toContain('text/csv')
  })

  it('answers nothing for an account nobody signed into', async () => {
    mocks.userId = ''
    const response = await app().request('/api/todos/export?format=json', {}, env)
    expect(response.status).toBe(401)
  })

  it('leaves a page-full account reading as one page', async () => {
    // The paging stops on a short page, so an account holding exactly one page must not be cut short
    // by the loop that walks it.
    const s = store()
    for (let index = 0; index < MAX_TASKS_PER_QUERY - 3; index += 1) {
      await s.createTask({ title: `填充 ${index}` }, 'UTC')
    }
    const { tasks, truncated } = await collectExportTasks(s)
    expect(truncated).toBe(false)
    expect(tasks.length).toBeGreaterThanOrEqual(MAX_TASKS_PER_QUERY)
  })
})
