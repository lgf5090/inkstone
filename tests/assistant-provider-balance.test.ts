// @vitest-environment node
/**
 * What a provider says about what it is owed, and what may be said about a key.
 *
 * A reader with a ring of three keys has three wallets. The settings screen showed none of them, and the
 * obvious way to fix that — ask whichever address the reader typed — is a way to send somebody's credential
 * to a host they never chose. So this feature is a table of vendors keyed by their own host, and everything
 * below is one of three questions: does the request go where the row says and nowhere else, does the number
 * come out of the field the vendor actually uses, and does the answer stop being a credential the moment it
 * leaves the server.
 *
 * The shapes are read off a working client of each endpoint rather than off the vendors' own references, so
 * these cases pin the row, not the vendor: if a vendor moves a field, the row changes and the assertion here
 * changes with it. What must not change is that an unknown address is never asked.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import { fetchProviderBalance } from '../src/worker/assistant/balance'
import { BALANCE_SPECS, balanceFromPayload, balanceSpecFor, pickPath } from '../src/shared/provider-balance'
import type { BalanceSpec } from '../src/shared/provider-balance'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'

/** A test token, in the shape a vendor issues. Nothing here is a credential anybody holds. */
const KEY = 'sk-test-0000000000000000abcd'
const SECOND = 'sk-test-0000000000000000wxyz'

const specOf = (host: string): BalanceSpec => {
  const found = balanceSpecFor(`https://${host}/v1`)
  if (!found) throw new Error(`no balance row for ${host}`)
  return found
}

/** One outbound request as the stub saw it. */
interface Sent {
  url: string
  method: string
  headers: Record<string, string>
}

/**
 * A wire that answers with one payload, or with one status.
 *
 * Each case gets its own call log, and the isolate's memory of a reading is sidestepped by a distinct cache
 * key — the readings themselves are asserted through what came back, not by asking twice.
 */
function stubWire(answer: { status?: number, body?: unknown, redirect?: boolean } = {}): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: { method?: string, headers?: Record<string, string> }) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    sent.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> })
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (answer.redirect) return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.test/' } })
    if (answer.status && answer.status !== 200) return new Response(JSON.stringify({ error: 'no' }), { status: answer.status, headers })
    // A string body is what a vendor answers when it answers with HTML: valid bytes, no payload.
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}), { status: 200, headers })
  }))
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('which provider may be asked', () => {
  it('answers for the vendor host and for nothing that merely ends like one', () => {
    expect(balanceSpecFor('https://api.deepseek.com/v1')?.path).toBe('/user/balance')
    // A relay that happens to be named after a vendor is not that vendor: this is the line that decides
    // whether somebody's key leaves for an address they never pointed it at.
    expect(balanceSpecFor('https://api.deepseek.com.example.test/v1')).toBeNull()
    expect(balanceSpecFor('https://attacker.test/@api.deepseek.com')).toBeNull()
    expect(balanceSpecFor('not a url')).toBeNull()
    expect(balanceSpecFor('https://API.DeepSeek.com/v1')?.host).toBe('api.deepseek.com')
  })

  it('lists only vendors a plain API key can ask', () => {
    // Presence here is a claim that a key answers this question. Anthropic, OpenAI and Gemini report a
    // balance only to an OAuth session, and Volcengine to a separate signed pair — none of which the reader
    // has stored, so none of which belongs in the table.
    expect(BALANCE_SPECS.map((spec) => spec.host)).toEqual([
      'api.deepseek.com',
      'openrouter.ai',
      'api.siliconflow.cn',
      'api.siliconflow.com',
      'api.stepfun.com',
      'api.novita.ai',
    ])
  })
})

describe('the number inside a vendor’s answer', () => {
  it('reaches into a list, and takes the currency the vendor names', () => {
    const deepseek = specOf('api.deepseek.com')
    expect(balanceFromPayload(deepseek, {
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '12.50' }],
    })).toEqual({ amount: 12.5, currency: 'USD' })
    // The same product answers in its own currency by default, and a zero is a balance, not an absence.
    expect(balanceFromPayload(deepseek, { balance_infos: [{ total_balance: 0 }] })).toEqual({ amount: 0, currency: 'CNY' })
  })

  it('subtracts what a credits vendor reports as spent', () => {
    const openrouter = specOf('openrouter.ai')
    expect(balanceFromPayload(openrouter, { data: { total_credits: 26.4, total_usage: 6.4 } }))
      .toEqual({ amount: 20, currency: 'USD' })
    // Only one of the two terms is not a balance: a number invented from half a subtraction would be worse
    // than saying nothing.
    expect(balanceFromPayload(openrouter, { data: { total_credits: 26.4 } })).toBeNull()
  })

  it('divides a vendor whose unit is not money, and reads either nesting', () => {
    const novita = specOf('api.novita.ai')
    expect(balanceFromPayload(novita, { data: { availableBalance: 12_345_000 } })).toEqual({ amount: 1234.5, currency: 'USD' })
    expect(balanceFromPayload(novita, { availableBalance: 50_000 })).toEqual({ amount: 5, currency: 'USD' })
  })

  it('tells the two siliconflow hosts apart by currency alone', () => {
    const payload = { data: { totalBalance: 3 } }
    expect(balanceFromPayload(specOf('api.siliconflow.cn'), payload)).toEqual({ amount: 3, currency: 'CNY' })
    expect(balanceFromPayload(specOf('api.siliconflow.com'), payload)).toEqual({ amount: 3, currency: 'USD' })
  })

  it('refuses to turn a word into money', () => {
    const stepfun = specOf('api.stepfun.com')
    expect(balanceFromPayload(stepfun, { data: { balance: 'unlimited' } })).toBeNull()
    expect(balanceFromPayload(stepfun, { data: { balance: '1,000' } })).toBeNull()
    expect(balanceFromPayload(stepfun, 'the vendor answered with a sentence')).toBeNull()
    expect(pickPath({ a: [{ b: 1 }] }, 'a.0.b')).toBe(1)
    expect(pickPath({ a: [] }, 'a.0.b')).toBeNull()
  })
})

describe('the request a balance is asked with', () => {
  it('asks the vendor’s own origin, never the path the reader’s address carried', async () => {
    const sent = stubWire({ body: { balance_infos: [{ total_balance: '7.25', currency: 'CNY' }] } })
    const reading = await fetchProviderBalance(specOf('api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions', KEY, 'k-origin')
    expect(reading).toEqual({ ok: true, amount: 7.25, currency: 'CNY' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://api.deepseek.com/user/balance')
    expect(sent[0]!.method).toBe('GET')
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    // The credential is in the header and nowhere else: a token on the query string lands in access logs.
    expect(sent[0]!.url).not.toContain(KEY)
  })

  it('remembers a reading for a while, so opening the panel twice asks once', async () => {
    const sent = stubWire({ body: { data: { total_credits: 10, total_usage: 4 } } })
    const row = 'same-key-row'
    expect(await fetchProviderBalance(specOf('openrouter.ai'), 'https://openrouter.ai/api/v1', KEY, row))
      .toEqual({ ok: true, amount: 6, currency: 'USD' })
    expect(await fetchProviderBalance(specOf('openrouter.ai'), 'https://openrouter.ai/api/v1', KEY, row))
      .toEqual({ ok: true, amount: 6, currency: 'USD' })
    expect(sent, 'the second look asked the vendor again').toHaveLength(1)
    // A different row is a different wallet, and must be asked for its own number.
    await fetchProviderBalance(specOf('openrouter.ai'), 'https://openrouter.ai/api/v1', SECOND, 'other-row')
    expect(sent).toHaveLength(2)
  })

  it('names a refusal for what it is, and keeps the four kinds apart', async () => {
    const spec = specOf('api.stepfun.com')
    const base = 'https://api.stepfun.com/v1'
    stubWire({ status: 401 })
    expect(await fetchProviderBalance(spec, base, KEY, 'r-401')).toEqual({ ok: false, reason: 'unauthorized' })
    stubWire({ status: 404 })
    expect(await fetchProviderBalance(spec, base, KEY, 'r-404')).toEqual({ ok: false, reason: 'unsupported' })
    stubWire({ status: 429 })
    expect(await fetchProviderBalance(spec, base, KEY, 'r-429')).toEqual({ ok: false, reason: 'unreachable' })
    stubWire({ body: '<html>a login page, not a balance</html>' })
    expect(await fetchProviderBalance(spec, base, KEY, 'r-html')).toEqual({ ok: false, reason: 'unreadable' })
    stubWire({ body: { nothing: 'the field we asked for' } })
    expect(await fetchProviderBalance(spec, base, KEY, 'r-empty')).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('will not follow a redirect, and does not call a vendor without a key to call with', async () => {
    const spec = specOf('api.novita.ai')
    const sent = stubWire({ redirect: true })
    expect(await fetchProviderBalance(spec, 'https://api.novita.ai/v3', KEY, 'r-302')).toEqual({ ok: false, reason: 'unsupported' })
    expect(sent, 'the redirect was followed').toHaveLength(1)
    const quiet = stubWire({ body: {} })
    expect(await fetchProviderBalance(spec, 'https://api.novita.ai/v3', '   ', 'r-blank')).toEqual({ ok: false, reason: 'unauthorized' })
    expect(quiet, 'an empty key still reached the vendor').toHaveLength(0)
  })
})

describe('the balance route', () => {
  let env: Env
  let store: AssistantStore
  let app: Hono<AppBindings>

  /** The vault's storage, held the way the platform holds it: one map per instance, not per request. */
  const vaultStorage = new Map<string, unknown>()

  function fakeVaultState(): DurableObjectState {
    return {
      storage: {
        async get(key: string) { return vaultStorage.get(key) },
        async put(key: string, value: unknown) { vaultStorage.set(key, value) },
      },
      async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> { return await fn() },
    } as unknown as DurableObjectState
  }

  async function call<T>(path: string): Promise<T> {
    const response = await app.fetch(new Request(`http://localhost${path}`, { method: 'GET' }), env, {} as ExecutionContext)
    expect(response.status, await response.clone().text()).toBe(200)
    return await response.json() as T
  }

  interface Reading {
    keyId: string
    label: string
    keyHint: string
    ok: boolean
    amount?: number
    currency?: string
    reason?: string
  }

  beforeEach(async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(SCHEMA_STATEMENTS.join(';'))
    vaultStorage.clear()
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

  it('answers one reading per stored key, named by the row it belongs to', async () => {
    stubWire({ body: { balance_infos: [{ total_balance: '3.5', currency: 'CNY' }] } })
    const provider = await store.createProvider({ label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY })
    const extra = await store.createProviderKey(provider.id, { label: 'Work', apiKey: SECOND })
    const answer = await call<{ supported: boolean, readings: Reading[] }>(`/api/assistant/providers/${provider.id}/balance`)
    expect(answer.supported).toBe(true)
    // The provider's own key is one of the ring, so it is read as one: an empty id, and the screen's word for it.
    expect(answer.readings.map((entry) => entry.keyId)).toEqual(['', extra.id])
    expect(answer.readings.map((entry) => entry.label)).toEqual(['', 'Work'])
    expect(answer.readings.every((entry) => entry.ok && entry.amount === 3.5)).toBe(true)
    // Each row carries its own last four characters, which is what lets a tooltip say whose money this is.
    expect(answer.readings.map((entry) => entry.keyHint)).toEqual([KEY.slice(-4), SECOND.slice(-4)])
  })

  it('asks nothing of a relay whose address is not a vendor, and says so', async () => {
    const sent = stubWire({ body: { total_balance: 1 } })
    const provider = await store.createProvider({ label: 'My relay', protocol: 'openai', baseUrl: 'https://relay.example.test/v1', apiKey: KEY })
    const answer = await call<{ supported: boolean, readings: unknown[] }>(`/api/assistant/providers/${provider.id}/balance`)
    expect(answer).toEqual({ supported: false, readings: [] })
    expect(sent, 'a key was sent to an address the table does not know').toHaveLength(0)
  })

  it('keeps the credential out of the answer, in either direction', async () => {
    stubWire({ body: { balance_infos: [{ total_balance: '9', currency: 'CNY' }] } })
    const provider = await store.createProvider({ label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY })
    await store.createProviderKey(provider.id, { label: '', apiKey: SECOND })
    const response = await app.fetch(new Request(`http://localhost/api/assistant/providers/${provider.id}/balance`, { method: 'GET' }), env, {} as ExecutionContext)
    const text = await response.text()
    expect(response.status).toBe(200)
    // The whole of what a browser may learn about a stored key: that it exists, and its last four.
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(SECOND)
    expect(text).not.toContain('ciphertext')
    expect(text).toContain(KEY.slice(-4))
    expect(text).toContain(SECOND.slice(-4))
  })

  it('leaves a key the reader switched off out of the asking', async () => {
    const sent = stubWire({ body: { balance_infos: [{ total_balance: '1', currency: 'CNY' }] } })
    const provider = await store.createProvider({ label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: '' })
    const off = await store.createProviderKey(provider.id, { label: 'Retired', apiKey: SECOND })
    const on = await store.createProviderKey(provider.id, { label: 'Live', apiKey: `${KEY}ef` })
    await store.updateProviderKey(off.id, { enabled: false })
    const answer = await call<{ readings: Reading[] }>(`/api/assistant/providers/${provider.id}/balance`)
    // A disabled row is not asked, and so is not shown as a failure either: the reader switched it off, and
    // the ring is not using it. `on.id` is the only row left standing.
    expect(answer.readings.map((entry) => entry.keyId)).toEqual([on.id])
    expect(sent).toHaveLength(1)
  })

  it('reports a provider nobody owns as missing rather than as empty', async () => {
    const response = await app.fetch(new Request('http://localhost/api/assistant/providers/000000000000000000000000a/balance', { method: 'GET' }), env, {} as ExecutionContext)
    expect(response.status).toBe(404)
  })
})
