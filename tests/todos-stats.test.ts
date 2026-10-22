// @vitest-environment node
/**
 * The statistics endpoint: `GET /api/todos/stats`.
 *
 * The numbers are measured in the account's own calendar days (`completed_on` / `created_on`), so
 * these cases pin the range boundaries, the empty and single-day answers, a range across a year
 * boundary, and the two readings of one instant in two zones. They also pin the counting rules the
 * plan calls out: a repeated task is one completion per finished row, a reopened task stops counting,
 * and a finished task without a due date counts as finished but never enters the on-time denominator.
 *
 * One request must prepare a constant number of statements: the fixture is seeded through the store
 * before recording starts, so only the stats request itself is counted.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import { computeTodoFlow } from '../src/worker/todos/stats'
import type { StatsFlowEvent } from '../src/worker/todos/stats'
import { AssistantStore } from '../src/worker/assistant/store'
import type { TaskStatus, TodoStats, TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnq01'
const OTHER = '0123456789abcdefghjkmnq02'
const DAY_MS = 86_400_000

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let env: Env

/** Every statement prepared while recording is on; seeding happens with it off. */
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

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  return instance
}

/** One request as the signed-in account, answering with the parsed statistics. */
async function stats(query = '', user = USER): Promise<TodoStats> {
  mocks.userId = user
  const response = await app().request(`/api/todos/stats${query}`, {}, env)
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json() as TodoStats
}

function storeFor(user = USER): AssistantStore {
  return new AssistantStore(env.DB as D1Database, user, env)
}

async function withZone(zone: string, user = USER): Promise<AssistantStore> {
  const store = storeFor(user)
  await store.saveSettings({ ...(await store.getSettings()), timezone: zone })
  return store
}

async function seedCompleted(options: {
  user?: string
  zone?: string
  title?: string
  dueAt?: number | null
  repeat?: TodoTask['repeat']
} = {}): Promise<TodoTask> {
  const { user = USER, zone = 'UTC' } = options
  const store = storeFor(user)
  const task = await store.createTask({
    title: options.title ?? 'A task',
    dueAt: options.dueAt ?? null,
    repeat: options.repeat ?? null,
  }, zone)
  const done = await store.completeTask(task.id, zone)
  if (!done) throw new Error(`task ${task.id} was written but could not be completed`)
  return done.task
}

/** Pins the clock the store reads, so a completion lands on a day this test names. */
function clock(instant: string): void {
  vi.useFakeTimers({ now: new Date(instant) })
}

/** One event row in the shape the replay reads, with the instant written as ISO for readability. */
function flowEvent(
  kind: 'born' | 'status',
  from: TaskStatus | null,
  to: TaskStatus,
  at: string,
  onDay: string,
): StatsFlowEvent {
  return { kind, fromStatus: from, toStatus: to, at: Date.parse(at), onDay }
}

beforeEach(() => {
  mocks.userId = USER
  statements.length = 0
  recording = false
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(countedD1(makeD1(sqlite)), { PUBLIC_URL: 'http://localhost' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the shape of the answer', () => {
  it('answers an empty range with zeros and a zero-filled day series', async () => {
    const answer = await stats('?from=2020-01-01&to=2020-01-03')

    expect(answer.range).toEqual({ from: '2020-01-01', to: '2020-01-03', bucket: 'day', timezone: 'UTC' })
    expect(answer.summary).toEqual({
      completed: 0,
      created: 0,
      net: 0,
      open: 0,
      completionRate: 0,
      onTime: 0,
      onTimeDue: 0,
      onTimeRate: 0,
      medianLeadTimeMs: null,
      currentStreak: 0,
      longestStreak: 0,
      overdue: 0,
    })
    expect(answer.series).toEqual([
      { day: '2020-01-01', completed: 0, created: 0 },
      { day: '2020-01-02', completed: 0, created: 0 },
      { day: '2020-01-03', completed: 0, created: 0 },
    ])
    expect(answer.distributions.byList).toEqual([])
    expect(answer.distributions.byTag).toEqual([])
    expect(answer.distributions.byPriority.map((entry) => entry.completed)).toEqual([0, 0, 0, 0])
    expect(answer.distributions.byWeekday).toHaveLength(7)
    expect(answer.distributions.byHour).toHaveLength(24)
    expect(answer.distributions.byWeekdayHour).toEqual([])
    expect(answer.distributions.byHour.every((entry) => entry.completed === 0)).toBe(true)
    expect(answer.leadTime).toEqual({
      p50: null,
      p90: null,
      byPriority: [
        { priority: 'low', count: 0, averageMs: null },
        { priority: 'medium', count: 0, averageMs: null },
        { priority: 'high', count: 0, averageMs: null },
        { priority: 'urgent', count: 0, averageMs: null },
      ],
    })
    expect(answer.backlog).toEqual({ under7: 0, days7to30: 0, over30: 0, none: 0 })
  })

  it('crosses the weekday and the hour into one heatmap cell', async () => {
    // 2026-03-04 is a Wednesday (3) and the completion lands at 14:30 UTC, so the cell is (3, 14).
    clock('2026-03-04T14:30:00Z')
    await withZone('UTC')
    await seedCompleted({ title: 'Wednesday afternoon' })

    const answer = await stats('?from=2026-03-04&to=2026-03-04')

    expect(answer.distributions.byWeekdayHour).toEqual([{ weekday: 3, hour: 14, completed: 1 }])
    // The marginals still agree with the cell: one completion, counted once in each reading.
    expect(answer.distributions.byWeekday.find((entry) => entry.weekday === 3)?.completed).toBe(1)
    expect(answer.distributions.byHour.find((entry) => entry.hour === 14)?.completed).toBe(1)
  })

  it('answers a single day with one series point', async () => {
    clock('2026-05-10T12:00:00Z')
    await withZone('UTC')
    await seedCompleted({ title: 'Single day' })

    const answer = await stats('?from=2026-05-10&to=2026-05-10')

    expect(answer.series).toEqual([{ day: '2026-05-10', completed: 1, created: 1 }])
    expect(answer.summary.completed).toBe(1)
    expect(answer.summary.created).toBe(1)
    expect(answer.summary.net).toBe(0)
  })

  it('defaults to the last 30 days in the account zone', async () => {
    clock('2026-06-15T12:00:00Z')
    await withZone('UTC')
    await seedCompleted({ title: 'Today' })

    const answer = await stats()

    expect(answer.range.from).toBe('2026-05-17')
    expect(answer.range.to).toBe('2026-06-15')
    expect(answer.series).toHaveLength(30)
    expect(answer.series[0]).toEqual({ day: '2026-05-17', completed: 0, created: 0 })
    expect(answer.series[29]).toEqual({ day: '2026-06-15', completed: 1, created: 1 })
  })

  it('walks a range across the new year', async () => {
    clock('2025-12-31T12:00:00Z')
    await withZone('UTC')
    await seedCompleted({ title: 'Old year' })
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    await seedCompleted({ title: 'New year' })

    const days = await stats('?from=2025-12-31&to=2026-01-01')
    expect(days.series).toEqual([
      { day: '2025-12-31', completed: 1, created: 1 },
      { day: '2026-01-01', completed: 1, created: 1 },
    ])

    const months = await stats('?from=2025-12-31&to=2026-01-01&bucket=month')
    expect(months.series).toEqual([
      { day: '2025-12-01', completed: 1, created: 1 },
      { day: '2026-01-01', completed: 1, created: 1 },
    ])
  })

  it('groups a week bucket on its Monday', async () => {
    clock('2026-01-05T12:00:00Z')
    await withZone('UTC')
    await seedCompleted({ title: 'Monday' })
    vi.setSystemTime(new Date('2026-01-06T12:00:00Z'))
    await seedCompleted({ title: 'Tuesday' })
    vi.setSystemTime(new Date('2026-01-12T12:00:00Z'))
    await seedCompleted({ title: 'Next Monday' })

    const weeks = await stats('?from=2026-01-05&to=2026-01-12&bucket=week')
    expect(weeks.series).toEqual([
      { day: '2026-01-05', completed: 2, created: 2 },
      { day: '2026-01-12', completed: 1, created: 1 },
    ])
  })
})

describe('the calendar is the account’s, not the server’s', () => {
  it('files one instant under two different days for two zones', async () => {
    clock('2026-01-01T00:30:00Z')
    const shanghai = await withZone('Asia/Shanghai')
    const losAngeles = await withZone('America/Los_Angeles', OTHER)

    const east = await shanghai.createTask({ title: 'East' }, 'Asia/Shanghai')
    await shanghai.completeTask(east.id, 'Asia/Shanghai')
    const west = await losAngeles.createTask({ title: 'West' }, 'America/Los_Angeles')
    await losAngeles.completeTask(west.id, 'America/Los_Angeles')

    expect(sqlite.prepare('SELECT completed_on FROM todos_tasks WHERE user_id = ? AND id = ?')
      .get(USER, east.id)).toEqual({ completed_on: '2026-01-01' })
    expect(sqlite.prepare('SELECT completed_on FROM todos_tasks WHERE user_id = ? AND id = ?')
      .get(OTHER, west.id)).toEqual({ completed_on: '2025-12-31' })

    expect((await stats('?from=2026-01-01&to=2026-01-01')).summary.completed).toBe(1)
    expect((await stats('?from=2025-12-31&to=2025-12-31')).summary.completed).toBe(0)
    expect((await stats('?from=2025-12-31&to=2025-12-31', OTHER)).summary.completed).toBe(1)
    expect((await stats('?from=2026-01-01&to=2026-01-01', OTHER)).summary.completed).toBe(0)
  })
})

describe('what counts as one completion', () => {
  it('counts a repeated task once per finished row', async () => {
    clock('2026-03-02T09:00:00Z')
    const store = await withZone('UTC')
    const task = await store.createTask({
      title: 'Water the plants',
      dueAt: Date.parse('2026-03-02T09:00:00Z'),
      repeat: { freq: 'daily', interval: 1 },
    }, 'UTC')

    const first = await store.completeTask(task.id, 'UTC')
    expect(first?.next).not.toBeNull()
    const second = await store.completeTask(first!.next!.id, 'UTC')
    expect(second?.next).not.toBeNull()

    const answer = await stats('?from=2026-03-02&to=2026-03-02')
    expect(answer.summary.completed).toBe(2)
    expect(answer.series[0]?.completed).toBe(2)
  })

  it('stops counting a task that was reopened', async () => {
    clock('2026-03-03T09:00:00Z')
    const store = await withZone('UTC')
    const done = await seedCompleted({ title: 'Reopen me' })
    expect((await stats('?from=2026-03-03&to=2026-03-03')).summary.completed).toBe(1)

    await store.updateTask(done.id, { status: 'todo' }, 'UTC')

    const answer = await stats('?from=2026-03-03&to=2026-03-03')
    expect(answer.summary.completed).toBe(0)
    expect(answer.summary.open).toBe(1)
    expect(answer.series[0]).toEqual({ day: '2026-03-03', completed: 0, created: 1 })
  })

  it('counts a finished task without a due date, but keeps it out of the on-time denominator', async () => {
    clock('2026-03-04T09:00:00Z')
    await withZone('UTC')
    await seedCompleted({ title: 'No due date' })

    const answer = await stats('?from=2026-03-04&to=2026-03-04')
    expect(answer.summary.completed).toBe(1)
    expect(answer.summary.onTime).toBe(0)
    expect(answer.summary.onTimeDue).toBe(0)
    expect(answer.summary.onTimeRate).toBe(0)
    expect(answer.summary.medianLeadTimeMs).toBe(0)
  })
})

describe('the cumulative flow replay', () => {
  const ONE_DAY = { from: '2026-03-02', to: '2026-03-02', bucket: 'day' as const }
  const EMPTY = { createdBefore: 0, doneBefore: 0, inProgressNow: 0 }

  it('holds the seed across a range with no events', () => {
    const points = computeTodoFlow({ createdBefore: 10, doneBefore: 4, inProgressNow: 2 }, [], ONE_DAY)

    expect(points).toEqual([{ day: '2026-03-02', todo: 4, inProgress: 2, done: 4 }])
  })

  it('adds a birth to todo, because a birth has nothing to leave', () => {
    const points = computeTodoFlow(EMPTY, [
      flowEvent('born', null, 'todo', '2026-03-02T09:00:00Z', '2026-03-02'),
    ], ONE_DAY)

    expect(points).toEqual([{ day: '2026-03-02', todo: 1, inProgress: 0, done: 0 }])
  })

  it('moves a finished task out of todo and into done', () => {
    const points = computeTodoFlow({ createdBefore: 1, doneBefore: 0, inProgressNow: 0 }, [
      flowEvent('status', 'todo', 'done', '2026-03-02T09:00:00Z', '2026-03-02'),
    ], ONE_DAY)

    expect(points).toEqual([{ day: '2026-03-02', todo: 0, inProgress: 0, done: 1 }])
  })

  it('moves a started task out of todo and into in progress', () => {
    const points = computeTodoFlow({ createdBefore: 1, doneBefore: 0, inProgressNow: 0 }, [
      flowEvent('status', 'todo', 'in_progress', '2026-03-02T09:00:00Z', '2026-03-02'),
    ], ONE_DAY)

    expect(points).toEqual([{ day: '2026-03-02', todo: 0, inProgress: 1, done: 0 }])
  })

  it('moves a reopened task back to todo', () => {
    const points = computeTodoFlow({ createdBefore: 1, doneBefore: 1, inProgressNow: 0 }, [
      flowEvent('status', 'done', 'todo', '2026-03-02T09:00:00Z', '2026-03-02'),
    ], ONE_DAY)

    expect(points).toEqual([{ day: '2026-03-02', todo: 1, inProgress: 0, done: 0 }])
  })

  it('applies a birth before a completion at the same instant', () => {
    // A task logged already finished: the completion is listed first on purpose, and the replay has
    // to sort the birth ahead of it or the subtraction would hit a `todo` count that never held it.
    const points = computeTodoFlow(EMPTY, [
      flowEvent('status', 'todo', 'done', '2026-03-02T09:00:00Z', '2026-03-02'),
      flowEvent('born', null, 'todo', '2026-03-02T09:00:00Z', '2026-03-02'),
    ], ONE_DAY)

    expect(points).toEqual([{ day: '2026-03-02', todo: 0, inProgress: 0, done: 1 }])
  })

  it('files an event under the bucket of its own day, not of the range start', () => {
    // The range is one week starting Monday 2026-01-05; the event lands on Sunday the 11th.
    const points = computeTodoFlow(EMPTY, [
      flowEvent('born', null, 'todo', '2026-01-11T20:00:00Z', '2026-01-11'),
    ], { from: '2026-01-05', to: '2026-01-11', bucket: 'week' })

    expect(points).toEqual([{ day: '2026-01-05', todo: 1, inProgress: 0, done: 0 }])
  })

  it('clamps a seed that disagrees with itself instead of reporting negative work', () => {
    // `inProgressNow` is today's status: a dirty seed can claim more running tasks than the created
    // and finished columns leave room for. The todo band starts at zero rather than below it.
    const points = computeTodoFlow({ createdBefore: 3, doneBefore: 3, inProgressNow: 2 }, [], ONE_DAY)

    expect(points[0]?.todo).toBe(0)
  })
})

describe('the cumulative flow on the wire', () => {
  it('marks the day the first start was recorded, and answers null when none was', async () => {
    clock('2026-03-02T09:00:00Z')
    const store = await withZone('UTC')
    const first = await store.createTask({ title: 'First' }, 'UTC')
    await store.updateTask(first.id, { status: 'in_progress' }, 'UTC')
    vi.setSystemTime(new Date('2026-03-04T09:00:00Z'))
    const second = await store.createTask({ title: 'Second' }, 'UTC')
    await store.updateTask(second.id, { status: 'in_progress' }, 'UTC')

    const answer = await stats('?from=2026-03-01&to=2026-03-05')
    expect(answer.flowTrackedSince).toBe('2026-03-02')

    // A range that holds no start event has nothing to mark, even though the tasks are running now.
    const earlier = await stats('?from=2026-02-01&to=2026-02-02')
    expect(earlier.flowTrackedSince).toBeNull()
  })

  it('marks the day the record begins when a restore rebuilt the event table', async () => {
    // A backup carries the rows, not the history they went through, so a restored account holds tasks
    // whose days are years old beside an event table that starts on the day it was restored. Without a
    // mark the chart reads as though it replayed the whole range: the flow starts with a jump that was
    // never recorded, and the reader has nothing telling them the backlog before that day is a guess.
    clock('2026-01-01T09:00:00Z')
    const store = await withZone('UTC')
    const restoredAt = Date.parse('2026-01-01T09:00:00Z')
    await store.importRows('todos_tasks', [{
      id: '0123456789abcdefghjkmnq10',
      title: 'Carried in by the restore',
      description: '',
      status: 'todo',
      priority: 'medium',
      due_at: null,
      created_at: restoredAt,
      updated_at: restoredAt,
      created_on: '2026-01-01',
      completed_on: null,
      completed_at: null,
    }])

    // The first task written after the restore is the first row the account's own history holds.
    vi.setSystemTime(new Date('2026-03-05T09:00:00Z'))
    await store.createTask({ title: 'Written here' }, 'UTC')

    const answer = await stats('?from=2026-03-01&to=2026-03-10')
    expect(answer.flowTrackedSince).toBe('2026-03-05')

    // A range entirely before that day has no recorded history at all, so nothing is marked.
    const before = await stats('?from=2026-02-01&to=2026-02-28')
    expect(before.flowTrackedSince).toBeNull()
  })

  it('does not count a task started inside the range twice', async () => {
    clock('2026-03-01T09:00:00Z')
    const store = await withZone('UTC')
    const task = await store.createTask({ title: 'Started later' }, 'UTC')
    vi.setSystemTime(new Date('2026-03-03T09:00:00Z'))
    await store.updateTask(task.id, { status: 'in_progress' }, 'UTC')

    const answer = await stats('?from=2026-03-02&to=2026-03-03')

    // The seed already reads today's in-progress status; the start event must move the task rather
    // than add a second one. Without the seed's correction the band would read 1 then 2.
    expect(answer.flow.map((point) => point.inProgress)).toEqual([0, 1])
    expect(answer.flow.map((point) => point.todo)).toEqual([1, 0])
  })

  it('counts a task reopened inside the range as done when the range opened', async () => {
    clock('2026-03-01T09:00:00Z')
    const store = await withZone('UTC')
    const task = await store.createTask({ title: 'Reopened' }, 'UTC')
    await store.completeTask(task.id, 'UTC')
    vi.setSystemTime(new Date('2026-03-03T09:00:00Z'))
    await store.updateTask(task.id, { status: 'todo' }, 'UTC')

    const answer = await stats('?from=2026-03-02&to=2026-03-03')

    // Reopening cleared `completed_on`, so the day column alone would file the task under todo and
    // the reopen event would add a second todo. The seed restores it to done from the event itself.
    expect(answer.flow.map((point) => point.todo)).toEqual([0, 1])
    expect(answer.flow.map((point) => point.done)).toEqual([1, 0])
  })
})

describe('the query', () => {
  it('refuses an inverted, unreadable or unknown range', async () => {
    for (const query of [
      '?from=2026-01-02&to=2026-01-01',
      '?from=2026-02-30&to=2026-03-01',
      '?from=not-a-date',
      '?to=not-a-date',
      '?from=2026-01-01&to=2026-01-02&bucket=year',
    ]) {
      mocks.userId = USER
      const response = await app().request(`/api/todos/stats${query}`, {}, env)
      expect(response.status, query).toBe(400)
    }
  })

  it('prepares a constant number of statements whatever the range holds', async () => {
    clock('2026-04-01T12:00:00Z')
    const store = await withZone('UTC')
    const task = await store.createTask({ title: 'One' }, 'UTC')
    expect(await store.completeTask(task.id, 'UTC')).not.toBeNull()

    const countWith = async (): Promise<number> => {
      statements.length = 0
      recording = true
      try {
        await stats('?from=2026-04-01&to=2026-04-01')
      } finally {
        recording = false
      }
      return statements.length
    }

    const small = await countWith()
    for (let index = 0; index < 40; index += 1) {
      await store.createTask({ title: `Bulk ${index}` }, 'UTC')
    }
    const large = await countWith()

    expect(small).toBeGreaterThan(0)
    // The seven reads the tables need, the flow's seed and event range, and the one indexed minimum that
    // says where this account's record begins.
    expect(small).toBe(9)
    expect(large).toBe(small)
    expect(statements).toHaveLength(large)
  })
})
