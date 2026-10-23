// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS, initializeDatabase } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { AssistantStore } from '../src/worker/assistant/store'
import { todoRoutes } from '../src/worker/routes/todos'
import {
  TODOS_REQUIRED_COLUMNS,
  TODOS_REQUIRED_INDEXES,
  TODOS_REQUIRED_TABLES,
} from '../src/worker/todos/schema'
import {
  MAX_DAY_TRACKED_MS,
  MAX_SINGLE_TIME_ENTRY_MS,
  MAX_TIME_ENTRY_AGE_DAYS,
  MAX_TIMER_START_FUTURE_MS,
  type TodoTimeEntry,
} from '../src/shared/todos/model'
import { localDate } from '../src/shared/assistant-time'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * R1-1, the time ledger's data layer.
 *
 * The ledger is one row per timed interval, and three rules decide whether it can be trusted: at
 * most one row per account runs at any instant (the partial unique index, not client discipline);
 * a day's total lands on the account's own calendar even across midnight and DST; and the server
 * refuses a client clock that writes an impossible interval rather than clamping it. Every gate
 * here is the ledger's reason for existing, so each one is pinned at the door that must hold it —
 * the schema, the store, the HTTP surface, the sync stream and the backup file.
 */

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const HOUR = 3_600_000
const DAY = 86_400_000

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

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.route('/api/todos', todoRoutes)
  return instance
}

async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
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

function countOpen(userId = USER): number {
  const row = sqlite.prepare(
    `SELECT COUNT(*) AS n FROM todos_time_entries WHERE user_id = ?1 AND end_at IS NULL`,
  ).get(userId) as { n: number }
  return Number(row.n)
}

function entryRows(userId = USER): { id: string; task_id: string; start_at: number; end_at: number | null; day: string; source: string }[] {
  return sqlite.prepare(
    `SELECT id, task_id, start_at, end_at, day, source FROM todos_time_entries
      WHERE user_id = ?1 ORDER BY start_at ASC, id ASC`,
  ).all(userId) as { id: string; task_id: string; start_at: number; end_at: number | null; day: string; source: string }[]
}

function insertEntry(entry: {
  id: string
  userId?: string
  taskId: string
  start: number
  end: number | null
  day: string
  source?: string
}): void {
  sqlite.prepare(
    `INSERT INTO todos_time_entries (user_id, id, task_id, start_at, end_at, day, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(entry.userId ?? USER, entry.id, entry.taskId, entry.start, entry.end, entry.day,
    entry.source ?? 'timer', entry.start, entry.start)
}

async function setTimezone(timeZone: string): Promise<void> {
  await store.saveSettings({ ...(await store.getSettings()), timezone: timeZone })
}

/** The account's own today, as every day-fixed assertion reads it. */
function today(timeZone = 'UTC'): string {
  return localDate(Date.now(), timeZone)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  mocks.userId = USER
  mocks.createdAt = Date.now() - 30 * DAY
  mocks.settingsRaw = '{}'
  store = new AssistantStore(env.DB as D1Database, USER, env)
})

afterEach(() => {
  vi.useRealTimers()
})

/** Pin the wall clock so a fixed calendar date stays inside the 400-day window forever. */
function freeze(epochMs: number, accountCreatedAt: number): void {
  vi.useFakeTimers({ now: epochMs })
  mocks.createdAt = accountCreatedAt
}

// ---------------------------------------------------------------- the schema

describe('the time entry table', () => {
  async function bootFresh(): Promise<DatabaseSync> {
    const fresh = new DatabaseSync(':memory:')
    fresh.exec('PRAGMA journal_mode = OFF')
    await initializeDatabase(testBindings(makeD1(fresh)))
    return fresh
  }

  it('is created by a fresh boot with its indexes, and listed as required', async () => {
    const fresh = await bootFresh()
    const columns = fresh.prepare(`SELECT name FROM pragma_table_info('todos_time_entries')`).all()
      .map((row) => (row as { name: string }).name)
    expect(columns).toEqual(['user_id', 'id', 'task_id', 'start_at', 'end_at', 'day', 'source', 'created_at', 'updated_at'])
    expect(TODOS_REQUIRED_COLUMNS.todos_time_entries).toEqual(columns)
    expect(TODOS_REQUIRED_TABLES).toContain('todos_time_entries')
    for (const index of ['ux_todos_time_open', 'idx_todos_time_task', 'idx_todos_time_day']) {
      const names = fresh.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all()
        .map((row) => (row as { name: string }).name)
      expect(names).toContain(index)
      expect(TODOS_REQUIRED_INDEXES).toContain(index)
    }
    fresh.close()
  })

  it('permits one open row per account and no more', async () => {
    const fresh = await bootFresh()
    const insert = fresh.prepare(
      `INSERT INTO todos_time_entries (user_id, id, task_id, start_at, end_at, day, source, created_at, updated_at)
       VALUES (?, ?, ?, 1, NULL, '2026-01-09', 'timer', 1, 1)`,
    )
    insert.run(USER, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'task-1')
    expect(() => insert.run(USER, 'bbbbbbbbbbbbbbbbbbbbbbbbbb', 'task-2')).toThrow()
    // Closed rows and other accounts are untouched by the partial predicate.
    expect(() => fresh.prepare(
      `INSERT INTO todos_time_entries (user_id, id, task_id, start_at, end_at, day, source, created_at, updated_at)
       VALUES (?, ?, 'task-1', 2, 3, '2026-01-09', 'timer', 1, 1)`,
    ).run(USER, 'cccccccccccccccccccccccccc')).not.toThrow()
    expect(() => insert.run(OTHER, 'dddddddddddddddddddddddddd', 'task-9')).not.toThrow()
    fresh.close()
  })

  it('carries the estimate column from version 148 on a database that predates it', async () => {
    const fresh = await bootFresh()
    const created = fresh.prepare(`SELECT name FROM pragma_table_info('todos_tasks')`).all()
      .map((row) => (row as { name: string }).name)
    expect(created).toContain('time_estimate_ms')
    expect(TODOS_REQUIRED_COLUMNS.todos_tasks).toContain('time_estimate_ms')

    fresh.exec(`ALTER TABLE todos_tasks DROP COLUMN time_estimate_ms`)
    fresh.exec(`DELETE FROM schema_migrations WHERE version = 148`)
    fresh.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
    await initializeDatabase(testBindings(makeD1(fresh)))

    const after = fresh.prepare(`SELECT name FROM pragma_table_info('todos_tasks')`).all()
      .map((row) => (row as { name: string }).name)
    expect(after).toContain('time_estimate_ms')
    expect(fresh.prepare(`SELECT version FROM schema_migrations WHERE version = 148`).all())
      .toEqual([{ version: 148 }])
    fresh.close()
  })
})

// ------------------------------------------------------------- timer endpoints

describe('starting and stopping a timer', () => {
  /** Midday in the default zone: no gesture here can cross a midnight unasked. */
  function atMidday(): number {
    freeze(Date.parse('2026-06-10T12:00:00Z'), Date.parse('2025-06-10T12:00:00Z'))
    return Date.now()
  }

  it('starting a second task stops the first', async () => {
    const now = atMidday()
    const a = await store.createTask({ title: 'Write the spec' })
    const b = await store.createTask({ title: 'Review the pull' })

    const first = await jsonOf(send('POST', `/${a.id}/timer/start`, { startAt: now - 2 * HOUR }))
    const entryA = first.entry as TodoTimeEntry
    expect(entryA.taskId).toBe(a.id)
    expect(entryA.endAt).toBeNull()
    expect(entryA.source).toBe('timer')
    expect(entryA.day).toBe(today())

    const second = await jsonOf(send('POST', `/${b.id}/timer/start`, { startAt: now - HOUR }))
    const entryB = second.entry as TodoTimeEntry
    expect(countOpen()).toBe(1)
    const rows = entryRows()
    const closedA = rows.find((row) => row.id === entryA.id)!
    expect(closedA.end_at).toBe(now - HOUR)
    expect(closedA.end_at! - closedA.start_at).toBe(HOUR)
    expect(entryB.endAt).toBeNull()
  })

  it('restarting the same task is idempotent and answers the running row', async () => {
    const a = await store.createTask({ title: 'Once only' })
    const first = await jsonOf(send('POST', `/${a.id}/timer/start`, {}))
    const again = await jsonOf(send('POST', `/${a.id}/timer/start`, {}))
    expect((again.entry as TodoTimeEntry).id).toBe((first.entry as TodoTimeEntry).id)
    expect(countOpen()).toBe(1)
  })

  it('stops the running row and refuses a stop with nothing running', async () => {
    const now = atMidday()
    const a = await store.createTask({ title: 'Deep work' })
    await send('POST', `/${a.id}/timer/start`, { startAt: now - HOUR })
    const stopped = await jsonOf(send('POST', `/${a.id}/timer/stop`, { endAt: now }))
    const entries = stopped.entries as TodoTimeEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0]!.endAt).toBe(now)
    expect(countOpen()).toBe(0)

    const response = await send('POST', `/${a.id}/timer/stop`, {})
    expect(response.status).toBe(404)
  })

  it('refuses an interval that ends before it starts instead of clamping it', async () => {
    const now = atMidday()
    const a = await store.createTask({ title: 'Back to front' })
    await send('POST', `/${a.id}/timer/start`, { startAt: now })
    const response = await send('POST', `/${a.id}/timer/stop`, { endAt: now - 1_000 })
    expect(response.status).toBe(400)
    expect(countOpen()).toBe(1)
  })

  it('answers 404 for a task the account does not have', async () => {
    expect((await send('POST', `/aaaaaaaaaaaaaaaaaaaaaaaaaa/timer/start`, {})).status).toBe(404)
  })
})

// ------------------------------------------------------------- manual entries

describe('a manual entry', () => {
  it('fixes the day in the account zone, not UTC', async () => {
    freeze(Date.parse('2026-03-01T12:00:00Z'), Date.parse('2026-01-01T00:00:00Z'))
    await setTimezone('Asia/Shanghai')
    const a = await store.createTask({ title: 'Filed late' })
    // 00:30 on the 28th in UTC+8 is still the 27th in UTC; the row must say the 28th.
    const startAt = Date.parse('2026-02-27T16:30:00Z')
    const created = await jsonOf(send('POST', `/${a.id}/time`, { startAt, endAt: startAt + 20 * 60_000 }))
    const entries = created.entries as TodoTimeEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0]!.day).toBe('2026-02-28')
    expect(entries[0]!.source).toBe('manual')
  })

  it('splits across the account midnight into one row per day', async () => {
    freeze(Date.parse('2026-01-11T12:00:00Z'), Date.parse('2025-12-01T00:00:00Z'))
    await setTimezone('America/New_York')
    const a = await store.createTask({ title: 'Overnight' })
    const startAt = Date.parse('2026-01-09T23:00:00-05:00')
    const endAt = Date.parse('2026-01-10T01:00:00-05:00')
    const created = await jsonOf(send('POST', `/${a.id}/time`, { startAt, endAt }))
    const entries = created.entries as TodoTimeEntry[]
    expect(entries.map((entry) => [entry.day, (entry.endAt ?? 0) - entry.startAt])).toEqual([
      ['2026-01-09', HOUR],
      ['2026-01-10', HOUR],
    ])
    expect(entries.reduce((total, entry) => total + ((entry.endAt ?? 0) - entry.startAt), 0))
      .toBe(endAt - startAt)
  })

  it('refuses a span past the per-entry ceiling', async () => {
    const a = await store.createTask({ title: 'All weekend' })
    const now = Date.now()
    const startAt = now - (MAX_SINGLE_TIME_ENTRY_MS + HOUR)
    const response = await send('POST', `/${a.id}/time`, { startAt, endAt: now })
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toMatch(/4 hours/)
  })

  it('refuses pushing one day past the daily ceiling', async () => {
    freeze(Date.parse('2026-06-10T12:00:00Z'), Date.parse('2025-06-10T12:00:00Z'))
    const a = await store.createTask({ title: 'One day over' })
    insertEntry({
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      taskId: a.id,
      start: 1,
      end: 1 + MAX_DAY_TRACKED_MS - HOUR / 2,
      day: today(),
    })
    const now = Date.now()
    const response = await send('POST', `/${a.id}/time`, { startAt: now - HOUR, endAt: now })
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toMatch(/24 hours/)
  })
})

// ------------------------------------------------------------- clock guards

describe('the server clock is the boundary', () => {
  it('refuses a start past the tolerance into the future', async () => {
    const a = await store.createTask({ title: 'From tomorrow' })
    const response = await send('POST', `/${a.id}/timer/start`, { startAt: Date.now() + MAX_TIMER_START_FUTURE_MS + 60_000 })
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toMatch(/future/)
  })

  it('refuses a start older than the account or older than the window', async () => {
    const a = await store.createTask({ title: 'Before the account' })
    const beforeAccount = await send('POST', `/${a.id}/timer/start`, { startAt: mocks.createdAt - DAY })
    expect(beforeAccount.status).toBe(400)
    const beforeWindow = await send('POST', `/${a.id}/timer/start`, { startAt: Date.now() - (MAX_TIME_ENTRY_AGE_DAYS + 1) * DAY })
    expect(beforeWindow.status).toBe(400)
  })

  it('refuses an instant that is not a timestamp', async () => {
    const a = await store.createTask({ title: 'Not a clock' })
    expect((await send('POST', `/${a.id}/timer/start`, { startAt: 'yesterday' })).status).toBe(400)
  })
})

// ------------------------------------------------------- split of a running row

describe('a running row split at the account midnight', () => {
  it('closes across midnight into one row per day whose total is the original span', async () => {
    await setTimezone('America/New_York')
    const a = await store.createTask({ title: 'Night shift' })
    const startAt = Date.parse('2026-01-09T23:00:00-05:00')
    const opened = await store.openTimeEntry(a.id, startAt)
    expect(opened?.day).toBe('2026-01-09')
    const endAt = Date.parse('2026-01-10T02:00:00-05:00')
    const entries = await store.closeTimeEntry(a.id, endAt)
    expect(entries).not.toBeNull()
    expect(entries!.map((entry) => [entry.day, (entry.endAt ?? 0) - entry.startAt])).toEqual([
      ['2026-01-09', HOUR],
      ['2026-01-10', 2 * HOUR],
    ])
    // The original row is reused rather than replaced: the id the client holds survives the split.
    expect(entries![0]!.id).toBe(opened!.id)
    expect(entries!.reduce((total, entry) => total + (entry.endAt ?? 0) - entry.startAt, 0))
      .toBe(endAt - startAt)
    expect(await store.timeByDay('2026-01-09', '2026-01-10')).toEqual([
      { day: '2026-01-09', ms: HOUR },
      { day: '2026-01-10', ms: 2 * HOUR },
    ])
  })

  it('keeps both entries of a short DST day on that day', async () => {
    await setTimezone('America/New_York')
    const a = await store.createTask({ title: 'Spring forward' })
    // 2026-03-08 is 23 hours long in New York: the clock jumps from 02:00 to 03:00.
    await store.addManualTime(a.id, Date.parse('2026-03-08T10:30:00-05:00'), Date.parse('2026-03-08T11:30:00-05:00'))
    await store.addManualTime(a.id, Date.parse('2026-03-08T20:00:00-04:00'), Date.parse('2026-03-08T21:00:00-04:00'))
    const days = await store.timeByDay('2026-03-07', '2026-03-09')
    expect(days).toEqual([{ day: '2026-03-08', ms: 2 * HOUR }])
  })
})

// ------------------------------------------------------------------ aggregates

describe('the aggregate reads', () => {
  it('sums a task closed rows only, ignoring the running one', async () => {
    const a = await store.createTask({ title: 'Counted' })
    insertEntry({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', taskId: a.id, start: 1_000, end: 1_000 + 90 * 60_000, day: '2026-01-05' })
    insertEntry({ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', taskId: a.id, start: 2_000, end: 2_000 + 30 * 60_000, day: '2026-01-06' })
    insertEntry({ id: 'cccccccccccccccccccccccccc', taskId: a.id, start: 3_000, end: null, day: '2026-01-07' })
    expect(await store.taskTimeSpent(a.id)).toBe(2 * HOUR)
  })

  it('answers the grouped range in one read', async () => {
    const a = await store.createTask({ title: 'Bucket me' })
    insertEntry({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', taskId: a.id, start: 1_000, end: 1_000 + HOUR, day: '2026-01-05' })
    insertEntry({ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', taskId: a.id, start: 2_000, end: 2_000 + 2 * HOUR, day: '2026-01-06' })
    insertEntry({ id: 'cccccccccccccccccccccccccc', taskId: a.id, start: 3_000, end: null, day: '2026-01-06' })

    const byDay = await jsonOf(send('GET', `/time?from=2026-01-05&to=2026-01-06`))
    expect(byDay.group).toBe('day')
    expect(byDay.totals).toEqual([
      { day: '2026-01-05', ms: HOUR },
      { day: '2026-01-06', ms: 2 * HOUR },
    ])
    expect(byDay.totalMs).toBe(3 * HOUR)

    const byTask = await jsonOf(send('GET', `/time?from=2026-01-05&to=2026-01-06&group=task`))
    expect(byTask.totals).toEqual([{ taskId: a.id, ms: 3 * HOUR }])

    expect((await send('GET', `/time?from=2026-01-05&to=2026-01-06&group=week`)).status).toBe(400)
    expect((await send('GET', `/time?from=2026-13-01&to=2026-01-06`)).status).toBe(400)
  })
})
