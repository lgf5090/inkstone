// @vitest-environment node
/**
 * The contracts added in the third audit round: single-use reveal tickets, the independent security
 * audit trail, atomic throttles, safe log deletion, filter-scoped cleanup previews, log-only key
 * statistics, aggregate cache invalidation and the DNS-rebinding host guard.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import { assertRelayableEndpoint } from '../src/shared/ai-proxy-guard'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const PROVIDER_ID = 'p'.repeat(26)
const DAY = 86_400_000

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let app: Hono<AppBindings>

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number, value: T }> {
  const response = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {} as ExecutionContext)
  return { status: response.status, value: await response.json() as T }
}

function provider(): void {
  sqlite.prepare(`INSERT INTO chat_providers
    (user_id, id, label, protocol, base_url, endpoints, reasoning_dialect, key_ciphertext, key_hint, sticky, created_at, updated_at)
    VALUES (?, ?, 'Vendor', 'openai', 'https://api.test', '{}', '', '', '', 1, 1, 1)`).run(USER, PROVIDER_ID)
}

function log(over: { ok?: number, starred?: number, providerId?: string, at?: number } = {}): string {
  const id = `log-${Math.random().toString(36).slice(2, 12)}`
  sqlite.prepare(`INSERT INTO chat_request_logs
    (user_id, id, at, provider_id, provider_label, key_id, key_label, key_hint, model_label,
     operation, ok, input_tokens, output_tokens, cached_input_tokens, starred)
    VALUES (?, ?, ?, ?, 'Vendor', 'k1', 'first', '1111', 'model', 'chat', ?, 4, 2, 0, ?)`)
    .run(USER, id, over.at ?? Date.now(), over.providerId ?? PROVIDER_ID, over.ok ?? 1, over.starred ?? 0)
  return id
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite))
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

describe('one-time reveal tickets', () => {
  it('redeems once, refuses a second use and refuses another session', async () => {
    provider()
    const issued = await store.issueRevealTicket(PROVIDER_ID, '', 'session-a')
    expect(issued.ticket.length).toBeGreaterThan(20)
    expect(issued.expiresAt).toBeGreaterThan(Date.now())
    expect(await store.redeemRevealTicket(issued.ticket, PROVIDER_ID, '', 'session-a')).toBe(true)
    expect(await store.redeemRevealTicket(issued.ticket, PROVIDER_ID, '', 'session-a')).toBe(false)

    const other = await store.issueRevealTicket(PROVIDER_ID, '', 'session-a')
    expect(await store.redeemRevealTicket(other.ticket, PROVIDER_ID, '', 'session-b')).toBe(false)
    expect(await store.redeemRevealTicket(other.ticket, 'w'.repeat(26), '', 'session-a')).toBe(false)
  })

  it('issues a ticket over HTTP and refuses an invented one', async () => {
    provider()
    const issued = await call<{ ticket: string }>('POST', `/api/assistant/providers/${PROVIDER_ID}/reveal-ticket`, {})
    expect(issued.status).toBe(200)
    expect(issued.value.ticket).toBeTruthy()
    const denied = await call('POST', `/api/assistant/providers/${PROVIDER_ID}/reveal`, { ticket: 'not-a-ticket' })
    expect(denied.status).toBe(400)
  })
})

describe('the security audit trail and throttles', () => {
  it('keeps the session, address and agent on a disclosure line outside the capped feed', async () => {
    await store.recordSecurityAudit('key.revealed', 'Vendor ····1111', {
      sessionId: 'session-a', ip: 'hashed-address', userAgent: 'QA Browser',
    })
    const events = await store.listSecurityAudit()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'key.revealed', sessionId: 'session-a', ip: 'hashed-address', userAgent: 'QA Browser',
    })
    const viaHttp = await call<{ events: unknown[] }>('GET', '/api/assistant/security-audit')
    expect(viaHttp.value.events).toHaveLength(1)
  })

  it('counts one window atomically and refuses the request past the limit', async () => {
    expect(await store.consumeRateLimit('unit', 2, 60_000)).toBe(true)
    expect(await store.consumeRateLimit('unit', 2, 60_000)).toBe(true)
    expect(await store.consumeRateLimit('unit', 2, 60_000)).toBe(false)
    expect(await store.consumeRateLimit('another', 2, 60_000)).toBe(true)
  })

  it('refuses wildcard-DNS hosts that resolve an arbitrary address from the name', () => {
    expect(() => assertRelayableEndpoint('https://127.0.0.1.nip.io/v1')).toThrow()
    expect(() => assertRelayableEndpoint('https://api.deepseek.com/v1')).not.toThrow()
  })
})

describe('log deletion and cleanup boundaries', () => {
  it('needs an explicit scope and keeps starred rows by default', async () => {
    const first = log({ starred: 1 })
    log()
    expect((await call('DELETE', '/api/assistant/logs')).status).toBe(400)
    expect(await store.deleteRequestLogs({ all: true })).toBe(1)
    expect(await store.deleteRequestLogs({ id: first, includeStarred: true })).toBe(1)
    expect((await call<{ total: number }>('GET', '/api/assistant/logs')).value.total).toBe(0)
  })

  it('ranks the "keep N" rule inside the current filters and reuses the preview clock', async () => {
    log({ providerId: 'p1', at: Date.now() - 3 * DAY })
    log({ providerId: 'p1', at: Date.now() - 2 * DAY })
    log({ providerId: 'p2', at: Date.now() - DAY })
    const preview = await store.cleanupRequestLogs({ rows: 1, providerId: 'p1', dryRun: true })
    expect(preview.matched).toBe(1)
    expect(preview.cutoff).toBeGreaterThan(0)
    const applied = await store.cleanupRequestLogs({ rows: 1, providerId: 'p1', cutoff: preview.cutoff })
    expect(applied.cutoff).toBe(preview.cutoff)
    expect((await call<{ total: number }>('GET', '/api/assistant/logs')).value.total).toBe(2)
  })
})

describe('statistics over a log with no rollup rows', () => {
  it('reports a key whose only evidence is an attempt', async () => {
    log({ ok: 0 })
    const rows = await store.keyStats({ scope: 'all' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ requests: 1, failed: 1, succeeded: 0 })
    // The log row supplies the label too: a key with no rollup is still a named key.
    const perKey = await store.keyStats({ scope: 'key' })
    expect(perKey[0]).toMatchObject({ requests: 1, label: 'first' })
  })

  it('invalidates its short-lived aggregate as soon as another attempt lands', async () => {
    log()
    const first = await store.logStats({ dimension: 'provider' })
    expect(first.summary.requests).toBe(1)
    log()
    const second = await store.logStats({ dimension: 'provider' })
    expect(second.summary.requests).toBe(2)
  })
})
