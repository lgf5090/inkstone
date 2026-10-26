// @vitest-environment node
/**
 * M-02: the statistics endpoint bounds the span it is asked to draw, in buckets.
 *
 * `statsRange` already refused an unreadable day and a backwards range; what it did not refuse was a
 * window so long that the answer itself is the problem. The arithmetic that emits one entry per day,
 * week or month has no ceiling of its own, so `?from=1900-01-01&to=2100-01-01&bucket=day` — a URL the
 * address bar accepts and the assistant can build — asked the worker for 73 050 buckets: a 7.4 MB
 * answer and ~309 ms of pure computation before D1 was read at all. The cases below pin the refusal on
 * both sides of each per-bucket boundary, pin the guard `bucketStarts` now carries for a caller that
 * skips the route, and pin the two spellings of the count (the O(1) one the route reads and the array
 * the answer is built from) against each other, because a count that quietly disagreed with the builder
 * would be a ceiling that admits what it means to refuse.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoRoutes } from '../src/worker/routes/todos'
import { addDays, computeTodoStats, countStatBuckets, MAX_STATS_BUCKETS } from '../src/worker/todos/stats'
import type { StatsInput } from '../src/worker/todos/stats'
import type { TaskStatsBucket, TodoStats } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnceil'
/** A Monday, so a weekly range from here starts its first bucket on the range's own first day. */
const MONDAY = '2021-01-04'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let env: Env

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  return instance
}

/** One statistics request, answered rather than asserted, so each case reads its own status. */
async function request(query: string): Promise<{ status: number, body: Record<string, unknown> }> {
  mocks.userId = USER
  const response = await app().request(`/api/todos/stats${query}`, {}, env)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** The same range the address bar would build: `?view=stats&from=…&to=…&bucket=…`. */
function rangeQuery(from: string, to: string, bucket: TaskStatsBucket): string {
  return `?from=${from}&to=${to}&bucket=${bucket}`
}

/** The message a refusal answers with, which is the half a reader acts on. */
function message(body: Record<string, unknown>): string {
  return (body.error as { message: string }).message
}

/** Everything `computeTodoStats` needs for an account that holds nothing, over one range. */
function emptyInput(range: { from: string; to: string; bucket: TaskStatsBucket }): StatsInput {
  return {
    completed: [],
    created: [],
    open: [],
    abandonedTotal: 0,
    lists: [],
    tags: [],
    flowSeed: { createdBefore: 0, doneBefore: 0, cancelledBefore: 0, inProgressNow: 0 },
    flowEvents: [],
    earliestEventDay: null,
    timezone: 'UTC',
    now: Date.parse('2026-10-26T12:00:00Z'),
    ...range,
  }
}

beforeEach(() => {
  mocks.userId = USER
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

describe('the day bucket boundary', () => {
  const to = '2026-03-31'

  it('answers a range of exactly 366 daily buckets', async () => {
    const answer = await request(rangeQuery(addDays(to, -365), to, 'day'))

    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect((answer.body as unknown as TodoStats).series).toHaveLength(MAX_STATS_BUCKETS.day)
  })

  it('refuses the range one daily bucket longer', async () => {
    const answer = await request(rangeQuery(addDays(to, -366), to, 'day'))

    expect(answer.status).toBe(400)
    expect(message(answer.body)).toContain('366')
    expect(message(answer.body)).toMatch(/coarser bucket|narrower window/)
  })
})

describe('the week bucket boundary', () => {
  it('answers a range of exactly 262 weekly buckets', async () => {
    const answer = await request(rangeQuery(MONDAY, addDays(MONDAY, (MAX_STATS_BUCKETS.week - 1) * 7), 'week'))

    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect((answer.body as unknown as TodoStats).series).toHaveLength(MAX_STATS_BUCKETS.week)
  })

  it('refuses the range one weekly bucket longer', async () => {
    const answer = await request(rangeQuery(MONDAY, addDays(MONDAY, MAX_STATS_BUCKETS.week * 7), 'week'))

    expect(answer.status).toBe(400)
    expect(message(answer.body)).toContain(String(MAX_STATS_BUCKETS.week))
  })
})

describe('the month bucket boundary', () => {
  it('answers a range of exactly 240 monthly buckets', async () => {
    const answer = await request(rangeQuery('2006-04-01', '2026-03-31', 'month'))

    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect((answer.body as unknown as TodoStats).series).toHaveLength(MAX_STATS_BUCKETS.month)
  })

  it('refuses the range one monthly bucket longer', async () => {
    const answer = await request(rangeQuery('2006-03-01', '2026-03-31', 'month'))

    expect(answer.status).toBe(400)
    expect(message(answer.body)).toContain(String(MAX_STATS_BUCKETS.month))
  })
})

describe('the span the audit measured', () => {
  it('refuses two centuries of daily buckets before reading anything', async () => {
    const answer = await request(rangeQuery('1900-01-01', '2100-01-01', 'day'))

    expect(answer.status).toBe(400)
    expect(message(answer.body)).toContain('73050')
  })

  it('refuses the same window at the coarsest bucket too, because 200 years is 2401 months', async () => {
    expect(await request(rangeQuery('1900-01-01', '2100-01-01', 'month'))).toMatchObject({ status: 400 })
  })

  it('still answers the default window the screen opens on', async () => {
    const answer = await request('')

    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect((answer.body as unknown as TodoStats).series).toHaveLength(30)
  })

  it('leaves the worklog alone, since that answer is already cut by eachDay rather than by this ceiling', async () => {
    mocks.userId = USER
    const response = await app().request('/api/todos/worklog?from=2000-01-01&to=2099-12-31', {}, env)

    expect(response.status, await response.text()).toBe(200)
  })
})

describe('bucketStarts bounds its own arithmetic', () => {
  // The route is the only caller today, and a caller that skips it is the reason this guard exists:
  // without it the loop spins to 73 050 entries and the response is built whatever the validator said.
  it('stops building daily buckets past the ceiling instead of running away', () => {
    const answer = computeTodoStats(emptyInput({ from: '1900-01-01', to: '2100-01-01', bucket: 'day' }))

    expect(answer.series.length).toBeLessThanOrEqual(MAX_STATS_BUCKETS.day + 1)
    expect(answer.flow.length).toBeLessThanOrEqual(MAX_STATS_BUCKETS.day + 1)
    // Measured unbounded: 73 050 buckets, 7 379 780 bytes. The guard is what keeps that out of reach.
    expect(JSON.stringify(answer).length).toBeLessThan(200_000)
  })

  it('stops building monthly buckets past the ceiling as well', () => {
    const answer = computeTodoStats(emptyInput({ from: '1900-01-01', to: '2100-01-01', bucket: 'month' }))

    expect(answer.series.length).toBeLessThanOrEqual(MAX_STATS_BUCKETS.month + 1)
  })
})

describe('the counted ceiling and the built array agree', () => {
  const cases: Array<{ label: string, from: string, to: string, bucket: TaskStatsBucket }> = [
    { label: 'one day', from: '2026-01-01', to: '2026-01-01', bucket: 'day' },
    { label: 'a month of days', from: '2026-01-01', to: '2026-01-31', bucket: 'day' },
    { label: 'days across a year boundary', from: '2025-12-29', to: '2026-01-03', bucket: 'day' },
    { label: 'weeks from a Sunday', from: '2026-03-01', to: '2026-03-29', bucket: 'week' },
    { label: 'weeks over a year and a bit', from: MONDAY, to: addDays(MONDAY, 500), bucket: 'week' },
    { label: 'two months from a month end', from: '2026-01-31', to: '2026-02-01', bucket: 'month' },
    { label: 'months over a leap day', from: '2024-02-29', to: '2026-02-28', bucket: 'month' },
    { label: 'the widest monthly window the ceiling admits', from: '2006-04-01', to: '2026-03-31', bucket: 'month' },
    { label: 'the widest daily window the ceiling admits', from: '2025-04-01', to: '2026-03-31', bucket: 'day' },
  ]

  it.each(cases)('counts one bucket per entry built for $label', async (range) => {
    const counted = countStatBuckets(range.from, range.to, range.bucket)
    const answer = await request(rangeQuery(range.from, range.to, range.bucket))

    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(counted).toBeLessThanOrEqual(MAX_STATS_BUCKETS[range.bucket])
    const stats = answer.body as unknown as TodoStats
    expect(stats.series).toHaveLength(counted)
    expect(stats.flow).toHaveLength(counted)
  })
})
