// @vitest-environment node
/**
 * The listing at the size a reader actually reaches: past the page the browser used to fetch.
 *
 * The to-do app used to ask for 500 open tasks and then filter, search and page them in JavaScript, which
 * works until the account has more than 500 tasks — at which point a search silently reports "no matches"
 * for anything filed past that page. This fixture is deliberately over that ceiling, and it files the
 * terms a search looks for beyond the first page, so an answer built by filtering a page would be wrong
 * rather than accidentally right.
 *
 * Everything here is the route's own contract: `total` measured over the filter that was asked for,
 * `counts` saying the same thing about a collection as that collection's listing does, and `sort`,
 * `status`, `dueFrom`/`dueTo` accepted or refused at the edge rather than guessed at further in.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import { AssistantStore } from '../src/worker/assistant/store'
import { MAX_TASKS_PER_QUERY, type TaskCounts, type TaskList, type TaskTag, type TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/** One account, seeded once through the store: nothing here writes over HTTP, so no write budget is spent. */
const USER = '0123456789abcdefghjkmnpqrv'
const FOREIGN = '0123456789abcdefghjkmnpqrw'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** The rows filed past the page the app used to read in one go. */
const BULK_TASKS = MAX_TASKS_PER_QUERY + 100
/** The day the fixture's due times are counted from, so a range filter can name whole hours. */
const BASE = Date.parse('2026-06-01T00:00:00Z')
/** A term no title carries except the three tasks this fixture files at the end of the due order. */
const NEEDLE = 'zebrafish'
/** The word only a tag carries: nothing in the fixture's titles or descriptions says it. */
const TAG_WORD = 'Focus'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let env: Env

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  return instance
}

interface Listing {
  tasks: TodoTask[]
  total: number
  counts: TaskCounts
  dayEnd: number
  timezone: string
}

/**
 * Every statement prepared while recording is on.
 *
 * A tag-word search is still one query with an `EXISTS` in it; if it were answered by looking the
 * tags up one at a time, the statement count would grow with the page. The fixture is seeded before
 * any test switches recording on, so only the request under measurement is counted.
 */
const statements: string[] = []
let recording = false

function countedD1(inner: D1Database): D1Database {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (recording) statements.push(sql)
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** How many statements one request prepares. */
async function statementsFor(query: string): Promise<number> {
  statements.length = 0
  recording = true
  try {
    await page<Listing>(query)
  } finally {
    recording = false
  }
  return statements.length
}

async function page<T>(query: string): Promise<T> {
  const response = await app().request(`/api/todos${query}`, {}, env)
  expect(response.status).toBe(200)
  return await response.json() as T
}

/** The handles the filters are pointed at, and the rows each one is expected to pick out. */
let workList: TaskList
let focusTag: TaskTag
let needles: string[] = []
/** The finished needle, and the finished bulk row filed in `workList`. */
let needleDone = ''
let bulkDone = ''

beforeAll(async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(countedD1(makeD1(sqlite)), { PUBLIC_URL: 'http://localhost' })
  // Pinned so a bare local date in a query means the same instant as the fixture's due times.
  const store = new AssistantStore(env.DB as D1Database, USER, env)
  await store.saveSettings({ ...(await store.getSettings()), timezone: 'UTC' })
  workList = await store.createTaskList({ name: 'Work' })
  focusTag = await store.createTaskTag({ name: TAG_WORD })
  // Every bulk row carries its own due time, so "the first 500" is a fixed set of rows rather than a race
  // between tasks written inside the same millisecond.
  for (let index = 0; index < BULK_TASKS; index += 1) {
    await store.createTask({ title: `Bulk ${index}`, dueAt: BASE + index * MINUTE, listId: workList.id })
  }
  for (let index = 0; index < 3; index += 1) {
    const task = await store.createTask({
      title: `Feed the ${NEEDLE}`,
      dueAt: BASE + (BULK_TASKS + index) * MINUTE,
      priority: index === 0 ? 'urgent' : index === 1 ? 'high' : 'low',
      tags: [TAG_WORD],
    })
    needles.push(task.id)
  }
  needleDone = needles[2]!
  await store.updateTask(needleDone, { status: 'done' })
  await store.updateTask(needles[0]!, { starred: true })
  // Undated and filed last, so the due order, the created order and the completed order differ.
  const done = await store.createTask({ title: 'Bulk done', listId: workList.id })
  bulkDone = done.id
  await store.updateTask(done.id, { status: 'done' })
})

beforeEach(() => {
  mocks.userId = USER
})

describe('a listing past one page', () => {
  it('answers a search from the database rather than from the page it happened to read', async () => {
    // The fixture's own proof: the needle rows are not inside the first page, so a filter applied to that
    // page could not have found them.
    const firstPage = await page<Listing>(`?limit=${MAX_TASKS_PER_QUERY}&sort=due`)
    expect(firstPage.tasks).toHaveLength(MAX_TASKS_PER_QUERY)
    expect(firstPage.tasks.some((task) => task.title.includes(NEEDLE))).toBe(false)

    const found = await page<Listing>(`?q=${NEEDLE}&sort=due`)
    expect(found.tasks.map((task) => task.id)).toEqual(needles)
    expect(found.total).toBe(3)
    // The same terms with the finished row left out: the page and its count move together.
    const open = await page<Listing>(`?q=${NEEDLE}&status=open&sort=due`)
    expect(open.tasks.map((task) => task.id)).toEqual([needles[0], needles[1]])
    expect(open.total).toBe(2)
  })

  it('carries the whole matched set in total while the page stays at its limit', async () => {
    const paged = await page<Listing>('?limit=100&sort=due')
    expect(paged.tasks).toHaveLength(100)
    expect(paged.total).toBe(BULK_TASKS + 4)
  })

  it('keeps offset paging inside the same total', async () => {
    const second = await page<Listing>('?limit=100&offset=100&sort=due')
    expect(second.tasks).toHaveLength(100)
    expect(second.total).toBe(BULK_TASKS + 4)
    expect(second.tasks[0]!.title).toBe('Bulk 100')
  })
})

describe('what total is measured over', () => {
  it('counts the filter it was asked for, not the whole table', async () => {
    expect((await page<Listing>(`?list=${workList.id}`)).total).toBe(BULK_TASKS + 1)
    expect((await page<Listing>(`?tag=${focusTag.id}`)).total).toBe(3)
    expect((await page<Listing>('?starred=1')).total).toBe(1)
    expect((await page<Listing>(`?q=${NEEDLE}`)).total).toBe(3)
    // A filter that matches nothing says zero rather than falling back to the account's size.
    const none = await page<Listing>('?q=nothing-matches-this')
    expect(none.total).toBe(0)
    expect(none.tasks).toEqual([])
  })

  it('says the same thing about a collection as that collection’s listing does', async () => {
    const counts = (await page<Listing>('')).counts
    // A list or a tag view shows its open rows and its finished ones, so the numbers beside it have to
    // carry both, and each of those two numbers is what the matching listing counts.
    expect(counts.byList[workList.id]).toEqual({ open: BULK_TASKS, done: 1 })
    expect(counts.byTag[focusTag.id]).toEqual({ open: 2, done: 1 })
    expect((await page<Listing>(`?view=all&list=${workList.id}`)).total).toBe(601)
    expect((await page<Listing>(`?status=open&list=${workList.id}`)).total).toBe(counts.byList[workList.id]!.open)
    expect((await page<Listing>(`?status=done&list=${workList.id}`)).total).toBe(counts.byList[workList.id]!.done)
    expect((await page<Listing>(`?view=all&tag=${focusTag.id}`)).total).toBe(
      counts.byTag[focusTag.id]!.open + counts.byTag[focusTag.id]!.done,
    )
    expect((await page<Listing>(`?status=open&tag=${focusTag.id}`)).total).toBe(counts.byTag[focusTag.id]!.open)
    expect((await page<Listing>(`?status=done&tag=${focusTag.id}`)).total).toBe(counts.byTag[focusTag.id]!.done)
  })

  it('reads the inbox as the collection it is for both the rows and the count', async () => {
    const counts = (await page<Listing>('')).counts
    const unfiled = await page<Listing>('?list=none&status=open')
    expect(unfiled.total).toBe(2)
    expect(unfiled.total).toBe(counts.byList.inbox!.open)
    expect(unfiled.tasks.map((task) => task.id).sort()).toEqual([needles[0], needles[1]].sort())
  })
})

describe('a search that names a tag', () => {
  it('finds a task by the name of its tag, not only by its own words', async () => {
    // Nothing the fixture filed carries this word in its title or description; three rows carry it as
    // a tag, and the search the app sends has to reach them the way the old in-browser filter did.
    const found = await page<Listing>(`?q=${TAG_WORD}&sort=due`)
    expect(found.tasks.map((task) => task.id)).toEqual(needles)
    expect(found.total).toBe(found.tasks.length)

    // The tag filter and the status filter narrow the same rows: the count follows the page.
    const open = await page<Listing>(`?q=${TAG_WORD}&status=open&sort=due`)
    expect(open.tasks.map((task) => task.id)).toEqual([needles[0], needles[1]])
    expect(open.total).toBe(open.tasks.length)
    expect(open.total).toBe(2)

    const done = await page<Listing>(`?q=${TAG_WORD}&status=done`)
    expect(done.tasks.map((task) => task.id)).toEqual([needleDone])
    expect(done.total).toBe(done.tasks.length)
  })

  it('does not match a tag another account gave the same name', async () => {
    // The same word is a tag in both accounts. A search that joins tags without asking whose they
    // are would hand one reader the other's rows.
    const foreignStore = new AssistantStore(env.DB as D1Database, FOREIGN, env)
    await foreignStore.createTaskTag({ name: TAG_WORD })
    const foreignTask = await foreignStore.createTask({ title: 'Foreign filing', tags: [TAG_WORD] })

    const mine = await page<Listing>(`?q=${TAG_WORD}`)
    expect(mine.tasks.map((task) => task.id)).toEqual(needles)
    expect(mine.total).toBe(needles.length)

    mocks.userId = FOREIGN
    const theirs = await page<Listing>(`?q=${TAG_WORD}`)
    expect(theirs.tasks.map((task) => task.id)).toEqual([foreignTask.id])
    expect(theirs.total).toBe(1)
  })

  it('answers a tag-word search in the same number of statements as any other page', async () => {
    // The settings row, the page, its steps, its tags, the count and the three sidebar numbers. A
    // tag name looked up per row would make this number follow the page or the tags on it.
    const found = await statementsFor(`?q=${TAG_WORD}`)
    expect(found).toBe(8)
    expect(await statementsFor(`?q=${TAG_WORD}&limit=1`)).toBe(found)
    expect(await statementsFor('?limit=100')).toBe(found)
  })
})

describe('the filters the route takes', () => {
  it('bounds the listing by due date on both ends', async () => {
    // Two hours of the fixture's own due times, the lower bound included and the upper one not.
    const window = await page<Listing>(`?dueFrom=${iso(BASE + 2 * HOUR)}&dueTo=${iso(BASE + 4 * HOUR)}&sort=due`)
    expect(window.total).toBe(120)
    expect(window.tasks).toHaveLength(120)
    expect(window.tasks[0]!.title).toBe('Bulk 120')
    expect(window.tasks.at(-1)!.title).toBe('Bulk 239')
    // An undated task is not in any window: there is no due date to compare.
    expect(window.tasks.some((task) => task.dueAt === null)).toBe(false)
    const from = await page<Listing>(`?dueFrom=${iso(BASE + 600 * MINUTE)}`)
    expect(from.total).toBe(3)
  })

  it('takes more than one status at a time', async () => {
    const two = await page<Listing>('?status=todo,in_progress')
    expect(two.total).toBe(BULK_TASKS + 2)
    expect(two.tasks.some((task) => task.status === 'done')).toBe(false)
    const one = await page<Listing>('?status=done')
    expect(one.total).toBe(2)
    expect(one.tasks.map((task) => task.id).sort()).toEqual([needleDone, bulkDone].sort())
    // `open` still means "everything not finished", which is the two statuses above.
    expect((await page<Listing>('?status=open')).total).toBe(two.total)
  })

  it('refuses a status, a sort or a date it cannot read', async () => {
    expect((await app().request('/api/todos?status=someday', {}, env)).status).toBe(400)
    expect((await app().request('/api/todos?status=todo,someday', {}, env)).status).toBe(400)
    expect((await app().request('/api/todos?sort=title', {}, env)).status).toBe(400)
    expect((await app().request('/api/todos?dueFrom=whenever', {}, env)).status).toBe(400)
    expect((await app().request('/api/todos?dueTo=whenever', {}, env)).status).toBe(400)
  })

  it('answers each sort key with the order that key names', async () => {
    const byPriority = await page<Listing>(`?q=${NEEDLE}&sort=priority`)
    expect(byPriority.tasks.map((task) => task.id)).toEqual([needles[0], needles[1], needleDone])

    const byDue = await page<Listing>('?sort=due&limit=5')
    expect(byDue.tasks.map((task) => task.title)).toEqual(['Bulk 0', 'Bulk 1', 'Bulk 2', 'Bulk 3', 'Bulk 4'])

    const byCreated = await page<Listing>('?sort=created&limit=5')
    expect(byCreated.tasks.every((task, index) => index === 0 || byCreated.tasks[index - 1]!.createdAt >= task.createdAt)).toBe(true)
    // The newest rows are not the oldest ones, so the two orders really are different keys.
    expect(byCreated.tasks.some((task) => byDue.tasks.some((entry) => entry.id === task.id))).toBe(false)

    const byCompleted = await page<Listing>('?status=done&sort=completed')
    expect(byCompleted.tasks.map((task) => task.id)).toContain(needleDone)
    expect(byCompleted.tasks.every((task, index) => index === 0 || (byCompleted.tasks[index - 1]!.completedAt ?? 0) >= (task.completedAt ?? 0))).toBe(true)

    // Left unset, the listing keeps the order it has always had: dated rows first, by due time.
    const noSort = await page<Listing>('?limit=5')
    expect(noSort.tasks.map((task) => task.title)).toEqual(['Bulk 0', 'Bulk 1', 'Bulk 2', 'Bulk 3', 'Bulk 4'])
  })

  it('is the same listing for a caller who is not the fixture’s reader', async () => {
    mocks.userId = FOREIGN
    const foreign = await page<Listing>(`?q=${NEEDLE}`)
    expect(foreign.tasks).toEqual([])
    expect(foreign.total).toBe(0)
    expect(foreign.counts.byTag[focusTag.id] ?? null).toBeNull()
  })
})

/** A local date-time the reader's UTC-pinned account reads back as the fixture's own instant. */
function iso(instant: number): string {
  const date = new Date(instant)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}
