// @vitest-environment node
/**
 * A pasted key ring: one line in the form, several credentials in the vault, one rotation.
 *
 * The reader's complaint was that the key box held one key and the polling was never complete. The form
 * now sends the line it typed and the route is the place that says what it means: the first key belongs to
 * the provider row, the rest become extra rows, and a filled box on an edit replaces the whole ring rather
 * than leaving the reader's old, labelled keys quietly beside the new ones. These cases pin that boundary,
 * the cap that keeps one request from writing an unbounded number of vault rows, and the short cooldown
 * that sends a refused key to the back of the ring instead of taking it away for good.
 *
 * All keys below are synthetic. No real credential appears in this file, in the database, or in a log.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import { MAX_PROVIDER_KEYS, parseProviderKeys } from '../src/shared/assistant'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
/** Synthetic tokens, in the shape a vendor issues. The last four are what a listing may show. */
const FIRST = 'sk-test-0000000000000000aaaa'
const SECOND = 'sk-test-0000000000000000bbbb'
const THIRD = 'sk-test-0000000000000000cccc'
const REPLACEMENT = 'sk-test-0000000000000000dddd'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let app: Hono<AppBindings>
/** One vault across the whole case: a fresh master key per request could not decrypt what it just wrote. */
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
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env, {} as ExecutionContext)
}

async function get(path: string): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`), env, {} as ExecutionContext)
}

const newProvider = (apiKey: string) => ({
  label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey, models: [],
})

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

describe('splitting the line the form typed', () => {
  it('takes commas and line breaks, drops blanks and repeats, and keeps order', () => {
    expect(parseProviderKeys(`${FIRST}, ${SECOND}\n${THIRD},${FIRST}, ,`)).toEqual([FIRST, SECOND, THIRD])
    expect(parseProviderKeys('')).toEqual([])
  })
})

describe('creating a provider from a pasted ring', () => {
  it('stores the first key on the provider and the rest as unnamed extras', async () => {
    const response = await send('POST', '/api/assistant/providers', newProvider(`${FIRST}, ${SECOND}, ${THIRD}`))
    expect(response.status, await response.clone().text()).toBe(201)
    const created = (await response.json() as { provider: { id: string, keyHint: string, icon: string } }).provider
    expect(created.keyHint).toBe('aaaa')
    const extras = await store.listProviderKeys(created.id)
    expect(extras.map((entry) => entry.keyHint)).toEqual(['bbbb', 'cccc'])
    expect(extras.every((entry) => entry.label === '' && entry.enabled)).toBe(true)
    // A listing may say which key it holds, never what it is.
    expect(JSON.stringify(created)).not.toContain(FIRST)
    expect(JSON.stringify(extras)).not.toContain(SECOND)
  })

  it('refuses a ring longer than the shared cap instead of dropping its tail', async () => {
    const tooMany = Array.from({ length: MAX_PROVIDER_KEYS + 1 }, (_, index) => `sk-test-many-${index}`).join(',')
    const response = await send('POST', '/api/assistant/providers', newProvider(tooMany))
    expect(response.status).toBe(400)
    expect(await store.listProviders()).toHaveLength(0)
  })
})

describe('editing a provider whose ring already holds extra keys', () => {
  const create = async () => {
    const response = await send('POST', '/api/assistant/providers', newProvider(`${FIRST}, ${SECOND}, ${THIRD}`))
    return (await response.json() as { provider: { id: string } }).provider.id
  }

  it('leaves the ring alone when the edit names no key', async () => {
    const id = await create()
    const before = await store.listProviderKeys(id)
    await send('PATCH', `/api/assistant/providers/${id}`, { label: 'Renamed' })
    expect((await store.listProviderKeys(id)).map((entry) => entry.id)).toEqual(before.map((entry) => entry.id))
    expect((await store.getProvider(id))?.keyHint).toBe('aaaa')
  })

  it('replaces the whole ring, including rows the reader had labelled', async () => {
    const id = await create()
    const firstExtra = (await store.listProviderKeys(id))[0]!
    await store.updateProviderKey(firstExtra.id, { label: 'Work account' })
    const response = await send('PATCH', `/api/assistant/providers/${id}`, { apiKey: `${REPLACEMENT}, ${THIRD}` })
    expect(response.status, await response.clone().text()).toBe(200)
    expect((await store.getProvider(id))?.keyHint).toBe('dddd')
    const extras = await store.listProviderKeys(id)
    expect(extras).toHaveLength(1)
    expect(extras[0]?.id).not.toBe(firstExtra.id)
    expect(extras[0]?.keyHint).toBe('cccc')
  })
})

describe('a balance the isolate remembered', () => {
  it('is asked again after the key ring is replaced', async () => {
    const created = await send('POST', '/api/assistant/providers', newProvider(FIRST))
    const id = (await created.json() as { provider: { id: string } }).provider.id
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return new Response(JSON.stringify({ balance_infos: [{ total_balance: '3.5', currency: 'CNY' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }))
    expect((await get(`/api/assistant/providers/${id}/balance`)).status).toBe(200)
    expect(calls).toBe(1)
    expect((await get(`/api/assistant/providers/${id}/balance`)).status).toBe(200)
    expect(calls, 'the second reading should have come from the cache').toBe(1)

    await send('PATCH', `/api/assistant/providers/${id}`, { apiKey: REPLACEMENT })
    expect((await get(`/api/assistant/providers/${id}/balance`)).status).toBe(200)
    expect(calls, 'the new ring kept the old key’s balance').toBe(2)
  })
})

describe('a key the vendor refused a moment ago', () => {
  it('goes to the back of the ring and comes back when the cooldown passes', async () => {
    const response = await send('POST', '/api/assistant/providers', newProvider(`${FIRST}, ${SECOND}, ${THIRD}`))
    const id = (await response.json() as { provider: { id: string } }).provider.id
    const extras = await store.listProviderKeys(id)
    // The primary key has just been used, so the extras are what a rotating call would choose between.
    // Read the row after stamping it: pickProviderKey takes the provider's own snapshot, not a query.
    await store.markProviderKeyUsed(id, '')
    await store.recordProviderKeyError(extras[0]!.id, 'rate: too many requests')
    const record = await store.providerRecord(id)
    expect(record).not.toBeNull()
    const first = await store.pickProviderKey(record!)
    expect(first?.keyId).toBe(extras[1]!.id)
    // A cooldown is a window, not a ban: once it has passed the refused key is back in the rotation.
    sqlite.exec(`UPDATE chat_provider_keys SET updated_at = 1 WHERE id = '${extras[0]!.id}'`)
    const later = await store.pickProviderKey(record!)
    expect(later?.keyId).toBe(extras[0]!.id)
  })
})
