// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CalendarDto, CalendarEventDto, CalendarMetaDto } from '../src/shared/calendar/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { calendarRoutes } from '../src/worker/routes/calendar'
import { calendarMemberRoutes } from '../src/worker/routes/calendar-members'
import { calendarResourceRoutes } from '../src/worker/routes/calendar-resources'
import { calendarBookingRoutes, calendarSchedulingRoutes } from '../src/worker/routes/calendar-scheduling'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const CAROL = 'user-carol'

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
app.route('/api/calendar', calendarMemberRoutes)
app.route('/api/calendar', calendarResourceRoutes)
app.route('/api/calendar', calendarSchedulingRoutes)
app.route('/api/calendar', calendarRoutes)
app.route('/api/public/calendar', calendarBookingRoutes)

function env(): AppBindings['Bindings'] {
  return { DB: db } as unknown as AppBindings['Bindings']
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env(), ctx)
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as T
}

function insertUser(id: string, username: string): void {
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'hash', ?, ?, '', 'member', '{}', 1, 1)`,
  ).run(id, username, username, username)
}

async function defaultCalendar(): Promise<CalendarDto> {
  return (await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))).calendars[0]!
}

function eventBody(calendarId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Review',
    start: { value: '2026-10-26T09:00:00', type: 'datetime' },
    end: { value: '2026-10-26T10:00:00', type: 'datetime' },
    calendarId,
    ...overrides,
  }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  sqlite.exec('DELETE FROM users')
  insertUser(ALICE, 'alice')
  insertUser(BOB, 'bob')
  insertUser(CAROL, 'carol')
  user = ALICE
})

async function invite(calendarId: string, username: string, role: 'reader' | 'writer'): Promise<void> {
  await json(await call('POST', `/api/calendar/calendars/${calendarId}/members`, { username, role }))
}

async function accept(ownerId: string, calendarId: string): Promise<void> {
  const response = await call('POST', `/api/calendar/invites/${ownerId}/${calendarId}/response`, { status: 'accepted' })
  expect(response.status).toBe(204)
}

describe('account sharing', () => {
  it('invites, accepts, and lets a writer create and edit an event in the shared calendar', async () => {
    const calendar = await defaultCalendar()
    await invite(calendar.id, 'bob', 'writer')
    await invite(calendar.id, 'carol', 'reader')

    user = BOB
    const bobMeta = await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))
    expect(bobMeta.invites?.map(entry => entry.calendarId)).toContain(calendar.id)
    await accept(ALICE, calendar.id)

    const after = await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))
    const shared = after.calendars.find(entry => entry.id.startsWith('shared:'))!
    expect(shared.readOnly).toBe(false)
    expect(shared.sharedRole).toBe('writer')

    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', {
      ...eventBody(shared.id),
      title: 'Written by Bob',
    }))
    expect(created.event.id.startsWith('shared:')).toBe(true)
    expect(created.event.calendarId).toBe(shared.id)

    const updated = await json<{ event: CalendarEventDto }>(await call('PATCH', `/api/calendar/events/${encodeURIComponent(created.event.id)}`, {
      rev: created.event.rev,
      title: 'Bob edited',
    }))
    expect(updated.event.title).toBe('Bob edited')

    user = ALICE
    const ownerEvent = await json<{ event: CalendarEventDto }>(await call('GET', `/api/calendar/events/${created.event.id.split(':').at(-1)}`))
    expect(ownerEvent.event.title).toBe('Bob edited')
  })

  it('refuses a writer moving a shared event into an owner-only calendar', async () => {
    const calendar = await defaultCalendar()
    const privateCal = await json<{ calendar: CalendarDto }>(await call('POST', '/api/calendar/calendars', { name: 'Private' }))
    await invite(calendar.id, 'bob', 'writer')
    user = BOB
    await accept(ALICE, calendar.id)
    const shared = (await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta')))
      .calendars.find(entry => entry.id.startsWith('shared:'))!
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(shared.id)))
    const moved = await call('PATCH', `/api/calendar/events/${encodeURIComponent(created.event.id)}`, {
      rev: created.event.rev,
      calendarIds: [privateCal.calendar.id],
    })
    expect(moved.status).toBe(403)
  })

  it('refuses a reader write and an unrelated account', async () => {
    const calendar = await defaultCalendar()
    await invite(calendar.id, 'carol', 'reader')
    user = CAROL
    await accept(ALICE, calendar.id)
    const meta = await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))
    const shared = meta.calendars.find(entry => entry.id.startsWith('shared:'))!
    expect(shared.readOnly).toBe(true)
    expect((await call('POST', '/api/calendar/events', eventBody(shared.id))).status).toBe(403)

    user = BOB
    expect((await call('POST', '/api/calendar/events', eventBody(shared.id))).status).toBe(403)
  })

  it('lets the guest leave and keeps declined rows out of the sidebar', async () => {
    const calendar = await defaultCalendar()
    await invite(calendar.id, 'bob', 'reader')
    user = BOB
    await accept(ALICE, calendar.id)
    expect((await call('DELETE', `/api/calendar/invites/${ALICE}/${calendar.id}`)).status).toBe(204)
    const meta = await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))
    expect(meta.calendars.some(entry => entry.id.startsWith('shared:'))).toBe(false)
  })
})

async function range(from: string, to: string): Promise<{ events: CalendarEventDto[]; occurrences: CalendarEventDto[] }> {
  return json(await call('GET', `/api/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&occurrences=1`))
}

describe('recurrence exceptions', () => {
  it('turns one occurrence into an override and hides the master copy with EXDATE', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Standup',
      recurrenceRule: 'FREQ=DAILY;COUNT=4',
    })))
    const week = await range('2026-10-26T00:00:00Z', '2026-10-31T00:00:00Z')
    expect(week.occurrences).toHaveLength(3)
    const target = week.occurrences[0]!

    const answer = await call('POST', `/api/calendar/events/${created.event.id}/recurrence`, {
      occurrenceStart: target.start,
      occurrenceEnd: target.end,
      scope: 'this',
      action: 'update',
      patch: { title: 'Standup with Bob' },
    })
    expect(answer.status).toBe(200)

    const after = await range('2026-10-26T00:00:00Z', '2026-10-31T00:00:00Z')
    expect(after.occurrences).toHaveLength(2)
    const override = after.events.find(event => event.recurrenceParentId === created.event.id)
    expect(override?.title).toBe('Standup with Bob')

    const master = await json<{ event: CalendarEventDto }>(await call('GET', `/api/calendar/events/${created.event.id}`))
    expect(Array.isArray(master.event.meta.exdates)).toBe(true)
  })

  it('splits a series for this-and-following and truncates the old rule', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Weekly',
      recurrenceRule: 'FREQ=WEEKLY;COUNT=5',
    })))
    const month = await range('2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z')
    const target = month.occurrences[1]!
    const split = await call('POST', `/api/calendar/events/${created.event.id}/recurrence`, {
      occurrenceStart: target.start,
      occurrenceEnd: target.end,
      scope: 'following',
      action: 'update',
      patch: { title: 'New series' },
    })
    expect(split.status).toBe(200)
    const after = await range('2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z')
    const masters = after.events.filter(event => event.recurrenceRule)
    expect(masters).toHaveLength(2)
    expect(masters.some(event => event.title === 'New series')).toBe(true)
    expect(masters.find(event => event.id === created.event.id)?.recurrenceRule).toContain('UNTIL=')
  })

  it('shifts a zoned master when the reader edits the whole series', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Zoned series',
      start: { value: '2026-11-10T09:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
      end: { value: '2026-11-10T10:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
      recurrenceRule: 'FREQ=DAILY;COUNT=3',
    })))
    const response = await call('POST', `/api/calendar/events/${created.event.id}/recurrence`, {
      occurrenceStart: created.event.start,
      occurrenceEnd: created.event.end,
      scope: 'all',
      action: 'update',
      patch: {
        title: 'Zoned series moved',
        start: { value: '2026-11-10T10:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
        end: { value: '2026-11-10T11:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
      },
    })
    expect(response.status).toBe(200)
    const master = await json<{ event: CalendarEventDto }>(await call('GET', `/api/calendar/events/${created.event.id}`))
    expect(master.event.title).toBe('Zoned series moved')
    expect(master.event.start.value).toContain('10:00:00')
  })

  it('cancels this and following without leaving orphan overrides', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Daily',
      recurrenceRule: 'FREQ=DAILY;COUNT=10',
    })))
    const week = await range('2026-10-26T00:00:00Z', '2026-10-30T00:00:00Z')
    const target = week.occurrences[1]!
    expect((await call('POST', `/api/calendar/events/${created.event.id}/recurrence`, {
      occurrenceStart: target.start,
      occurrenceEnd: target.end,
      scope: 'following',
      action: 'cancel',
    })).status).toBe(200)
    const after = await range('2026-10-28T00:00:00Z', '2026-11-10T00:00:00Z')
    expect(after.occurrences).toHaveLength(0)
  })
})

describe('resources, booking links and snoozes', () => {
  it('creates a resource calendar and exposes it in meta', async () => {
    const response = await call('POST', '/api/calendar/resources', { name: 'Room 3', capacity: 8 })
    expect(response.status).toBe(200)
    const created = await json<{ resource: { calendarId: string; name: string; capacity: number } }>(response)
    const meta = await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))
    expect(meta.resources?.some(resource => resource.id && resource.name === 'Room 3')).toBe(true)
    expect(meta.calendars.some(calendar => calendar.id === created.resource.calendarId)).toBe(true)
  })

  it('publishes a booking link, returns busy blocks and books a slot into the owner calendar', async () => {
    const calendar = await defaultCalendar()
    const link = await json<{ link: { id: string; slug: string } }>(await call('POST', '/api/calendar/scheduling-links', {
      calendarId: calendar.id,
      title: 'Intro call',
      durationMinutes: 30,
      days: [0, 1, 2, 3, 4, 5, 6],
      startHour: 0,
      endHour: 24,
    }))
    const publicRead = await json<{ busy: unknown[] }>(await call('GET', `/api/public/calendar/scheduling/${link.link.slug}`))
    expect(Array.isArray(publicRead.busy)).toBe(true)

    const startMs = Math.ceil((Date.now() + 3 * 86_400_000) / 1_800_000) * 1_800_000
    const booked = await call('POST', `/api/public/calendar/scheduling/${link.link.slug}/book`, {
      startMs,
      name: 'Dana',
      email: 'dana@example.com',
    })
    expect(booked.status).toBe(200)

    user = ALICE
    const from = new Date(startMs - 3_600_000).toISOString()
    const to = new Date(startMs + 3_600_000).toISOString()
    const events = await range(from, to)
    expect(events.events.some(event => event.title.includes('Dana'))).toBe(true)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_event_attendees').get()).toEqual({ count: 1 })
  })

  it('parks a snooze and filters search by attendee, recurrence and task status', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Guest sync',
      recurrenceRule: 'FREQ=WEEKLY',
    })))
    await json(await call('PUT', `/api/calendar/events/${created.event.id}/attendees`, {
      rev: created.event.rev,
      attendees: [{ email: 'guest@example.com', name: 'Guest', status: 'accepted' }],
    }))
    const snooze = await call('POST', `/api/calendar/events/${created.event.id}/snooze`, { minutes: 10 })
    expect(snooze.status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_reminder_snoozes').get()).toEqual({ count: 1 })

    const byGuest = await json<{ results: unknown[] }>(await call('GET', '/api/calendar/events/search?q=&attendee=guest%40example.com'))
    expect(byGuest.results).toHaveLength(1)
    const oneOff = await json<{ results: unknown[] }>(await call('GET', '/api/calendar/events/search?q=&recurring=0'))
    expect(oneOff.results).toHaveLength(0)
    const recurring = await json<{ results: unknown[] }>(await call('GET', '/api/calendar/events/search?q=&recurring=1'))
    expect(recurring.results).toHaveLength(1)
  })
})
