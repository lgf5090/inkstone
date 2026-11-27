// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { CalendarStore } from '../src/worker/calendar/store'
import { errorResponse } from '../src/worker/lib/errors'
import { calendarIcsRoutes } from '../src/worker/routes/calendar-ics'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'f'.repeat(26)
let sqlite: DatabaseSync
let db: D1Database
let user: string

const app = new Hono<AppBindings>()
app.onError((error, context) => errorResponse(context, error))
app.use('*', async (context, next) => {
  if (user) context.set('userId', user)
  await next()
})
app.route('/api/calendar/ics', calendarIcsRoutes)

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  user = USER
})

async function call(body: unknown): Promise<Response> {
  return app.request('/api/calendar/ics/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, { DB: db } as AppBindings['Bindings'])
}

function ics(lines: string[] = []): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Inkstone//Import Test//EN',
    'BEGIN:VEVENT',
    'UID:import@example.com',
    'DTSTART:20261126T010000Z',
    'DTEND:20261126T020000Z',
    'SUMMARY:Imported event',
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

describe('POST /api/calendar/ics/import service boundary', () => {
  it('requires a session and validates the request before creating anything', async () => {
    user = ''
    expect((await call({ content: ics(), newCalendar: { name: 'Private' } })).status).toBe(401)
    user = USER
    expect((await call({ newCalendar: { name: 'Missing content' } })).status).toBe(400)
    expect((await call({ content: ics() })).status).toBe(400)
    expect((await call({ content: ics(), newCalendar: 'not-an-object' })).status).toBe(400)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_calendars').get()).toEqual({ count: 0 })
  })

  it('returns malformed ICS as a client error without leaving a new calendar', async () => {
    const response = await call({ content: 'BEGIN:VCALENDAR\r\nnot a calendar', newCalendar: { name: 'Broken' } })
    expect(response.status).toBe(400)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_calendars').get()).toEqual({ count: 0 })
  })

  it('refuses a read-only target before writing events', async () => {
    const store = new CalendarStore(db, USER)
    const calendar = await store.createCalendar({ name: 'Read only', color: '#112233' })
    sqlite.prepare('UPDATE calendar_calendars SET read_only = 1 WHERE user_id = ? AND id = ?').run(USER, calendar.id)
    const response = await call({ content: ics(), calendarId: calendar.id })
    expect(response.status).toBe(403)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events').get()).toEqual({ count: 0 })
  })

  it('falls back to the account time zone and keeps retries idempotent', async () => {
    const store = new CalendarStore(db, USER)
    const calendar = await store.createCalendar({ name: 'Imports', color: '#112233' })
    const preferences = await store.preferences()
    await store.savePreferences({ ...preferences, timeZone: 'Asia/Shanghai' })
    const content = ics()
      .replace('DTSTART:20261126T010000Z', 'DTSTART:20261126T010000')
      .replace('DTEND:20261126T020000Z', 'DTEND:20261126T020000')
    const request = { content, calendarId: calendar.id, defaultTimeZone: 'Not/AZone' }

    expect(await call(request)).toMatchObject({ status: 200 })
    expect(await call(request)).toMatchObject({ status: 200 })
    const rows = sqlite.prepare('SELECT start_ms, COUNT(*) AS count FROM calendar_events GROUP BY start_ms').all()
    expect(rows).toEqual([{ start_ms: Date.parse('2026-11-25T17:00:00Z'), count: 1 }])
  })

  it('normalizes attendees into the table and clears them when a re-import omits them', async () => {
    const store = new CalendarStore(db, USER)
    const calendar = await store.createCalendar({ name: 'Imports', color: '#112233' })
    const withGuest = ics([
      'ATTENDEE;CN=Guest;PARTSTAT=ACCEPTED:mailto:Guest@Example.com',
      'ATTENDEE;CN=Duplicate;PARTSTAT=DECLINED:mailto:guest@example.com',
    ])
    expect(await call({ content: withGuest, calendarId: calendar.id })).toMatchObject({ status: 200 })
    const [event] = await store.listAllEvents()
    expect(event).toBeTruthy()
    expect(await store.eventAttendees(event!.id)).toEqual([
      { email: 'guest@example.com', name: 'Guest', status: 'accepted' },
    ])
    expect(event!.meta).not.toHaveProperty('attendees')

    expect(await call({ content: ics(), calendarId: calendar.id })).toMatchObject({ status: 200 })
    expect(await store.eventAttendees(event!.id)).toEqual([])
    const stored = sqlite.prepare('SELECT meta_json FROM calendar_events WHERE id = ?').get(event!.id) as { meta_json: string }
    expect(JSON.parse(stored.meta_json)).not.toHaveProperty('attendees')
  })

  it('cleans up a newly created calendar when persistence fails', async () => {
    sqlite.exec(`CREATE TRIGGER fail_import_insert
      BEFORE INSERT ON calendar_events
      BEGIN SELECT RAISE(ABORT, 'forced import failure'); END`)
    const response = await call({ content: ics(), newCalendar: { name: 'Rollback' } })
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('partially imported')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_calendars').get()).toEqual({ count: 0 })
  })
})
