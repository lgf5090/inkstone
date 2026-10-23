// @vitest-environment node
/**
 * The worklog: the hours the ledger holds, read over a window.
 *
 * Three things the endpoint is easy to get wrong about, each pinned below. An open timer is not hours
 * anybody spent yet, so only closed spans count. A day nobody worked on is a zero on the series rather
 * than a missing point, because a chart that omits quiet days draws a busier week than the account had.
 * And the overrun rate has no answer at all when nothing was estimated — `0` there is not an absence of
 * overrun, it is the reference app's mistake, and it tells an account that never planned anything that
 * it plans perfectly.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { todoRoutes } from '../src/worker/routes/todos'
import { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import type { Worklog } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

const USER = '0123456789abcdefghjkmnq01'
const HOUR = 3_600_000

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

function app(): Hono {
  const instance = new Hono()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  return instance
}

/** One worklog reading, as the endpoint answers it. */
async function worklog(query = ''): Promise<Worklog> {
  mocks.userId = USER
  const response = await app().request(`/api/todos/worklog${query}`, {}, env)
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json() as Worklog
}

/** A closed span on a day, filed the way the timer's own door files it. */
async function track(taskId: string, startDay: string, hours: number): Promise<void> {
  const start = Date.parse(`${startDay}T00:00:00Z`)
  await store.addManualTime(taskId, start, start + hours * HOUR)
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
})

describe('the hours a window holds', () => {
  it('counts closed spans and leaves the running one out', async () => {
    const worked = await store.createTask({ title: 'Report' })
    const running = await store.createTask({ title: 'Still going' })
    await track(worked.id, '2026-03-04', 2)
    await track(worked.id, '2026-03-05', 0.5)
    await store.openTimeEntry(running.id, Date.parse('2026-03-04T06:00:00Z'))

    const answer = await worklog('?from=2026-03-01&to=2026-03-31')

    expect(answer.totalMs).toBe(2.5 * HOUR)
    expect(answer.entryCount).toBe(2)
  })

  it('answers every day in the window, worked on or not', async () => {
    const task = await store.createTask({ title: 'Report' })
    await track(task.id, '2026-03-02', 1)

    const answer = await worklog('?from=2026-03-01&to=2026-03-05')

    expect(answer.byDay.map((entry) => entry.day)).toEqual([
      '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05',
    ])
    expect(answer.byDay.map((entry) => entry.trackedMs)).toEqual([0, HOUR, 0, 0, 0])
  })

  it('drops the hours of a task the trash took away', async () => {
    const kept = await store.createTask({ title: 'Kept' })
    const trashed = await store.createTask({ title: 'Trashed' })
    await track(kept.id, '2026-03-02', 1)
    await track(trashed.id, '2026-03-02', 5)
    await store.deleteTask(trashed.id)

    expect((await worklog('?from=2026-03-01&to=2026-03-05')).totalMs).toBe(HOUR)
  })

  it('groups by list, and lets a tagged hour appear under each tag it wears', async () => {
    const list = await store.createTaskList({ name: 'Client' })
    const tagged = await store.createTask({ title: 'Both tags', listId: list.id, tags: ['Fixed', 'Billable'] })
    await track(tagged.id, '2026-03-02', 1)

    const byList = await worklog('?from=2026-03-01&to=2026-03-05&group=list')
    expect(byList.byGroup.map((entry) => [entry.label, entry.trackedMs])).toEqual([['Client', HOUR]])

    const byTag = await worklog('?from=2026-03-01&to=2026-03-05&group=tag')
    expect(byTag.byGroup.map((entry) => entry.label).sort()).toEqual(['Billable', 'Fixed'])
    // Overlapping on purpose: the breakdown is read one dimension at a time, so the second copy is a
    // different question ("how much was billable"), not a double count of the same total.
    expect(byTag.byGroup.reduce((sum, entry) => sum + entry.trackedMs, 0)).toBe(2 * HOUR)
    expect(byTag.totalMs).toBe(HOUR)
  })

  it('names the groups it left out instead of dropping them', async () => {
    for (const index of Array.from({ length: 10 }, (_, i) => i))
      await track((await store.createTask({ title: `Task ${index}` })).id, '2026-03-02', 1)

    const answer = await worklog('?from=2026-03-01&to=2026-03-05&group=task')

    expect(answer.byGroup).toHaveLength(8)
    expect(answer.truncatedGroups).toBe(2)
  })
})

describe('the overrun reading', () => {
  // The window is deliberately the whole calendar: `completeTask` stamps the finish day from the real
  // clock, and the reading under test is about tasks that finished *in* the window, not about which
  // window a fixed-date test happened to fall in.
  const window = '?from=2000-01-01&to=2099-12-31'

  it('has no answer when nothing was planned', async () => {
    const task = await store.createTask({ title: 'No estimate' })
    await track(task.id, '2026-03-02', 3)
    await store.completeTask(task.id, 'UTC')

    // `0` would be the reference app's bug: an account that never types an estimate told it never
    // overruns, which is the opposite of an answer.
    expect((await worklog(window)).overEstimateRate).toBeNull()
    expect((await worklog(window)).estimatedCount).toBe(0)
  })

  it('divides the tasks that outgrew their plan by the tasks that had one', async () => {
    const under = await store.createTask({ title: 'Under', timeEstimateMs: 2 * HOUR })
    const over = await store.createTask({ title: 'Over', timeEstimateMs: HOUR })
    const unplanned = await store.createTask({ title: 'Unplanned' })
    await track(under.id, '2026-03-02', 1)
    await track(over.id, '2026-03-02', 2)
    await track(unplanned.id, '2026-03-02', 9)
    for (const task of [under, over, unplanned]) await store.completeTask(task.id, 'UTC')

    const answer = await worklog(window)
    expect(answer.estimatedCount).toBe(2)
    expect(answer.overEstimateCount).toBe(1)
    expect(answer.overEstimateRate).toBe(0.5)
  })

  it('measures the hours spent inside the window, not the task’s lifetime total', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const task = await store.createTask({ title: 'Across months', timeEstimateMs: HOUR })
    await track(task.id, '2025-11-02', 5)
    await track(task.id, today, 0.5)
    await store.completeTask(task.id, 'UTC')

    // Half an hour here, under an hour of plan: the five hours from November belong to November's
    // window, and reading them again would call this month's work an overrun it was not.
    expect((await worklog(`?from=${today}&to=${today}`)).overEstimateCount).toBe(0)
    // Read across the whole calendar, the same task did overrun: the five hours are real, they just
    // belong to November.
    expect((await worklog(window)).overEstimateCount).toBe(1)
  })
})

describe('the endpoint’s own door', () => {
  it('refuses a grouping it does not know', async () => {
    mocks.userId = USER
    const response = await app().request('/api/todos/worklog?from=2026-03-01&to=2026-03-05&group=project', {}, env)
    expect(response.status).toBe(400)
  })

  it('refuses a window that is not a pair of days', async () => {
    mocks.userId = USER
    const response = await app().request('/api/todos/worklog?from=2026-03&to=2026-03-05', {}, env)
    expect(response.status).toBe(400)
  })
})
