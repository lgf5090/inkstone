// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import {
  addCounterTick,
  claimCounterTimer,
  createCounter,
  deleteCounter,
  getCounter,
  listCounters,
  loadCounterReadings,
  startCounterTimer,
  stopCounterTimer,
  updateCounter,
} from '../src/worker/todos/counters'
import { TODOS_REQUIRED_COLUMNS, TODOS_REQUIRED_TABLES } from '../src/worker/todos/schema'
import {
  COUNTER_WINDOW_DAYS,
  MAX_COUNTERS_PER_ACCOUNT,
  MAX_COUNTER_DAY_AMOUNT,
  counterDayMet,
} from '../src/shared/todos/model'
import { localDate } from '../src/shared/assistant-time'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * R4-1a, the habit counters' data layer.
 *
 * A habit is only two tables and a handful of numbers, so everything worth pinning is a rule about
 * where a day begins, what an empty day is, and who may see a row: a run that files itself on the day
 * it was stopped rather than the day it started rewrites the past at midnight; a tap that leaves a
 * zero behind makes "I did nothing" and "I undid what I did" the same record; and the day window is
 * read once for the whole screen, because forty habits asked one at a time is forty round trips over
 * the same rows.
 */

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const MINUTE = 60_000

let sqlite: DatabaseSync
let env: Env
let db: D1Database

function tickRows(counterId: string, userId = USER): { day: string, amount: number }[] {
  return sqlite.prepare(
    `SELECT day, amount FROM todos_counter_ticks WHERE user_id = ?1 AND counter_id = ?2 ORDER BY day ASC`,
  ).all(userId, counterId) as { day: string, amount: number }[]
}

function columnsOf(table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name)
}

async function newHabit(title = 'Meditate', input: Record<string, unknown> = {}) {
  const counter = await createCounter(db, USER, { title, kind: 'clicks', ...input })
  if (!counter) throw new Error(`The habit ${title} was not created.`)
  return counter
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  db = env.DB as D1Database
})

describe('the two tables the habits screen reads', () => {
  it('is declared, guarded and built with exactly the columns the guard names', () => {
    expect(TODOS_REQUIRED_TABLES).toContain('todos_counters')
    expect(TODOS_REQUIRED_TABLES).toContain('todos_counter_ticks')
    expect(TODOS_REQUIRED_COLUMNS.todos_counters).toEqual(columnsOf('todos_counters'))
    expect(TODOS_REQUIRED_COLUMNS.todos_counter_ticks).toEqual(columnsOf('todos_counter_ticks'))
  })

  it('holds one row per habit and day, which is what makes a tap an upsert', () => {
    expect(() => sqlite.prepare(
      `INSERT INTO todos_counter_ticks (user_id, counter_id, day, amount) VALUES (?1, ?2, ?3, 1)`,
    ).run(USER, 'c1', '2026-10-20')).not.toThrow()
    expect(() => sqlite.prepare(
      `INSERT INTO todos_counter_ticks (user_id, counter_id, day, amount) VALUES (?1, ?2, ?3, 1)`,
    ).run(USER, 'c1', '2026-10-20')).toThrow()
  })
})

describe('creating a habit', () => {
  it('keeps the palette rule the lists use and reads the two nulls apart', async () => {
    const bare = await newHabit('Read')
    expect(bare.color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(bare.goal).toBeNull()
    expect(bare.runningSince).toBeNull()
    const targetless = await newHabit('Stretch', { goal: 0 })
    // Zero is a target the reader set; null is the absence of one, and a day counts differently against
    // each, so the row has to keep them as two different values.
    expect(targetless.goal).toBe(0)
  })

  it('refuses more habits than the screen can read', async () => {
    for (let index = 0; index < MAX_COUNTERS_PER_ACCOUNT; index++) {
      expect(await createCounter(db, USER, { title: `Habit ${index}`, kind: 'clicks' })).not.toBeNull()
    }
    expect(await createCounter(db, USER, { title: 'One too many', kind: 'clicks' })).toBeNull()
    expect(await listCounters(db, USER)).toHaveLength(MAX_COUNTERS_PER_ACCOUNT)
  })

  it('holds the same order across a rename, which is what the screen reads', async () => {
    const first = await newHabit('First')
    const second = await newHabit('Second')
    const before = (await listCounters(db, USER)).map((counter) => counter.id)
    expect(new Set(before)).toEqual(new Set([first.id, second.id]))
    const renamed = await updateCounter(db, USER, first.id, { title: 'First, renamed' })
    expect(renamed?.title).toBe('First, renamed')
    // Nothing but the day's own stamp moves a habit down the list, so editing one never re-shuffles the
    // others under the reader's hands.
    expect((await listCounters(db, USER)).map((counter) => counter.id)).toEqual(before)
  })

  it('names the habit the account holds and no one else\'s', async () => {
    const habit = await newHabit('Walk')
    expect(await getCounter(db, OTHER, habit.id)).toBeNull()
    expect(await updateCounter(db, OTHER, habit.id, { title: 'Stolen' })).toBeNull()
    expect(await deleteCounter(db, OTHER, habit.id)).toBe(false)
    expect(await getCounter(db, USER, habit.id)).not.toBeNull()
  })
})

describe('tapping a day', () => {
  it('adds, and takes away, and leaves no row when the day is empty again', async () => {
    const habit = await newHabit('Water', { goal: 8 })
    await addCounterTick(db, USER, habit.id, '2026-10-20', 1)
    await addCounterTick(db, USER, habit.id, '2026-10-20', 1)
    expect(tickRows(habit.id)).toEqual([{ day: '2026-10-20', amount: 2 }])
    await addCounterTick(db, USER, habit.id, '2026-10-20', -1)
    expect(tickRows(habit.id)).toEqual([{ day: '2026-10-20', amount: 1 }])
    // Undoing the last tap removes the row rather than writing a zero, so an untouched day and a day
    // whose taps were all taken back are the same record — and the same answer.
    await addCounterTick(db, USER, habit.id, '2026-10-20', -1)
    expect(tickRows(habit.id)).toEqual([])
  })

  it('cannot be talked into a day that is longer than a day, or shorter than nothing', async () => {
    const habit = await newHabit('Study')
    await addCounterTick(db, USER, habit.id, '2026-10-20', MAX_COUNTER_DAY_AMOUNT * 10)
    expect(tickRows(habit.id)).toEqual([{ day: '2026-10-20', amount: MAX_COUNTER_DAY_AMOUNT }])
    await addCounterTick(db, USER, habit.id, '2026-10-20', -MAX_COUNTER_DAY_AMOUNT * 10)
    expect(tickRows(habit.id)).toEqual([])
  })

  it('keeps one habit\'s days away from another\'s', async () => {
    const one = await newHabit('One')
    const two = await newHabit('Two')
    await addCounterTick(db, USER, one.id, '2026-10-20', 3)
    await addCounterTick(db, USER, two.id, '2026-10-20', 5)
    expect(tickRows(one.id)).toEqual([{ day: '2026-10-20', amount: 3 }])
    expect(tickRows(two.id)).toEqual([{ day: '2026-10-20', amount: 5 }])
  })
})

describe('a habit\'s own stopwatch', () => {
  it('takes the run that is already going when start is pressed twice', async () => {
    const habit = await newHabit('Run', { kind: 'stopwatch' })
    const started = await startCounterTimer(db, USER, habit.id, 1_000)
    expect(started?.runningSince).toBe(1_000)
    // A replay after a dropped response must not open a second timer: the instant the first one began
    // is the answer, and the seconds it runs are the only ones that will ever be filed.
    const again = await startCounterTimer(db, USER, habit.id, 5_000)
    expect(again?.runningSince).toBe(1_000)
  })

  it('files the run on the day it began, not on the day it was stopped', async () => {
    const habit = await newHabit('Meditate', { kind: 'stopwatch' })
    // A run started at 23:45 and stopped half past midnight belongs to the evening it was begun in,
    // in the account's zone: the same rule every other day column in this schema was fixed for.
    const began = Date.parse('2026-10-20T23:45:00Z')
    await startCounterTimer(db, USER, habit.id, began)
    const stopped = await stopCounterTimer(db, USER, habit.id, began + 30 * MINUTE, 'UTC')
    expect(stopped?.runningSince).toBeNull()
    expect(tickRows(habit.id)).toEqual([{ day: '2026-10-20', amount: 1_800 }])
  })

  it('writes nothing when the clock went backwards between start and stop', async () => {
    const habit = await newHabit('Yoga', { kind: 'stopwatch' })
    const began = Date.parse('2026-10-20T08:00:00Z')
    await startCounterTimer(db, USER, habit.id, began)
    await stopCounterTimer(db, USER, habit.id, began - 10 * MINUTE, 'UTC')
    expect(tickRows(habit.id)).toEqual([])
    expect((await getCounter(db, USER, habit.id))?.runningSince).toBeNull()
  })

  it('will not stop a run that began after the one this call read', async () => {
    const habit = await newHabit('Row', { kind: 'stopwatch' })
    const began = Date.parse('2026-10-20T08:00:00Z')
    await startCounterTimer(db, USER, habit.id, began)
    await stopCounterTimer(db, USER, habit.id, began + 20 * MINUTE, 'UTC')
    expect(tickRows(habit.id)).toEqual([{ day: '2026-10-20', amount: 1_200 }])
    // A second run is now open. A stop that arrived late still names the first instant, and clearing on
    // "is anything running" instead of "is this still the run I read" would take the new one away and
    // bill the reader for twenty minutes they are still inside.
    const again = began + 60 * MINUTE
    await startCounterTimer(db, USER, habit.id, again)
    expect(await claimCounterTimer(db, USER, habit.id, began, again + 25 * MINUTE)).toBe(false)
    expect((await getCounter(db, USER, habit.id))?.runningSince).toBe(again)
    expect(tickRows(habit.id)).toEqual([{ day: '2026-10-20', amount: 1_200 }])
  })

  it('is not a ledger row, and leaves the task timer alone', async () => {
    const habit = await newHabit('Breath', { kind: 'stopwatch' })
    await startCounterTimer(db, USER, habit.id, Date.parse('2026-10-20T08:00:00Z'))
    expect(Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM todos_time_entries`).get() as { n: number }).n)).toBe(0)
    // A habit's run does not take the account's one open slot, so a meditation beside a work timer is
    // not refused by the ledger's partial unique index.
    sqlite.prepare(
      `INSERT INTO todos_time_entries (user_id, id, task_id, start_at, end_at, day, source, created_at, updated_at)
       VALUES (?1, 't1', 'task-1', ?2, NULL, '2026-10-20', 'timer', ?2, ?2)`,
    ).run(USER, Date.parse('2026-10-20T08:00:00Z'))
    expect(Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM todos_time_entries WHERE end_at IS NULL`).get() as { n: number }).n)).toBe(1)
  })
})

describe('reading a habit\'s days', () => {
  it('answers every habit with the whole window, empty days included', async () => {
    const one = await newHabit('One')
    await newHabit('Two')
    const today = localDate(Date.now(), 'UTC')
    await addCounterTick(db, USER, one.id, today, 2)
    const readings = await loadCounterReadings(db, USER, today)
    expect(readings).toHaveLength(2)
    // Read by id, not by position: two habits created inside the same millisecond are ordered by their
    // ids, and an id is only time-prefixed, so the list's order is stable without being creation order.
    const tapped = readings.find((reading) => reading.counter.id === one.id)
    const untouched = readings.find((reading) => reading.counter.id !== one.id)
    for (const reading of readings) {
      expect(reading.days).toHaveLength(COUNTER_WINDOW_DAYS)
      expect(reading.to).toBe(reading.today)
    }
    // The habit nobody tapped still comes back, with a zero for every day: a screen that had to infer
    // "no rows" from a missing key would be deciding what an empty habit looks like on its own.
    expect(untouched?.days.every((day) => day.amount === 0)).toBe(true)
    expect(tapped?.days[tapped.days.length - 1]?.amount).toBe(2)
  })

  it('reads every habit\'s days in one statement', async () => {
    for (const title of ['A', 'B', 'C', 'D', 'E']) await newHabit(title)
    const prepare = vi.spyOn(db, 'prepare')
    await loadCounterReadings(db, USER, localDate(Date.now(), 'UTC'))
    const tickReads = prepare.mock.calls.filter(([sql]) => String(sql).includes('todos_counter_ticks'))
    expect(tickReads).toHaveLength(1)
    prepare.mockRestore()
  })

  it('does not carry a day outside the window it names', async () => {
    const habit = await newHabit('Early')
    const today = localDate(Date.now(), 'UTC')
    await addCounterTick(db, USER, habit.id, '2020-01-01', 4)
    const [reading] = await loadCounterReadings(db, USER, today)
    expect(reading?.days.some((day) => day.amount > 0)).toBe(false)
    expect(reading?.from > '2020-01-01').toBe(true)
  })

  it('takes a habit\'s history with it when the habit goes', async () => {
    const habit = await newHabit('Dissolved')
    await addCounterTick(db, USER, habit.id, localDate(Date.now(), 'UTC'), 3)
    expect(await deleteCounter(db, USER, habit.id)).toBe(true)
    expect(tickRows(habit.id)).toEqual([])
    expect(await listCounters(db, USER)).toEqual([])
  })
})

describe('what a day counts as', () => {
  it('measures against the target when there is one, and against nothing when there is not', () => {
    expect(counterDayMet(7, 8)).toBe(false)
    expect(counterDayMet(8, 8)).toBe(true)
    expect(counterDayMet(9, 8)).toBe(true)
    // A target of zero is a target the reader set; no target at all is not, and the difference shows up
    // as the day that counts by having happened.
    expect(counterDayMet(0, 0)).toBe(true)
    expect(counterDayMet(0, null)).toBe(false)
    expect(counterDayMet(1, null)).toBe(true)
  })
})
