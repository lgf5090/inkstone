// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CalendarDto, CalendarEventDto, CalendarGroupDto, CalendarMetaDto, CalendarPreferences } from '../src/shared/calendar/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
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

async function meta(): Promise<CalendarMetaDto> {
  return json<CalendarMetaDto>(await call('GET', '/meta'))
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
  user = ALICE
})

describe('the calendar routes', () => {
  it('requires a session', async () => {
    user = ''
    const response = await call('GET', '/meta')
    expect(response.status).toBe(401)
  })

  it('answers meta with the default calendar created on first read', async () => {
    const answer = await meta()
    expect(answer.calendars).toHaveLength(1)
    expect(answer.calendars[0]?.isDefault).toBe(true)
    expect(answer.groups).toEqual([])
    expect(answer.subscriptions).toEqual([])
    expect(answer.connections).toEqual([])
    expect(answer.preferences.defaultView).toBe('week')
  })
})

describe('calendar routes', () => {
  it('refuses local batch writes to a read-only calendar but accepts provider sync writes', async () => {
    const readOnly = await json<{ calendar: CalendarDto }>(await call('POST', '/calendars', {
      name: 'Read only',
      color: '#123456',
      readOnly: true,
    }))

    expect((await call('POST', '/events', eventBody(readOnly.calendar.id))).status).toBe(403)
    expect((await call('POST', '/events/batch', {
      mode: 'create',
      events: [eventBody(readOnly.calendar.id)],
    })).status).toBe(403)

    const synced = await call('POST', '/events/batch', {
      mode: 'create',
      events: [eventBody(readOnly.calendar.id, { source: 'caldav', externalId: 'remote-sync-1' })],
    })
    expect(synced.status).toBe(200)
    expect((await json<{ events: CalendarEventDto[] }>(synced)).events[0]?.calendarIds).toEqual([readOnly.calendar.id])

    const writable = await json<{ calendar: CalendarDto }>(await call('POST', '/calendars', {
      name: 'Writable',
      color: '#654321',
    }))
    const mixed = await call('POST', '/events', eventBody(writable.calendar.id, {
      calendarIds: [writable.calendar.id, readOnly.calendar.id],
    }))
    expect(mixed.status).toBe(403)
  })

  it('creates, patches, reorders and deletes calendars', async () => {
    const home = (await meta()).calendars[0]!
    const created = await json<{ calendar: CalendarDto }>(await call('POST', '/calendars', {
      name: 'Work',
      color: '#112233',
    }))
    expect(created.calendar.name).toBe('Work')

    const patched = await json<{ calendar: CalendarDto }>(await call('PATCH', `/calendars/${created.calendar.id}`, {
      rev: created.calendar.rev,
      name: 'Job',
    }))
    expect(patched.calendar.name).toBe('Job')
    expect(patched.calendar.rev).toBe(created.calendar.rev + 1)

    const stale = await call('PATCH', `/calendars/${created.calendar.id}`, {
      rev: created.calendar.rev,
      name: 'Stale',
    })
    expect(stale.status).toBe(409)

    const ordered = await call('PUT', '/calendars/order', { ids: [patched.calendar.id, home.id] })
    expect(ordered.status).toBe(204)
    expect((await meta()).calendars.map((entry) => entry.id)).toEqual([patched.calendar.id, home.id])

    const deleted = await call('DELETE', `/calendars/${patched.calendar.id}?mode=delete`)
    expect(deleted.status).toBe(204)
    expect((await meta()).calendars.map((entry) => entry.id)).toEqual([home.id])
  })

  it('refuses to delete the last calendar and a malformed id', async () => {
    const home = (await meta()).calendars[0]!
    expect((await call('DELETE', `/calendars/${home.id}?mode=delete`)).status).toBe(409)
    expect((await call('PATCH', '/calendars/bad!id', { rev: 1, name: 'X' })).status).toBe(400)
    expect((await call('PATCH', '/calendars/does-not-exist', { rev: 1, name: 'X' })).status).toBe(404)
  })
})

describe('group routes', () => {
  it('creates, renames, reorders and deletes groups', async () => {
    const work = (await json<{ group: CalendarGroupDto }>(await call('POST', '/groups', { name: 'Work' }))).group
    const home = (await json<{ group: CalendarGroupDto }>(await call('POST', '/groups', { name: 'Home' }))).group
    expect((await call('POST', '/groups', { name: 'work' })).status).toBe(409)

    const renamed = await json<{ group: CalendarGroupDto }>(await call('PATCH', `/groups/${home.id}`, { name: 'Personal' }))
    expect(renamed.group.name).toBe('Personal')

    expect((await call('PUT', '/groups/order', { ids: [home.id, work.id] })).status).toBe(204)
    expect((await meta()).groups.map((entry) => entry.id)).toEqual([home.id, work.id])

    const calendar = (await json<{ calendar: CalendarDto }>(await call('POST', '/calendars', {
      name: 'Work calendar',
      groupId: work.id,
    }))).calendar
    expect((await call('DELETE', `/groups/${work.id}`)).status).toBe(204)
    expect((await meta()).calendars.find((entry) => entry.id === calendar.id)?.groupId).toBeNull()
  })
})

describe('event routes', () => {
  it('creates, lists, patches and deletes an event', async () => {
    const home = (await meta()).calendars[0]!
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/events', eventBody(home.id)))
    expect(created.event.rev).toBe(1)

    const listed = await json<{ events: CalendarEventDto[] }>(await call(
      'GET',
      '/events?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z',
    ))
    expect(listed.events.map((event) => event.id)).toEqual([created.event.id])

    const patched = await json<{ event: CalendarEventDto }>(await call('PATCH', `/events/${created.event.id}`, {
      rev: created.event.rev,
      title: 'Renamed',
    }))
    expect(patched.event.title).toBe('Renamed')
    expect(patched.event.rev).toBe(2)

    expect((await call('PATCH', `/events/${created.event.id}`, { rev: 1, title: 'Stale' })).status).toBe(409)
    expect((await call('DELETE', `/events/${created.event.id}?rev=1`)).status).toBe(409)
    expect((await call('DELETE', `/events/${created.event.id}?rev=${patched.event.rev}`)).status).toBe(204)
    expect((await call('DELETE', `/events/${created.event.id}?rev=${patched.event.rev}`)).status).toBe(404)
  })

  it('batch-creates and searches events', async () => {
    const home = (await meta()).calendars[0]!
    const batch = await json<{ events: CalendarEventDto[] }>(await call('POST', '/events/batch', {
      mode: 'create',
      events: [
        eventBody(home.id, { title: 'Alpha planning' }),
        eventBody(home.id, { title: 'Beta review', start: { value: '2026-10-27T09:00:00', type: 'datetime' }, end: { value: '2026-10-27T10:00:00', type: 'datetime' } }),
      ],
    }))
    expect(batch.events).toHaveLength(2)

    const found = await json<{ results: Array<{ event: CalendarEventDto; calendarName: string }>; truncated: boolean }>(
      await call('GET', '/events/search?q=planning'),
    )
    expect(found.results.map((entry) => entry.event.title)).toEqual(['Alpha planning'])
    expect(found.results[0]?.calendarName).toBe('Calendar')
    expect(found.truncated).toBe(false)
  })

  it('rejects a malformed event id and a bad range', async () => {
    const home = (await meta()).calendars[0]!
    expect((await call('GET', '/events?from=nope&to=also-nope')).status).toBe(400)
    expect((await call('POST', '/events', eventBody(home.id, { id: 'master::repeat-1' }))).status).toBe(400)
    expect((await call('PATCH', '/events/bad!id', { rev: 1, title: 'X' })).status).toBe(400)
    expect((await call('DELETE', `/events/${home.id}`)).status).toBe(400)
  })

  it('expands a recurring series for the requested range without duplicating its anchor', async () => {
    const home = (await meta()).calendars[0]!
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/events', eventBody(home.id, {
      title: 'Weekly sync',
      start: { value: '2026-10-28T12:00:00', type: 'datetime' },
      end: { value: '2026-10-28T13:00:00', type: 'datetime' },
      recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU,WE',
    })))
    const page = await json<{
      events: CalendarEventDto[]
      occurrences: CalendarEventDto[]
      recurrenceTruncated: boolean
    }>(await call('GET', '/events?from=2026-10-01T00:00:00Z&to=2026-11-30T00:00:00Z'))

    expect(page.events.map(event => event.id)).toContain(created.event.id)
    expect(page.recurrenceTruncated).toBe(false)
    expect(page.occurrences).toHaveLength(8)
    expect(page.occurrences.every(event => event.id.startsWith(`${created.event.id}::repeat-`))).toBe(true)
    expect(page.occurrences.every(event => event.recurrenceRule === null)).toBe(true)
    expect(page.occurrences.map(event => event.start.value)).toContain('2026-11-03T12:00:00')
    expect(page.occurrences.map(event => event.id)).not.toContain(created.event.id)
  })

  it('hides another account’s events behind 404', async () => {
    const home = (await meta()).calendars[0]!
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/events', eventBody(home.id)))

    user = BOB
    const listed = await json<{ events: CalendarEventDto[] }>(await call(
      'GET',
      '/events?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z',
    ))
    expect(listed.events).toEqual([])
    expect((await call('PATCH', `/events/${created.event.id}`, { rev: 1, title: 'Stolen' })).status).toBe(404)
    expect((await call('DELETE', `/events/${created.event.id}?rev=1`)).status).toBe(404)
  })
})

describe('preference routes', () => {
  it('saves the supplied shape and answers it back', async () => {
    const saved = await json<{ preferences: CalendarPreferences }>(await call('PUT', '/preferences', {
      weekStart: 0,
      timeZone: 'UTC',
      defaultView: 'month',
    }))
    expect(saved.preferences.weekStart).toBe(0)
    expect(saved.preferences.defaultView).toBe('month')

    const read = await json<{ preferences: CalendarPreferences }>(await call('GET', '/preferences'))
    expect(read.preferences).toEqual(saved.preferences)
    expect((await call('PUT', '/preferences', { notASetting: true })).status).toBe(400)
  })

  it('refuses a body over the small limit', async () => {
    const response = await call('PUT', '/preferences', { weekStart: 0, padding: 'x'.repeat(20_000) })
    expect(response.status).toBe(413)
  })
})
