/**
 * The read-only AI Gateway platform routes: list, logs, routing, billing and analytics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cfJson,
  makeCloudflareBed,
  readJson,
  seedAccount,
  stubCloudflare,
  TEST_USER,
  type CloudflareTestBed,
} from './cloudflare-fixtures'

const ACCOUNT = 'a'.repeat(26)
const CF_ACCOUNT = 'c'.repeat(32)
const GATEWAY = 'my-gateway'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

interface CfCall {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}

let bed: CloudflareTestBed
let calls: CfCall[]

function stubApi(handler: (call: CfCall) => Response | null | Promise<Response | null>): void {
  calls = []
  stubCloudflare(async (url, init) => {
    const call: CfCall = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace('/client/v4', ''),
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : init?.body,
    }
    calls.push(call)
    const custom = await handler(call)
    return custom ?? new Response('unexpected', { status: 404 })
  })
}

async function panelGet(path: string): Promise<Response> {
  const url = `/api/cloudflare/ai-gateway-platform/accounts${path}`
  return bed.app.request(url, {}, bed.env)
}

beforeEach(async () => {
  mocks.userId = TEST_USER
  bed = await makeCloudflareBed()
  await seedAccount(bed, TEST_USER, { id: ACCOUNT, token: 'token-a', accountId: CF_ACCOUNT })
})

describe('AI Gateway platform read routes', () => {
  it('lists gateways with pagination and search', async () => {
    stubApi(({ path, query }) => {
      if (path === `/accounts/${CF_ACCOUNT}/ai-gateway/gateways`) {
        expect(query.get('search')).toBe('prod')
        return Response.json({
          success: true,
          errors: [],
          result: [{
            id: GATEWAY,
            cache_invalidate_on_update: true,
            cache_ttl: 60,
            collect_logs: true,
            created_at: '2026-11-01T00:00:00Z',
            modified_at: '2026-11-02T00:00:00Z',
            rate_limiting_interval: 60,
            rate_limiting_limit: 120,
          }],
          result_info: { page: 2, per_page: 10, total_count: 1, total_pages: 1 },
        })
      }
      return null
    })
    const page = await readJson<{ items: Array<{ id: string }>; total: number }>(
      await panelGet(`/${ACCOUNT}/gateways?search=prod&page=2&perPage=10`),
    )
    expect(page.items[0]!.id).toBe(GATEWAY)
    expect(calls[0]!.query.get('page')).toBe('2')
    expect(calls[0]!.query.get('per_page')).toBe('10')
  })

  it('passes status, model, provider and time as log filters', async () => {
    stubApi(({ path, query }) => {
      if (path === `/accounts/${CF_ACCOUNT}/ai-gateway/gateways/${GATEWAY}/logs`) {
        expect(query.getAll('filters.key')).toEqual(['success', 'model', 'provider', 'created_at', 'created_at'])
        expect(query.getAll('filters.value')).toContain('false')
        return Response.json({
          success: true,
          errors: [],
          result: [{
            id: 'log-1',
            cached: false,
            created_at: '2026-11-01T00:00:00Z',
            duration: 120,
            model: '@cf/qwen/qwen3',
            path: '/chat',
            provider: 'workers-ai',
            success: false,
            tokens_in: 10,
            tokens_out: 20,
          }],
          result_info: { page: 1, per_page: 20, total_count: 1, total_pages: 1 },
        })
      }
      return null
    })
    const page = await readJson<{ items: Array<{ id: string }> }>(
      await panelGet(`/${ACCOUNT}/gateways/${GATEWAY}/logs?status=error&model=${encodeURIComponent('@cf/qwen/qwen3')}`
        + '&provider=workers-ai&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z'),
    )
    expect(page.items[0]!.id).toBe('log-1')
  })

  it('returns routing, provider configs, spending limit and the gateway URL', async () => {
    stubApi(({ path }) => {
      if (path.endsWith('/routes')) {
        return Response.json({ success: true, data: { routes: [{ id: 'route-1', name: 'primary' }], page: 1, per_page: 20, order_by: 'created_at', order_by_direction: 'desc' } })
      }
      if (path.endsWith('/provider_configs')) {
        return cfJson([{ id: 'pc-1', alias: 'openai-main', provider_slug: 'openai', secret_preview: 'sk-***', default_config: true, gateway_id: GATEWAY, secret_id: 's', modified_at: '2026-11-01T00:00:00Z' }])
      }
      if (path.endsWith('/billing/spending-limit')) {
        return cfJson({ enabled: true, config: { amount: 500, duration: 'monthly', strategy: 'fixed' } })
      }
      if (path.endsWith('/url/workers-ai')) {
        return cfJson(`https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT}/${GATEWAY}/workers-ai`)
      }
      return null
    })
    const routes = await readJson<{ items: Array<{ id: string }> }>(
      await panelGet(`/${ACCOUNT}/gateways/${GATEWAY}/routes`),
    )
    expect(routes.items[0]!.id).toBe('route-1')
    const providers = await readJson<{ items: Array<{ alias: string; secret_preview: string }> }>(
      await panelGet(`/${ACCOUNT}/gateways/${GATEWAY}/provider-configs`),
    )
    expect(providers.items[0]!.secret_preview).toBe('sk-***')
    const limit = await readJson<{ enabled: boolean; config: { amount: number } }>(
      await panelGet(`/${ACCOUNT}/billing/spending-limit`),
    )
    expect(limit.config.amount).toBe(500)
    const url = await readJson<{ url: string }>(
      await panelGet(`/${ACCOUNT}/gateways/${GATEWAY}/url/workers-ai`),
    )
    expect(url.url).toContain(`/v1/${CF_ACCOUNT}/${GATEWAY}/workers-ai`)
  })

  it('maps analytics totals and series', async () => {
    stubApi(({ path }) => {
      if (path === '/graphql') {
        return Response.json({
          data: {
            viewer: {
              accounts: [{
                totals: [{ count: 12, sum: { cost: 0.42, erroredRequests: 2, cachedTokensIn: 5, cachedTokensOut: 6, uncachedTokensIn: 7, uncachedTokensOut: 8 } }],
                series: [{ dimensions: { datetimeHour: '2026-11-01T01:00:00Z' }, count: 3, sum: { cost: 0.1, erroredRequests: 1 } }],
              }],
            },
          },
        })
      }
      return null
    })
    const analytics = await readJson<{ requests: number; errors: number; series: Array<{ label: string }> }>(
      await panelGet(`/${ACCOUNT}/gateways/${GATEWAY}/analytics?days=1`),
    )
    expect(analytics.requests).toBe(12)
    expect(analytics.errors).toBe(2)
    expect(analytics.series[0]!.label).toBe('2026-11-01T01:00:00Z')
    expect(calls[0]!.body).toMatchObject({ variables: { gateway: GATEWAY, accountTag: CF_ACCOUNT } })
  })

  it('truncates a very large log payload and keeps the byte count', async () => {
    stubApi(({ path }) => {
      if (path.endsWith('/logs/log-1/request')) {
        return new Response('x'.repeat(300 * 1024), { headers: { 'content-type': 'text/plain' } })
      }
      return null
    })
    const payload = await readJson<{ body: string; truncated: boolean; size: number }>(
      await panelGet(`/${ACCOUNT}/gateways/${GATEWAY}/logs/log-1/request`),
    )
    expect(payload.truncated).toBe(true)
    expect(payload.size).toBe(300 * 1024)
    expect(payload.body.endsWith('[truncated]')).toBe(true)
  })

  it('refuses a demo account instead of reading real gateways', async () => {
    await bed.env.DB.prepare(
      'INSERT INTO cloudflare_setting (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
    ).bind(TEST_USER, 'demo_account_ids', ACCOUNT, Date.now()).run()
    const response = await panelGet(`/${ACCOUNT}/gateways`)
    expect(response.status).toBe(403)
  })
})
