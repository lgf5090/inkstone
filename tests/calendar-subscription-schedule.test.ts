// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import {
  deleteIcsSubscription,
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
  vi.useRealTimers()
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

  it('refreshes more than three due feeds and indexes the scheduler query', async () => {
    for (let index = 0; index < 5; index += 1) await insertSubscription(`capacity-${index}`, 1, null)
    expect(await refreshDueIcsSubscriptions(env, Date.now())).toBe(5)
    const indexes = sqlite.prepare("PRAGMA index_list('calendar_subscriptions')").all() as Array<{ name: string }>
    expect(indexes.map(index => index.name)).toContain('idx_calendar_subscriptions_due')
  })

  it('backs off failed feeds exponentially and pauses them after repeated failures', async () => {
    vi.useFakeTimers()
    const startedAt = Date.parse('2026-11-27T00:00:00Z')
    vi.setSystemTime(startedAt)
    await insertSubscription('backoff', 1, null)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })))
    let expectedRetryAt = startedAt
    for (let failure = 1; failure <= 8; failure += 1) {
      vi.setSystemTime(expectedRetryAt)
      await expect(refreshIcsSubscription(env, USER, 'backoff')).rejects.toMatchObject({ status: 502 })
      const row = sqlite.prepare(
        'SELECT enabled, last_error_at, sync_state_json FROM calendar_subscriptions WHERE user_id = ? AND id = ?',
      ).get(USER, 'backoff') as { enabled: number; last_error_at: number; sync_state_json: string }
      const delay = Math.min(5 * 60 * 1000 * (2 ** (failure - 1)), 24 * 60 * 60 * 1000)
      expectedRetryAt += delay
      expect(row.last_error_at).toBe(expectedRetryAt)
      expect(JSON.parse(row.sync_state_json).failures).toBe(failure)
      expect(row.enabled).toBe(failure === 8 ? 0 : 1)
      if (failure === 1) expect(await refreshDueIcsSubscriptions(env, expectedRetryAt - 1)).toBe(0)
    }
  })

  it('refuses a manual refresh while the subscription is paused', async () => {
    await insertSubscription('paused', 0, null)
    await expect(refreshIcsSubscription(env, USER, 'paused')).rejects.toMatchObject({ status: 409 })
    await setIcsSubscriptionEnabled(env, USER, 'paused', true)
    await expect(refreshIcsSubscription(env, USER, 'paused')).resolves.toMatchObject({ imported: 1 })
  })

  it('times out a response body that never finishes', async () => {
    await insertSubscription('slow-body', 1, null)
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('example.com/feed')) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 })
      }
      return Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
    }))
    const pending = refreshIcsSubscription(env, USER, 'slow-body')
    const assertion = expect(pending).rejects.toMatchObject({ status: 502 })
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
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

  it('cleans every calendar-level dependent when an ICS subscription is deleted', async () => {
    const calendarId = await insertSubscription('delete-me', 1, null)
    const store = new CalendarStore(db, USER)
    const event = await store.createEvent({
      title: 'Deleted feed event',
      start: { value: '2026-10-27T09:00:00', type: 'datetime' },
      end: { value: '2026-10-27T10:00:00', type: 'datetime' },
      calendarId,
      source: 'ics',
      externalId: 'delete-me-event',
    })
    await store.setEventReminders(event.id, [10], event.rev)
    sqlite.prepare('INSERT INTO calendar_event_attendees (user_id, event_id, email, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(USER, event.id, 'guest@example.com', 'Guest', 'needs-action', 1)
    sqlite.prepare(`INSERT INTO attachments
      (id, user_id, scope, filename, mime, size, sha256, object_key, storage, created_at)
      VALUES (?, ?, 'calendar', 'feed.txt', 'text/plain', 4, 'hash', ?, 'r2', ?)`)
      .run('feed-attachment', USER, 'calendar/user/feed-attachment.txt', 1)
    sqlite.prepare('INSERT INTO calendar_event_attachments (user_id, attachment_id, event_id, created_at) VALUES (?, ?, ?, ?)')
      .run(USER, 'feed-attachment', event.id, 1)
    sqlite.prepare('INSERT INTO calendar_shares (user_id, calendar_id, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(USER, calendarId, 'deleted-feed-share', 1, 1)
    sqlite.prepare(`INSERT INTO calendar_members
      (owner_user_id, calendar_id, member_user_id, role, status, created_at, updated_at)
      VALUES (?, ?, ?, 'reader', 'accepted', 1, 1)`)
      .run(USER, calendarId, 'guest-user')

    await deleteIcsSubscription(env, USER, 'delete-me')

    for (const table of ['calendar_events', 'calendar_event_reminders', 'calendar_event_attendees', 'calendar_event_attachments', 'attachments', 'calendar_shares', 'calendar_subscriptions']) {
      const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(USER) as { count: number }
      expect(row.count, table).toBe(0)
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_members WHERE owner_user_id = ?').get(USER)).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_calendars WHERE user_id = ?').get(USER)).toEqual({ count: 1 })
    expect(sqlite.prepare('SELECT object_key FROM attachment_cleanup WHERE user_id = ?').get(USER))
      .toEqual({ object_key: 'r2:calendar/user/feed-attachment.txt' })
  })

  it('removes stale ICS event dependents while preserving events in another calendar', async () => {
    const calendarId = await insertSubscription('stale-cleanup', 1, null)
    const store = new CalendarStore(db, USER)
    const [home] = await store.ensureDefaultCalendar()
    const stale = await store.createEvent({
      title: 'Stale only',
      start: { value: '2026-10-27T09:00:00', type: 'datetime' },
      end: { value: '2026-10-27T10:00:00', type: 'datetime' },
      calendarId,
      source: 'ics',
      externalId: 'stale-only',
    })
    const shared = await store.createEvent({
      title: 'Stale but shared',
      start: { value: '2026-10-28T09:00:00', type: 'datetime' },
      end: { value: '2026-10-28T10:00:00', type: 'datetime' },
      calendarIds: [calendarId, home.id],
      source: 'ics',
      externalId: 'stale-shared',
    })
    await store.setEventReminders(stale.id, [5], stale.rev)
    sqlite.prepare('INSERT INTO calendar_event_attendees (user_id, event_id, email, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(USER, stale.id, 'stale@example.com', 'Stale', 'needs-action', 1)
    sqlite.prepare(`INSERT INTO attachments
      (id, user_id, scope, filename, mime, size, sha256, object_key, storage, created_at)
      VALUES (?, ?, 'calendar', 'stale.txt', 'text/plain', 5, 'hash', ?, 'r2', ?)`)
      .run('stale-attachment', USER, 'calendar/user/stale-attachment.txt', 1)
    sqlite.prepare('INSERT INTO calendar_event_attachments (user_id, attachment_id, event_id, created_at) VALUES (?, ?, ?, ?)')
      .run(USER, 'stale-attachment', stale.id, 1)

    const result = await refreshIcsSubscription(env, USER, 'stale-cleanup')

    expect(result.removed).toBe(1)
    expect(await store.getEvent(stale.id)).toBeNull()
    expect(await store.getEvent(shared.id)).toMatchObject({ calendarIds: [home.id] })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_event_reminders WHERE user_id = ?').get(USER)).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_event_attendees WHERE user_id = ?').get(USER)).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_event_attachments WHERE user_id = ?').get(USER)).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM attachments WHERE user_id = ?').get(USER)).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM attachment_cleanup WHERE user_id = ?').get(USER)).toEqual({ count: 1 })
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
