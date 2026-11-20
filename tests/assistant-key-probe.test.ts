// @vitest-environment node
/**
 * Asking whether a key still works, and the discipline of three answers.
 *
 * The point of this file is the case a two-outcome probe gets wrong: a 429, a timeout or a 5xx says
 * nothing about the credential, and a screen that called those "invalid" would send the reader to delete
 * a key that works. So the classification table below is the contract, and "cannot tell" has to survive
 * every path — including the probe's own failure.
 *
 * The probe asks the model listing rather than a chat call: it must stay free, or nobody runs it.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import { probeProviderKey } from '../src/worker/assistant/key-probe'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
/** Synthetic tokens in the shape a vendor issues. The last four are what a listing may show. */
const FIRST = 'sk-test-0000000000000000aaaa'
const SECOND = 'sk-test-0000000000000000bbbb'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let app: Hono<AppBindings>
let vaultStorage: Map<string, unknown>

function fakeVaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) { return vaultStorage.get(key) },
      async put(key: string, value: unknown) { vaultStorage.set(key, value) },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> { return await fn() },
  } as unknown as DurableObjectState
}

async function send(method: string, path: string, body: unknown): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env, {} as ExecutionContext)
}

async function get(path: string): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`), env, {} as ExecutionContext)
}

beforeEach(async () => {
  vaultStorage = new Map<string, unknown>()
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), {
    PUBLIC_URL: 'http://localhost',
    DO_AUTH_KEY: 'test-internal-key',
    CREDENTIAL_VAULT: testDurableObjectNamespace(
      async (request) => await new CredentialVault(fakeVaultState(), env).fetch(request),
    ),
  })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  instance.route('/api/assistant', assistantRoutes)
  app = instance
})

afterEach(() => vi.unstubAllGlobals())

const reply = (status: number) => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })))

describe('what one probe may conclude', () => {
  it('calls an accepted credential passed, and measures how long it took', async () => {
    reply(200)
    const result = await probeProviderKey('openai', 'https://api.deepseek.com', 'sk-x')
    expect(result.outcome).toBe('passed')
    expect(result.reason).toBeNull()
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('blames the key only for a refusal', async () => {
    for (const status of [401, 403]) {
      vi.unstubAllGlobals()
      reply(status)
      const result = await probeProviderKey('openai', 'https://api.deepseek.com', 'sk-x')
      expect(result.outcome).toBe('failed')
      expect(result.reason).toBe('invalid_credential')
    }
  })

  it('does not blame the key for a limit, an outage or a timeout', async () => {
    const cases: Array<[number, string]> = [[429, 'rate_limited'], [500, 'upstream_error'], [503, 'upstream_error']]
    for (const [status, reason] of cases) {
      vi.unstubAllGlobals()
      reply(status)
      const result = await probeProviderKey('openai', 'https://api.deepseek.com', 'sk-x')
      expect(result.outcome).toBe('inconclusive')
      expect(result.reason).toBe(reason)
    }

    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }))
    const timeout = await probeProviderKey('openai', 'https://api.deepseek.com', 'sk-x')
    expect(timeout.outcome).toBe('inconclusive')
    expect(timeout.reason).toBe('timeout')

    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const offline = await probeProviderKey('openai', 'https://api.deepseek.com', 'sk-x')
    expect(offline.outcome).toBe('inconclusive')
    expect(offline.reason).toBe('upstream_error')
  })

  it('names a vendor that does not publish the listing door instead of guessing', async () => {
    for (const status of [404, 405]) {
      vi.unstubAllGlobals()
      reply(status)
      const result = await probeProviderKey('openai', 'https://api.example.com', 'sk-x')
      expect(result.outcome).toBe('inconclusive')
      expect(result.reason).toBe('probe_incompatible')
    }
  })

  it('refuses to send a key to an address inside the network', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const result = await probeProviderKey('openai', 'http://127.0.0.1:8080', 'sk-x')
    expect(result.outcome).toBe('inconclusive')
    expect(result.reason).toBe('probe_incompatible')
    expect(spy, 'the guard let a loopback probe leave').not.toHaveBeenCalled()
  })

  it('uses the protocol’s own header spelling', async () => {
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>)
      return new Response(null, { status: 200 })
    }))
    await probeProviderKey('anthropic', 'https://api.anthropic.test', 'key-9')
    expect(seen[0]?.['x-api-key']).toBe('key-9')
    await probeProviderKey('gemini', 'https://generativelanguage.googleapis.com', 'g-key')
    expect(seen[1]?.['x-goog-api-key']).toBe('g-key')
  })
})

describe('probing a whole key ring', () => {
  const createRing = async () => {
    const response = await send('POST', '/api/assistant/providers', {
      label: 'Probe', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1',
      apiKey: `${FIRST}, ${SECOND}`, models: [],
    })
    return (await response.json() as { provider: { id: string } }).provider.id
  }

  it('answers one outcome per key and stores it for the next visit', async () => {
    const id = await createRing()
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      return auth.includes('aaaa') ? new Response(null, { status: 401 }) : new Response('{}', { status: 200 })
    }))
    const response = await send('POST', `/api/assistant/providers/${id}/keys/probe`, {})
    expect(response.status, await response.clone().text()).toBe(200)
    const body = await response.json() as { results: Array<{ keyId: string, keyHint: string, outcome: string, reason: string | null }> }
    expect(body.results.map((entry) => [entry.keyHint, entry.outcome, entry.reason])).toEqual([
      ['aaaa', 'failed', 'invalid_credential'],
      ['bbbb', 'passed', null],
    ])

    const listed = await get(`/api/assistant/providers/${id}/keys`)
    const stored = await listed.json() as { probes: Array<{ keyId: string, outcome: string }> }
    expect(stored.probes.map((entry) => entry.outcome).sort()).toEqual(['failed', 'passed'])
    // The provider's own key is named by the empty string, the same way the rest of the app names it.
    expect(stored.probes.some((entry) => entry.keyId === '')).toBe(true)
  })

  it('does not let one unreadable row stop the rest of the ring', async () => {
    const id = await createRing()
    // A row whose ciphertext the vault cannot read stands in for a probe that would have thrown.
    const at = Date.now()
    sqlite.prepare(
      `INSERT INTO chat_provider_keys (user_id, id, provider_id, label, key_ciphertext, key_hint, enabled, created_at, updated_at)
       VALUES (?, ?, ?, '', 'not-a-ciphertext', 'cccc', 1, ?, ?)`,
    ).run(USER, 'broken-key', id, at, at)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    const response = await send('POST', `/api/assistant/providers/${id}/keys/probe`, {})
    expect(response.status).toBe(200)
    const body = await response.json() as { results: Array<{ outcome: string, reason: string | null }> }
    // The unreadable row cannot be decrypted, so it never reaches the wire; the two real keys still answer.
    expect(body.results.map((entry) => entry.outcome).sort()).toEqual(['passed', 'passed'])
  })

  it('refuses to probe a provider with no key at all', async () => {
    const response = await send('POST', '/api/assistant/providers', {
      label: 'Empty', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', models: [],
    })
    const id = (await response.json() as { provider: { id: string } }).provider.id
    expect((await send('POST', `/api/assistant/providers/${id}/keys/probe`, {})).status).toBe(400)
  })
})
