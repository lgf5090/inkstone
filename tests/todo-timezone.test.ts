// @vitest-environment node
/**
 * The zone the account picks is the zone the app answers in.
 *
 * This is the reachability half of the to-do settings page: a reader who moves the zone has to see the
 * day move with it, because every "today", "overdue" and reminder in the app is a span in that zone
 * rather than something each browser computes for itself. The instant below is chosen so the two zones
 * land on different calendar days, which is exactly when a wrong boundary becomes a wrong badge count.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import { AssistantStore } from '../src/worker/assistant/store'
import type { TaskCounts, TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let env: Env

interface Page {
  tasks: TodoTask[]
  counts: TaskCounts
  dayEnd: number
  timezone: string
}

async function page(query: string): Promise<Page> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.route('/api/todos', todoRoutes)
  const response = await instance.request(`/api/todos${query}`, undefined, env)
  expect(response.status).toBe(200)
  return await response.json() as Page
}

/** The assistant settings are stored whole, so moving the zone reads them first rather than guessing at
 * the twenty-odd fields beside it — the same order the settings page goes through. */
async function setZone(timeZone: string): Promise<void> {
  const store = new AssistantStore(env.DB as D1Database, USER, env)
  await store.saveSettings({ ...(await store.getSettings()), timezone: timeZone })
}

/** The wall-clock reading of an instant, in the zone that is supposed to own it. */
function clockIn(millis: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
    .format(new Date(millis))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T17:30:00Z'))
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the account zone', () => {
  it('moves which task counts as today when the zone moves', async () => {
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    await setZone('Asia/Shanghai')
    // Ten on Tuesday night in Shanghai, and the afternoon of Wednesday in Greenwich.
    const evening = await store.createTask({ title: 'Close the books', dueAt: Date.parse('2026-10-20T14:00:00Z') })

    const shanghai = await page('?view=today')
    expect(shanghai.timezone).toBe('Asia/Shanghai')
    expect(shanghai.tasks.map((task) => task.id)).toContain(evening.id)

    await setZone('UTC')
    const utc = await page('?view=today')
    expect(utc.timezone).toBe('UTC')
    expect(utc.tasks.map((task) => task.id)).not.toContain(evening.id)
    // It did not disappear with the boundary; it moved to the other side of it, which is what
    // `upcoming` is for.
    const upcoming = await page('?view=upcoming')
    expect(upcoming.tasks.map((task) => task.id)).toContain(evening.id)
  })

  it('ends each day at the first instant of the next one, in its own zone', async () => {
    await setZone('Asia/Shanghai')
    const shanghai = await page('?view=today')
    await setZone('UTC')
    const utc = await page('?view=today')

    // The bound is exclusive, which is why the list can ask for `due_at < dayEnd` and why a task filed
    // at 23:59 belongs to the day it was written for rather than to the midnight that follows it.
    expect(shanghai.dayEnd).not.toBe(utc.dayEnd)
    expect(clockIn(shanghai.dayEnd, 'Asia/Shanghai')).toBe('21/10, 00:00')
    expect(clockIn(utc.dayEnd, 'UTC')).toBe('20/10, 00:00')
  })

  it('counts today with the same boundary the list is cut by', async () => {
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    await setZone('Asia/Shanghai')
    await store.createTask({ title: 'Close the books', dueAt: Date.parse('2026-10-20T14:00:00Z') })
    const shanghai = await page('?view=today')
    await setZone('UTC')
    const utc = await page('?view=today')

    // The sidebar badge and the list a reader opens cannot be two answers to one question.
    expect(shanghai.counts.today).toBe(shanghai.tasks.length)
    expect(utc.counts.today).toBe(utc.tasks.length)
    expect(shanghai.counts.today).toBe(1)
    expect(utc.counts.today).toBe(0)
  })

  it('counts the coming week in calendar days, not in seven sets of twenty-four hours', async () => {
    // The American spring-forward of 2026 falls on 8 March, so the week that follows is seven
    // calendar days spread over 167 hours. A window built by adding 7 × 24 h to the day end lands an
    // hour inside the eighth day, and a task owed in that hour is announced as still coming.
    vi.setSystemTime(new Date('2026-03-04T12:00:00Z'))
    await setZone('America/New_York')
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    // Wednesday 11 March, 23:00 in New York: the last hour of the seventh day.
    const inside = await store.createTask({ title: 'Last of the week', dueAt: Date.parse('2026-03-12T03:00:00Z') })
    // Thursday 12 March, 00:30 in New York: the eighth day has already begun.
    const outside = await store.createTask({ title: 'The eighth day', dueAt: Date.parse('2026-03-12T04:30:00Z') })

    const upcoming = await page('?view=upcoming')
    expect(upcoming.timezone).toBe('America/New_York')
    expect(upcoming.tasks.map((task) => task.id)).toEqual([inside.id])
    // The badge is the other door of the same window; both read one boundary.
    expect(upcoming.counts.upcoming).toBe(1)
    expect(outside.dueAt).toBeGreaterThan(upcoming.dayEnd)
  })
})
