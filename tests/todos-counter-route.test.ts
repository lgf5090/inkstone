// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { AssistantStore } from '../src/worker/assistant/store'
import { todoRoutes } from '../src/worker/routes/todos'
import {
  COUNTER_WINDOW_DAYS,
  MAX_COUNTERS_PER_ACCOUNT,
  MAX_COUNTER_DAY_AMOUNT,
} from '../src/shared/todos/model'
import { localDate } from '../src/shared/assistant-time'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * R4-1b, the habits screen's HTTP surface.
 *
 * Six questions, each answered where the app already answers its kind: the listing carries the day window
 * the screen shades, a name and a kind and a target are validated as words and numbers rather than trusted,
 * and the day a tap lands on is named by the server — except when the reader is naming a day they forgot,
 * which is bounded to the window the screen can actually show. These routes sit before `/:id`, because a
 * habit called "counters" is not what that address means.
 */

const OTHER = '0123456789abcdefghjkmnpqrt'
const DAY_MS = 86_400_000

const mocks = vi.hoisted(() => ({ userId: '', createdAt: 1, settingsRaw: '{}' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { get: (key: string) => unknown; set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    c.set('user', {
      id: mocks.userId,
      username: mocks.userId,
      login: mocks.userId,
      name: '',
      avatarUrl: '',
      role: 'member',
      createdAt: mocks.createdAt,
      settingsRaw: mocks.settingsRaw,
    })
    await next()
  },
}))

/** One reading of the listing, as the shape the routes answer with. */
interface Reading {
  counter: { id: string, title: string, kind: string, goal: number | null, runningSince: number | null, color: string | null }
  from: string
  to: string
  today: string
  days: { day: string, amount: number }[]
}

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
// One account per case: the routes spend a shared per-minute write budget keyed on the reader, and a file
// that reuses one id across its cases watches that budget run out halfway through — the same reason the
// budget cases in `todos-route.test.ts` hand each caller a fresh id.
let account = 0

function freshUser(): string {
  account += 1
  return `habitaccount${String(account).padStart(14, '0')}`
}

/** The account the case under it signs in as. */
let reader = ''

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  return instance
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return app().request(`/api/todos${path}`, init, env)
}

async function jsonOf(response: Promise<Response> | Response): Promise<Record<string, unknown>> {
  return await (await response).json() as Record<string, unknown>
}

/** The account's own today — the day the server writes onto when the request names none. */
function today(): string {
  return localDate(Date.now(), 'UTC')
}

async function readings(): Promise<Reading[]> {
  return (await jsonOf(send('GET', '/counters'))).readings as Reading[]
}

async function create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await send('POST', '/counters', body)
  expect(response.status).toBe(201)
  return (await jsonOf(response)).counter as Record<string, unknown>
}

async function habitId(body: Record<string, unknown>): Promise<string> {
  return String((await create(body)).id)
}

/** What the listing says one day of one habit holds. */
async function amountOn(id: string, day: string): Promise<number> {
  const found = (await readings()).find((reading) => reading.counter.id === id)
  return found?.days.find((entry) => entry.day === day)?.amount ?? -1
}

/** The window's own first day, so a back-fill test never hard-codes a date. */
async function windowStart(): Promise<string> {
  return (await readings())[0]!.from
}

function rowCount(table: string): number {
  return Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  reader = freshUser()
  mocks.userId = reader
  mocks.createdAt = Date.now() - 30 * DAY_MS
  mocks.settingsRaw = '{}'
  store = new AssistantStore(env.DB as D1Database, reader, env)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the habits listing', () => {
  it('answers an empty account with an empty list and the reader\'s day', async () => {
    const body = await jsonOf(send('GET', '/counters'))
    expect(body.readings).toEqual([])
    expect(body.today).toBe(today())
  })

  it('is a route and not a task called counters', async () => {
    // Registered before `/:id` on purpose: if that order ever changes, the address is read as the id of a
    // task and answers with a 404 about a task nobody asked for.
    const body = await jsonOf(send('GET', '/counters'))
    expect(Array.isArray(body.readings)).toBe(true)
    expect(body).not.toHaveProperty('task')
  })

  it('carries every habit with the whole window, including the one with no days', async () => {
    const tapped = await habitId({ title: 'Tapped' })
    await habitId({ title: 'Untouched' })
    await send('POST', `/counters/${tapped}/tick`, { delta: 2 })
    const list = await readings()
    // Looked up by id: two habits made in the same millisecond are ordered by their ids, and an id is
    // only time-prefixed, so the page's order is stable without being creation order.
    expect(new Set(list.map((reading) => reading.counter.title))).toEqual(new Set(['Tapped', 'Untouched']))
    for (const reading of list) {
      expect(reading.days).toHaveLength(COUNTER_WINDOW_DAYS)
      expect(reading.to).toBe(reading.today)
    }
    const untouched = list.find((reading) => reading.counter.title === 'Untouched')
    expect(untouched?.days.every((entry) => entry.amount === 0)).toBe(true)
  })
})

describe('creating a habit', () => {
  it('takes a name, defaults to counting, and keeps the palette rule', async () => {
    const counter = await create({ title: '  Water  ' })
    expect(counter.title).toBe('Water')
    expect(counter.kind).toBe('clicks')
    expect(counter.goal).toBeNull()
    expect(counter.runningSince).toBeNull()
    expect(String(counter.color)).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('refuses a name that is not there and a kind that is not one', async () => {
    expect((await send('POST', '/counters', { title: '   ' })).status).toBe(400)
    expect((await send('POST', '/counters', { title: 'X', kind: 'interval' })).status).toBe(400)
    expect(await readings()).toEqual([])
  })

  it('refuses a target that is not a whole number inside a day', async () => {
    for (const goal of [-1, 1.5, '8', MAX_COUNTER_DAY_AMOUNT + 1]) {
      expect((await send('POST', '/counters', { title: 'Goal', goal })).status).toBe(400)
    }
    expect((await create({ title: 'Zero target', goal: 0 })).goal).toBe(0)
    expect((await create({ title: 'No target', goal: null })).goal).toBeNull()
  })

  it('refuses a colour outside the palette and an icon that is not text', async () => {
    expect((await send('POST', '/counters', { title: 'A', color: 'crimson' })).status).toBe(400)
    expect((await send('POST', '/counters', { title: 'B', icon: 7 })).status).toBe(400)
  })

  it('refuses the habit the account cannot hold any more of', async () => {
    for (let index = 0; index < MAX_COUNTERS_PER_ACCOUNT; index++) await habitId({ title: `Habit ${index}` })
    const response = await send('POST', '/counters', { title: 'One too many' })
    expect(response.status).toBe(400)
    expect(await jsonOf(response)).toHaveProperty('error')
  })
})

describe('editing and deleting', () => {
  it('changes only what the request names', async () => {
    const id = await habitId({ title: 'Walk', goal: 3 })
    const response = await send('PATCH', `/counters/${id}`, { title: 'Walk the dog' })
    expect(response.status).toBe(200)
    expect((await jsonOf(response)).counter).toMatchObject({ id, title: 'Walk the dog', goal: 3, kind: 'clicks' })
  })

  it('clears a target with null and refuses one that is not a number', async () => {
    const id = await habitId({ title: 'Read', goal: 20 })
    expect(((await jsonOf(send('PATCH', `/counters/${id}`, { goal: null }))).counter as { goal: unknown }).goal).toBeNull()
    expect((await send('PATCH', `/counters/${id}`, { goal: -3 })).status).toBe(400)
  })

  it('says nothing was found for another account\'s habit, and leaves it alone', async () => {
    const id = await habitId({ title: 'Mine' })
    mocks.userId = OTHER
    expect((await send('PATCH', `/counters/${id}`, { title: 'Yours' })).status).toBe(404)
    expect((await send('POST', `/counters/${id}/tick`, { delta: 1 })).status).toBe(404)
    expect((await send('DELETE', `/counters/${id}`)).status).toBe(404)
    expect(await readings()).toEqual([])
    mocks.userId = reader
    expect((await readings())[0]!.counter.title).toBe('Mine')
  })

  it('deletes the habit and its days with it', async () => {
    const id = await habitId({ title: 'Gone' })
    await send('POST', `/counters/${id}/tick`, { delta: 4 })
    expect(rowCount('todos_counter_ticks')).toBe(1)
    expect((await send('DELETE', `/counters/${id}`)).status).toBe(200)
    expect(await readings()).toEqual([])
    expect(rowCount('todos_counter_ticks')).toBe(0)
  })
})

describe('tapping a day', () => {
  it('lands on the account\'s today when the request names no day', async () => {
    const id = await habitId({ title: 'Push-ups' })
    expect(await jsonOf(send('POST', `/counters/${id}/tick`, { delta: 1 }))).toEqual({ day: today(), amount: 1 })
    expect(await amountOn(id, today())).toBe(1)
  })

  it('counts up and back down, and answers with the day\'s new total', async () => {
    const id = await habitId({ title: 'Water', goal: 3 })
    const amounts: number[] = []
    for (const delta of [1, 2, -1, -2]) {
      amounts.push(Number((await jsonOf(send('POST', `/counters/${id}/tick`, { delta }))).amount))
    }
    expect(amounts).toEqual([1, 3, 2, 0])
    expect(await amountOn(id, today())).toBe(0)
  })

  it('refuses a delta that taps nothing', async () => {
    const id = await habitId({ title: 'Stretch' })
    for (const delta of [0, 1.5, '2', MAX_COUNTER_DAY_AMOUNT + 1, -(MAX_COUNTER_DAY_AMOUNT + 1)]) {
      expect((await send('POST', `/counters/${id}/tick`, { delta })).status).toBe(400)
    }
    expect(await amountOn(id, today())).toBe(0)
  })

  it('answers with the reader\'s day, not the server\'s', async () => {
    // Half past noon UTC is already the next day at UTC+14, so the two answers differ and the case says
    // which one the route took. The habit's day window and a run of days both hang on this stamp.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'))
    await store.saveSettings({ ...(await store.getSettings()), timezone: 'Pacific/Kiritimati' })
    expect((await jsonOf(send('GET', '/counters'))).today).toBe('2026-10-21')
    const id = await habitId({ title: 'Late night' })
    expect((await jsonOf(send('POST', `/counters/${id}/tick`, { delta: 1 }))).day).toBe('2026-10-21')
  })

  it('back-fills a day the reader forgot, inside the window the screen shows', async () => {
    const id = await habitId({ title: 'Journal' })
    const first = await windowStart()
    const second = new Date(Date.parse(`${first}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)
    expect((await jsonOf(send('POST', `/counters/${id}/tick`, { delta: 1, day: second }))).day).toBe(second)
    expect(await amountOn(id, second)).toBe(1)
    expect(await amountOn(id, today())).toBe(0)
  })

  it('refuses a day that has not arrived, or is older than the window, or is not a day', async () => {
    const id = await habitId({ title: 'Early' })
    const first = await windowStart()
    const before = new Date(Date.parse(`${first}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)
    for (const day of ['2099-01-01', '2026-13-45', 'not-a-day', before]) {
      expect((await send('POST', `/counters/${id}/tick`, { delta: 1, day })).status).toBe(400)
    }
    expect(await amountOn(id, before)).toBe(-1)
  })
})

describe('a habit\'s own stopwatch', () => {
  it('runs only on a habit that counts seconds', async () => {
    const clicks = await habitId({ title: 'Tap only' })
    expect((await send('POST', `/counters/${clicks}/timer/start`)).status).toBe(400)
    expect((await send('POST', `/counters/${clicks}/timer/stop`)).status).toBe(400)
  })

  it('starts on the server\'s clock and stops onto the day it began', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T09:00:00Z'))
    const id = await habitId({ title: 'Meditate', kind: 'stopwatch', goal: 1_200 })
    const started = (await jsonOf(send('POST', `/counters/${id}/timer/start`))).counter as { runningSince: number }
    expect(started.runningSince).toBe(Date.parse('2026-10-20T09:00:00Z'))
    // Pressing start again takes the run that is already going rather than opening a second one.
    const again = (await jsonOf(send('POST', `/counters/${id}/timer/start`))).counter as { runningSince: number }
    expect(again.runningSince).toBe(started.runningSince)
    vi.setSystemTime(new Date('2026-10-20T09:20:00Z'))
    const body = await jsonOf(send('POST', `/counters/${id}/timer/stop`))
    expect((body.counter as { runningSince: number | null }).runningSince).toBeNull()
    expect(body.filed).toEqual({ day: '2026-10-20', amount: 1_200 })
    expect(await amountOn(id, '2026-10-20')).toBe(1_200)
  })

  it('says there was nothing to file when the stopwatch was already stopped', async () => {
    const id = await habitId({ title: 'Idle', kind: 'stopwatch' })
    const body = await jsonOf(send('POST', `/counters/${id}/timer/stop`))
    expect(body.filed).toBeNull()
    expect((body.counter as { runningSince: number | null }).runningSince).toBeNull()
  })

  it('takes the run from a habit of another account not at all', async () => {
    const id = await habitId({ title: 'Theirs', kind: 'stopwatch' })
    mocks.userId = OTHER
    expect((await send('POST', `/counters/${id}/timer/start`)).status).toBe(404)
    expect((await send('POST', `/counters/${id}/timer/stop`)).status).toBe(404)
    expect(await readings()).toEqual([])
  })
})
