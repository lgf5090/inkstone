// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CalendarDto, CalendarEventDto } from '../src/shared/calendar/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { CalendarStore } from '../src/worker/calendar/store'
import { calendarRoutes } from '../src/worker/routes/calendar'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'
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

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.fetch(new Request(`http://localhost${TREE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { DB: db } as unknown as AppBindings['Bindings'], ctx)
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as T
}

const store = (who = ALICE) => new CalendarStore(db, who)

let calendar: CalendarDto

async function createEvent(overrides: Record<string, unknown> = {}): Promise<CalendarEventDto> {
  const response = await call('POST', '/events', {
    title: 'Kickoff',
    start: { value: '2026-11-02T09:00:00', type: 'datetime' },
    end: { value: '2026-11-02T10:00:00', type: 'datetime' },
    calendarId: calendar.id,
    ...overrides,
  })
  return (await json<{ event: CalendarEventDto }>(response)).event
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  user = ALICE
  calendar = (await store().ensureDefaultCalendar())[0]!
})

describe('the guest list', () => {
  it('replaces the whole list and reads it back in order', async () => {
    const event = await createEvent()

    const first = await store().setEventAttendees(event.id, [
      { email: 'kim@example.com', name: 'Kim', status: 'accepted' },
      { email: 'lee@example.com', name: '', status: 'needs-action' },
    ], event.rev)
    expect(first.attendees).toHaveLength(2)
    expect(await store().eventAttendees(event.id)).toEqual([
      { email: 'kim@example.com', name: 'Kim', status: 'accepted' },
      { email: 'lee@example.com', name: '', status: 'needs-action' },
    ])

    await store().setEventAttendees(event.id, [
      { email: 'lee@example.com', name: 'Lee', status: 'declined' },
    ], first.event.rev)
    expect(await store().eventAttendees(event.id)).toEqual([
      { email: 'lee@example.com', name: 'Lee', status: 'declined' },
    ])
  })

  it('carries the event revision and refuses a stale write', async () => {
    const event = await createEvent()

    const answer = await store().setEventAttendees(event.id, [
      { email: 'kim@example.com', name: '', status: 'tentative' },
    ], event.rev)

    expect(answer.event.rev).toBe(event.rev + 1)
    await expect(store().setEventAttendees(event.id, [], event.rev))
      .rejects.toMatchObject({ status: 409 })
    expect((await store().eventAttendees(event.id))[0]?.status).toBe('tentative')
  })

  it('keeps a read-only calendar read-only', async () => {
    const readOnly = await store().createCalendar({ name: 'Feed', color: '#112233', readOnly: true })
    // Only a provider sync may write into a read-only calendar, and it goes through the batch route.
    const synced = await json<{ events: CalendarEventDto[] }>(await call('POST', '/events/batch', {
      mode: 'create',
      events: [{
        title: 'Kickoff',
        start: { value: '2026-11-02T09:00:00', type: 'datetime' },
        end: { value: '2026-11-02T10:00:00', type: 'datetime' },
        calendarId: readOnly.id,
        source: 'caldav',
        externalId: 'ext-1',
      }],
    }))
    const event = synced.events[0]!

    await expect(store().setEventAttendees(event.id, [
      { email: 'kim@example.com', name: '', status: 'accepted' },
    ], event.rev)).rejects.toMatchObject({ status: 403 })
  })

  it('forgets the guests when the event or the calendar goes', async () => {
    const event = await createEvent()
    const withGuests = await store().setEventAttendees(event.id, [
      { email: 'kim@example.com', name: '', status: 'accepted' },
    ], event.rev)

    await store().deleteEvent(event.id, withGuests.event.rev)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_event_attendees').get()).toEqual({ n: 0 })

    // The app keeps one calendar per account, so a deletion needs another place for the account to live.
    await store().createCalendar({ name: 'Second', color: '#223344' })
    const other = await createEvent({ calendarId: calendar.id })
    await store().setEventAttendees(other.id, [{ email: 'lee@example.com', name: '', status: 'accepted' }], other.rev)
    await store().deleteCalendar(calendar.id, { mode: 'delete' })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_event_attendees').get()).toEqual({ n: 0 })
  })
})

describe('the attendee routes', () => {
  it('round-trips through the api', async () => {
    const event = await createEvent()

    const written = await json<{ event: CalendarEventDto; attendees: unknown[] }>(await call(
      'PUT',
      `/events/${event.id}/attendees`,
      {
        rev: event.rev,
        attendees: [
          { email: ' Kim.Song@Example.com ', name: 'Kim', status: 'accepted' },
          { email: 'kim.song@example.com', name: 'dup', status: 'declined' },
          { email: 'lee@example.com', status: 'tentative' },
        ],
      },
    ))
    expect(written.attendees).toEqual([
      { email: 'kim.song@example.com', name: 'Kim', status: 'accepted' },
      { email: 'lee@example.com', name: '', status: 'tentative' },
    ])

    const read = await json<{ attendees: unknown[] }>(await call('GET', `/events/${event.id}/attendees`))
    expect(read.attendees).toEqual(written.attendees)
  })

  it('refuses addresses, statuses and sizes it cannot store', async () => {
    const event = await createEvent()

    expect((await call('PUT', `/events/${event.id}/attendees`, {
      rev: event.rev, attendees: [{ email: 'nope', status: 'accepted' }],
    })).status).toBe(400)
    expect((await call('PUT', `/events/${event.id}/attendees`, {
      rev: event.rev, attendees: [{ email: 'a@b.co', status: 'maybe' }],
    })).status).toBe(400)
    expect((await call('PUT', `/events/${event.id}/attendees`, {
      rev: event.rev,
      attendees: Array.from({ length: 51 }, (_entry, index) => ({ email: `g${index}@example.com` })),
    })).status).toBe(400)
    expect((await call('PUT', `/events/${event.id}/attendees`, {
      rev: event.rev, attendees: 'kim@example.com',
    })).status).toBe(400)
    expect((await call('PUT', `/events/${event.id}/attendees`, {
      rev: event.rev, attendees: [{ email: 'a@b.co', name: 'x'.repeat(200) }],
    })).status).toBe(400)
  })

  it('answers only for the account that owns the row', async () => {
    const event = await createEvent()
    await call('PUT', `/events/${event.id}/attendees`, {
      rev: event.rev, attendees: [{ email: 'kim@example.com' }],
    })

    user = BOB
    expect((await call('GET', `/events/${event.id}/attendees`)).status).toBe(404)
    expect((await call('PUT', `/events/${event.id}/attendees`, {
      rev: event.rev, attendees: [],
    })).status).toBe(404)
  })
})
