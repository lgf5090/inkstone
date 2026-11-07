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
import {
  parseIpAccessRuleInput,
  toCertificatePack,
  toPageRule,
  toUniversalSsl,
  toUrlNormalization,
} from '../src/worker/cloudflare/dns-security'
import { parseSettingsPatch, readPurgeHosts, readPurgeTags, readPurgeUrls, RULE_PHASES } from '../src/worker/cloudflare/dns'

const ACCOUNT = 'a'.repeat(26)
const ZONE_ID = 'zone-a'
const ZONE_NAME = 'alpha.example'

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

interface StubOptions {
  handler?: (call: { method: string; path: string; body: unknown }) => Response | null
}

function stubApi(options: StubOptions = {}): void {
  calls = []
  stubCloudflare(async (url, init) => {
    const method = init?.method ?? 'GET'
    const path = url.pathname.replace('/client/v4', '')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    const call = { method, path, body }
    calls.push(call)
    const custom = options.handler?.(call)
    if (custom) return custom
    if (method === 'GET' && path === '/zones') {
      return cfJson([{ id: ZONE_ID, name: ZONE_NAME, status: 'active', paused: false }])
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

beforeEach(async () => {
  mocks.userId = TEST_USER
  bed = await makeCloudflareBed()
  await seedAccount(bed, TEST_USER, {
    id: ACCOUNT,
    name: 'Alpha',
    token: 'token-a',
    accountId: 'cf-a',
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('Page Rules', () => {
  it('lists Cloudflare page rules as the table fields', async () => {
    stubApi({
      handler: ({ method, path }) => (
        method === 'GET' && path === `/zones/${ZONE_ID}/pagerules`
          ? cfJson([{
            id: 'rule-1',
            status: 'active',
            priority: 1,
            targets: [{ target: 'url', constraint: { operator: 'matches', value: `${ZONE_NAME}/*` } }],
            actions: [{ id: 'always_use_https' }],
          }])
          : null
      ),
    })
    const response = await send('GET', '/domains/alpha.example/page-rules')
    expect(response.status).toBe(200)
    const body = await response.json() as { pageRules: unknown[] }
    expect(body.pageRules).toEqual([{
      id: 'rule-1',
      status: 'active',
      priority: 1,
      target: `${ZONE_NAME}/*`,
      constraint_operator: 'matches',
      action_ids: ['always_use_https'],
    }])
  })

  it('toggles a page rule status and records the change', async () => {
    stubApi({
      handler: ({ method, path }) => (
        method === 'PATCH' && path === `/zones/${ZONE_ID}/pagerules/rule-1`
          ? cfJson({ id: 'rule-1', status: 'disabled' })
          : null
      ),
    })
    const response = await send('PATCH', '/domains/alpha.example/page-rules/rule-1', { status: 'disabled' })
    expect(response.status).toBe(200)
    expect(calls.at(-1)?.body).toEqual({ status: 'disabled' })
    const rows = await bed.env.DB.prepare(
      'SELECT action FROM cloudflare_log WHERE user_id = ?',
    ).bind(TEST_USER).all<{ action: string }>()
    expect((rows.results ?? []).map((row) => row.action)).toContain('update_page_rule')
  })
})

describe('URL normalization', () => {
  it('reads and validates the enum pair', async () => {
    stubApi({
      handler: ({ method, path }) => (
        method === 'GET' && path === `/zones/${ZONE_ID}/url_normalization`
          ? cfJson({ type: 'rfc3986', scope: 'both' })
          : null
      ),
    })
    const response = await send('GET', '/domains/alpha.example/url-normalization')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: 'rfc3986', scope: 'both' })

    const bad = await send('PUT', '/domains/alpha.example/url-normalization', { type: 'unknown', scope: 'both' })
    expect(bad.status).toBe(400)
  })
})

describe('SSL certificates', () => {
  it('lists packs, reads universal SSL and validates the boolean patch', async () => {
    stubApi({
      handler: ({ method, path }) => {
        if (method === 'GET' && path === `/zones/${ZONE_ID}/ssl/certificate_packs`) {
          return cfJson([{
            id: 'pack-1',
            type: 'universal',
            hosts: [ZONE_NAME],
            status: 'active',
            certificate_authority: 'DigiCert',
            certificates: [{ id: 'cert-1', issuer: 'DigiCert', status: 'active', expires_on: '2026-12-01T00:00:00Z' }],
          }])
        }
        if (method === 'GET' && path === `/zones/${ZONE_ID}/ssl/universal/settings`) {
          return cfJson({ enabled: true })
        }
        if (method === 'PATCH' && path === `/zones/${ZONE_ID}/ssl/universal/settings`) {
          return cfJson({ enabled: false })
        }
        return null
      },
    })
    const packs = await send('GET', '/domains/alpha.example/ssl/certificates')
    expect(packs.status).toBe(200)
    expect(await packs.json()).toMatchObject({
      certificates: [{ id: 'pack-1', certificate_authority: 'DigiCert' }],
    })

    const universal = await send('GET', '/domains/alpha.example/ssl/universal')
    expect(await universal.json()).toEqual({ enabled: true })

    const bad = await send('PATCH', '/domains/alpha.example/ssl/universal', { enabled: 'yes' })
    expect(bad.status).toBe(400)
  })
})

describe('IP Access Rules', () => {
  it('creates a rule, and rejects a value that does not match its target', async () => {
    stubApi({
      handler: ({ method, path }) => (
        method === 'POST' && path === `/zones/${ZONE_ID}/firewall/access_rules/rules`
          ? cfJson({
            id: 'ip-1',
            mode: 'block',
            configuration: { target: 'ip', value: '203.0.113.9' },
            notes: 'scanner',
          })
          : null
      ),
    })
    const created = await send('POST', '/domains/alpha.example/ip-access-rules', {
      mode: 'block',
      target: 'ip',
      value: '203.0.113.9',
      notes: 'scanner',
    })
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({ id: 'ip-1', mode: 'block', target: 'ip', value: '203.0.113.9' })

    const bad = await send('POST', '/domains/alpha.example/ip-access-rules', {
      mode: 'block',
      target: 'ip',
      value: 'not-an-ip',
      notes: '',
    })
    expect(bad.status).toBe(400)
    expect(calls.some((call) => call.path.endsWith('/firewall/access_rules/rules') && call.body)).toBe(true)
  })

  it('rejects an unknown mode before it reaches Cloudflare', () => {
    expect(() => parseIpAccessRuleInput({ mode: 'allow', target: 'ip', value: '1.2.3.4', notes: '' }, false))
      .toThrow('mode must be one of')
  })
})

describe('purge cache variants', () => {
  it('accepts prefixes, hosts and tags, and refuses two kinds at once', async () => {
    stubApi({
      handler: ({ method, path }) => (
        method === 'POST' && path === `/zones/${ZONE_ID}/purge_cache`
          ? cfJson({ id: 'purge-1' })
          : null
      ),
    })
    for (const body of [
      { prefixes: ['https://alpha.example/static/'] },
      { hosts: ['www.alpha.example'] },
      { tags: ['release-1'] },
    ]) {
      const response = await send('POST', '/domains/alpha.example/purge-cache', body)
      expect(response.status).toBe(200)
    }
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(3)

    const both = await send('POST', '/domains/alpha.example/purge-cache', {
      files: ['https://alpha.example/a.js'],
      tags: ['release-1'],
    })
    expect(both.status).toBe(400)
  })

  it('validates the values before building the request', () => {
    expect(() => readPurgeUrls(['ftp://x'], 'files', 30)).toThrow('Not a URL')
    expect(() => readPurgeHosts(['https://alpha.example'])).toThrow('Not a hostname')
    expect(() => readPurgeTags([''])).toThrow('cannot be empty')
  })
})

describe('zone settings expansion', () => {
  it('accepts the TLS and performance switches and refuses a bad TLS version', () => {
    expect(parseSettingsPatch({ tls_1_3: 'on', http3: 'off', min_tls_version: '1.2' })).toEqual([
      { key: 'tls_1_3', path: 'tls_1_3', value: 'on' },
      { key: 'http3', path: 'http3', value: 'off' },
      { key: 'min_tls_version', path: 'min_tls_version', value: '1.2' },
    ])
    expect(() => parseSettingsPatch({ min_tls_version: '1.4' })).toThrow('min_tls_version must be one of')
  })

  it('routes the four new ruleset phases to their Cloudflare phases', () => {
    expect(RULE_PHASES.single_redirect.phase).toBe('http_request_dynamic_redirect')
    expect(RULE_PHASES.config.phase).toBe('http_config_settings')
    expect(RULE_PHASES.compression.phase).toBe('http_response_compression')
    expect(RULE_PHASES.custom_errors.phase).toBe('http_custom_errors')
  })
})

describe('ruleset inventory', () => {
  it('lists phases and rule counts, fetching a ruleset detail only when the list omits its rules', async () => {
    stubApi({
      handler: ({ method, path }) => {
        if (method === 'GET' && path === `/zones/${ZONE_ID}/rulesets`) {
          return cfJson([
            { id: 'managed', phase: 'http_request_firewall_managed', name: 'Managed', rules: [{ id: 'r1' }] },
            { id: 'empty', phase: 'http_config_settings', name: 'Config' },
          ])
        }
        if (method === 'GET' && path === `/zones/${ZONE_ID}/rulesets/empty`) {
          return cfJson({ id: 'empty', rules: [] })
        }
        return null
      },
    })
    const response = await send('GET', '/domains/alpha.example/rulesets')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      rulesets: [
        { id: 'managed', phase: 'http_request_firewall_managed', name: 'Managed', ruleCount: 1 },
        { id: 'empty', phase: 'http_config_settings', name: 'Config', ruleCount: 0 },
      ],
    })
  })
})

describe('converters', () => {
  it('keep only the modelled fields', () => {
    expect(toPageRule({ id: 'r', targets: [{ constraint: { value: 'x', operator: 'equals' } }], actions: [{ id: 'a' }] }))
      .toEqual({ id: 'r', status: '', priority: null, target: 'x', constraint_operator: 'equals', action_ids: ['a'] })
    expect(toUrlNormalization({ type: 'cloudflare' })).toEqual({ type: 'cloudflare', scope: 'incoming' })
    expect(toUniversalSsl({ enabled: false })).toEqual({ enabled: false })
    expect(toCertificatePack({ id: 'p', hosts: ['a'], certificates: [{ issuer: 'x' }] })).toMatchObject({
      id: 'p',
      hosts: ['a'],
      certificates: [{ issuer: 'x', id: '', status: '', expires_on: '' }],
    })
  })
})
