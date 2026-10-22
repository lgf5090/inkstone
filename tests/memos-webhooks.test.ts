// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_HEADER } from '../src/shared/constants'
import { MEMO_WEBHOOK_SECRET_PREFIX } from '../src/shared/memos/constants'
import type {
  Memo,
  MemoListResponse,
  MemoWebhook,
  MemoWebhookCreateResult,
} from '../src/shared/memos/types'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import type { AppBindings, Env } from '../src/worker/env'
import { decryptMemoWebhookSecret } from '../src/worker/lib/crypto'
import { fromBase64Url, toBase64, utf8 } from '../src/worker/lib/encoding'
import { errorResponse } from '../src/worker/lib/errors'
import {
  MEMO_WEBHOOK_TITLE_MAX_LENGTH,
  type MemoWebhookPayload,
} from '../src/worker/memos/webhooks'
import { memoListRoutes } from '../src/worker/routes/memos'
import { memoWebhookRoutes } from '../src/worker/routes/memos/webhooks'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER_ID = 'user-owner'
const OTHER_ID = 'user-other'
const SESSION_HEADER = 'X-Test-Session'
const DEFAULT_URL = 'https://hooks.example/receiver'
const ID_SHAPE = /^[0-9a-hjkmnp-tv-z]{26}$/
const SECRET_SHAPE = /^whsec_[A-Za-z0-9_-]{43}$/

const app = new Hono<AppBindings>()

app.onError((err, c) => errorResponse(c, err))
app.use('/api/*', async (c, next) => {
  const userId = c.req.header(SESSION_HEADER)
  if (userId === OWNER_ID || userId === OTHER_ID) c.set('userId', userId)
  await next()
})
app.route('/api/memos/webhooks', memoWebhookRoutes)
app.route('/api/memos', memoListRoutes)

const pending: Promise<unknown>[] = []
const ctx: ExecutionContext = {
  waitUntil(promise) {
    pending.push(promise)
  },
  passThroughOnException() {},
  props: {},
}

const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
const vaultStorage = new Map<string, unknown>()

let sqlite: DatabaseSync
let env: Env
let warn: ReturnType<typeof vi.spyOn>

interface StoredWebhook {
  id: string
  user_id: string
  title: string
  url: string
  secret_ciphertext: string
  created_at: number
  updated_at: number
}

interface DeliveryCall {
  url: string
  init: RequestInit
  body: string
  payload: MemoWebhookPayload
}

function fakeVaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) {
        return vaultStorage.get(key)
      },
      async put(key: string, value: unknown) {
        vaultStorage.set(key, value)
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return await fn()
    },
  } as unknown as DurableObjectState
}

function insertUser(id: string, username: string): void {
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'hash', ?, ?, '', 'owner', '{}', ?, ?)`,
  ).run(id, username, username, username, now, now)
}

function storedWebhook(id: string): StoredWebhook {
  return sqlite.prepare('SELECT * FROM memos_webhooks WHERE id = ?').get(id) as unknown as StoredWebhook
}

function webhookCount(): number {
  return Number((sqlite.prepare('SELECT COUNT(*) AS count FROM memos_webhooks').get() as { count: number }).count)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

interface CallOptions {
  userId?: string | null
  body?: unknown
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const userId = options.userId === undefined ? OWNER_ID : options.userId
  const headers: Record<string, string> = {}
  if (userId) headers[SESSION_HEADER] = userId
  if (method !== 'GET' && method !== 'HEAD') headers[CLIENT_HEADER] = '1'
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return await app.request(`http://localhost${path}`, { method, headers, body }, env, ctx)
}

async function createWebhook(
  userId: string = OWNER_ID,
  body: Record<string, unknown> = { title: 'Receiver', url: DEFAULT_URL },
): Promise<MemoWebhookCreateResult> {
  const response = await call('POST', '/api/memos/webhooks', { userId, body })
  expect(response.status, await response.clone().text()).toBe(201)
  return json<MemoWebhookCreateResult>(response)
}

async function listWebhooks(userId: string = OWNER_ID): Promise<MemoWebhook[]> {
  const response = await call('GET', '/api/memos/webhooks', { userId })
  expect(response.status).toBe(200)
  return (await json<{ webhooks: MemoWebhook[] }>(response)).webhooks
}

async function createMemo(body: Record<string, unknown>, userId: string = OWNER_ID): Promise<Memo> {
  const response = await call('POST', '/api/memos', { userId, body })
  expect(response.status).toBe(201)
  return json<Memo>(response)
}

async function flushWebhooks(): Promise<void> {
  await Promise.all(pending)
  pending.length = 0
}

function deliveryAt(index: number): DeliveryCall {
  const entry = fetchMock.mock.calls[index]
  expect(entry, `delivery ${index}`).toBeDefined()
  const [input, init] = entry!
  const body = String(init?.body ?? '')
  return {
    url: String(input),
    init: init ?? {},
    body,
    payload: JSON.parse(body) as MemoWebhookPayload,
  }
}

async function expectStandardSignature(secret: string, delivery: DeliveryCall): Promise<void> {
  const headers = delivery.init.headers as Record<string, string>
  const messageId = headers['webhook-id']!
  const timestamp = headers['webhook-timestamp']!
  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(secret.slice(MEMO_WEBHOOK_SECRET_PREFIX.length)) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    utf8(`${messageId}.${timestamp}.${delivery.body}`) as BufferSource,
  )
  expect(headers['webhook-signature']).toBe(`v1,${toBase64(signature)}`)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  insertUser(OWNER_ID, 'owner')
  insertUser(OTHER_ID, 'other')
  pending.length = 0
  vaultStorage.clear()
  env = testBindings(makeD1(sqlite), {
    DO_AUTH_KEY: 'test-internal-key',
    CREDENTIAL_VAULT: testDurableObjectNamespace(
      async (request) => await new CredentialVault(fakeVaultState(), env).fetch(request),
    ),
  })
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  vi.unstubAllGlobals()
})

describe('memo webhook management', () => {
  it('creates, lists, updates, and deletes a webhook without exposing the secret', async () => {
    const created = await createWebhook()
    const id = created.webhook.id
    expect(id).toMatch(ID_SHAPE)
    expect(created.signingSecret).toMatch(SECRET_SHAPE)
    expect(created.webhook).toMatchObject({
      title: 'Receiver',
      url: DEFAULT_URL,
      signingSecretSet: true,
    })
    expect(JSON.stringify(created.webhook)).not.toContain(created.signingSecret)

    const listed = await listWebhooks()
    expect(listed).toEqual([created.webhook])
    expect(JSON.stringify(listed)).not.toContain(created.signingSecret)

    const ciphertext = storedWebhook(id).secret_ciphertext
    const patched = await call('PATCH', `/api/memos/webhooks/${id}`, { body: { title: 'Renamed' } })
    expect(patched.status).toBe(200)
    const updated = await json<MemoWebhook>(patched)
    expect(updated).toMatchObject({
      id,
      title: 'Renamed',
      url: DEFAULT_URL,
      signingSecretSet: true,
      createdAt: created.webhook.createdAt,
    })
    expect(updated.updatedAt).toBeGreaterThan(created.webhook.updatedAt)
    expect(JSON.stringify(updated)).not.toContain(created.signingSecret)
    expect(storedWebhook(id).secret_ciphertext).toBe(ciphertext)

    const removed = await call('DELETE', `/api/memos/webhooks/${id}`)
    expect(removed.status).toBe(200)
    expect(await json(removed)).toEqual({ ok: true })
    expect(await listWebhooks()).toEqual([])
  })

  it('regenerates the signing secret once and keeps it out of later reads', async () => {
    const created = await createWebhook()
    const id = created.webhook.id
    const before = storedWebhook(id).secret_ciphertext

    const response = await call('POST', `/api/memos/webhooks/${id}/secret`)
    expect(response.status).toBe(200)
    const regenerated = await json<MemoWebhookCreateResult>(response)
    expect(regenerated.webhook.id).toBe(id)
    expect(regenerated.webhook.createdAt).toBe(created.webhook.createdAt)
    expect(regenerated.signingSecret).toMatch(SECRET_SHAPE)
    expect(regenerated.signingSecret).not.toBe(created.signingSecret)

    const after = storedWebhook(id).secret_ciphertext
    expect(after).not.toBe(before)
    await expect(decryptMemoWebhookSecret(env, id, after)).resolves.toBe(regenerated.signingSecret)
    expect(JSON.stringify(await listWebhooks())).not.toContain(regenerated.signingSecret)
  })

  it('stores the signing secret as vault ciphertext scoped to the webhook id', async () => {
    const created = await createWebhook()
    const row = storedWebhook(created.webhook.id)
    expect(row.secret_ciphertext).toMatch(/^v1\./)
    expect(row.secret_ciphertext).not.toContain(created.signingSecret)
    await expect(decryptMemoWebhookSecret(env, created.webhook.id, row.secret_ciphertext))
      .resolves.toBe(created.signingSecret)
  })

  it('validates the title and the target before storing anything', async () => {
    const bodies: Array<Record<string, unknown>> = [
      { url: DEFAULT_URL },
      { title: '', url: DEFAULT_URL },
      { title: '   ', url: DEFAULT_URL },
      { title: 'x'.repeat(MEMO_WEBHOOK_TITLE_MAX_LENGTH + 1), url: DEFAULT_URL },
      { title: 'Hook' },
      { title: 'Hook', url: 'not a url' },
      { title: 'Hook', url: 'ftp://hooks.example/receiver' },
      { title: 'Hook', url: 'https://user:password@hooks.example/receiver' },
      { title: 'Hook', url: 'http://127.0.0.1/receiver' },
      { title: 'Hook', url: 'http://hooks.example/receiver' },
      { title: 'Hook', url: 'http://169.254.169.254/latest/meta-data' },
    ]
    for (const body of bodies) {
      const response = await call('POST', '/api/memos/webhooks', { body })
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
    expect(webhookCount()).toBe(0)

    const created = await createWebhook()
    const invalid = await call('PATCH', `/api/memos/webhooks/${created.webhook.id}`, {
      body: { url: 'http://127.0.0.1/receiver' },
    })
    expect(invalid.status).toBe(400)
    const row = storedWebhook(created.webhook.id)
    expect(row.title).toBe('Receiver')
    expect(row.url).toBe(DEFAULT_URL)
  })

  it('scopes reads, updates, deletes, and secret regeneration to the owner', async () => {
    const created = await createWebhook(OWNER_ID)
    const id = created.webhook.id
    const ciphertext = storedWebhook(id).secret_ciphertext

    expect(await listWebhooks(OTHER_ID)).toEqual([])
    const attempts: Array<[string, string, unknown?]> = [
      ['PATCH', `/api/memos/webhooks/${id}`, { title: 'stolen' }],
      ['DELETE', `/api/memos/webhooks/${id}`],
      ['POST', `/api/memos/webhooks/${id}/secret`],
    ]
    for (const [method, path, body] of attempts) {
      const response = await call(method, path, { userId: OTHER_ID, body })
      expect(response.status, `${method} ${path}`).toBe(404)
    }
    expect(await listWebhooks(OWNER_ID)).toHaveLength(1)
    expect(storedWebhook(id).secret_ciphertext).toBe(ciphertext)
  })

  it('requires a signed-in user on every endpoint', async () => {
    const id = 'a'.repeat(26)
    const paths: Array<[string, string]> = [
      ['GET', '/api/memos/webhooks'],
      ['POST', '/api/memos/webhooks'],
      ['PATCH', `/api/memos/webhooks/${id}`],
      ['DELETE', `/api/memos/webhooks/${id}`],
      ['POST', `/api/memos/webhooks/${id}/secret`],
    ]
    for (const [method, path] of paths) {
      const response = await call(method, path, { userId: null, body: method === 'GET' ? undefined : {} })
      expect(response.status, `${method} ${path}`).toBe(401)
    }
  })
})

describe('memo webhook delivery', () => {
  it('signs and delivers the created activity with Standard Webhooks headers', async () => {
    const hook = await createWebhook()
    const memo = await createMemo({ content: 'first memo' })
    await flushWebhooks()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const delivery = deliveryAt(0)
    expect(delivery.url).toBe(DEFAULT_URL)
    expect(delivery.init).toMatchObject({ method: 'POST', redirect: 'manual' })

    const headers = delivery.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['webhook-id']).toMatch(/^msg_[A-Za-z0-9_-]{22}$/)
    expect(headers['webhook-timestamp']).toMatch(/^\d+$/)
    expect(Math.abs(Number(headers['webhook-timestamp']) - Math.floor(Date.now() / 1000)))
      .toBeLessThan(60)
    expect(headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/)

    expect(delivery.payload).toEqual({
      url: `http://localhost/memos/m/${memo.id}`,
      activityType: 'memos.memo.created',
      creator: expect.objectContaining({ id: OWNER_ID, username: 'owner' }),
      memo,
    })
    await expectStandardSignature(hook.signingSecret, delivery)
  })

  it('dispatches updated, comment, and deleted activities from the returned DTOs', async () => {
    const hook = await createWebhook()
    const memo = await createMemo({ content: 'root' })
    await flushWebhooks()

    const patched = await call('PATCH', `/api/memos/${memo.id}`, {
      body: { rev: memo.rev, content: 'root edited' },
    })
    expect(patched.status).toBe(200)
    const updated = await json<Memo>(patched)
    await flushWebhooks()

    const commented = await call('POST', `/api/memos/${memo.id}/comments`, {
      body: { content: 'reply' },
    })
    expect(commented.status).toBe(201)
    const comment = await json<Memo>(commented)
    await flushWebhooks()

    expect((await call('DELETE', `/api/memos/${memo.id}`)).status).toBe(200)
    await flushWebhooks()

    expect(fetchMock).toHaveBeenCalledTimes(4)
    const payloads = [0, 1, 2, 3].map((index) => deliveryAt(index).payload)
    expect(payloads.map((payload) => payload.activityType)).toEqual([
      'memos.memo.created',
      'memos.memo.updated',
      'memos.memo.comment.created',
      'memos.memo.deleted',
    ])
    expect(payloads[1]?.memo).toEqual(updated)
    expect(payloads[2]?.memo).toEqual(comment)
    expect(payloads[2]?.memo.parentId).toBe(memo.id)
    expect(payloads[3]?.memo.id).toBe(memo.id)
    expect(payloads[3]?.memo.rev).toBe(updated.rev)
    expect(payloads[3]?.url).toBe(`http://localhost/memos/m/${memo.id}`)
    await expectStandardSignature(hook.signingSecret, deliveryAt(0))
    await expectStandardSignature(hook.signingSecret, deliveryAt(3))
  })

  it('delivers only to the account that owns the memo and the webhook', async () => {
    await createWebhook(OWNER_ID)
    await createMemo({ content: 'another account' }, OTHER_ID)
    await flushWebhooks()
    expect(fetchMock).not.toHaveBeenCalled()

    const otherHook = await createWebhook(OTHER_ID, { title: 'Other', url: 'https://other.example/receiver' })
    await createMemo({ content: 'owner again' })
    await flushWebhooks()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(deliveryAt(0).url).toBe(DEFAULT_URL)

    await createMemo({ content: 'other again' }, OTHER_ID)
    await flushWebhooks()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(deliveryAt(1).url).toBe(otherHook.webhook.url)
  })

  it('does not follow redirects and reports the refusal once', async () => {
    const hook = await createWebhook()
    fetchMock.mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://elsewhere.example/' },
    }))

    const response = await call('POST', '/api/memos', { body: { content: 'redirected' } })
    expect(response.status).toBe(201)
    await flushWebhooks()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(deliveryAt(0).init.redirect).toBe('manual')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Memo webhook ${hook.webhook.id} delivery failed: 302`))
  })

  it('keeps the memo write successful when delivery fails', async () => {
    await createWebhook()
    fetchMock.mockRejectedValue(new Error('network down'))

    const response = await call('POST', '/api/memos', { body: { content: 'still saved' } })
    expect(response.status).toBe(201)
    await flushWebhooks()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('delivery failed: network down'))
    const listed = await call('GET', '/api/memos')
    expect((await json<MemoListResponse>(listed)).items).toHaveLength(1)
  })
})
