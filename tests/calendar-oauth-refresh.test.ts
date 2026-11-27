// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCalendarConnection, getCalendarConnection, loadCalendarCredential } from '../src/worker/calendar/connections'
import { ensureAccessToken, type CalendarOAuthCredential } from '../src/worker/calendar/oauth'
import { CALENDAR_SCHEMA_STATEMENTS } from '../src/worker/calendar/schema'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import { decryptCalendarCredential, encryptCalendarCredential } from '../src/worker/lib/crypto'
import { newId } from '../src/worker/lib/id'
import type { Env } from '../src/worker/env'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'e'.repeat(26)
const SCOPE = 'https://www.googleapis.com/auth/calendar'

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let objectNames: string[]

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CALENDAR_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  const values = new Map<string, unknown>()
  const state = {
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => { values.set(key, value) },
    },
    blockConcurrencyWhile: async <T>(run: () => Promise<T>) => await run(),
  } as unknown as DurableObjectState
  const vault = new CredentialVault(state)
  objectNames = []
  const namespace = testDurableObjectNamespace((request) => vault.fetch(request), {
    onGet: (id) => { objectNames.push(id.name ?? id.toString()) },
  })
  env = testBindings(db, {
    CREDENTIAL_VAULT: namespace,
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function seedOAuth(): Promise<{ id: string; credential: CalendarOAuthCredential }> {
  const id = newId()
  const credential: CalendarOAuthCredential = {
    kind: 'oauth',
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: Date.now() - 1,
    scope: SCOPE,
    tokenType: 'Bearer',
  }
  const ciphertext = await encryptCalendarCredential(env, id, credential)
  await createCalendarConnection(db, USER, {
    id,
    kind: 'google',
    label: 'Google Calendar',
    baseUrl: 'https://www.googleapis.com/calendar/v3/',
    calendarHomeUrl: 'https://www.googleapis.com/calendar/v3/',
    username: null,
    scope: 'write',
    writable: true,
    credential: { kind: 'oauth', ciphertext },
  })
  return { id, credential }
}

describe('credential vault OAuth refresh coordination', () => {
  it('coalesces callers through the vault and persists a rotated refresh token', async () => {
    const seeded = await seedOAuth()
    const connection = await getCalendarConnection(db, USER, seeded.id)
    let resolveFetch: ((response: Response) => void) | undefined
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)

    const first = ensureAccessToken(env, USER, connection!, seeded.credential)
    const second = ensureAccessToken(env, USER, connection!, seeded.credential)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    resolveFetch?.(Response.json({
      access_token: 'access-new',
      refresh_token: 'refresh-rotated',
      expires_in: 3600,
      scope: SCOPE,
      token_type: 'Bearer',
    }))

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { accessToken: 'access-new', refreshToken: 'refresh-rotated' },
      { accessToken: 'access-new', refreshToken: 'refresh-rotated' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const ciphertext = await loadCalendarCredential(db, USER, seeded.id, 'oauth')
    await expect(decryptCalendarCredential(env, seeded.id, ciphertext!)).resolves.toMatchObject({
      accessToken: 'access-new',
      refreshToken: 'refresh-rotated',
    })
    expect(objectNames.filter(name => name === `calendar-oauth:${USER}:${seeded.id}`)).toHaveLength(2)
  })

  it('cleans up a refused flight so a later refresh can reconnect the connection', async () => {
    const seeded = await seedOAuth()
    const connection = await getCalendarConnection(db, USER, seeded.id)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'access-retry', refresh_token: 'refresh-retry', expires_in: 3600 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(ensureAccessToken(env, USER, connection!, seeded.credential))
      .rejects.toMatchObject({ status: 502 })
    expect(await getCalendarConnection(db, USER, seeded.id)).toMatchObject({
      status: 'expired',
      lastErrorCode: 'authorization_expired',
    })

    await expect(ensureAccessToken(env, USER, connection!, seeded.credential))
      .resolves.toMatchObject({ accessToken: 'access-retry' })
    expect(await getCalendarConnection(db, USER, seeded.id)).toMatchObject({ status: 'connected', lastErrorCode: null })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not coalesce different connections', async () => {
    const first = await seedOAuth()
    const second = await seedOAuth()
    const firstConnection = await getCalendarConnection(db, USER, first.id)
    const secondConnection = await getCalendarConnection(db, USER, second.id)
    const fetchMock = vi.fn(async () => Response.json({ access_token: 'access-new', expires_in: 3600 }))
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([
      ensureAccessToken(env, USER, firstConnection!, first.credential),
      ensureAccessToken(env, USER, secondConnection!, second.credential),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(objectNames).toContain(`calendar-oauth:${USER}:${first.id}`)
    expect(objectNames).toContain(`calendar-oauth:${USER}:${second.id}`)
  })
})
