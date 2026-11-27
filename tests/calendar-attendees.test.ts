// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CalendarDto, CalendarEventDto } from '../src/shared/calendar/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { CalendarStore } from '../src/worker/calendar/store'
import { parseEventInput, parseEventPatch } from '../src/worker/calendar/validation'
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
  it('strips legacy meta attendees at the public input boundary', async () => {
    const event = await createEvent({
      meta: { location: 'Room', attendees: [{ email: 'legacy@example.com', name: 'Legacy' }] },
    })
    expect(event.meta).toEqual({ location: 'Room' })
    expect(await store().eventAttendees(event.id)).toEqual([])

    const patch = parseEventPatch({
      rev: event.rev,
      meta: { attendees: [{ email: 'patch@example.com' }], location: 'New room' },
    }, { defaultTimeZone: 'UTC' })
    expect(patch.meta).toEqual({ location: 'New room' })
    expect(patch.attendees).toBeUndefined()
  })

  it('creates and updates top-level attendees atomically without storing meta copies', async () => {
    const event = await createEvent({
      attendees: [
        { email: ' Kim@Example.com ', name: 'Kim', status: 'accepted' },
        { email: 'kim@example.com', name: 'duplicate', status: 'declined' },
      ],
      meta: { attendees: [{ email: 'ignored@example.com' }] },
    })
    expect(await store().eventAttendees(event.id)).toEqual([
      { email: 'kim@example.com', name: 'Kim', status: 'accepted' },
    ])
    expect(event.meta).toEqual({})

    const updated = await store().updateEvent(event.id, {
      rev: event.rev,
      attendees: [{ email: 'lee@example.com', name: 'Lee', status: 'tentative' }],
    })
    expect(updated.meta).toEqual({})
    expect(await store().eventAttendees(event.id)).toEqual([
      { email: 'lee@example.com', name: 'Lee', status: 'tentative' },
    ])
  })

  it('preserves guests on an upsert that does not edit them and clears an explicit empty list', async () => {
    const event = await createEvent({
      attendees: [{ email: 'kim@example.com', name: 'Kim', status: 'accepted' }],
    })
    const changed = parseEventInput({
      id: event.id,
      rev: event.rev,
      title: 'Changed without guest edit',
      start: event.start,
      end: event.end,
      calendarIds: [calendar.id],
    }, { defaultTimeZone: 'UTC' })
    await store().createEvents([changed], 'upsert')
    expect(await store().eventAttendees(event.id)).toEqual([
      { email: 'kim@example.com', name: 'Kim', status: 'accepted' },
    ])

    const cleared = parseEventInput({
      id: event.id,
      rev: event.rev + 1,
      title: 'Changed with guest edit',
      start: event.start,
      end: event.end,
      calendarIds: [calendar.id],
      attendees: [],
    }, { defaultTimeZone: 'UTC' })
    await store().createEvents([cleared], 'upsert')
    expect(await store().eventAttendees(event.id)).toEqual([])
  })

  it('clears legacy meta when the dedicated guest write empties the table', async () => {
    const event = await createEvent()
    sqlite.prepare('UPDATE calendar_events SET meta_json = ? WHERE user_id = ? AND id = ?')
      .run(JSON.stringify({ attendees: [{ email: 'old@example.com' }], location: 'Room' }), ALICE, event.id)
    const answer = await store().setEventAttendees(event.id, [], event.rev)
    expect(answer.event.meta).toEqual({ location: 'Room' })
    expect(await store().eventAttendees(event.id)).toEqual([])
  })

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
    // Provider identity is accepted only by the internal sync/import path, never the public batch API.
    const created = await store().createEvents([parseEventInput({
      title: 'Kickoff',
      start: { value: '2026-11-02T09:00:00', type: 'datetime' },
      end: { value: '2026-11-02T10:00:00', type: 'datetime' },
      calendarIds: [readOnly.id],
      source: 'caldav',
      externalId: 'ext-1',
    }, { defaultTimeZone: 'UTC' })], 'create')
    const event = created[0]!

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
  it('copies table guests to a recurrence exception and a following series', async () => {
    const event = await createEvent({
      recurrenceRule: 'FREQ=DAILY;COUNT=4',
      attendees: [{ email: 'guest@example.com', name: 'Guest', status: 'accepted' }],
    })
    await store().applyRecurrenceChange(event.id, {
      rev: event.rev,
      occurrenceStart: { value: '2026-11-03T09:00:00', type: 'datetime' },
      occurrenceEnd: { value: '2026-11-03T10:00:00', type: 'datetime' },
      scope: 'this',
      action: 'update',
      patch: { rev: event.rev, title: 'Exception' },
    })
    const exception = (await store().listAllEvents()).find(row => row.recurrenceParentId === event.id)
    expect(exception).toBeTruthy()
    expect(await store().eventAttendees(exception!.id)).toEqual([
      { email: 'guest@example.com', name: 'Guest', status: 'accepted' },
    ])

    const master = await store().getEvent(event.id)
    expect(await store().eventAttendees(event.id)).toEqual([
      { email: 'guest@example.com', name: 'Guest', status: 'accepted' },
    ])
    const split = await store().applyRecurrenceChange(event.id, {
      rev: master!.rev,
      occurrenceStart: { value: '2026-11-04T09:00:00', type: 'datetime' },
      occurrenceEnd: { value: '2026-11-04T10:00:00', type: 'datetime' },
      scope: 'following',
      action: 'update',
      patch: { rev: master!.rev, title: 'Following' },
    })
    expect(split.masterId).not.toBe(event.id)
    expect(await store().eventAttendees(split.masterId!)).toEqual([
      { email: 'guest@example.com', name: 'Guest', status: 'accepted' },
    ])
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
