// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import { createCalendarConnection } from '../src/worker/calendar/connections'
import { syncDueProviderConnections } from '../src/worker/calendar/provider-sync'
import { CALENDAR_SCHEMA_STATEMENTS } from '../src/worker/calendar/schema'
import { CalendarStore } from '../src/worker/calendar/store'
import { newId } from '../src/worker/lib/id'
import type { Env } from '../src/worker/env'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

type ProviderKind = 'caldav' | 'google' | 'outlook'

const mocks = vi.hoisted(() => ({
  caldavSync: vi.fn(),
  googleSync: vi.fn(),
  outlookSync: vi.fn(),
  projectSync: vi.fn(),
}))

vi.mock('@dayflow/caldav', () => ({
  createCalDAVAdapter: vi.fn(() => ({ syncEvents: mocks.caldavSync })),
  createCalDAVSync: vi.fn(() => ({ syncEvents: mocks.caldavSync })),
  mapCalDAVEventToDayFlow: vi.fn((data: { uid: string }) => remoteEvent(data.uid, 'caldav')),
}))

vi.mock('@dayflow/google-sync', () => ({
  createGoogleSyncAdapter: vi.fn(() => ({})),
  createGoogleSync: vi.fn(() => ({ syncEvents: mocks.googleSync })),
}))

vi.mock('@dayflow/outlook-sync', () => ({
  createOutlookSyncAdapter: vi.fn(() => ({})),
  createOutlookSync: vi.fn(() => ({ syncEvents: mocks.outlookSync })),
}))

vi.mock('../src/worker/project/project-calendar', () => ({
  syncProjectCardForCalendarEvent: mocks.projectSync,
}))

const USER = 'p'.repeat(26)
const NOW = Date.parse('2026-10-26T08:00:00Z')
let sqlite: DatabaseSync
let db: D1Database
let env: Env

function remoteEvent(id: string, source: ProviderKind) {
  return {
    title: `Remote ${id}`,
    start: Temporal.ZonedDateTime.from('2026-10-28T09:00:00+00:00[UTC]'),
    end: Temporal.ZonedDateTime.from('2026-10-28T10:00:00+00:00[UTC]'),
    meta: source === 'caldav'
      ? { caldav: { uid: id, href: `/${id}.ics` } }
      : { [source]: { eventId: id } },
  }
}

async function seed(source: ProviderKind, syncToken: string | null = null): Promise<string> {
  const connectionId = newId()
  const baseUrl = source === 'google'
    ? 'https://www.googleapis.com/calendar/v3/'
    : source === 'outlook'
      ? 'https://graph.microsoft.com/v1.0/'
      : 'https://dav.example.com/'
  await createCalendarConnection(db, USER, {
    id: connectionId,
    kind: source,
    label: source,
    baseUrl,
    calendarHomeUrl: baseUrl,
    username: source === 'caldav' ? 'alice' : null,
    scope: 'read',
    writable: false,
    credential: { kind: source === 'caldav' ? 'basic' : 'oauth', ciphertext: 'sealed-test-credential' },
  })
  const calendarId = `${source}-calendar`
  await new CalendarStore(db, USER).createCalendar({ id: calendarId, name: source, source })
  sqlite.prepare(`INSERT INTO calendar_provider_calendars
    (user_id, connection_id, remote_calendar_id, local_calendar_id, sync_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1)`).run(USER, connectionId, calendarId, calendarId, syncToken)
  return connectionId
}

function storedToken(connectionId: string): string | null {
  const row = sqlite.prepare('SELECT sync_token FROM calendar_provider_calendars WHERE connection_id = ?')
    .get(connectionId) as { sync_token: string | null }
  return row.sync_token
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.caldavSync.mockReset()
  mocks.googleSync.mockReset()
  mocks.outlookSync.mockReset()
  mocks.projectSync.mockReset()
  mocks.projectSync.mockResolvedValue(undefined)
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CALENDAR_SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.exec(`CREATE TABLE attachments (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL,
    filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    object_key TEXT, storage TEXT NOT NULL, created_at INTEGER NOT NULL
  ); CREATE TABLE attachment_cleanup (
    object_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL
  )`)
  db = makeD1(sqlite)
  env = testBindings(db)
})

describe('provider adapter boundary', () => {
  it.each(['google', 'outlook'] as const)('persists and reuses %s delta tokens without mirroring a delta as a full list', async (source) => {
    const connectionId = await seed(source)
    const sync = source === 'google' ? mocks.googleSync : mocks.outlookSync
    const tokenKey = source === 'google' ? 'syncToken' : 'deltaToken'
    sync
      .mockResolvedValueOnce({ events: [remoteEvent('first', source)], deleted: [], [tokenKey]: 'token-1' })
      .mockResolvedValueOnce({ events: [], deleted: [], [tokenKey]: 'token-2' })

    expect(await syncDueProviderConnections(env, NOW)).toMatchObject({ events: 1, deleted: 0, failed: 0 })
    expect(storedToken(connectionId)).toBe('token-1')
    sqlite.prepare('UPDATE calendar_provider_calendars SET last_sync_at = ? WHERE connection_id = ?')
      .run(NOW - 16 * 60_000, connectionId)

    expect(await syncDueProviderConnections(env, NOW)).toMatchObject({ events: 0, deleted: 0, failed: 0 })
    expect(sync.mock.calls[1]?.[0]).toBe(`${source}-calendar`)
    expect(sync.mock.calls[1]?.[1]).toBeUndefined()
    expect(sync.mock.calls[1]?.[2]).toBe('token-1')
    expect(storedToken(connectionId)).toBe('token-2')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events').get()).toEqual({ count: 1 })
  })

  it('writes provider events back to linked project cards using the created event id', async () => {
    await seed('google')
    mocks.googleSync.mockResolvedValueOnce({
      events: [remoteEvent('linked-project', 'google')], deleted: [], syncToken: 'project-token',
    })

    expect(await syncDueProviderConnections(env, NOW)).toMatchObject({ events: 1, deleted: 0, failed: 0 })
    const event = sqlite.prepare('SELECT id FROM calendar_events').get() as { id: string }
    expect(mocks.projectSync).toHaveBeenCalledTimes(1)
    expect(mocks.projectSync).toHaveBeenCalledWith(db, USER, event.id)
  })

  it('passes CalDAV sync tokens to the adapter and keeps unchanged rows during incremental sync', async () => {
    const connectionId = await seed('caldav')
    mocks.caldavSync
      .mockResolvedValueOnce({
        events: [{ calendarId: 'caldav-calendar', uid: 'first', href: '/first.ics', icalData: 'BEGIN:VEVENT' }],
        deleted: [], syncToken: 'caldav-1',
      })
      .mockResolvedValueOnce({ events: [], deleted: [], syncToken: 'caldav-2' })
      .mockResolvedValueOnce({
        events: [], deleted: [{ calendarId: 'caldav-calendar', href: '/first.ics' }], syncToken: 'caldav-3',
      })

    expect(await syncDueProviderConnections(env, NOW)).toMatchObject({ events: 1, deleted: 0, failed: 0 })
    sqlite.prepare('UPDATE calendar_provider_calendars SET last_sync_at = ? WHERE connection_id = ?')
      .run(NOW - 16 * 60_000, connectionId)
    expect(await syncDueProviderConnections(env, NOW)).toMatchObject({ events: 0, deleted: 0, failed: 0 })

    expect(mocks.caldavSync.mock.calls[1]?.[0]).toMatchObject({
      calendarId: 'caldav-calendar', syncToken: 'caldav-1',
    })
    expect(mocks.caldavSync.mock.calls[1]?.[0].range).toBeUndefined()
    expect(storedToken(connectionId)).toBe('caldav-2')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events').get()).toEqual({ count: 1 })

    sqlite.prepare('UPDATE calendar_provider_calendars SET last_sync_at = ? WHERE connection_id = ?')
      .run(NOW - 16 * 60_000, connectionId)
    expect(await syncDueProviderConnections(env, NOW)).toMatchObject({ events: 0, deleted: 1, failed: 0 })
    expect(storedToken(connectionId)).toBe('caldav-3')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events').get()).toEqual({ count: 0 })
  })

  it.each([
    { events: {}, deleted: [], syncToken: 'untrusted' },
    { events: [], deleted: [null], syncToken: 'untrusted' },
    { events: [], deleted: [], syncToken: 42 },
  ])('rejects a malformed vendor envelope before writing events or advancing the token', async (result) => {
    const connectionId = await seed('google', 'last-good')
    mocks.googleSync.mockResolvedValueOnce(result)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await syncDueProviderConnections(env, NOW)).toMatchObject({ events: 0, deleted: 0, failed: 1 })
    expect(storedToken(connectionId)).toBe('last-good')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events').get()).toEqual({ count: 0 })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('skips malformed mapped events with context while preserving valid events and the returned token', async () => {
    const connectionId = await seed('google')
    mocks.googleSync.mockResolvedValueOnce({
      events: [null, { title: 'Bad dates', start: '2026-10-28', end: '2026-10-28' }, remoteEvent('valid', 'google')],
      deleted: [], syncToken: 'next-good',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await syncDueProviderConnections(env, NOW)).toMatchObject({ events: 1, deleted: 0, failed: 0 })
    expect(storedToken(connectionId)).toBe('next-good')
    expect(sqlite.prepare('SELECT external_id FROM calendar_events').all()).toEqual([{ external_id: 'valid' }])
    expect(warn.mock.calls.filter(([message]) => message === '[inkstone] Provider event skipped:')).toHaveLength(2)
    warn.mockRestore()
  })

  it('normalizes provider meta attendees and treats an omitted list as empty on delta sync', async () => {
    await seed('google')
    const first = remoteEvent('guest-event', 'google')
    mocks.googleSync
      .mockResolvedValueOnce({
        events: [{
          ...first,
          meta: {
            ...first.meta,
            attendees: [{ email: ' Provider@Example.com ', name: 'Provider Guest', status: 'accepted' }],
          },
        }],
        deleted: [],
        syncToken: 'guest-token-1',
      })
      .mockResolvedValueOnce({ events: [first], deleted: [], syncToken: 'guest-token-2' })

    expect(await syncDueProviderConnections(env, NOW)).toMatchObject({ events: 1, failed: 0 })
    const store = new CalendarStore(db, USER)
    const [event] = await store.listAllEvents()
    expect(await store.eventAttendees(event!.id)).toEqual([
      { email: 'provider@example.com', name: 'Provider Guest', status: 'accepted' },
    ])
    expect(event!.meta).not.toHaveProperty('attendees')

    sqlite.prepare('UPDATE calendar_provider_calendars SET last_sync_at = ?').run(NOW - 16 * 60_000)
    expect(await syncDueProviderConnections(env, NOW)).toMatchObject({ events: 1, failed: 0 })
    expect(await store.eventAttendees(event!.id)).toEqual([])
  })

  it('validates raw CalDAV resources before passing them to the vendor mapper', async () => {
    const connectionId = await seed('caldav')
    mocks.caldavSync.mockResolvedValueOnce({
      events: [{ calendarId: 'caldav-calendar', uid: 'broken', href: '/broken.ics', icalData: null }],
      deleted: [], syncToken: 'caldav-next',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await syncDueProviderConnections(env, NOW)).toMatchObject({ events: 0, deleted: 0, failed: 0 })
    expect(storedToken(connectionId)).toBe('caldav-next')
    expect(warn.mock.calls.some(([message]) => message === '[inkstone] Provider event skipped:')).toBe(true)
    warn.mockRestore()
  })
})
