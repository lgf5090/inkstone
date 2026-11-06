// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cfJson,
  makeCloudflareBed,
  seedAccount,
  stubCloudflare,
  TEST_USER,
  type CloudflareTestBed,
} from './cloudflare-fixtures'

const ACCOUNT = 'a'.repeat(26)
const ZONE_ID = 'zone-a'
const CF_ACCOUNT = 'cf-a'

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
let calls: Array<{ method: string; path: string }>

function stubApi(handler?: (call: { method: string; path: string }) => Response | null): void {
  calls = []
  stubCloudflare(async (url, init) => {
    const method = init?.method ?? 'GET'
    const path = url.pathname.replace('/client/v4', '')
    const call = { method, path }
    calls.push(call)
    const custom = handler?.(call)
    if (custom) return custom
    if (method === 'GET' && path === `/zones/${ZONE_ID}`) {
      return cfJson({ id: ZONE_ID, name: 'alpha.example', account: { id: CF_ACCOUNT } })
    }
    return new Response('unexpected', { status: 404 })
  })
}

async function send(path: string): Promise<Response> {
  return bed.app.request(`/api/cloudflare/network/${ACCOUNT}${path}`, {}, bed.env)
}

beforeEach(async () => {
  mocks.userId = TEST_USER
  bed = await makeCloudflareBed()
  await seedAccount(bed, TEST_USER, { id: ACCOUNT, name: 'Alpha', token: 'token-a', accountId: CF_ACCOUNT })
})

afterEach(() => vi.unstubAllGlobals())

describe('load balancing reads', () => {
  it('maps account pools and monitors to the fields the table draws', async () => {
    stubApi(({ path }) => {
      if (path === `/accounts/${CF_ACCOUNT}/load_balancers/pools`) {
        return cfJson([{ id: 'pool-1', name: 'Primary', enabled: true, origins: [{ name: 'a' }, { name: 'b' }], monitor: 'mon-1' }])
      }
      if (path === `/accounts/${CF_ACCOUNT}/load_balancers/monitors`) {
        return cfJson([{ id: 'mon-1', description: 'HTTP check', type: 'http', method: 'GET', path: '/health', expected_codes: '200', interval: 60, timeout: 5, retries: 2 }])
      }
      return null
    })
    const pools = await send('/load-balancer/pools')
    expect(pools.status).toBe(200)
    expect(await pools.json()).toEqual({
      pools: [{ id: 'pool-1', name: 'Primary', enabled: true, originCount: 2, monitorId: 'mon-1', notificationEmail: '' }],
    })
    const monitors = await send('/load-balancer/monitors')
    expect(await monitors.json()).toEqual({
      monitors: [{ id: 'mon-1', description: 'HTTP check', type: 'http', method: 'GET', path: '/health', expectedCodes: '200', interval: 60, timeout: 5, retries: 2 }],
    })
  })

  it('lists zone load balancers only after proving the zone belongs to the account', async () => {
    stubApi(({ path }) => (
      path === `/zones/${ZONE_ID}/load_balancers`
        ? cfJson([{ id: 'lb-1', name: 'main', enabled: true, proxied: true, default_pools: ['pool-1'], fallback_pool: 'pool-2', steering_policy: 'off' }])
        : null
    ))
    const response = await send(`/load-balancer/zones/${ZONE_ID}/load-balancers`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      loadBalancers: [{ id: 'lb-1', name: 'main', enabled: true, proxied: true, defaultPools: ['pool-1'], fallbackPool: 'pool-2', steeringPolicy: 'off' }],
    })
  })
})

describe('bulk redirects reads', () => {
  it('turns an entitlement 403 into an explicit unsupported answer, not a success', async () => {
    stubApi(({ path }) => (
      path === `/accounts/${CF_ACCOUNT}/rules/lists`
        ? Response.json({ success: false, errors: [{ message: 'not entitled' }] }, { status: 403 })
        : null
    ))
    const response = await send('/bulk-redirect/lists')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ supported: false, lists: [], reason: 'not entitled' })
  })

  it('maps list items and forwards the cursor', async () => {
    stubApi(({ path }) => {
      if (path === `/accounts/${CF_ACCOUNT}/rules/lists`) {
        return cfJson([{ id: 'list-1', name: 'Redirects', kind: 'redirect', num_items: 2 }])
      }
      if (path === `/accounts/${CF_ACCOUNT}/rules/lists/list-1/items`) {
        return Response.json({
          success: true,
          errors: [],
          result: [{ id: 'item-1', redirect: { source_url: 'https://old.example/', target_url: 'https://new.example/', status_code: 301, preserve_query_string: true } }],
          result_info: { cursor: 'next' },
        })
      }
      return null
    })
    const lists = await send('/bulk-redirect/lists')
    expect(await lists.json()).toMatchObject({ supported: true, lists: [{ id: 'list-1', itemCount: 2 }] })
    const items = await send('/bulk-redirect/lists/list-1/items')
    expect(await items.json()).toEqual({
      items: [{ id: 'item-1', sourceUrl: 'https://old.example/', targetUrl: 'https://new.example/', statusCode: 301, preserveQueryString: true, includeSubdomains: false, enabled: true }],
      cursor: 'next',
    })
  })
})

describe('email routing and snippets reads', () => {
  it('returns settings, rules and destination addresses for a zone', async () => {
    stubApi(({ path }) => {
      if (path === `/zones/${ZONE_ID}/email/routing`) return cfJson({ enabled: false, status: 'unconfigured', name: 'alpha.example' })
      if (path === `/zones/${ZONE_ID}/email/routing/rules`) {
        return cfJson([{ id: 'rule-1', name: 'drop', enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] }])
      }
      if (path === `/accounts/${CF_ACCOUNT}/email/routing/addresses`) {
        return cfJson([{ id: 'addr-1', email: 'dest@example.com', verified: '2026-01-01' }])
      }
      return null
    })
    const response = await send(`/email-routing/${ZONE_ID}`)
    expect(response.status).toBe(200)
    const body = await response.json() as { settings: unknown; rules: unknown[]; addresses: unknown[] }
    expect(body.settings).toEqual({ enabled: false, status: 'unconfigured', name: 'alpha.example' })
    expect(body.rules).toHaveLength(1)
    expect(body.addresses).toEqual([{ id: 'addr-1', email: 'dest@example.com', verified: true, created: '' }])
  })

  it('treats a missing snippet rules entrypoint as an empty rule list, not an unsupported product', async () => {
    stubApi(({ path }) => {
      if (path === `/zones/${ZONE_ID}/snippets`) return cfJson([])
      if (path === `/zones/${ZONE_ID}/snippets/snippet_rules`) {
        return Response.json(
          { success: false, errors: [{ message: 'could not find entrypoint ruleset in the http_request_snippets phase' }] },
          { status: 404 },
        )
      }
      return null
    })
    const response = await send(`/snippets/${ZONE_ID}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ supported: true, snippets: [], rules: [] })
  })

  it('maps a snippet list row by its snippet_name, which the API uses instead of an id', async () => {
    stubApi(({ path }) => {
      if (path === `/zones/${ZONE_ID}/snippets`) {
        return cfJson([{ created_on: '2026-01-01T00:00:00Z', snippet_name: 'parity_write_test', modified_on: '2026-01-02T00:00:00Z' }])
      }
      if (path === `/zones/${ZONE_ID}/snippets/snippet_rules`) return cfJson([])
      return null
    })
    const body = await (await send(`/snippets/${ZONE_ID}`)).json() as { snippets: unknown[] }
    expect(body.snippets).toEqual([{
      id: 'parity_write_test',
      name: 'parity_write_test',
      createdOn: '2026-01-01T00:00:00Z',
      modifiedOn: '2026-01-02T00:00:00Z',
    }])
  })
})

async function sendWrite(path: string, method: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Inkstone-Client': '1',
      'X-Inkstone-Origin': 'test',
    },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  return bed.app.request(`/api/cloudflare/network/${ACCOUNT}${path}`, init, bed.env)
}

async function auditActions(): Promise<string[]> {
  const rows = await bed.env.DB.prepare(
    'SELECT action FROM cloudflare_log WHERE user_id = ? ORDER BY rowid ASC',
  ).bind(TEST_USER).all<{ action: string }>()
  return (rows.results ?? []).map((row) => row.action)
}

describe('network writes', () => {
  it('creates and deletes a pool and a monitor', async () => {
    stubApi(({ method, path }) => {
      if (method === 'POST' && path === `/accounts/${CF_ACCOUNT}/load_balancers/pools`) {
        return cfJson({ id: 'pool-1', name: 'parity_pool', enabled: true, origins: [{ name: 'origin-1' }] })
      }
      if (method === 'POST' && path === `/accounts/${CF_ACCOUNT}/load_balancers/monitors`) {
        return cfJson({
          id: 'mon-1',
          description: 'parity monitor',
          type: 'http',
          method: 'GET',
          path: '/',
          expected_codes: '200',
          interval: 1,
          timeout: 5,
          retries: 0,
        })
      }
      if (method === 'DELETE' && path === `/accounts/${CF_ACCOUNT}/load_balancers/pools/pool-1`) return cfJson({})
      if (method === 'DELETE' && path === `/accounts/${CF_ACCOUNT}/load_balancers/monitors/mon-1`) return cfJson({})
      return null
    })

    const pool = await sendWrite('/load-balancer/pools', 'POST', { name: 'parity_pool', address: 'example.com' })
    expect(pool.status).toBe(201)
    expect(await pool.json()).toMatchObject({ id: 'pool-1', name: 'parity_pool', originCount: 1 })
    const monitor = await sendWrite('/load-balancer/monitors', 'POST', {
      description: 'parity monitor',
      type: 'http',
      method: 'GET',
      path: '/',
      expectedCodes: '200',
      interval: 1,
      timeout: 5,
      retries: 0,
    })
    expect(monitor.status).toBe(201)
    expect(await monitor.json()).toMatchObject({ id: 'mon-1', description: 'parity monitor' })
    expect((await sendWrite('/load-balancer/pools/pool-1', 'DELETE')).status).toBe(200)
    expect((await sendWrite('/load-balancer/monitors/mon-1', 'DELETE')).status).toBe(200)
    expect(await auditActions()).toEqual(expect.arrayContaining([
      'create_lb_pool',
      'delete_lb_pool',
      'create_lb_monitor',
      'delete_lb_monitor',
    ]))
  })

  it('creates a redirect list and sends list items as the bare array the API expects', async () => {
    let itemBody: unknown = null
    stubCloudflare(async (url, init) => {
      const method = init?.method ?? 'GET'
      const path = url.pathname.replace('/client/v4', '')
      if (method === 'POST' && path === `/accounts/${CF_ACCOUNT}/rules/lists`) {
        return cfJson({ id: 'list-1', name: 'parity list', kind: 'redirect', num_items: 0 })
      }
      if (method === 'POST' && path === `/accounts/${CF_ACCOUNT}/rules/lists/list-1/items`) {
        itemBody = JSON.parse(init?.body as string) as unknown
        return cfJson({ operation_id: 'op-1' })
      }
      if (method === 'DELETE' && path === `/accounts/${CF_ACCOUNT}/rules/lists/list-1`) return cfJson({})
      if (method === 'GET' && path === `/zones/${ZONE_ID}`) {
        return cfJson({ id: ZONE_ID, name: 'alpha.example', account: { id: CF_ACCOUNT } })
      }
      return new Response('unexpected', { status: 404 })
    })

    const list = await sendWrite('/bulk-redirect/lists', 'POST', { name: 'parity list' })
    expect(list.status).toBe(201)
    expect(await list.json()).toMatchObject({ id: 'list-1', name: 'parity list' })
    const item = await sendWrite('/bulk-redirect/lists/list-1/items', 'POST', {
      sourceUrl: 'https://old.example/',
      targetUrl: 'https://new.example/',
      statusCode: 301,
      preserveQueryString: true,
      includeSubdomains: false,
    })
    expect(item.status).toBe(201)
    expect(Array.isArray(itemBody)).toBe(true)
    expect((itemBody as Array<{ redirect: Record<string, unknown> }>)[0]?.redirect).toMatchObject({
      source_url: 'https://old.example/',
      target_url: 'https://new.example/',
      status_code: 301,
      preserve_query_string: true,
    })
    expect((await sendWrite('/bulk-redirect/lists/list-1', 'DELETE')).status).toBe(200)
    expect(await auditActions()).toEqual(expect.arrayContaining([
      'create_bulk_list',
      'create_bulk_item',
      'delete_bulk_list',
    ]))
  })

  it('creates an email rule and destination, then deletes both', async () => {
    stubApi(({ method, path }) => {
      if (method === 'POST' && path === `/zones/${ZONE_ID}/email/routing/rules`) {
        return cfJson({
          id: 'rule-1',
          name: 'parity rule',
          enabled: true,
          matchers: [{ type: 'literal', field: 'to', value: 'parity@example.com' }],
          actions: [{ type: 'drop', value: [] }],
        })
      }
      if (method === 'DELETE' && path === `/zones/${ZONE_ID}/email/routing/rules/rule-1`) return cfJson({})
      if (method === 'POST' && path === `/accounts/${CF_ACCOUNT}/email/routing/addresses`) {
        return cfJson({ id: 'addr-1', email: 'parity@example.com', verified: null, created: '2026-01-01T00:00:00Z' })
      }
      if (method === 'DELETE' && path === `/accounts/${CF_ACCOUNT}/email/routing/addresses/addr-1`) return cfJson({})
      return null
    })

    const rule = await sendWrite(`/email-routing/${ZONE_ID}/rules`, 'POST', {
      name: 'parity rule',
      recipient: 'parity@example.com',
      action: 'drop',
    })
    expect(rule.status).toBe(201)
    expect(await rule.json()).toMatchObject({ id: 'rule-1', name: 'parity rule', enabled: true })
    const address = await sendWrite('/email-routing/addresses', 'POST', { email: 'parity@example.com' })
    expect(address.status).toBe(201)
    expect(await address.json()).toMatchObject({ id: 'addr-1', email: 'parity@example.com', verified: false })
    expect((await sendWrite(`/email-routing/${ZONE_ID}/rules/rule-1`, 'DELETE')).status).toBe(200)
    expect((await sendWrite('/email-routing/addresses/addr-1', 'DELETE')).status).toBe(200)
    expect(await auditActions()).toEqual(expect.arrayContaining([
      'create_email_rule',
      'delete_email_rule',
      'create_email_address',
      'delete_email_address',
    ]))
  })

  it('uploads a snippet as multipart and deletes it with its rule gone first', async () => {
    stubApi(({ method, path }) => {
      if (method === 'PUT' && path === `/zones/${ZONE_ID}/snippets/parity_write_test`) return cfJson({})
      if (method === 'GET' && path === `/zones/${ZONE_ID}/snippets/snippet_rules`) {
        return cfJson([{ id: 'rule-1', snippet_name: 'parity_write_test', expression: 'true', enabled: true }])
      }
      if (method === 'PUT' && path === `/zones/${ZONE_ID}/snippets/snippet_rules`) return cfJson([])
      if (method === 'DELETE' && path === `/zones/${ZONE_ID}/snippets/parity_write_test`) return cfJson({})
      return null
    })

    const created = await sendWrite(`/snippets/${ZONE_ID}`, 'POST', {
      name: 'parity_write_test',
      content: 'export default { async fetch(request) { return fetch(request) } }',
      expression: 'http.request.uri.path eq "/parity"',
    })
    expect(created.status).toBe(201)
    const deleted = await sendWrite(`/snippets/${ZONE_ID}/parity_write_test`, 'DELETE')
    expect(deleted.status).toBe(200)
    expect(await auditActions()).toEqual(expect.arrayContaining(['create_snippet', 'delete_snippet']))
  })
})
