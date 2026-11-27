// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { expect, it, vi } from 'vitest'
import { createCalendarConnection } from '../src/worker/calendar/connections'
import { listProviderCalendarMappings } from '../src/worker/calendar/provider-mappings'
import { CALENDAR_SCHEMA_STATEMENTS } from '../src/worker/calendar/schema'
import { CalendarStore } from '../src/worker/calendar/store'
import { newId } from '../src/worker/lib/id'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'f'.repeat(26))
    await next()
  },
}))

vi.mock('../src/worker/calendar/provider-sync', () => {
  throw new Error('Mapping routes must not import provider-sync')
})
vi.mock('@dayflow/caldav', () => { throw new Error('Mapping routes must not import CalDAV transport') })
vi.mock('@dayflow/google-sync', () => { throw new Error('Mapping routes must not import Google transport') })
vi.mock('@dayflow/outlook-sync', () => { throw new Error('Mapping routes must not import Outlook transport') })

it('loads the mapping route without provider transports and performs mapping CRUD', async () => {
  const [{ calendarSyncRoutes }, { parseProviderCalendarMappings }] = await Promise.all([
    import('../src/worker/routes/calendar-sync'),
    import('../src/worker/calendar/provider-mappings'),
  ])
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of CALENDAR_SCHEMA_STATEMENTS) sqlite.exec(statement)
  const db = makeD1(sqlite)
  const userId = 'f'.repeat(26)
  const connectionId = newId()
  await createCalendarConnection(db, userId, {
    id: connectionId,
    kind: 'caldav',
    label: 'Home',
    baseUrl: 'https://dav.example.com/',
    calendarHomeUrl: 'https://dav.example.com/calendars/alice/',
    username: 'alice',
    scope: 'read',
    writable: false,
    credential: { kind: 'basic', ciphertext: 'sealed-test-credential' },
  })
  await new CalendarStore(db, userId).createCalendar({ id: 'remote-cal', name: 'Remote', source: 'caldav' })
  const mappings = parseProviderCalendarMappings([{ remoteId: 'remote-cal', localId: 'remote-cal' }])

  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.route('/api/calendar', calendarSyncRoutes)
  const response = await app.request(`/api/calendar/connections/${connectionId}/calendars`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ calendars: mappings }),
  }, testBindings(db))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ mapped: 1 })
  expect(await listProviderCalendarMappings(db, userId, connectionId)).toEqual([
    expect.objectContaining({ remote_calendar_id: 'remote-cal', local_calendar_id: 'remote-cal' }),
  ])
})
