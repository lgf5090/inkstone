// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import {
  refreshDueIcsSubscriptions,
  refreshIcsSubscription,
  setIcsSubscriptionEnabled,
} from '../src/worker/calendar/subscriptions'
import { CalendarStore } from '../src/worker/calendar/store'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-alice'
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Inkstone test//EN',
  'BEGIN:VEVENT',
  'UID:schedule-1@example.com',
  'DTSTAMP:20261026T000000Z',
  'DTSTART:20261027T090000Z',
  'DTEND:20261027T100000Z',
  'SUMMARY:Scheduled feed',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

let sqlite: DatabaseSync
let db: D1Database
let env: Env

async function insertSubscription(id: string, enabled: number, lastSyncAt: number | null): Promise<string> {
  const calendar = await new CalendarStore(db, USER).createCalendar({ name: id })
  sqlite.prepare(
    `INSERT INTO calendar_subscriptions (
       user_id, id, calendar_id, kind, url, enabled, sync_state_json, last_sync_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'ics', 'https://example.com/feed.ics', ?, '{}', ?, 1, 1)`,
  ).run(USER, id, calendar.id, enabled, lastSyncAt)
  return calendar.id
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  env = { DB: db } as unknown as Env
  const store = new CalendarStore(db, USER)
  await store.ensureDefaultCalendar()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(ICS, {
    status: 200,
    headers: { 'content-type': 'text/calendar' },
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('scheduled calendar subscriptions', () => {
  it('refreshes only enabled, due feeds and skips a future sync', async () => {
    await insertSubscription('due', 1, null)
    await insertSubscription('paused', 0, null)
    await insertSubscription('fresh', 1, Date.now())

    expect(await refreshDueIcsSubscriptions(env, Date.now())).toBe(1)
    const events = sqlite.prepare(
      `SELECT title FROM calendar_events WHERE user_id = ? AND calendar_source = 'ics'`,
    ).all(USER) as Array<{ title: string }>
    expect(events).toEqual([{ title: 'Scheduled feed' }])
    const paused = sqlite.prepare(
      `SELECT last_sync_at FROM calendar_subscriptions WHERE user_id = ? AND id = 'paused'`,
    ).get(USER) as { last_sync_at: number | null }
    expect(paused.last_sync_at).toBeNull()
  })

  it('refuses a manual refresh while the subscription is paused', async () => {
    await insertSubscription('paused', 0, null)
    await expect(refreshIcsSubscription(env, USER, 'paused')).rejects.toMatchObject({ status: 409 })
    await setIcsSubscriptionEnabled(env, USER, 'paused', true)
    await expect(refreshIcsSubscription(env, USER, 'paused')).resolves.toMatchObject({ imported: 1 })
  })
})
