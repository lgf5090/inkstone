// @vitest-environment node
/**
 * What "still owed" answers with, at the edge the app reads.
 *
 * `shared/todos/status.ts` spells one question — is this task still the reader's — and every listing,
 * badge and card number in the to-do domain is meant to answer it from the same set. While `done` was
 * the only way a task could end, that set was just "not done" and any inline negation said the right
 * thing. A second non-terminal status makes the equality a decision rather than a tautology: a task
 * the reader has started is the most obviously owed work they have, so a surface that quietly filed
 * `in_progress` under "finished" would hide it behind its own progress.
 *
 * So every row here is `in_progress` unless the case says otherwise, and the assertions are made on
 * what the route and the store actually hand back — a page of rows, a `total`, a badge number, a card
 * count — never on the set of statuses itself. A test over the constant would still pass while every
 * consumer had drifted away from it, which is the failure this file exists to catch.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import { AssistantStore } from '../src/worker/assistant/store'
import type { TaskCounts, TaskList, TaskTag, TodoTask } from '../src/shared/todos/model'
import { taskListProgress } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqs1'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** Noon UTC on the day these cases call today, so either side of midnight is unambiguous. */
const NOON = Date.parse('2026-10-20T12:00:00Z')

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let env: Env
let store: AssistantStore
/** The raw handle, for the one fixture a validated write would refuse — see the board-card cases. */
let sqlite: DatabaseSync

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

async function page(query: string): Promise<Listing> {
  const response = await app().request(`/api/todos${query}`, {}, env)
  expect(response.status, query).toBe(200)
  return await response.json() as Listing
}

/** The ids one view answers with, so a case can name the set rather than a page order. */
async function ids(query: string): Promise<string[]> {
  return (await page(query)).tasks.map((task) => task.id).sort()
}

/** Rows the fixture leaves in each shape, by name rather than by id. */
let startedUndated = ''
let startedLate = ''
let startedAhead = ''
let startedStarred = ''
/** An unstarted, undated row: open, but not today's — the started row is in today for being started. */
let plainUndated = ''
let finished = ''
let workList: TaskList
let focusTag: TaskTag

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOON))
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  // Pinned, so the day the route names and the fixture's due times are the same day.
  await store.saveSettings({ ...(await store.getSettings()), timezone: 'UTC' })

  workList = await store.createTaskList({ name: 'Work' })
  const undated = await store.createTask({ title: 'Started undated', status: 'in_progress' })
  const late = await store.createTask({ title: 'Started late', status: 'in_progress', dueAt: NOON - 2 * DAY })
  const ahead = await store.createTask({
    title: 'Started ahead', status: 'in_progress', dueAt: NOON + 3 * DAY, listId: workList.id, tags: ['Focus'],
  })
  const starred = await store.createTask({
    title: 'Started starred', status: 'in_progress', dueAt: NOON + HOUR, starred: true, tags: ['Focus'],
  })
  const plain = await store.createTask({ title: 'Undated and unstarted' })
  const done = await store.createTask({ title: 'Finished', dueAt: NOON - 2 * DAY })
  // Finished through `completeTask`: the general patch refuses a transition into `done`.
  await store.completeTask(done.id, 'UTC')

  focusTag = (await store.listTaskTags()).find((tag) => tag.name === 'Focus')!
  startedUndated = undated.id
  startedLate = late.id
  startedAhead = ahead.id
  startedStarred = starred.id
  plainUndated = plain.id
  finished = done.id
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the open set the screens page through', () => {
  it('lists a started row among the work still owed', async () => {
    const open = await page('?view=open')
    expect(open.tasks.map((task) => task.id).sort()).toEqual(
      [startedUndated, startedLate, startedAhead, startedStarred, plainUndated].sort(),
    )
    expect(open.total).toBe(open.tasks.length)
    expect(open.total).toBe(5)
    // A started row is not, on the strength of having been started, a finished one.
    expect(open.tasks.map((task) => task.id)).not.toContain(finished)
    expect(open.tasks.every((task) => task.status === 'in_progress' || task.status === 'todo')).toBe(true)
  })

  it('reads the status filter and the open view as the same question', async () => {
    // The list page and the calendar page ask for `view=open`; a saved filter names the statuses. Both
    // have to reach the same five rows, or the two screens show different work under one label.
    expect(await ids('?status=open')).toEqual(await ids('?view=open'))
    expect((await page('?status=open')).total).toBe(5)
    // Naming `in_progress` outright is the same four rows the open set holds for that status.
    expect(await ids('?status=in_progress')).toEqual([startedAhead, startedLate, startedStarred, startedUndated].sort())
    expect(await ids('?status=todo,in_progress')).toEqual(await ids('?view=open'))
  })

  it('keeps a started row out of the finished view and the completed count', async () => {
    const completed = await page('?view=completed')
    expect(completed.tasks.map((task) => task.id)).toEqual([finished])
    const open = await page('?view=open')
    expect(open.counts.completed).toBe(1)
    // The two buckets stay disjoint whatever the open set is: a started row is counted once, as open.
    expect(open.counts.all + open.counts.completed).toBe(6)
  })
})

describe('the smart views a started row can belong to', () => {
  it('files each started row under the reason its own date gives it', async () => {
    // An undated row that the reader has begun is today's for that reason alone — there is no date to
    // put it anywhere else, and a row that vanished into "someday" once it was started is work lost.
    expect(await ids('?view=today')).toEqual([startedLate, startedStarred, startedUndated].sort())
    // A row that has passed its hour is overdue, started or not.
    expect(await ids('?view=overdue')).toEqual([startedLate])
    // A row an week ahead is upcoming, and stays out of today.
    expect(await ids('?view=upcoming')).toEqual([startedAhead])
    // The inbox is unfiled open work, so the one row put on a list is the only started row missing.
    expect(await ids('?view=inbox')).toEqual([startedLate, startedStarred, startedUndated, plainUndated].sort())
    expect(await ids('?view=starred')).toEqual([startedStarred])
  })

  it('answers an unstarted undated row as open work that is not today’s', async () => {
    // The counterweight to the case above: `due_at IS NULL AND status = 'in_progress'` is what pulls a
    // started row into today, so a plain undated row must still be missing from it while staying open.
    const today = await ids('?view=today')
    expect(today).not.toContain(plainUndated)
    expect(await ids('?view=open')).toContain(plainUndated)
  })
})

describe('the badges beside those views', () => {
  it('counts each badge with the rows the same view lists', async () => {
    // One predicate, two reads: the sidebar number and the page it opens are answered from the same set,
    // so every pair below is the badge against the rows rather than against a hand-written count.
    const counts = (await page('?view=open')).counts
    const pairs: [string, number][] = [
      ['inbox', counts.inbox],
      ['today', counts.today],
      ['upcoming', counts.upcoming],
      ['overdue', counts.overdue],
      ['starred', counts.starred],
      ['open', counts.all],
    ]
    for (const [view, badge] of pairs) {
      expect(await ids(`?view=${view}`), `the ${view} badge and the ${view} rows disagree`).toHaveLength(badge)
    }
    expect(counts.all).toBe(5)
    expect(counts.today).toBe(3)
  })

  it('carries a started row in the list and tag numbers beside a card', async () => {
    const counts = (await page('?view=open')).counts
    // A board card reads `done / total` off these pairs, and a list or tag view shows its open rows and
    // its finished ones, so both halves have to hold.
    expect(counts.byList[workList.id]).toEqual({ open: 1, done: 0 })
    expect(counts.byTag[focusTag.id]).toEqual({ open: 2, done: 0 })
    // The collections answer the same numbers from their own reads, and the row set under a tag is the
    // one its sidebar count is measured over.
    expect((await page(`?view=open&list=${workList.id}`)).total).toBe(1)
    expect((await page(`?view=open&tag=${focusTag.id}`)).total).toBe(counts.byTag[focusTag.id]!.open)
    expect((await store.listTaskLists()).find((entry) => entry.id === workList.id)?.openCount).toBe(1)
    expect((await store.listTaskTags()).find((entry) => entry.id === focusTag.id)?.openCount).toBe(2)
  })
})

describe('the done / total a card prints', () => {
  // These three numbers — a list's pair, a tag's pair, and the pair a sidebar row and a board card print
  // — are the only status reads in the app that are answered by *adding up grouped rows* rather than by a
  // query. Until now each of them filed every row that was not finished under "open", so they could not
  // disagree with the open set however that set was written: widening or narrowing it left these numbers
  // untouched, which is the blind spot. Every case here therefore asserts the pair and nothing before it.
  it('fills both halves of the pair from the same set every badge uses', async () => {
    const counts = (await page('?view=open')).counts
    expect(counts.byList[workList.id]).toEqual({ open: 1, done: 0 })
    expect(counts.byTag[focusTag.id]).toEqual({ open: 2, done: 0 })
    const card = (await store.listTaskLists()).find((entry) => entry.id === workList.id)
    expect(card).toBeDefined()
    expect({ open: card!.openCount, done: card!.doneCount }).toEqual({ open: 1, done: 0 })
    // The line on the card itself, one step further out than either number.
    expect(taskListProgress(card!)).toEqual({ done: 0, total: 1 })
  })

  it('counts a row that is neither finished nor owed in neither half of the pair', async () => {
    // The shape a `cancelled` row will arrive with, written straight to the column because no validator
    // would accept it yet. Whether it lands outside both buckets is a decision these three sums have to
    // make on purpose: left as "anything not finished is open", an abandoned row inflates every card.
    const abandoned = await store.createTask({ title: 'Not going to do it', listId: workList.id, tags: ['Focus'] })
    sqlite.prepare('UPDATE todos_tasks SET status = ? WHERE id = ?').run('cancelled', abandoned.id)

    const counts = (await page('?view=open')).counts
    expect(counts.byList[workList.id]).toEqual({ open: 1, done: 0 })
    expect(counts.byTag[focusTag.id]).toEqual({ open: 2, done: 0 })
    const card = (await store.listTaskLists()).find((entry) => entry.id === workList.id)
    expect({ open: card!.openCount, done: card!.doneCount }).toEqual({ open: 1, done: 0 })
    expect(taskListProgress(card!)).toEqual({ done: 0, total: 1 })
    // The same row read through the SQL half of the rule, so the card and the badges cannot drift apart.
    expect(counts.all).toBe(5)
    expect(counts.completed).toBe(1)
    expect((await store.getTaskList(workList.id))?.openCount).toBe(1)
  })
})
