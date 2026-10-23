// @vitest-environment node
/**
 * The end-of-day pass: the four buckets one close-out reads about one day.
 *
 * Three things this endpoint is easy to get silently wrong about, each pinned below.
 *
 * The completion window is half-open (`completed_on >= from AND < to`), so a bucket that asked for
 * `{from: day, to: day}` would answer "nothing was finished today" — an empty section drawn as a fact.
 * The bucket asks for the day and the day after it, and the first case below is the only thing standing
 * between that and a quiet lie.
 *
 * "Worked on today" is a question about the ledger, not about the task row, and three different states
 * look alike from the outside: a closed span on another day, a timer still running, and a row the reader
 * finished. Only the first is a day's work that is still owed.
 *
 * And "tomorrow" is cut in the account's own zone. A due time late on tomorrow's evening belongs to
 * tomorrow; the same clock reading on today's evening does not.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { todoRoutes } from '../src/worker/routes/todos'
import { AssistantStore } from '../src/worker/assistant/store'
import { addDays } from '../src/worker/todos/stats'
import type { Env } from '../src/worker/env'
import type { FinishDay, TodoTask } from '../src/shared/todos/model'
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
const FOREIGN = '0123456789abcdefghjkmnq02'
const HOUR = 3_600_000
/** Midday, so a pass that runs near midnight cannot roll into a different day between the two reads. */
const NOON = '2026-06-01T12:00:00Z'
const DAY = '2026-06-01'
const YESTERDAY = '2026-05-31'
const TOMORROW = '2026-06-02'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

function app(): Hono {
  const instance = new Hono()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  return instance
}

/** The pass as the endpoint answers it, for the account the mock names. */
async function pass(query = ''): Promise<FinishDay> {
  const response = await app().request(`/api/todos/finish-day${query}`, {}, env)
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json() as FinishDay
}

const titles = (rows: TodoTask[]): string[] => rows.map((task) => task.title).sort()

/** A closed span on a day, filed the way the timer's own door files it. */
async function track(taskId: string, day: string, hours = 1): Promise<void> {
  const start = Date.parse(`${day}T08:00:00Z`)
  await store.addManualTime(taskId, start, start + hours * HOUR)
}

/**
 * Move a finished row's completion day back one day.
 *
 * No store door back-dates a completion — `updateTask` always stamps today's day in the account's zone —
 * but a row restored from a backup carries the day it was finished on. That is the state the window has
 * to answer correctly, so it is written here rather than pretended away.
 */
async function finishOn(taskId: string, day: string): Promise<void> {
  sqlite.prepare('UPDATE todos_tasks SET completed_on = ? WHERE id = ?').run(day, taskId)
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOON))
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  // Pinned, so the day the endpoint names and the fixture's due times are the same days.
  await store.saveSettings({ ...(await store.getSettings()), timezone: 'UTC' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the day the pass finished', () => {
  it('holds the rows finished today, and not the one finished the day before', async () => {
    const finishedToday = await store.createTask({ title: 'Filed today', status: 'done' })
    const abandonedToday = await store.createTask({ title: 'Given up today', status: 'cancelled' })
    const finishedYesterday = await store.createTask({ title: 'Filed yesterday', status: 'done' })
    const stillOpen = await store.createTask({ title: 'Still open' })
    await finishOn(finishedYesterday.id, YESTERDAY)

    const answer = await pass()

    expect(titles(answer.done.rows)).toEqual(['Filed today', 'Given up today'])
    expect(answer.done.more).toBe(0)
    expect(stillOpen.title).toBe('Still open')
  })

  it('leaves a row the reader put away out of the bucket it would otherwise fill', async () => {
    const onThePlate = await store.createTask({ title: 'On the plate', status: 'done' })
    await store.createTask({ title: 'Shelved', status: 'done', archivedAt: Date.now() })

    expect(titles((await pass()).done.rows)).toEqual(['On the plate'])
    expect(onThePlate.archivedAt).toBeNull()
  })
})

describe('the work the day touched', () => {
  it('counts an open row with a closed span today, and refuses the three shapes that only look alike', async () => {
    const worked = await store.createTask({ title: 'Worked today' })
    const finished = await store.createTask({ title: 'Worked and finished', status: 'done' })
    const running = await store.createTask({ title: 'Timer still running' })
    const otherDay = await store.createTask({ title: 'Worked yesterday' })
    const trashed = await store.createTask({ title: 'Worked, then deleted' })
    await track(worked.id, DAY)
    await track(finished.id, DAY)
    await store.openTimeEntry(running.id, Date.parse(`${DAY}T09:00:00Z`))
    await track(otherDay.id, YESTERDAY)
    await track(trashed.id, DAY)
    await store.deleteTask(trashed.id)

    expect(titles((await pass()).worked.rows)).toEqual(['Worked today'])
  })

  it('asks the ledger about one day and not about the whole window around it', async () => {
    const task = await store.createTask({ title: 'Two days of work' })
    await track(task.id, YESTERDAY)
    await track(task.id, DAY)

    const answer = await pass()

    // The row is in yesterday's pass too — the point is that a day's bucket holds only that day's work,
    // so a row whose hours all belong to another day cannot arrive here and be called today's debt.
    expect(titles(answer.worked.rows)).toEqual(['Two days of work'])
    const yesterday = await pass(`?day=${YESTERDAY}`)
    expect(titles(yesterday.worked.rows)).toEqual(['Two days of work'])
    expect(titles((await pass(`?day=${TOMORROW}`)).worked.rows)).toEqual([])
  })
})

describe('what the reader fell behind on', () => {
  it('is open and due before the moment the pass was read', async () => {
    const late = await store.createTask({ title: 'An hour late', dueAt: Date.parse(`${NOON}`) - HOUR })
    await store.createTask({ title: 'Due this afternoon', dueAt: Date.parse(`${NOON}`) + HOUR })
    await store.createTask({ title: 'Finished late', dueAt: Date.parse(`${NOON}`) - HOUR, status: 'done' })

    expect(titles((await pass()).overdue.rows)).toEqual(['An hour late'])
    expect(late.status).toBe('todo')
  })

  it('is empty when nothing is behind', async () => {
    await store.createTask({ title: 'No dates at all' })

    const answer = await pass()

    expect(answer.overdue.rows).toEqual([])
    expect(answer.overdue.more).toBe(0)
  })
})

describe('what tomorrow already holds', () => {
  it('is picked for tomorrow, or due somewhere inside tomorrow’s own day', async () => {
    await store.createTask({ title: 'Picked for tomorrow', plannedFor: TOMORROW })
    await store.createTask({ title: 'Due tomorrow morning', dueAt: Date.parse(`${TOMORROW}T09:00:00Z`) })
    await store.createTask({ title: 'Due tomorrow evening', dueAt: Date.parse(`${TOMORROW}T23:30:00Z`) })
    await store.createTask({ title: 'Due this evening', dueAt: Date.parse(`${DAY}T23:30:00Z`) })
    await store.createTask({ title: 'Due the day after', dueAt: Date.parse('2026-06-03T09:00:00Z') })
    await store.createTask({ title: 'Picked for today', plannedFor: DAY })

    expect(titles((await pass()).planned.rows)).toEqual([
      'Due tomorrow evening', 'Due tomorrow morning', 'Picked for tomorrow',
    ])
  })

  it('cuts tomorrow at the account’s own clock, not at UTC midnight', async () => {
    await store.saveSettings({ ...(await store.getSettings()), timezone: 'Asia/Shanghai' })
    // Shanghai runs eight hours ahead, so the account's June 2nd is the UTC window 2026-06-01T16:00 to
    // 2026-06-02T16:00. Two of these four readings change which side of that line they fall on depending
    // on whose clock cuts it, and that is the whole case: a preview that cut at UTC would show a reader
    // work they had not taken on yet, and hide work they had.
    await store.createTask({ title: 'Tomorrow before dawn', dueAt: Date.parse('2026-06-01T20:00:00Z') })
    await store.createTask({ title: 'Tomorrow evening', dueAt: Date.parse('2026-06-02T10:00:00Z') })
    await store.createTask({ title: 'The day after, there', dueAt: Date.parse('2026-06-02T23:30:00Z') })
    await store.createTask({ title: 'Still tonight, there', dueAt: Date.parse('2026-06-01T12:00:00Z') })

    const answer = await pass()

    expect(answer.timezone).toBe('Asia/Shanghai')
    expect(answer.day).toBe('2026-06-01')
    expect(titles(answer.planned.rows)).toEqual(['Tomorrow before dawn', 'Tomorrow evening'])
  })

  it('takes the day after the one the address names, not the day after today', async () => {
    await store.createTask({ title: 'For the day after the pass', plannedFor: addDays(YESTERDAY, 1) })
    await store.createTask({ title: 'For the day after today', plannedFor: TOMORROW })

    // Asked about yesterday, the pass previews today: the preview always rides one day ahead of the
    // day being closed out, which is what makes an old day's close-out still useful.
    expect(titles((await pass(`?day=${YESTERDAY}`)).planned.rows)).toEqual(['For the day after the pass'])
    expect(titles((await pass()).planned.rows)).toEqual(['For the day after today'])
  })

  it('leaves an open row with no plan and no date out of every bucket', async () => {
    const undated = await store.createTask({ title: 'Someday' })

    const answer = await pass()

    expect(titles([...answer.done.rows, ...answer.overdue.rows, ...answer.planned.rows])).not.toContain('Someday')
    expect(undated.plannedFor).toBeNull()
  })
})

describe('the hours the day spent', () => {
  it('sums the closed spans of that day, and of that day only', async () => {
    const task = await store.createTask({ title: 'Two days of work' })
    await track(task.id, DAY, 2)
    await track(task.id, YESTERDAY, 5)

    expect((await pass()).trackedMs).toBe(2 * HOUR)
    expect((await pass(`?day=${YESTERDAY}`)).trackedMs).toBe(5 * HOUR)
  })

  it('leaves a running timer and a deleted row out of the day', async () => {
    const running = await store.createTask({ title: 'Timer still running' })
    const trashed = await store.createTask({ title: 'Worked, then deleted' })
    const kept = await store.createTask({ title: 'Kept' })
    await store.openTimeEntry(running.id, Date.parse(`${DAY}T09:00:00Z`))
    await track(trashed.id, DAY, 4)
    await track(kept.id, DAY, 1)
    await store.deleteTask(trashed.id)

    // The same two rules the worklog answers with, because the day-close page and the statistics have to
    // be able to sit beside each other and print one number.
    expect((await pass()).trackedMs).toBe(HOUR)
  })

  it('is zero, and not an absence, when nothing was tracked', async () => {
    await store.createTask({ title: 'A day of meetings nobody timed' })

    expect((await pass()).trackedMs).toBe(0)
  })
})

describe('the day the pass reads', () => {
  it('defaults to the account’s own today and echoes both days back', async () => {
    const answer = await pass()

    expect(answer.day).toBe(DAY)
    expect(answer.tomorrow).toBe(TOMORROW)
    expect(answer.timezone).toBe('UTC')
  })

  it('refuses a day it cannot read rather than answering about today', async () => {
    for (const day of ['2026-13-45', 'not-a-day', '2026-06-01T09:00']) {
      const response = await app().request(`/api/todos/finish-day?day=${day}`, {}, env)
      expect(response.status, day).toBe(400)
    }
  })

  it('names what the page left out instead of quietly shortening a bucket', async () => {
    for (const title of ['First', 'Second', 'Third']) {
      await store.createTask({ title, status: 'done' })
    }

    const answer = await pass('?limit=2')

    expect(answer.done.rows).toHaveLength(2)
    expect(answer.done.more).toBe(1)
  })

  it('never answers about another account’s rows', async () => {
    const other = new AssistantStore(env.DB as D1Database, FOREIGN, env)
    await other.saveSettings({ ...(await other.getSettings()), timezone: 'UTC' })
    await other.createTask({ title: 'Someone else’s work', status: 'done' })
    await other.createTask({ title: 'Someone else’s debt', dueAt: Date.parse(NOON) - HOUR })

    mocks.userId = USER
    const answer = await pass()

    expect(titles(answer.done.rows)).toEqual([])
    expect(titles(answer.overdue.rows)).toEqual([])
  })
})
