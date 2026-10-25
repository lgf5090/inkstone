// @vitest-environment node
/**
 * Reading a list together with its sections, where a section is that list's child.
 *
 * The page needs one answer, not one answer per section: a list assembled from several reads shows
 * whichever collections had replied when it was drawn, and then offers to drag a row into a section it
 * has not met yet. So the listing takes `scope=subtree` and resolves the children in the same statement
 * that filters the rows. Three things follow, and each is pinned below.
 *
 * The count has to be measured over the same set as the rows, or the page's own footer disagrees with
 * the page. An archived section contributes nothing — putting a list away takes its open work off every
 * page the reader browses. And the child lookup is correlated on the account, because a list id is not a
 * secret and another account's nesting must not reach this one's page.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { todoRoutes } from '../src/worker/routes/todos'
import { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import type { TaskCounts, TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

const USER = '0123456789abcdefghjkmns01'
const FOREIGN = '0123456789abcdefghjkmns02'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

function app(): Hono {
  const instance = new Hono()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  return instance
}

interface Listing {
  tasks: TodoTask[]
  total: number
  counts: TaskCounts
}

/** One listing, asked as the account itself would ask it. */
async function page(query: string): Promise<Listing> {
  mocks.userId = USER
  const response = await app().request(`/api/todos${query}`, {}, env)
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json() as Listing
}

const titles = (listing: Listing): string[] => listing.tasks.map((task) => task.title).sort()

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
})

describe('a list read with its sections', () => {
  it('takes the child lists rows in the same read, and counts exactly what it returned', async () => {
    const parent = await store.createTaskList({ name: 'Client work' })
    const billing = await store.createTaskList({ name: 'Billing' })
    await store.updateTaskList(billing.id, { parentId: parent.id })
    await store.createTask({ title: 'Own row', listId: parent.id })
    await store.createTask({ title: 'Section row', listId: billing.id })
    await store.createTask({ title: 'Elsewhere', listId: (await store.createTaskList({ name: 'Unrelated' })).id })

    const subtree = await page(`?list=${parent.id}&scope=subtree`)
    expect(titles(subtree)).toEqual(['Own row', 'Section row'])
    expect(subtree.total, 'the count answered a different question than the page').toBe(2)

    // Without the scope the same page is the list alone — which is what every other surface reads.
    const plain = await page(`?list=${parent.id}`)
    expect(titles(plain)).toEqual(['Own row'])
    expect(plain.total).toBe(1)
  })

  it('leaves an archived section off the page, because its work is off every page the reader browses', async () => {
    const parent = await store.createTaskList({ name: 'Client work' })
    const shelved = await store.createTaskList({ name: 'Old gigs' })
    await store.updateTaskList(shelved.id, { parentId: parent.id, archivedAt: Date.parse('2026-10-20T09:00:00Z') })
    await store.createTask({ title: 'Own row', listId: parent.id })
    await store.createTask({ title: 'Shelved section row', listId: shelved.id })

    const answer = await page(`?list=${parent.id}&scope=subtree`)

    expect(titles(answer)).toEqual(['Own row'])
    expect(answer.total).toBe(1)
  })

  it('finishes a section the reader deleted as a section, not as a list of lost rows', async () => {
    const parent = await store.createTaskList({ name: 'Client work' })
    const child = await store.createTaskList({ name: 'Billing' })
    await store.updateTaskList(child.id, { parentId: parent.id })
    await store.createTask({ title: 'Section row', listId: child.id })
    await store.deleteTaskList(child.id)

    // The rows survive at the top level — deleting a container is not a statement about what is inside
    // it — so the parent's page still shows one row, and no section supplies it.
    const answer = await page(`?list=${child.id}`)
    expect(titles(answer)).toEqual([])
    expect(titles(await page(`?list=${parent.id}&scope=subtree`))).toEqual([])
    expect(titles(await page('?view=all'))).toEqual(['Section row'])
  })

  it('never reads another account nesting into this ones page', async () => {
    const parent = await store.createTaskList({ name: 'Client work' })
    await store.createTask({ title: 'Own row', listId: parent.id })

    // A list of somebody else's, filed under this account's parent id. The route would refuse the shape;
    // the store is the last trust boundary, so the clause is written to survive it anyway.
    const other = new AssistantStore(env.DB as D1Database, FOREIGN, env)
    const theirs = await other.createTaskList({ name: 'Their work' })
    await other.createTask({ title: 'Their row', listId: theirs.id })
    sqlite.prepare('UPDATE todos_lists SET parent_id = ?1 WHERE user_id = ?2 AND id = ?3')
      .run(parent.id, FOREIGN, theirs.id)

    const answer = await page(`?list=${parent.id}&scope=subtree`)

    expect(titles(answer)).toEqual(['Own row'])
    expect(answer.total).toBe(1)
  })

  it('refuses a scope it cannot read rather than answering a narrower question', async () => {
    const parent = await store.createTaskList({ name: 'Client work' })
    for (const query of ['?scope=all', '?scope=subtree', `?list=${parent.id}&scope=everything`]) {
      const response = await app().request(`/api/todos${query}`, {}, env)
      expect(response.status, query).toBe(400)
    }
  })

  it('leaves the sidebar numbers alone: they count one collection, not the page', async () => {
    const parent = await store.createTaskList({ name: 'Client work' })
    const child = await store.createTaskList({ name: 'Billing' })
    await store.updateTaskList(child.id, { parentId: parent.id })
    await store.createTask({ title: 'Own row', listId: parent.id })
    await store.createTask({ title: 'Section row', listId: child.id })

    const answer = await page(`?list=${parent.id}&scope=subtree`)

    // A badge that widened with the page would read as though the section had moved into the list.
    expect(answer.counts.all).toBe(2)
    expect(answer.counts.byList[parent.id]).toEqual({ open: 1, done: 0 })
    expect(answer.counts.byList[child.id]).toEqual({ open: 1, done: 0 })
  })
})
