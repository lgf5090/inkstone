// @vitest-environment node
// Behavioural coverage for the instance YouTube settings: the key is sealed, never returned, and
// becomes the upstream key; region and quota override the deployment values; members cannot write.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { isCredentialRecord, isScope } from '../src/worker/durable/credential-vault'
import { youtubeSettingsRoutes } from '../src/worker/youtube/routes-settings'
import { youtubeUpstreamRoutes } from '../src/worker/youtube/routes-upstream'
import { YOUTUBE_SCHEMA_STATEMENTS } from '../src/worker/youtube/schema'
import { YOUTUBE_SETTINGS_SECRET_SCOPE } from '../src/worker/lib/crypto'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'

const USER = 'u-owner'
const LOGIN_ATTEMPTS_SCHEMA = `CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  last_fail_at INTEGER NOT NULL,
  locked_until INTEGER
)`
const ctx: ExecutionContext = { waitUntil() {}, passThroughOnException() {}, props: {} }

let sqlite: DatabaseSync
let db: D1Database
let calls: URL[]
let role: 'owner' | 'member'

const app = new Hono<AppBindings>()
app.onError((error, c) => errorResponse(c, error))
app.use('*', async (c, next) => {
  c.set('userId', USER)
  c.set('user', {
    id: USER, username: 'owner', login: 'owner', name: 'Owner', avatarUrl: '',
    role, createdAt: 1, settingsRaw: '{}',
  })
  await next()
})
app.route('/api/youtube/settings', youtubeSettingsRoutes)
app.route('/api/youtube', youtubeUpstreamRoutes)

function vault() {
  const values = new Map<string, unknown>()
  let seq = 0
  return testDurableObjectNamespace(async (request) => {
    const body = await request.json() as { scope: string; value?: unknown; ciphertext?: string }
    if (request.url.endsWith('/encrypt')) {
      const ciphertext = `cipher-${++seq}`
      values.set(ciphertext, body.value)
      return Response.json({ ciphertext })
    }
    if (!values.has(body.ciphertext ?? '')) return new Response('', { status: 422 })
    return Response.json({ value: values.get(body.ciphertext!) })
  })
}

function envWith(overrides: Partial<Env> = {}): Env {
  return testBindings(db, {
    YOUTUBE_API_KEY: 'env-key-1234567890',
    CREDENTIAL_VAULT: vault(),
    ...overrides,
  })
}

async function request(path: string, method = 'GET', body?: unknown, env = envWith()): Promise<Response> {
  return await app.request(
    `/api/youtube${path}`,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
    ctx,
  )
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of YOUTUBE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.exec(LOGIN_ATTEMPTS_SCHEMA)
  db = makeD1(sqlite)
  calls = []
  role = 'owner'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
    calls.push(url)
    return jsonResponse({ items: [], pageInfo: { totalResults: 0 } })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

describe('youtube settings', () => {
  it('stores the key under a scope the real vault policy accepts', () => {
    const scope = `youtube:${YOUTUBE_SETTINGS_SECRET_SCOPE}`
    expect(isScope(scope)).toBe(true)
    expect(isCredentialRecord(scope, { apiKey: 'AIzaSyExample' })).toBe(true)
    expect(isCredentialRecord(scope, { apiKey: '' })).toBe(false)
    expect(isCredentialRecord(scope, { apiKey: 'x', regionCode: 'US' })).toBe(false)
    expect(isCredentialRecord(scope, { apiKey: 'x'.repeat(4096 + 1) })).toBe(false)
  })

  it('reports the Worker secret without returning it', async () => {
    const response = await request('/settings')
    expect(response.status).toBe(200)
    const body = await response.json() as {
      canEdit: boolean
      api: { configured: boolean; source: string; hasEnvKey: boolean; hasStoredKey: boolean; vaultAvailable: boolean }
    }
    expect(body.canEdit).toBe(true)
    expect(body.api).toMatchObject({ configured: true, source: 'env', hasEnvKey: true, hasStoredKey: false, vaultAvailable: true })
    expect(JSON.stringify(body)).not.toContain('env-key-1234567890')
  })

  it('seals a stored key, never returns it, and signs upstream calls with it', async () => {
    const env = envWith()
    const saved = await request('/settings', 'PUT', { apiKey: 'stored-key-abcdefgh', regionCode: 'us', dailyQuota: 5000 }, env)
    expect(saved.status).toBe(200)
    const body = await saved.json() as { api: { source: string; hasStoredKey: boolean; region: string | null; dailyQuota: number } }
    expect(body.api).toMatchObject({ source: 'stored', hasStoredKey: true, region: 'US', dailyQuota: 5000 })
    expect(JSON.stringify(body)).not.toContain('stored-key-abcdefgh')

    const storedRow = sqlite.prepare('SELECT api_key_ciphertext FROM youtube_settings WHERE id = ?').get('instance') as { api_key_ciphertext: string }
    expect(storedRow.api_key_ciphertext).not.toBe('')
    expect(storedRow.api_key_ciphertext).not.toContain('stored-key-abcdefgh')

    const discover = await request('/discover?sort=viewCount&range=week', 'GET', undefined, env)
    expect(discover.status).toBe(200)
    expect(calls[0]?.searchParams.get('key')).toBe('stored-key-abcdefgh')
    expect(calls[0]?.searchParams.get('regionCode')).toBe('US')
  })

  it('falls back to the Worker secret after the stored key is removed', async () => {
    await request('/settings', 'PUT', { apiKey: 'stored-key-abcdefgh' })
    const removed = await request('/settings', 'PUT', { apiKey: null })
    expect(removed.status).toBe(200)
    const body = await removed.json() as { api: { source: string; hasStoredKey: boolean; configured: boolean } }
    expect(body.api).toMatchObject({ source: 'env', hasStoredKey: false, configured: true })
    await request('/discover')
    expect(calls[0]?.searchParams.get('key')).toBe('env-key-1234567890')
  })

  it('refuses writes from a member and bad values', async () => {
    role = 'member'
    expect((await request('/settings', 'PUT', { regionCode: 'US' })).status).toBe(403)

    role = 'owner'
    expect((await request('/settings', 'PUT', { regionCode: 'USA' })).status).toBe(400)
    expect((await request('/settings', 'PUT', { dailyQuota: 0 })).status).toBe(400)
    expect((await request('/settings', 'PUT', { apiKey: ' short ' })).status).toBe(400)
  })

  it('refuses to store a key when the vault is not bound, but still reports the secret', async () => {
    const noVault = envWith({ CREDENTIAL_VAULT: undefined })
    const response = await request('/settings', 'PUT', { apiKey: 'stored-key-abcdefgh' }, noVault)
    expect(response.status).toBe(503)
    const view = await request('/settings', undefined, undefined, noVault)
    const body = await view.json() as { api: { configured: boolean; source: string; vaultAvailable: boolean } }
    expect(body.api).toMatchObject({ configured: true, source: 'env', vaultAvailable: false })
  })
})
