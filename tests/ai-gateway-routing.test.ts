/**
 * The per-account routing switches behind the relay's `/ai/v1` calls.
 *
 * The contract under test is the default: a missing row means direct, no gateway header and no
 * payload header. Only an explicit switch adds `cf-aig-gateway-id`, and payload collection is its own
 * opt-in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppBindings } from '../src/worker/env'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'
import { gatewayRoutes } from '../src/worker/routes/gateway'
import { createGatewayKey } from '../src/worker/cloudflare/ai-gateway-keys'
import {
  gatewayHeadersForAccount,
  gatewayRoutingHeaders,
  normalizeGatewayRouting,
  readGatewayRouting,
  saveGatewayRouting,
} from '../src/worker/cloudflare/ai-gateway-routing'
import {
  makeCloudflareBed,
  seedAccount,
  stubCloudflare,
  TEST_USER,
  type CloudflareTestBed,
} from './cloudflare-fixtures'

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

const ACCOUNT = 'e'.repeat(26)
const CF_ACCOUNT = 'f'.repeat(32)

let bed: CloudflareTestBed
let relay: Hono<AppBindings>

beforeEach(async () => {
  bed = await makeCloudflareBed()
  mocks.userId = TEST_USER
  relay = new Hono<AppBindings>()
  relay.route('/api/gateway', gatewayRoutes)
})

describe('routing settings', () => {
  it('defaults to off when no row exists', async () => {
    expect(await readGatewayRouting(bed.env, TEST_USER, ACCOUNT)).toEqual({
      enabled: false,
      gatewayId: '',
      collectLogPayload: false,
    })
    expect(await gatewayHeadersForAccount(bed.env, TEST_USER, ACCOUNT)).toEqual({})
  })

  it('stores the switches and forces payload collection off while routing is off', async () => {
    await saveGatewayRouting(bed.env, TEST_USER, ACCOUNT, {
      enabled: true,
      gatewayId: 'parity-panel-verify',
      collectLogPayload: true,
    })
    expect(await readGatewayRouting(bed.env, TEST_USER, ACCOUNT)).toEqual({
      enabled: true,
      gatewayId: 'parity-panel-verify',
      collectLogPayload: true,
    })

    await saveGatewayRouting(bed.env, TEST_USER, ACCOUNT, {
      enabled: false,
      gatewayId: 'parity-panel-verify',
      collectLogPayload: true,
    })
    expect(await readGatewayRouting(bed.env, TEST_USER, ACCOUNT)).toEqual({
      enabled: false,
      gatewayId: 'parity-panel-verify',
      collectLogPayload: false,
    })
  })

  it('requires a gateway id before routing can be enabled', () => {
    expect(() => normalizeGatewayRouting({ enabled: true, gatewayId: '  ' })).toThrow(/gateway id/)
    expect(() => normalizeGatewayRouting({ enabled: true, gatewayId: 'bad id with space' })).toThrow(/gateway id/)
  })

  it('only emits headers the switch names', () => {
    expect(gatewayRoutingHeaders({ enabled: false, gatewayId: 'g', collectLogPayload: true })).toEqual({})
    expect(gatewayRoutingHeaders({ enabled: true, gatewayId: 'g', collectLogPayload: false })).toEqual({
      'cf-aig-gateway-id': 'g',
    })
    expect(gatewayRoutingHeaders({ enabled: true, gatewayId: 'g', collectLogPayload: true })).toEqual({
      'cf-aig-gateway-id': 'g',
      'cf-aig-collect-log-payload': 'true',
    })
  })

  it('ships under migration 299', () => {
    const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === 299)
    expect(migration?.statements).toEqual([
      expect.stringMatching(/CREATE TABLE IF NOT EXISTS ai_gateway_routing\s+/),
    ])
  })
})

describe('routing API', () => {
  beforeEach(async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT, accountId: CF_ACCOUNT })
  })

  it('lists an account as off before anything was saved', async () => {
    const response = await bed.app.request('/api/cloudflare/ai-gateway/routing', {}, bed.env)
    expect(response.status).toBe(200)
    const body = await response.json() as { items: Array<Record<string, unknown>> }
    expect(body.items).toEqual([{
      accountId: ACCOUNT,
      accountName: 'Test account',
      enabled: false,
      gatewayId: '',
      collectLogPayload: false,
    }])
  })

  it('saves the switches and audits the change', async () => {
    const response = await bed.app.request(`/api/cloudflare/ai-gateway/routing/${ACCOUNT}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, gatewayId: 'parity-panel-verify', collectLogPayload: true }),
    }, bed.env)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      accountId: ACCOUNT,
      enabled: true,
      gatewayId: 'parity-panel-verify',
      collectLogPayload: true,
    })

    const rows = await bed.env.DB.prepare(
      'SELECT action, status FROM cloudflare_log WHERE action = ?1 ORDER BY created_at DESC',
    ).bind('ai_gateway_routing_update').all<{ action: string; status: string }>()
    expect(rows.results).toEqual([{ action: 'ai_gateway_routing_update', status: 'success' }])
  })

  it('rejects an enabled switch without a gateway id', async () => {
    const response = await bed.app.request(`/api/cloudflare/ai-gateway/routing/${ACCOUNT}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, gatewayId: '' }),
    }, bed.env)
    expect(response.status).toBe(400)
  })
})

describe('relay headers', () => {
  beforeEach(async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT, accountId: CF_ACCOUNT })
  })

  async function chat(): Promise<Response> {
    const created = await createGatewayKey(bed.env, TEST_USER, { name: 'routing test' })
    return relay.request('/api/gateway/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3', messages: [{ role: 'user', content: 'hello' }] }),
    }, bed.env)
  }

  it('sends no gateway header while the switch is off', async () => {
    let headers: Record<string, string> = {}
    stubCloudflare((_url, init) => {
      headers = init?.headers as Record<string, string>
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    })
    expect((await chat()).status).toBe(200)
    expect(headers['cf-aig-gateway-id']).toBeUndefined()
    expect(headers['cf-aig-collect-log-payload']).toBeUndefined()
  })

  it('adds the gateway header only after the switch is on', async () => {
    await saveGatewayRouting(bed.env, TEST_USER, ACCOUNT, {
      enabled: true,
      gatewayId: 'parity-panel-verify',
      collectLogPayload: false,
    })
    let headers: Record<string, string> = {}
    stubCloudflare((_url, init) => {
      headers = init?.headers as Record<string, string>
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    })
    expect((await chat()).status).toBe(200)
    expect(headers['cf-aig-gateway-id']).toBe('parity-panel-verify')
    expect(headers['cf-aig-collect-log-payload']).toBeUndefined()
  })

  it('adds the payload header only when its own switch is on', async () => {
    await saveGatewayRouting(bed.env, TEST_USER, ACCOUNT, {
      enabled: true,
      gatewayId: 'parity-panel-verify',
      collectLogPayload: true,
    })
    let headers: Record<string, string> = {}
    stubCloudflare((_url, init) => {
      headers = init?.headers as Record<string, string>
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    })
    expect((await chat()).status).toBe(200)
    expect(headers['cf-aig-gateway-id']).toBe('parity-panel-verify')
    expect(headers['cf-aig-collect-log-payload']).toBe('true')
  })
})
