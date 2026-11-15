// @vitest-environment node
/**
 * The request log as a screen can drive it: filtered pages, one row's details, annotations, deletion,
 * cleanup previews and the statistics behind the same slice.
 *
 * The reference project keeps a request record and its attempts apart; this app writes one line per
 * attempt and ties the chain together with a conversation id and an attempt number. What matters is the
 * same: a reader must be able to find the one line that failed, say why, and keep the table bounded.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
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

type Log = {
  id: string, at: number, providerId: string, modelLabel: string, modelId: string,
  conversationId: string, attempt: number, ok: boolean, note: string, starred: boolean,
  errorKind: string | null, latencyMs: number | null, inputTokens: number,
}
type Page = { logs: Log[], total: number, page: number, pageSize: number }

async function write(over: Partial<Parameters<AssistantStore['recordRequestLog']>[0]> = {}): Promise<string> {
  return await store.recordRequestLog({
    providerId: 'p1', providerLabel: 'Example', keyId: 'k1', keyLabel: 'second', keyHint: '4321',
    modelLabel: 'example-model', operation: 'chat', ok: true, httpStatus: 200,
    inputTokens: 10, outputTokens: 5, latencyMs: 120,
    conversationId: 'c1', modelId: 'example-model', attempt: 1, ...over,
  })
}

function insertOld(at: number, over: { ok?: number, starred?: number, providerId?: string } = {}): string {
  const id = `old-${Math.random().toString(36).slice(2, 10)}`
  sqlite.prepare(`INSERT INTO chat_request_logs
    (user_id, id, at, provider_id, provider_label, key_id, key_label, key_hint, model_label,
     operation, ok, input_tokens, output_tokens, cached_input_tokens, starred)
    VALUES (?, ?, ?, ?, 'Example', 'k1', 'second', '4321', 'example-model', 'chat', ?, 1, 1, 0, ?)`)
    .run(USER, id, at, over.providerId ?? 'p1', over.ok ?? 1, over.starred ?? 0)
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

describe('reading and filtering the log', () => {
  it('carries the attempt context and answers a page with its total', async () => {
    const first = await write()
    await write({ ok: false, httpStatus: 401, errorKind: 'auth', errorMessage: 'bad key', attempt: 2, providerId: 'p2', modelLabel: 'other-model', modelId: 'other-model' })
    await write({ providerId: 'p2', modelLabel: 'third-model' })

    const all = await call<Page>('GET', '/api/assistant/logs')
    expect(all.status).toBe(200)
    expect(all.value.total).toBe(3)
    expect(all.value.pageSize).toBeGreaterThan(0)
    expect(all.value.logs[0]?.conversationId).toBe('c1')

    const one = await call<{ entry: Log }>('GET', `/api/assistant/logs/${first}`)
    expect(one.value.entry.modelId).toBe('example-model')
    expect(one.value.entry.attempt).toBe(1)
    expect(one.value.entry.note).toBe('')
    expect(one.value.entry.starred).toBe(false)
  })

  it('narrows by text, status, provider, model and page', async () => {
    await write({ ok: true })
    await write({ ok: false, errorKind: 'auth', errorMessage: 'refused', providerId: 'p2', modelLabel: 'other-model' })
    await write({ ok: true, providerId: 'p2', modelLabel: 'third-model' })

    expect((await call<Page>('GET', '/api/assistant/logs?q=refused')).value.total).toBe(1)
    expect((await call<Page>('GET', '/api/assistant/logs?status=failed')).value.total).toBe(1)
    expect((await call<Page>('GET', '/api/assistant/logs?providerId=p2')).value.total).toBe(2)
    expect((await call<Page>('GET', '/api/assistant/logs?model=other-model')).value.total).toBe(1)
    const page = (await call<Page>('GET', '/api/assistant/logs?pageSize=2&page=2')).value
    expect(page.logs).toHaveLength(1)
    expect(page.total).toBe(3)
  })

  it('sorts by a column and goes back to its own newest-first order', async () => {
    await write({ latencyMs: 300 })
    await write({ latencyMs: 100 })
    await write({ latencyMs: 200 })

    const descending = (await call<Page>('GET', '/api/assistant/logs?sortBy=latency&sortDir=desc')).value
    expect(descending.logs.map((row) => row.latencyMs)).toEqual([300, 200, 100])
    const ascending = (await call<Page>('GET', '/api/assistant/logs?sortBy=latency&sortDir=asc')).value
    expect(ascending.logs.map((row) => row.latencyMs)).toEqual([100, 200, 300])
    const natural = (await call<Page>('GET', '/api/assistant/logs?sortBy=latency&sortDir=none')).value
    expect(natural.logs.map((row) => row.latencyMs)).not.toEqual([300, 200, 100])
    const unknown = (await call<Page>('GET', '/api/assistant/logs?sortBy=nonsense&sortDir=desc')).value
    expect(unknown.total).toBe(3)
  })

  it('offers facets drawn from the rows the account has', async () => {
    await write({ ok: false, errorKind: 'rate' })
    const facets = (await call<{ providers: unknown[], models: string[], errorKinds: string[] }>(
      'GET', '/api/assistant/logs/facets',
    )).value
    expect(facets.providers).toHaveLength(1)
    expect(facets.models).toContain('example-model')
    expect(facets.errorKinds).toContain('rate')
  })
})

describe('writing on a log line', () => {
  it('annotates, stars and deletes, including a batch of ids', async () => {
    const first = await write()
    const second = await write({ ok: false, errorKind: 'auth' })

    const patched = await call<{ entry: Log }>('PATCH', `/api/assistant/logs/${first}`, { note: 'check the key', starred: true })
    expect(patched.value.entry.note).toBe('check the key')
    expect(patched.value.entry.starred).toBe(true)
    expect((await call<Page>('GET', '/api/assistant/logs?starred=1')).value.total).toBe(1)

    // A starred row means "keep it": a batch no longer deletes one unless the caller says so.
    const removed = await call<{ deleted: number }>('POST', '/api/assistant/logs/delete', { ids: [first, second] })
    expect(removed.value.deleted).toBe(1)
    expect((await call<Page>('GET', '/api/assistant/logs?starred=1')).value.total).toBe(1)
    const forced = await call<{ deleted: number }>('POST', '/api/assistant/logs/delete', { ids: [first], includeStarred: true })
    expect(forced.value.deleted).toBe(1)
    expect((await call<Page>('GET', '/api/assistant/logs')).value.total).toBe(0)
    expect((await call<{ deleted: number }>('POST', '/api/assistant/logs/delete', { ids: [] })).status).toBe(400)
  })

  it('refuses a clear with no scope and keeps starred rows even for all=1', async () => {
    await write()
    await call<{ entry: Log }>('PATCH', `/api/assistant/logs/${(await call<Page>('GET', '/api/assistant/logs')).value.logs[0]!.id}`, { starred: true })
    expect((await call('DELETE', '/api/assistant/logs')).status).toBe(400)
    const cleared = await call<{ deleted: number }>('DELETE', '/api/assistant/logs?all=1')
    expect(cleared.value.deleted).toBe(0)
    expect((await call<Page>('GET', '/api/assistant/logs')).value.total).toBe(1)
    const forced = await call<{ deleted: number }>('DELETE', '/api/assistant/logs?all=1&includeStarred=1')
    expect(forced.value.deleted).toBe(1)
  })

  it('refuses a row that belongs to nobody', async () => {
    expect((await call('GET', '/api/assistant/logs/missing')).status).toBe(404)
  })
})

describe('cleaning the log up', () => {
  it('previews by age and count and keeps starred rows when applied', async () => {
    // The standing rules are off so the manual cleanup is the only thing that removes a row here.
    await store.saveSettings({ ...(await store.getSettings()), logRetentionDays: 0, logMaxRows: 0 })
    insertOld(Date.now() - 10 * DAY)
    insertOld(Date.now() - 10 * DAY, { starred: 1 })
    await write()

    const preview = await call<{ matched: number, deleted: number }>('POST', '/api/assistant/logs/cleanup', { days: 7, rows: 0, dryRun: true })
    expect(preview.status, JSON.stringify(preview.value)).toBe(200)
    expect(preview.value.matched).toBe(1)
    expect(preview.value.deleted).toBe(0)

    const applied = await call<{ matched: number, deleted: number }>('POST', '/api/assistant/logs/cleanup', { days: 7, rows: 0, dryRun: false })
    expect(applied.value.deleted).toBe(1)
    expect((await call<Page>('GET', '/api/assistant/logs')).value.total).toBe(2)
    expect((await call<Page>('GET', '/api/assistant/logs?starred=1')).value.total).toBe(1)
  })

  it('takes only the status the reader named, and needs at least one rule', async () => {
    insertOld(Date.now() - 10 * DAY, { ok: 1 })
    insertOld(Date.now() - 10 * DAY, { ok: 0 })
    expect((await call('POST', '/api/assistant/logs/cleanup', { days: 7, rows: 0, dryRun: true })).status).toBe(200)
    const failed = (await call<{ matched: number }>('POST', '/api/assistant/logs/cleanup?status=failed', { days: 7, rows: 0, dryRun: true })).value
    expect(failed.matched).toBe(1)
    expect((await call('POST', '/api/assistant/logs/cleanup', { days: 0, rows: 0 })).status).toBe(400)
  })

  it('applies the standing retention and row ceiling on the next write', async () => {
    await store.saveSettings({
      ...(await store.getSettings()), logRetentionDays: 1, logMaxRows: 2, logCleanupStatus: 'all',
    })
    insertOld(Date.now() - 5 * DAY)
    await write()
    await write()
    await write()
    const rows = sqlite.prepare('SELECT COUNT(*) AS total FROM chat_request_logs').get() as { total: number }
    expect(rows.total).toBe(2)
  })

  it('leaves starred rows out of the standing row ceiling', async () => {
    await store.saveSettings({ ...(await store.getSettings()), logRetentionDays: 0, logMaxRows: 1 })
    insertOld(Date.now() - 1000, { starred: 1 })
    await write()
    await write()
    const starred = sqlite.prepare('SELECT COUNT(*) AS total FROM chat_request_logs WHERE starred = 1').get() as { total: number }
    expect(starred.total).toBe(1)
  })
})

describe('statistics over a filtered slice', () => {
  it('reports totals, a trend and a ranking by the chosen dimension', async () => {
    await write({ ok: true, inputTokens: 100, outputTokens: 20, latencyMs: 100 })
    await write({ ok: false, errorKind: 'auth', latencyMs: 300, providerId: 'p2', modelLabel: 'other-model' })
    await write({ ok: true, latencyMs: 200, providerId: 'p2', modelLabel: 'other-model' })

    const report = (await call<{
      summary: { requests: number, succeeded: number, failed: number, successRate: number, p95LatencyMs: number | null },
      series: Array<{ at: number, requests: number }>,
      breakdown: Array<{ id: string, requests: number, failed: number }>,
    }>('GET', '/api/assistant/stats/requests?dimension=provider')).value
    expect(report.summary.requests).toBe(3)
    expect(report.summary.succeeded).toBe(2)
    expect(report.summary.failed).toBe(1)
    expect(report.summary.successRate).toBeCloseTo(2 / 3)
    expect(report.summary.p95LatencyMs).not.toBeNull()
    expect(report.series.length).toBeGreaterThan(0)
    expect(report.breakdown.find((row) => row.id === 'p2')?.requests).toBe(2)

    const byModel = (await call<{ breakdown: Array<{ id: string, requests: number }> }>(
      'GET', '/api/assistant/stats/requests?dimension=model&status=failed',
    )).value
    expect(byModel.breakdown).toHaveLength(1)
    expect(byModel.breakdown[0]?.id).toBe('other-model')
  })
})
