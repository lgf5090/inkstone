// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CalendarDto } from '../src/shared/calendar/model'
import { MAX_EVENT_DESCRIPTION, MAX_ICS_EXPORT_BYTES } from '../src/shared/calendar/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { CalendarStore } from '../src/worker/calendar/store'
import { parseIcsCalendar, serializeIcsCalendar } from '../src/worker/calendar/ics'
import { calendarRoutes } from '../src/worker/routes/calendar'
import { calendarIcsRoutes } from '../src/worker/routes/calendar-ics'
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
app.route(`${TREE}/ics`, calendarIcsRoutes)

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

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as T
}

async function createCalendar(name: string): Promise<CalendarDto> {
  const answer = await json<{ calendar: CalendarDto }>(await call('POST', '/calendars', {
    name,
    color: '#112233',
  }))
  return answer.calendar
}

async function createEvent(
  calendarId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const response = await call('POST', '/events', {
    title: 'Review',
    start: { value: '2026-10-26T09:00:00', type: 'datetime' },
    end: { value: '2026-10-26T10:00:00', type: 'datetime' },
    calendarId,
    ...overrides,
  })
  await json(response)
}

/** Rows written straight to the table: the API caps one description well below a whole file. */
function insertStoredEvents(calendarId: string, count: number, description: string): void {
  const insert = sqlite.prepare(
    `INSERT INTO calendar_events (user_id, id, title, description, kind, start_value, start_type,
       start_ms, end_value, end_type, end_ms, all_day, meta_json, calendar_source, external_scope,
       created_at, updated_at, rev)
     VALUES (?, ?, ?, ?, 'event', '2026-10-26T09:00:00', 'datetime', 1761462000000,
       '2026-10-26T10:00:00', 'datetime', 1761465600000, 0, '{}', 'local', '', 1, 1, 1)`,
  )
  const link = sqlite.prepare(
    'INSERT INTO calendar_event_calendars (user_id, event_id, calendar_id, position) VALUES (?, ?, ?, 0)',
  )
  sqlite.exec('BEGIN')
  for (let index = 0; index < count; index += 1) {
    const id = `bulk-${index}`
    insert.run(ALICE, id, `Bulk ${index}`, description)
    link.run(ALICE, id, calendarId)
  }
  sqlite.exec('COMMIT')
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  user = ALICE
})

describe('GET /api/calendar/ics/export', () => {
  it('needs a session', async () => {
    user = ''
    const response = await call('GET', '/ics/export?calendarId=calendar-1')
    expect(response.status).toBe(401)
  })

  it('answers with the document its events serialize to', async () => {
    const calendar = await createCalendar('Work')
    await createEvent(calendar.id, { title: 'Standup' })
    await createEvent(calendar.id, {
      title: '设计评审',
      description: '带中文正文的评审，检查 UTF-8 导出。',
      meta: { location: '会议室' },
    })

    const response = await call('GET', `/ics/export?calendarId=${calendar.id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''Work.ics")
    expect(response.headers.get('cache-control')).toBe('no-store')

    const text = await response.text()
    const store = new CalendarStore(db, ALICE)
    const range = await store.listEvents(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, [calendar.id])
    // DTSTAMP is stamped per request, so the two documents are compared without it.
    const withoutStamps = (value: string): string =>
      value.split('\r\n').filter((line) => !line.startsWith('DTSTAMP:')).join('\r\n')
    expect(withoutStamps(text)).toBe(withoutStamps(serializeIcsCalendar({
      name: calendar.name,
      events: range.events,
      timeZone: (await store.preferences()).timeZone,
    })))

    const again = parseIcsCalendar({ content: text, defaultTimeZone: 'UTC', maxEvents: 10 })
    expect(again.events.map((event) => event.title).sort()).toEqual(['Standup', '设计评审'])
  })

  it('exports only the requested calendar', async () => {
    const work = await createCalendar('Work')
    const personal = await createCalendar('Personal')
    await createEvent(work.id, { title: 'Roadmap' })
    await createEvent(personal.id, { title: 'Dentist' })

    const text = await (await call('GET', `/ics/export?calendarId=${work.id}`)).text()
    expect(text).toContain('SUMMARY:Roadmap')
    expect(text).not.toContain('Dentist')
  })

  it('refuses an unknown calendar', async () => {
    const response = await call('GET', '/ics/export?calendarId=calendar-missing')
    expect(response.status).toBe(404)
  })

  it('refuses a calendar whose stored text cannot fit in one file, before reading its rows', async () => {
    const calendar = await createCalendar('Huge')
    const rows = Math.ceil(MAX_ICS_EXPORT_BYTES / MAX_EVENT_DESCRIPTION) + 1
    insertStoredEvents(calendar.id, rows, 'x'.repeat(MAX_EVENT_DESCRIPTION))

    const response = await call('GET', `/ics/export?calendarId=${calendar.id}`)
    expect(response.status).toBe(413)
    expect(await response.text()).toContain('more text than one file')
  })
})

describe('CalendarStore.exportSizeFor', () => {
  it('counts UTF-8 bytes of the text a calendar would export', async () => {
    const work = await createCalendar('Work')
    const personal = await createCalendar('Personal')
    await createEvent(work.id, { title: 'Standup', description: '备注' })
    await createEvent(personal.id, { title: 'Elsewhere', description: 'ignored' })

    const store = new CalendarStore(db, ALICE)
    expect(await store.exportSizeFor(work.id)).toEqual({
      events: 1,
      // 'Standup' is 7 bytes, the two-character Han description is 6 UTF-8 bytes, the empty meta
      // object is 2 — characters would have counted 13.
      storedBytes: 15,
    })
  })
})
