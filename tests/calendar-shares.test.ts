// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CalendarDto, CalendarShareDto } from '../src/shared/calendar/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { calendarRoutes } from '../src/worker/routes/calendar'
import { calendarShareRoutes } from '../src/worker/routes/calendar-shares'
import { calendarPublicRoutes } from '../src/worker/routes/calendar-public'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'

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
app.route('/api/calendar', calendarRoutes)
app.route('/api/calendar', calendarShareRoutes)
app.route('/feeds', calendarPublicRoutes)

function env(): AppBindings['Bindings'] {
  return { DB: db } as unknown as AppBindings['Bindings']
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.fetch(new Request(`http://localhost/api/calendar${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env(), ctx)
}

async function read(slug: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost/feeds/calendar/${slug}`), env(), ctx)
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as T
}

async function newCalendar(name: string): Promise<CalendarDto> {
  const answer = await json<{ calendar: CalendarDto }>(await call('POST', '/calendars', { name, color: '#112233' }))
  return answer.calendar
}

async function addEvent(calendarId: string, title: string): Promise<void> {
  const created = await call('POST', '/events', {
    title,
    start: { value: '2026-11-03T09:00:00', type: 'datetime' },
    end: { value: '2026-11-03T10:00:00', type: 'datetime' },
    calendarId,
  })
  await json(created)
}

async function shareOf(calendarId: string): Promise<CalendarShareDto | null> {
  return (await json<{ share: CalendarShareDto | null }>(await call('GET', `/calendars/${calendarId}/share`))).share
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  user = ALICE
})

describe('the owner side of a public calendar link', () => {
  it('answers null until the calendar is published', async () => {
    const calendar = await newCalendar('Trips')
    expect(await shareOf(calendar.id)).toBeNull()
  })

  it('mints one address and keeps handing back the same one', async () => {
    const calendar = await newCalendar('Trips')
    const first = await json<{ share: CalendarShareDto }>(await call('POST', `/calendars/${calendar.id}/share`))
    const second = await json<{ share: CalendarShareDto }>(await call('POST', `/calendars/${calendar.id}/share`))
    expect(second.share.slug).toBe(first.share.slug)
    expect(first.share.slug).toMatch(/^[0-9a-hjkmnp-tv-z]{20}$/)
    expect((await shareOf(calendar.id))?.views).toBe(0)
  })

  it('answers two simultaneous publish presses with one address', async () => {
    const calendar = await newCalendar('Trips')
    const responses = await Promise.all([
      call('POST', `/calendars/${calendar.id}/share`),
      call('POST', `/calendars/${calendar.id}/share`),
    ])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    const answers = await Promise.all(responses.map(response => response.json() as Promise<{ share: CalendarShareDto }>))
    expect(answers[0]!.share.slug).toBe(answers[1]!.share.slug)
  })

  it('will not publish a calendar the caller does not own', async () => {
    const calendar = await newCalendar('Trips')
    user = BOB
    expect((await call('POST', `/calendars/${calendar.id}/share`)).status).toBe(404)
    expect((await call('GET', `/calendars/${calendar.id}/share`)).status).toBe(200)
    expect(await shareOf(calendar.id)).toBeNull()
    expect((await call('DELETE', `/calendars/${calendar.id}/share`)).status).toBe(404)
  })

  it('requires a session', async () => {
    const calendar = await newCalendar('Trips')
    user = ''
    expect((await call('POST', `/calendars/${calendar.id}/share`)).status).toBe(401)
    expect((await call('GET', `/calendars/${calendar.id}/share`)).status).toBe(401)
  })

  it('refuses to revoke a calendar that was never published', async () => {
    const calendar = await newCalendar('Trips')
    expect((await call('DELETE', `/calendars/${calendar.id}/share`)).status).toBe(404)
  })
})

describe('the reader side of a public calendar link', () => {
  it('serves the published document to someone who never logs in', async () => {
    const trips = await newCalendar('Trips')
    const work = await newCalendar('Work')
    await addEvent(trips.id, 'Ferry to the island')
    await addEvent(work.id, 'Quarterly review')
    const share = (await json<{ share: CalendarShareDto }>(await call('POST', `/calendars/${trips.id}/share`))).share

    user = ''
    const response = await read(`${share.slug}.ics`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    expect(body).toContain('BEGIN:VCALENDAR')
    expect(body).toContain('SUMMARY:Ferry to the island')
    expect(body).not.toContain('Quarterly review')
    expect(body).not.toContain(ALICE)
  })

  it('addresses the same calendar with or without the .ics suffix', async () => {
    const trips = await newCalendar('Trips')
    await addEvent(trips.id, 'Ferry to the island')
    const share = (await json<{ share: CalendarShareDto }>(await call('POST', `/calendars/${trips.id}/share`))).share
    user = ''
    expect((await read(share.slug)).status).toBe(200)
    expect((await read(`${share.slug.toUpperCase()}.ICS`)).status).toBe(200)
  })

  it('counts each read for the owner', async () => {
    const trips = await newCalendar('Trips')
    const share = (await json<{ share: CalendarShareDto }>(await call('POST', `/calendars/${trips.id}/share`))).share
    user = ''
    await read(share.slug)
    await read(share.slug)
    user = ALICE
    const answer = await shareOf(trips.id)
    expect(answer?.views).toBe(2)
    expect(answer?.lastViewedAt).not.toBeNull()
  })

  it('refuses a slug that is not shaped like one before looking it up', async () => {
    const trips = await newCalendar('Trips')
    const share = (await json<{ share: CalendarShareDto }>(await call('POST', `/calendars/${trips.id}/share`))).share
    user = ''
    // Counted, not inferred from the status: a wrong-shaped guess answers 404 either way, and the
    // claim under test is that the endpoint cannot be used to make the database work.
    const prepared: string[] = []
    const original = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      prepared.push(sql)
      return original(sql)
    }) as typeof db.prepare
    try {
      for (const guess of ['', 'short', 'iiooul'.padEnd(20, 'a'), `${share.slug.slice(0, 19)}i`, '--------------------abcd']) {
        const response = await read(guess)
        expect(response.status).toBe(404)
        expect(await response.text()).not.toContain('SUMMARY')
      }
    } finally {
      db.prepare = original
    }
    expect(prepared).toEqual([])
  })

  it('stops answering once the owner revokes the link', async () => {
    const trips = await newCalendar('Trips')
    await addEvent(trips.id, 'Ferry to the island')
    const share = (await json<{ share: CalendarShareDto }>(await call('POST', `/calendars/${trips.id}/share`))).share
    expect((await call('DELETE', `/calendars/${trips.id}/share`)).status).toBe(204)
    expect(await shareOf(trips.id)).toBeNull()
    user = ''
    expect((await read(share.slug)).status).toBe(404)
    user = ALICE
  })

  it('gives a revoked calendar a new address, leaving the old one dead', async () => {
    const trips = await newCalendar('Trips')
    await addEvent(trips.id, 'Ferry to the island')
    const old = (await json<{ share: CalendarShareDto }>(await call('POST', `/calendars/${trips.id}/share`))).share
    await call('DELETE', `/calendars/${trips.id}/share`)
    const fresh = (await json<{ share: CalendarShareDto }>(await call('POST', `/calendars/${trips.id}/share`))).share
    expect(fresh.slug).not.toBe(old.slug)
    user = ''
    expect((await read(old.slug)).status).toBe(404)
    expect((await read(fresh.slug)).status).toBe(200)
    user = ALICE
  })

  it('kills the link in the same statement that deletes the calendar', async () => {
    const trips = await newCalendar('Trips')
    await newCalendar('Home')
    const share = (await json<{ share: CalendarShareDto }>(await call('POST', `/calendars/${trips.id}/share`))).share
    // Publishing must not move the calendar's own revision, or the owner's cached copy would conflict on save.
    const live = (await json<{ calendars: CalendarDto[] }>(await call('GET', '/meta'))).calendars.find(item => item.id === trips.id)!
    expect(live.rev).toBe(trips.rev)
    const removed = await call('DELETE', `/calendars/${trips.id}?mode=delete&rev=${live.rev}`)
    expect(removed.status).toBe(204)
    user = ''
    expect((await read(share.slug)).status).toBe(404)
    user = ALICE
    expect(await shareOf(trips.id)).toBeNull()
  })
})
