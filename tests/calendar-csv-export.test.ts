// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CalendarDto, CalendarEventDto } from '../src/shared/calendar/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { calendarRoutes } from '../src/worker/routes/calendar'
import { calendarCsvRoutes } from '../src/worker/routes/calendar-csv'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const TREE = '/api/calendar'

let sqlite: DatabaseSync
let db: D1Database
let user: string

const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
}

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.use('*', async (c, next) => {
  if (user) c.set('userId', user)
  await next()
})
app.route(TREE, calendarRoutes)
app.route(TREE, calendarCsvRoutes)

function env(): AppBindings['Bindings'] {
  return { DB: db } as unknown as AppBindings['Bindings']
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.fetch(new Request(`http://localhost${TREE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env(), ctx)
}

async function createCalendar(name: string): Promise<CalendarDto> {
  const response = await call('POST', '/calendars', { name, color: '#112233' })
  return (await response.json() as { calendar: CalendarDto }).calendar
}

async function createEvent(
  calendarId: string,
  overrides: Record<string, unknown> = {},
): Promise<CalendarEventDto> {
  const response = await call('POST', '/events', {
    title: 'Review',
    start: { value: '2026-10-26T09:00:00', type: 'datetime' },
    end: { value: '2026-10-26T10:00:00', type: 'datetime' },
    calendarId,
    ...overrides,
  })
  return (await response.json() as { event: CalendarEventDto }).event
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  user = ALICE
})

describe('GET /api/calendar/csv/export', () => {
  it('needs a session', async () => {
    user = ''
    const response = await call('GET', '/csv/export?calendarId=calendar-1')
    expect(response.status).toBe(401)
  })

  it('answers with one row per event and a round-trippable header', async () => {
    const calendar = await createCalendar('Work')
    await createEvent(calendar.id, { title: 'Standup' })
    await createEvent(calendar.id, {
      title: '设计评审',
      description: '带逗号, 引号"与换行\n的正文',
    })

    const response = await call('GET', `/csv/export?calendarId=${calendar.id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''Work.csv")
    expect(response.headers.get('cache-control')).toBe('no-store')

    const text = await response.text()
    expect(text.split('\r\n')[0]).toBe('title,start,end,all_day,description')
    expect(text).toContain('Standup,2026-10-26T09:00:00,2026-10-26T10:00:00,0,')
    expect(text).toContain('"带逗号, 引号""与换行\n的正文"')
  })

  it('exports only the named calendar', async () => {
    const work = await createCalendar('Work')
    const personal = await createCalendar('Personal')
    await createEvent(work.id, { title: 'Roadmap' })
    await createEvent(personal.id, { title: 'Dentist' })

    const text = await (await call('GET', `/csv/export?calendarId=${work.id}`)).text()
    expect(text).toContain('Roadmap')
    expect(text).not.toContain('Dentist')
  })

  it('refuses an unknown calendar', async () => {
    const response = await call('GET', '/csv/export?calendarId=calendar-missing')
    expect(response.status).toBe(404)
  })
})
