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

  it('keeps valid feed events when another event fails validation', async () => {
    await insertSubscription('mixed', 1, null)
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Audit//EN',
      'BEGIN:VEVENT', 'UID:good', 'DTSTART:20261126T010000Z', 'DTEND:20261126T020000Z', 'SUMMARY:Good', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:bad', 'DTSTART:20261126T010000Z', 'DTEND:20261126T020000Z', `SUMMARY:${'x'.repeat(301)}`, 'END:VEVENT',
      'END:VCALENDAR', '',
    ].join('\r\n'))))
    const result = await refreshIcsSubscription(env, USER, 'mixed')
    expect(result.imported).toBe(1)
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid_event', uid: 'bad' })]))
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM calendar_events WHERE calendar_source = 'ics'").get()).toEqual({ count: 1 })
  })

  it('keeps UID-less feed events stable across refreshes', async () => {
    const calendarId = await insertSubscription('uidless', 1, null)
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Audit//EN', 'BEGIN:VEVENT',
      'DTSTART:20261126T010000Z', 'DTEND:20261126T020000Z', 'SUMMARY:No UID',
      'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n'))))
    await refreshIcsSubscription(env, USER, 'uidless')
    await refreshIcsSubscription(env, USER, 'uidless')
    const rows = sqlite.prepare(`SELECT e.id, e.external_id FROM calendar_events e
      JOIN calendar_event_calendars m ON m.user_id = e.user_id AND m.event_id = e.id
      WHERE e.calendar_source = 'ics' AND m.calendar_id = ?`).all(calendarId) as Array<{ id: string; external_id: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.external_id).toBeTruthy()
  })
})
