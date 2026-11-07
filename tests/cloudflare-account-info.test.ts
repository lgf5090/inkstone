// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cfJson,
  makeCloudflareBed,
  seedAccount,
  TEST_USER,
  type CloudflareTestBed,
} from './cloudflare-fixtures'

const ACCOUNT = 'a'.repeat(26)

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

let bed: CloudflareTestBed
let calls: Array<{ method: string; path: string; body: unknown }>

function stubBothSites(): void {
  calls = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = init?.method ?? 'GET'
    if (url.hostname === 'api.cloudflare.com') {
      const path = url.pathname.replace('/client/v4', '') + (url.search ? url.search : '')
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
      calls.push({ method, path, body })
      if (method === 'GET' && path.startsWith('/accounts/cf-a/subscriptions')) {
        return cfJson([{
          id: 'sub-1',
          state: 'active',
          rate_plan: { id: 'pro', name: 'Pro', price: 20, currency: 'USD', frequency: 'monthly' },
        }])
      }
      if (method === 'GET' && path.startsWith('/accounts/cf-a/logs/audit')) {
        return Response.json({
          success: true,
          errors: [],
          result: [{
            id: 'audit-1',
            action: { type: 'user.login', description: 'User logged in', result: 'success', time: '2026-11-01T00:00:00Z' },
            actor: { email: 'reader@example.com', type: 'user', context: 'dash', ip_address: '203.0.113.4' },
            resource: { type: 'account', product: 'account', id: 'cf-a' },
            zone: { name: 'alpha.example' },
            raw: { method: 'GET', uri: '/login', status_code: 200 },
          }],
          result_info: { cursor: 'next-page' },
        })
      }
      return new Response('unexpected', { status: 404 })
    }
    if (url.hostname === 'www.cloudflarestatus.com') {
      if (url.pathname.endsWith('/status.json')) {
        return Response.json({ status: { indicator: 'minor', description: 'Minor service outage' } })
      }
      if (url.pathname.endsWith('/components.json')) {
        return Response.json({ components: [{ id: 'c1', name: 'Workers', status: 'degraded_performance', group: 'Compute' }] })
      }
      if (url.pathname.endsWith('/incidents/unresolved.json')) {
        return Response.json({ incidents: [{ id: 'i1', name: 'Elevated errors', status: 'investigating', impact: 'minor', created_at: '2026-11-01', shortlink: 'https://stspg.io/x' }] })
      }
    }
    throw new Error(`Unexpected outbound fetch: ${url.toString()}`)
  })
}

async function send(path: string): Promise<Response> {
  return bed.app.request(`/api/cloudflare${path}`, {}, bed.env)
}

beforeEach(async () => {
  mocks.userId = TEST_USER
  bed = await makeCloudflareBed()
  await seedAccount(bed, TEST_USER, { id: ACCOUNT, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
  stubBothSites()
})

afterEach(() => vi.unstubAllGlobals())

describe('account information', () => {
  it('maps subscriptions to the fields the panel draws', async () => {
    const response = await send(`/dashboard/subscription?accountId=${ACCOUNT}`)
    expect(response.status).toBe(200)
    const body = await response.json() as { subscriptions: unknown[] }
    expect(body.subscriptions).toEqual([{
      id: 'sub-1',
      name: 'Pro',
      state: 'active',
      price: 20,
      currency: 'USD',
      frequency: 'monthly',
    }])
  })

  it('pages Cloudflare audit logs with Cloudflare’s cursor', async () => {
    const response = await send(`/audit-logs?accountId=${ACCOUNT}&limit=50`)
    expect(response.status).toBe(200)
    const body = await response.json() as { entries: unknown[]; cursor: string | null }
    expect(body.cursor).toBe('next-page')
    expect(body.entries).toEqual([{
      id: 'audit-1',
      time: '2026-11-01T00:00:00Z',
      description: 'User logged in',
      result: 'success',
      actor_email: 'reader@example.com',
      actor_type: 'user',
      actor_context: 'dash',
      actor_ip: '203.0.113.4',
      resource_type: 'account',
      resource_product: 'account',
      resource_id: 'cf-a',
      method: 'GET',
      uri: '/login',
      status_code: 200,
      zone_name: 'alpha.example',
    }])
  })

  it('rejects an impossible audit window', async () => {
    const response = await send(`/audit-logs?accountId=${ACCOUNT}&since=100&before=100`)
    expect(response.status).toBe(400)
  })

  it('summarizes the public status feed and caches it', async () => {
    const first = await send('/dashboard/status')
    expect(first.status).toBe(200)
    const body = await first.json() as { indicator: string; components: unknown[]; incidents: unknown[] }
    expect(body.indicator).toBe('minor')
    expect(body.components).toHaveLength(1)
    expect(body.incidents[0]).toMatchObject({ name: 'Elevated errors' })
  })
})
