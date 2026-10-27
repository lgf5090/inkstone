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

const OTHER_USER = 'o'.repeat(26)
const ACCOUNT_A = 'a'.repeat(26)
const ACCOUNT_B = 'b'.repeat(26)
const ACCOUNT_C = 'c'.repeat(26)

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
  token: string
  body: unknown
}

let bed: CloudflareTestBed
let calls: CfCall[]

function zone(id: string, name: string, status = 'active') {
  return {
    id,
    name,
    status,
    paused: false,
    name_servers: [`ns1.${name}`, `ns2.${name}`],
    original_name_servers: [],
    created_on: '2026-01-01T00:00:00Z',
    modified_on: '2026-01-02T00:00:00Z',
  }
}

interface StubOptions {
  zones?: Record<string, unknown[]>
  handler?: (call: CfCall) => Response | null | Promise<Response | null>
}

function stubApi(options: StubOptions = {}): void {
  calls = []
  stubCloudflare(async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const token = (headers.Authorization ?? '').replace(/^Bearer /, '')
    const method = init?.method ?? 'GET'
    const path = url.pathname.replace('/client/v4', '')
    const rawBody = init?.body
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined
    const call = { method, path, token, body }
    calls.push(call)
    const custom = await options.handler?.(call)
    if (custom) return custom
    if (method === 'GET' && path === '/zones') {
      return cfJson(options.zones?.[token] ?? [])
    }
    return new Response('unexpected', { status: 404 })
  })
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return bed.app.request(`/api/cloudflare/dns${path}`, init, bed.env)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function auditActions(): Promise<string[]> {
  const rows = await bed.env.DB.prepare(
    'SELECT action FROM cloudflare_log WHERE user_id = ? ORDER BY rowid ASC',
  ).bind(TEST_USER).all<{ action: string }>()
  return (rows.results ?? []).map((row) => row.action)
}

beforeEach(async () => {
  mocks.userId = TEST_USER
  bed = await makeCloudflareBed()
})

afterEach(() => vi.unstubAllGlobals())

describe('the DNS zone list', () => {
  it('aggregates every DNS account and keeps the others when one fails', async () => {
    const a = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    const b = await seedAccount(bed, TEST_USER, { id: ACCOUNT_B, name: 'Beta', token: 'token-b', accountId: 'cf-b' })
    stubApi({
      zones: { 'token-b': [zone('zone-b', 'beta.com', 'pending')] },
      handler: ({ token, path }) => (
        token === 'token-a' && path === '/zones'
          ? Response.json({ success: false, errors: [{ message: 'token revoked' }] }, { status: 401 })
          : null
      ),
    })

    const response = await send('GET', '/domains')
    expect(response.status).toBe(200)
    const body = await json<{
      domains: Array<{ name: string; status: string; cfAccountId: string; accountName: string }>
      accounts: Array<{ id: string; name: string; canCreateZone: boolean }>
    }>(response)
    expect(body.domains).toHaveLength(1)
    expect(body.domains[0]).toMatchObject({
      name: 'beta.com',
      status: 'pending',
      cfAccountId: b.id,
      accountName: 'Beta',
    })
    expect(body.accounts.map((account) => account.id).sort()).toEqual([a.id, b.id].sort())
    expect(body.accounts.every((account) => account.canCreateZone)).toBe(true)
  })

  it('never lists another reader’s zones', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    await seedAccount(bed, OTHER_USER, { id: ACCOUNT_C, name: 'Theirs', token: 'token-c', accountId: 'cf-c' })
    stubApi({
      zones: {
        'token-a': [zone('zone-a', 'alpha.com')],
        'token-c': [zone('zone-c', 'secret.com')],
      },
    })

    const body = await json<{ domains: Array<{ name: string }> }>(await send('GET', '/domains'))
    expect(body.domains.map((item) => item.name)).toEqual(['alpha.com'])
    expect(calls.every((call) => call.token !== 'token-c')).toBe(true)
  })
})

describe('domain resolution', () => {
  it('uses the account that owns the domain for record calls', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_B, name: 'Beta', token: 'token-b', accountId: 'cf-b' })
    stubApi({
      zones: {
        'token-a': [zone('zone-a', 'alpha.com')],
        'token-b': [zone('zone-b', 'beta.com')],
      },
      handler: ({ path }) => (
        path === '/zones/zone-b/dns_records'
          ? cfJson([{ id: 'rec-1', type: 'A', name: 'www.beta.com', content: '203.0.113.1', ttl: 120, proxied: true }])
          : null
      ),
    })

    const response = await send('GET', '/domains/beta.com/records')
    expect(response.status).toBe(200)
    const records = await json<Array<{ id: string; proxied: boolean }>>(response)
    expect(records).toEqual([{ id: 'rec-1', type: 'A', name: 'www.beta.com', content: '203.0.113.1', ttl: 120, proxied: true }])
    const recordCall = calls.find((call) => call.path === '/zones/zone-b/dns_records')
    expect(recordCall?.token).toBe('token-b')
    expect(calls.some((call) => call.path === '/zones/zone-a/dns_records')).toBe(false)
  })

  it('answers 404 for a domain no account of this reader owns', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    await seedAccount(bed, OTHER_USER, { id: ACCOUNT_C, name: 'Theirs', token: 'token-c', accountId: 'cf-c' })
    stubApi({
      zones: {
        'token-a': [zone('zone-a', 'alpha.com')],
        'token-c': [zone('zone-c', 'secret.com')],
      },
    })

    const response = await send('GET', '/domains/secret.com/records')
    expect(response.status).toBe(404)
    expect(calls.some((call) => call.token === 'token-c')).toBe(false)
  })
})

describe('DNS records', () => {
  async function seedZones(): Promise<void> {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    stubApi({ zones: { 'token-a': [zone('zone-a', 'alpha.com')] } })
  }

  it('creates a record with the validated body and audits it', async () => {
    await seedZones()
    stubApi({
      zones: { 'token-a': [zone('zone-a', 'alpha.com')] },
      handler: ({ method, path }) => (
        method === 'POST' && path === '/zones/zone-a/dns_records'
          ? cfJson({ id: 'rec-1', type: 'A', name: 'www', content: '203.0.113.10', ttl: 120, proxied: true })
          : null
      ),
    })

    const response = await send('POST', '/domains/alpha.com/records', {
      type: 'A',
      name: 'www',
      content: '203.0.113.10',
      ttl: 120,
      proxied: true,
    })
    expect(response.status).toBe(201)
    expect(await json(response)).toMatchObject({ id: 'rec-1', type: 'A', name: 'www', proxied: true })
    const create = calls.find((call) => call.method === 'POST' && call.path === '/zones/zone-a/dns_records')
    expect(create?.body).toEqual({ type: 'A', name: 'www', content: '203.0.113.10', ttl: 120, proxied: true })
    expect(await auditActions()).toEqual(['create_dns'])
  })

  it('rejects malformed records before calling Cloudflare', async () => {
    await seedZones()
    const base = { type: 'A', name: 'www', content: '203.0.113.10', ttl: 120 }
    const cases: Array<Record<string, unknown>> = [
      { ...base, type: 'ALIAS' },
      { ...base, content: '999.1.1.1' },
      { ...base, ttl: 30 },
      { ...base, type: 'TXT', proxied: true },
      { ...base, name: 'bad name' },
    ]
    for (const body of cases) {
      const response = await send('POST', '/domains/alpha.com/records', body)
      expect(response.status).toBe(400)
    }
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it('updates with PATCH, deletes, and audits both', async () => {
    await seedZones()
    stubApi({
      zones: { 'token-a': [zone('zone-a', 'alpha.com')] },
      handler: ({ method, path }) => {
        if (method === 'PATCH' && path === '/zones/zone-a/dns_records/rec-1') {
          return cfJson({ id: 'rec-1', type: 'A', name: 'www', content: '203.0.113.11', ttl: 300, proxied: false })
        }
        if (method === 'DELETE' && path === '/zones/zone-a/dns_records/rec-1') {
          return cfJson({ id: 'rec-1' })
        }
        return null
      },
    })

    const updated = await send('PUT', '/domains/alpha.com/records/rec-1', {
      type: 'A',
      name: 'www',
      content: '203.0.113.11',
      ttl: 300,
      proxied: false,
    })
    expect(updated.status).toBe(200)
    const patch = calls.find((call) => call.method === 'PATCH')
    expect(patch?.path).toBe('/zones/zone-a/dns_records/rec-1')

    const deleted = await send('DELETE', '/domains/alpha.com/records/rec-1')
    expect(deleted.status).toBe(200)
    expect(await json(deleted)).toEqual({ id: 'rec-1' })
    expect(await auditActions()).toEqual(['update_dns', 'delete_dns'])
  })

  it('toggles the proxy with a boolean record id body', async () => {
    await seedZones()
    stubApi({
      zones: { 'token-a': [zone('zone-a', 'alpha.com')] },
      handler: ({ method, path }) => (
        method === 'PATCH' && path === '/zones/zone-a/dns_records/rec-1'
          ? cfJson({ id: 'rec-1' })
          : null
      ),
    })

    const response = await send('PATCH', '/domains/alpha.com/proxy', { record_id: 'rec-1', proxied: false })
    expect(response.status).toBe(200)
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ proxied: false })

    const invalid = await send('PATCH', '/domains/alpha.com/proxy', { proxied: true })
    expect(invalid.status).toBe(400)
  })
})

describe('zone settings, cache and status', () => {
  async function seedZone(): Promise<void> {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
  }

  it('reads the whitelisted settings and patches only known keys', async () => {
    await seedZone()
    stubApi({
      zones: { 'token-a': [zone('zone-a', 'alpha.com')] },
      handler: ({ method, path }) => {
        if (method === 'GET' && path === '/zones/zone-a/settings') {
          return cfJson([
            { id: 'ssl', value: 'full' },
            { id: 'zero_rtt', value: 'on' },
            { id: 'unrelated', value: 1 },
          ])
        }
        if (method === 'PATCH' && path === '/zones/zone-a/settings/ssl') return cfJson({ id: 'ssl', value: 'strict' })
        return null
      },
    })

    const settings = await json<Record<string, unknown>>(await send('GET', '/domains/alpha.com/settings'))
    expect(settings).toEqual({ ssl: 'full', zero_rtt: 'on' })

    const patched = await send('PATCH', '/domains/alpha.com/settings', { ssl: 'strict' })
    expect(patched.status).toBe(200)
    expect(await json(patched)).toEqual({ updated: ['ssl'], failed: [] })
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ value: 'strict' })

    expect((await send('PATCH', '/domains/alpha.com/settings', { nope: true })).status).toBe(400)
    expect((await send('PATCH', '/domains/alpha.com/settings', { ssl: 'full_strict' })).status).toBe(400)
  })

  it('purges everything or a URL list, and rejects an ambiguous body', async () => {
    await seedZone()
    stubApi({
      zones: { 'token-a': [zone('zone-a', 'alpha.com')] },
      handler: ({ method, path }) => (
        method === 'POST' && path === '/zones/zone-a/purge_cache' ? cfJson({ id: 'purge-1' }) : null
      ),
    })

    expect((await send('POST', '/domains/alpha.com/purge-cache', { purge_everything: true })).status).toBe(200)
    expect(calls.filter((call) => call.path === '/zones/zone-a/purge_cache')[0]?.body).toEqual({ purge_everything: true })

    const byUrl = await send('POST', '/domains/alpha.com/purge-cache', { files: ['https://alpha.com/app.css'] })
    expect(byUrl.status).toBe(200)
    expect(calls.filter((call) => call.path === '/zones/zone-a/purge_cache')[1]?.body).toEqual({
      files: ['https://alpha.com/app.css'],
    })

    expect((await send('POST', '/domains/alpha.com/purge-cache', {
      purge_everything: true,
      files: ['https://alpha.com/a.css'],
    })).status).toBe(400)
    expect((await send('POST', '/domains/alpha.com/purge-cache', { files: ['not a url'] })).status).toBe(400)
    expect((await send('POST', '/domains/alpha.com/purge-cache', { files: [] })).status).toBe(400)
    expect(await auditActions()).toEqual(['purge_cache', 'purge_cache'])
  })

  it('pauses a zone with a boolean flag', async () => {
    await seedZone()
    stubApi({
      zones: { 'token-a': [zone('zone-a', 'alpha.com')] },
      handler: ({ method, path }) => (
        method === 'PATCH' && path === '/zones/zone-a' ? cfJson({ id: 'zone-a' }) : null
      ),
    })

    const response = await send('PATCH', '/domains/alpha.com/status', { paused: true })
    expect(response.status).toBe(200)
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ paused: true })
    expect((await send('PATCH', '/domains/alpha.com/status', { paused: 'yes' })).status).toBe(400)
    expect(await auditActions()).toEqual(['update_zone_status'])
  })
})

describe('zone creation and deletion', () => {
  it('creates full and partial zones and deletes them', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    stubApi({
      zones: { 'token-a': [zone('zone-a', 'alpha.com')] },
      handler: ({ method, path }) => {
        if (method === 'POST' && path === '/zones') {
          return cfJson({ id: 'zone-new', name_servers: ['ns1.new.com'] })
        }
        if (method === 'DELETE' && path === '/zones/zone-a') return cfJson({ id: 'zone-a' })
        return null
      },
    })

    const created = await send('POST', '/domains', {
      names: ['new.com', 'new.com', 'other.com'],
      account_id: ACCOUNT_A,
      type: 'partial',
    })
    expect(created.status).toBe(201)
    const createdBody = await json<{ total: number; succeeded: number; results: Array<{ name_servers?: string[] }> }>(created)
    expect(createdBody).toMatchObject({ total: 2, succeeded: 2 })
    expect(createdBody.results[0]?.name_servers).toEqual(['ns1.new.com'])
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      name: 'new.com',
      account: { id: 'cf-a' },
      type: 'partial',
    })

    const deleted = await send('DELETE', '/domains', { domains: ['alpha.com'] })
    expect(await json(deleted)).toMatchObject({ total: 1, succeeded: 1 })
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/zones/zone-a')).toBe(true)
    expect(await auditActions()).toEqual(['create_zone', 'delete_zone'])
  })

  it('refuses another reader’s account and an account without the DNS feature', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_B, name: 'AI only', token: 'token-b', accountId: 'cf-b', features: 'ai' })
    await seedAccount(bed, OTHER_USER, { id: ACCOUNT_C, name: 'Theirs', token: 'token-c', accountId: 'cf-c' })
    stubApi({})

    expect((await send('POST', '/domains', { names: ['new.com'], account_id: ACCOUNT_C })).status).toBe(404)
    expect((await send('POST', '/domains', { names: ['new.com'], account_id: ACCOUNT_B })).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('rulesets', () => {
  async function seedZone(): Promise<void> {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
  }

  it('rejects a phase outside the whitelist without touching Cloudflare', async () => {
    await seedZone()
    stubApi({ zones: { 'token-a': [zone('zone-a', 'alpha.com')] } })

    const response = await send('GET', '/domains/alpha.com/rules/http_request_origin')
    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('reads and creates rules in zone-level phases', async () => {
    await seedZone()
    stubApi({
      zones: { 'token-a': [zone('zone-a', 'alpha.com')] },
      handler: ({ method, path, body }) => {
        if (method === 'GET' && path === '/zones/zone-a/rulesets') {
          return cfJson([{ id: 'rs-origin', phase: 'http_request_origin' }])
        }
        if (method === 'GET' && path === '/zones/zone-a/rulesets/rs-origin') {
          return cfJson({ id: 'rs-origin', rules: [{ id: 'r1', expression: 'true', action: 'route' }] })
        }
        if (method === 'PUT' && path === '/zones/zone-a/rulesets/rs-origin') {
          return cfJson({ id: 'rs-origin', rules: (body as { rules: Array<Record<string, unknown>> }).rules.map((rule, index) => ({ ...rule, id: `r${index + 1}` })) })
        }
        return null
      },
    })

    const listed = await send('GET', '/domains/alpha.com/rules/origin')
    expect(listed.status).toBe(200)
    expect(await json<{ rules: unknown[] }>(listed)).toEqual({
      rules: [{ id: 'r1', expression: 'true', action: 'route' }],
    })

    const created = await send('POST', '/domains/alpha.com/rules/origin', {
      expression: 'http.host eq "alpha.com"',
      action: 'route',
      action_parameters: { origin: { port: 8080 } },
    })
    expect(created.status).toBe(201)
    const put = calls.find((call) => call.method === 'PUT')
    const rules = (put?.body as { rules: Array<Record<string, unknown>> }).rules
    expect(rules).toHaveLength(2)
    expect(rules[1]).toMatchObject({
      expression: 'http.host eq "alpha.com"',
      action: 'route',
      enabled: true,
    })
    expect(await auditActions()).toEqual(['create_rule'])
  })

  it('maps redirect to the account ruleset and requires an account id', async () => {
    await seedAccount(bed, TEST_USER, {
      id: ACCOUNT_A,
      name: 'Alpha',
      token: 'token-a',
      accountId: 'cf-a',
    })
    stubApi({
      zones: { 'token-a': [zone('zone-a', 'alpha.com')] },
      handler: ({ method, path, body }) => {
        if (method === 'GET' && path === '/accounts/cf-a/rulesets') return cfJson([])
        if (method === 'POST' && path === '/accounts/cf-a/rulesets') {
          expect(body).toMatchObject({ kind: 'root', phase: 'http_request_redirect' })
          return cfJson({ id: 'rs-redirect' })
        }
        return null
      },
    })

    const response = await send('GET', '/domains/alpha.com/rules/redirect')
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ rules: [] })
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      kind: 'root',
      phase: 'http_request_redirect',
      rules: [],
    })
  })

  it('updates and deletes a rule, and 404s an unknown rule id', async () => {
    await seedZone()
    stubApi({
      zones: { 'token-a': [zone('zone-a', 'alpha.com')] },
      handler: ({ method, path, body }) => {
        if (method === 'GET' && path === '/zones/zone-a/rulesets') {
          return cfJson([{ id: 'rs-origin', phase: 'http_request_origin' }])
        }
        if (method === 'GET' && path === '/zones/zone-a/rulesets/rs-origin') {
          return cfJson({
            id: 'rs-origin',
            rules: [{ id: 'r1', expression: 'true', action: 'route', enabled: true }],
          })
        }
        if (method === 'PUT' && path === '/zones/zone-a/rulesets/rs-origin') {
          const rules = (body as { rules: unknown[] }).rules
          return cfJson({ id: 'rs-origin', rules })
        }
        return null
      },
    })

    const missing = await send('PUT', '/domains/alpha.com/rules/origin/r999', {
      expression: 'true',
      action: 'route',
    })
    expect(missing.status).toBe(404)
    expect(calls.some((call) => call.method === 'PUT')).toBe(false)

    const updated = await send('PUT', '/domains/alpha.com/rules/origin/r1', {
      expression: 'http.host eq "alpha.com"',
      action: 'route',
      description: 'hello',
    })
    expect(updated.status).toBe(200)

    const deleted = await send('DELETE', '/domains/alpha.com/rules/origin/r1')
    expect(deleted.status).toBe(200)
    expect(await json(deleted)).toEqual({ deleted: 'r1' })
    const puts = calls.filter((call) => call.method === 'PUT')
    expect((puts[1]?.body as { rules: unknown[] }).rules).toEqual([])
    expect(await auditActions()).toEqual(['update_rule', 'delete_rule'])
  })
})
