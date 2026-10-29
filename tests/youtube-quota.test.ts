// @vitest-environment node
// The quota panel contract: unconfigured deployments still answer 200, seven UTC days are always
// present, and today's breakdown carries the same cost table the rest of the app uses.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { YOUTUBE_QUOTA_COSTS, type YouTubeQuotaData } from '../src/shared/youtube/model'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { youtubeQuotaRoutes } from '../src/worker/youtube/routes-quota'
import { YOUTUBE_SCHEMA_STATEMENTS } from '../src/worker/youtube/schema'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = new Hono<AppBindings>()
app.onError((error, c) => errorResponse(c, error))
app.use('*', async (c, next) => {
  c.set('userId', 'u1')
  await next()
})
app.route('/api/youtube/quota', youtubeQuotaRoutes)

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
}

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(YOUTUBE_SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
})

function envWith(overrides: Partial<Env> = {}): Env {
  return testBindings(db, overrides)
}

async function get(env: Env): Promise<Response> {
  return await app.request('/api/youtube/quota', { method: 'GET' }, env, ctx)
}

async function read(response: Response): Promise<YouTubeQuotaData> {
  return await response.json() as YouTubeQuotaData
}

function utcDate(offsetDays = 0): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10)
}

async function seedUsage(date: string, endpoint: string, units: number, count: number): Promise<void> {
  await db.prepare(
    'INSERT INTO youtube_quota_usage (date, endpoint, units, count) VALUES (?, ?, ?, ?)',
  )
    .bind(date, endpoint, units, count)
    .run()
}

describe('youtube quota route', () => {
  it('answers 200 with configured false and a zero-filled week when no key is set', async () => {
    const response = await get(envWith())
    expect(response.status).toBe(200)
    const body = await read(response)

    expect(body.configured).toBe(false)
    expect(body.limit).toBe(10_000)
    expect(body.today.date).toBe(utcDate())
    expect(body.today.total).toBe(0)
    expect(body.today.remaining).toBe(10_000)
    expect(body.today.breakdown).toEqual([])
    expect(body.quotaCosts).toEqual({ ...YOUTUBE_QUOTA_COSTS })
    expect(body.quotaCosts.search).toBe(100)

    expect(body.history).toHaveLength(7)
    expect(body.history.map((day) => day.date)).toEqual([
      utcDate(6),
      utcDate(5),
      utcDate(4),
      utcDate(3),
      utcDate(2),
      utcDate(1),
      utcDate(0),
    ])
    expect(body.history.every((day) => day.units === 0 && day.count === 0)).toBe(true)
    expect(body.weekBreakdown).toEqual([])
  })

  it('aggregates today, zero-fills missing days and sums the week by endpoint', async () => {
    await seedUsage(utcDate(0), 'search', 100, 1)
    await seedUsage(utcDate(0), 'videos', 3, 3)
    await seedUsage(utcDate(1), 'search', 50, 1)
    await seedUsage(utcDate(8), 'search', 999, 9)

    const response = await get(envWith({
      YOUTUBE_API_KEY: 'test-key',
      YOUTUBE_DAILY_QUOTA: '500',
    }))
    expect(response.status).toBe(200)
    const body = await read(response)

    expect(body.configured).toBe(true)
    expect(body.limit).toBe(500)
    expect(body.today.total).toBe(103)
    expect(body.today.remaining).toBe(397)
    expect(body.today.breakdown).toEqual([
      { endpoint: 'search', units: 100, count: 1, cost: 100 },
      { endpoint: 'videos', units: 3, count: 3, cost: 1 },
    ])

    expect(body.history).toHaveLength(7)
    expect(body.history[6]).toEqual({ date: utcDate(0), units: 103, count: 4 })
    expect(body.history[5]).toEqual({ date: utcDate(1), units: 50, count: 1 })
    expect(body.history[0]).toEqual({ date: utcDate(6), units: 0, count: 0 })
    expect(body.history.reduce((sum, day) => sum + day.units, 0)).toBe(153)

    expect(body.weekBreakdown).toEqual([
      { endpoint: 'search', units: 150, count: 2, cost: 100 },
      { endpoint: 'videos', units: 3, count: 3, cost: 1 },
    ])
  })

  it('keeps configured false for a whitespace-only key', async () => {
    const response = await get(envWith({ YOUTUBE_API_KEY: '   ' }))
    expect(response.status).toBe(200)
    const body = await read(response)
    expect(body.configured).toBe(false)
  })
})
