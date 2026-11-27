// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachCalendarProviders } from '../src/client/features/calendar/providers'
import { createCalendarConnection } from '../src/worker/calendar/connections'
import {
  DEFAULT_OUTLOOK_GRAPH_API_BASE,
  assertOutlookGraphBase,
  outlookGraphBase,
  validateOutlookGraphBase,
} from '../src/worker/calendar/graph'
import { syncDueProviderConnections } from '../src/worker/calendar/provider-sync'
import { CALENDAR_SCHEMA_STATEMENTS } from '../src/worker/calendar/schema'
import { CalendarStore } from '../src/worker/calendar/store'
import { newId } from '../src/worker/lib/id'
import type { Env } from '../src/worker/env'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const mocks = vi.hoisted(() => ({ adapterOptions: [] as Array<Record<string, unknown>> }))

vi.mock('@dayflow/outlook-sync', () => ({
  createOutlookSyncAdapter: vi.fn((options: Record<string, unknown>) => {
    mocks.adapterOptions.push(options)
    return {}
  }),
  createOutlookSync: vi.fn(() => ({
    listCalendars: async () => [],
    syncEvents: async () => ({ events: [], deleted: [] }),
  })),
  attachOutlookSyncToDayFlow: vi.fn(() => ({ start: async () => {}, stop: () => {} })),
}))

vi.mock('../src/client/features/calendar/api', () => ({
  proxyCalendar: vi.fn(),
  reportConnectionCalendars: vi.fn(async () => undefined),
  reportConnectionStatus: vi.fn(async () => undefined),
}))

const USER = 'e'.repeat(26)
let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  mocks.adapterOptions.length = 0
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CALENDAR_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

function environment(configured?: string): Env {
  return testBindings(db, configured === undefined ? {} : { OUTLOOK_GRAPH_API_BASE: configured })
}

async function seedOutlook(env: Env, baseUrl: string): Promise<string> {
  const id = newId()
  await createCalendarConnection(db, USER, {
    id,
    kind: 'outlook',
    label: 'Outlook',
    baseUrl,
    calendarHomeUrl: baseUrl,
    username: null,
    scope: 'read',
    writable: false,
    credential: { kind: 'oauth', ciphertext: 'sealed-test-credential' },
  })
  await new CalendarStore(db, USER).createCalendar({ id: 'outlook-cal', name: 'Outlook', source: 'outlook' })
  sqlite.prepare(`INSERT INTO calendar_provider_calendars
    (user_id, connection_id, remote_calendar_id, local_calendar_id, created_at, updated_at)
    VALUES (?, ?, 'outlook-cal', 'outlook-cal', 1, 1)`).run(USER, id)
  return id
}

describe('Outlook Graph base configuration', () => {
  it('defaults to public v1.0 and accepts beta and custom HTTPS bases', () => {
    expect(outlookGraphBase(environment())).toBe(DEFAULT_OUTLOOK_GRAPH_API_BASE)
    expect(outlookGraphBase(environment(' https://graph.microsoft.com/beta/ ')))
      .toBe('https://graph.microsoft.com/beta/')
    expect(outlookGraphBase(environment('https://graph.example.com/calendar/v2/')))
      .toBe('https://graph.example.com/calendar/v2/')
  })

  it.each([
    'not a url',
    'http://graph.microsoft.com/v1.0/',
    'https://alice:secret@graph.microsoft.com/v1.0/',
    'https://graph.microsoft.com:8443/v1.0/',
    'https://graph.microsoft.com/v1.0/?token=x',
    'https://graph.microsoft.com/v1.0/#fragment',
    'https://graph.microsoft.com/v1.0/%2e%2e/admin/',
    'https://graph.microsoft.com/v1.0/%252e%252e/admin/',
    'https://graph.microsoft.com/v1.0\\..\\admin/',
  ])('rejects invalid configured base %s before OAuth or sync', (base) => {
    expect(() => validateOutlookGraphBase(base)).toThrowError(expect.objectContaining({
      status: 503,
      code: 'server_misconfigured',
    }))
  })

  it('rejects a persisted origin or path that differs from the configured base', () => {
    const env = environment('https://graph.microsoft.com/beta/')
    expect(assertOutlookGraphBase(env, 'https://graph.microsoft.com/beta/', 'https://graph.microsoft.com/beta/'))
      .toBe('https://graph.microsoft.com/beta/')
    expect(() => assertOutlookGraphBase(env, 'https://evil.example/beta/', 'https://graph.microsoft.com/beta/'))
      .toThrowError(expect.objectContaining({ status: 500 }))
    expect(() => assertOutlookGraphBase(env, 'https://graph.microsoft.com/v1.0/', 'https://graph.microsoft.com/v1.0/'))
      .toThrowError(expect.objectContaining({ status: 500 }))
  })
})

describe('Outlook adapters use the persisted Graph base', () => {
  it.each<[string | undefined, string]>([
    [undefined, DEFAULT_OUTLOOK_GRAPH_API_BASE],
    ['https://graph.microsoft.com/beta/', 'https://graph.microsoft.com/beta/'],
    ['https://graph.example.com/calendar/v2/', 'https://graph.example.com/calendar/v2/'],
  ])('passes %s to the server and browser adapters', async (configured, expected) => {
    const env = environment(configured)
    const id = await seedOutlook(env, expected)
    const fetchMock = vi.fn(async () => Response.json({}))
    vi.stubGlobal('fetch', fetchMock)

    expect(await syncDueProviderConnections(env, Date.now())).toMatchObject({ connections: 1, failed: 0 })
    expect(mocks.adapterOptions[0]).toMatchObject({ baseUrl: expected, fetch: expect.any(Function) })

    const attachment = attachCalendarProviders({} as Parameters<typeof attachCalendarProviders>[0], {
      userId: USER,
      connections: [{
        id,
        kind: 'outlook',
        label: 'Outlook',
        baseUrl: expected,
        calendarHomeUrl: expected,
        scope: 'read',
        writable: false,
        status: 'connected',
        lastSyncedAt: null,
        lastErrorCode: null,
      }],
      getInitialSnapshot: () => ({ events: [], calendars: [] }),
    })
    await vi.waitFor(() => expect(mocks.adapterOptions).toHaveLength(2))
    expect(mocks.adapterOptions[1]).toMatchObject({ baseUrl: expected, fetch: expect.any(Function) })
    attachment.stop()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a tampered stored origin or path before creating an adapter', async () => {
    const env = environment('https://graph.microsoft.com/beta/')
    const id = await seedOutlook(env, 'https://graph.microsoft.com/beta/')
    const fetchMock = vi.fn(async () => Response.json({}))
    vi.stubGlobal('fetch', fetchMock)
    for (const tampered of ['https://evil.example/beta/', 'https://graph.microsoft.com/v1.0/']) {
      sqlite.prepare('UPDATE calendar_connections SET base_url = ?, calendar_home_url = ? WHERE user_id = ? AND id = ?')
        .run(tampered, tampered, USER, id)
      expect(await syncDueProviderConnections(env, Date.now())).toMatchObject({ connections: 1, failed: 1 })
    }
    expect(mocks.adapterOptions).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
