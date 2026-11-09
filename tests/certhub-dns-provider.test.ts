// @vitest-environment node
/**
 * The DNS-provider contract of a DNS-01 order.
 *
 * These cases cover the four ways an order could silently sit in "waiting for DNS": the request form
 * never picks a provider, the queue has no way to report the missing provider, an existing order
 * cannot gain one, and a retried write stacks a duplicate value beside another order's TXT.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEVELOPMENT_CERTHUB_SCHEMA_STATEMENTS } from '../src/worker/development/certhub/schema'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'
import { ensureTxtRecord, probeDnsWrite, resolveZoneId, verifyCloudflareToken } from '../src/worker/development/certhub/dns/cloudflare'
import { autoBindMissingProviders, bindOrderDomainProvider, domainsWithoutProvider } from '../src/worker/development/certhub/state-machine'
import { parseAcmeFailure } from '../src/worker/development/certhub/acme/errors'
import { matchProviderForDomain } from '../src/client/features/development/certhub/rules'
import { ApiError } from '../src/worker/lib/errors'
import { makeD1 } from './doubles/d1-sqlite'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('default provider for a typed domain', () => {
  const providers = [
    { id: 'apex', zoneName: 'example.com' },
    { id: 'sub', zoneName: 'shop.example.com' },
    { id: 'other', zoneName: 'example.org' },
  ]

  it('matches the zone that contains the domain and prefers the longest one', () => {
    expect(matchProviderForDomain('example.com', providers)).toBe('apex')
    expect(matchProviderForDomain('www.example.com', providers)).toBe('apex')
    expect(matchProviderForDomain('shop.example.com', providers)).toBe('sub')
    expect(matchProviderForDomain('*.shop.example.com', providers)).toBe('sub')
    expect(matchProviderForDomain('shop.example.org', providers)).toBe('other')
  })

  it('does not match a domain outside every zone, or an empty name', () => {
    expect(matchProviderForDomain('example.net', providers)).toBe('')
    expect(matchProviderForDomain('', providers)).toBe('')
    expect(matchProviderForDomain('example.com', [])).toBe('')
  })

  it('ignores a provider with no zone name', () => {
    expect(matchProviderForDomain('example.com', [{ id: 'blind', zoneName: '' }])).toBe('')
  })
})

describe('domains without a provider', () => {
  it('reports waiting DNS-01 rows but never a validated one', () => {
    const rows = [
      { challenge_mode: 'dns-01', dns_provider_id: '', status: 'prepared' },
      { challenge_mode: 'dns-01', dns_provider_id: '01m6x5h138kwsw8ssz29qhqv5r', status: 'prepared' },
      { challenge_mode: 'dns-01', dns_provider_id: '', status: 'valid' },
      { challenge_mode: 'http-01', dns_provider_id: '', status: 'prepared' },
    ]
    expect(domainsWithoutProvider(rows)).toEqual([rows[0]])
  })
})

describe('idempotent TXT write', () => {
  const record = (id: string, content: string, comment: string) => ({ id, name: '_acme-challenge.example.com', type: 'TXT', content, comment })

  it('reuses the record this order already owns instead of writing a duplicate', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, result: [record('own', 'value', 'certhub:order-1')] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(ensureTxtRecord('token', 'zone', '_acme-challenge.example.com', 'value', 'certhub:order-1')).resolves.toBe('own')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('leaves another order\'s value alone and adds its own', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') {
        return new Response(JSON.stringify({ success: true, result: [record('theirs', 'value', 'certhub:order-2')] }), { status: 200 })
      }
      expect(JSON.parse(String(init.body))).toMatchObject({ type: 'TXT', content: 'value', comment: 'certhub:order-1' })
      return new Response(JSON.stringify({ success: true, result: { id: 'mine' } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(ensureTxtRecord('token', 'zone', '_acme-challenge.example.com', 'value', 'certhub:order-1')).resolves.toBe('mine')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

function database() {
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_CERTHUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.exec(`INSERT INTO development_certhub_orders
    (user_id, id, account_id, ca, environment, key_algorithm, status, subject_json, created_at, updated_at)
    VALUES ('u1', '01m6x7pbeg5pc4vfgqt1vtzddd', 'a1', 'lets-encrypt', 'production', 'eccp256', 'awaiting_dns', '{}', 1, 2)`)
  sqlite.exec(`INSERT INTO development_certhub_order_domains
    (user_id, id, order_id, name, wildcard, is_primary, challenge_mode, status, created_at, updated_at)
    VALUES ('u1', '01m6x7pbegytjtsc6acsqktjj6', '01m6x7pbeg5pc4vfgqt1vtzddd', 'example.com', 0, 1, 'dns-01', 'prepared', 1, 2)`)
  sqlite.exec(`INSERT INTO development_certhub_dns_providers
    (user_id, id, kind, label, zone_id, zone_name, account_email, credential_ciphertext, status, created_at, updated_at)
    VALUES ('u1', '01m6x5h138kwsw8ssz29qhqv5r', 'cloudflare', 'example.com', 'zone', 'example.com', '', 'cipher', 'active', 1, 2)`)
  return sqlite
}

describe('binding a provider to an existing order', () => {
  it('attaches the provider, re-queues the order and records the change', async () => {
    const sqlite = database()
    const db = makeD1(sqlite)
    await bindOrderDomainProvider({} as never, db, 'u1', '01m6x7pbeg5pc4vfgqt1vtzddd', '01m6x7pbegytjtsc6acsqktjj6', '01m6x5h138kwsw8ssz29qhqv5r', 'user')

    const order = sqlite.prepare(`SELECT status, version FROM development_certhub_orders WHERE user_id = 'u1' AND id = '01m6x7pbeg5pc4vfgqt1vtzddd'`).get() as { status: string; version: number }
    expect(order).toEqual({ status: 'queued', version: 2 })
    const domain = sqlite.prepare(`SELECT dns_provider_id, status FROM development_certhub_order_domains WHERE user_id = 'u1' AND id = '01m6x7pbegytjtsc6acsqktjj6'`).get() as { dns_provider_id: string; status: string }
    expect(domain).toEqual({ dns_provider_id: '01m6x5h138kwsw8ssz29qhqv5r', status: 'pending' })
    const event = sqlite.prepare(`SELECT kind FROM development_certhub_events WHERE order_id = '01m6x7pbeg5pc4vfgqt1vtzddd' ORDER BY created_at DESC LIMIT 1`).get() as { kind: string }
    expect(event.kind).toBe('order.provider_bound')
    const job = sqlite.prepare(`SELECT kind, status FROM development_certhub_jobs WHERE order_id = '01m6x7pbeg5pc4vfgqt1vtzddd'`).get() as { kind: string; status: string }
    expect(job).toEqual({ kind: 'advance', status: 'queued' })
    sqlite.close()
  })

  it('refuses to change the provider of a finished order', async () => {
    const sqlite = database()
    sqlite.exec(`UPDATE development_certhub_orders SET status = 'issued' WHERE user_id = 'u1' AND id = '01m6x7pbeg5pc4vfgqt1vtzddd'`)
    const db = makeD1(sqlite)
    await expect(bindOrderDomainProvider({} as never, db, 'u1', '01m6x7pbeg5pc4vfgqt1vtzddd', '01m6x7pbegytjtsc6acsqktjj6', '01m6x5h138kwsw8ssz29qhqv5r', 'user'))
      .rejects.toMatchObject({ status: 409, code: 'order_state_conflict' })
    sqlite.close()
  })

  it('answers not-found for a provider that belongs to another account', async () => {
    const sqlite = database()
    const db = makeD1(sqlite)
    await expect(bindOrderDomainProvider({} as never, db, 'u2', '01m6x7pbeg5pc4vfgqt1vtzddd', '01m6x7pbegytjtsc6acsqktjj6', '01m6x5h138kwsw8ssz29qhqv5r', 'user'))
      .rejects.toBeInstanceOf(ApiError)
    sqlite.close()
  })
})

describe('repairing a stored order', () => {
  it('binds the provider whose zone covers the domain and re-queues the order', async () => {
    const sqlite = database()
    const db = makeD1(sqlite)
    const order = { id: '01m6x7pbeg5pc4vfgqt1vtzddd' } as never
    const domains = sqlite.prepare(`SELECT id, name, challenge_mode, dns_provider_id, status FROM development_certhub_order_domains WHERE user_id = 'u1' AND order_id = '01m6x7pbeg5pc4vfgqt1vtzddd'`).all() as never
    expect(await autoBindMissingProviders(db, 'u1', order, domains, 'system')).toBe(true)
    const domain = sqlite.prepare(`SELECT dns_provider_id, status FROM development_certhub_order_domains WHERE user_id = 'u1' AND id = '01m6x7pbegytjtsc6acsqktjj6'`).get() as { dns_provider_id: string; status: string }
    expect(domain).toEqual({ dns_provider_id: '01m6x5h138kwsw8ssz29qhqv5r', status: 'pending' })
    const row = sqlite.prepare(`SELECT status FROM development_certhub_orders WHERE user_id = 'u1' AND id = '01m6x7pbeg5pc4vfgqt1vtzddd'`).get() as { status: string }
    expect(row.status).toBe('queued')
    const event = sqlite.prepare(`SELECT detail_json FROM development_certhub_events WHERE kind = 'order.provider_bound' ORDER BY created_at DESC LIMIT 1`).get() as { detail_json: string }
    expect(JSON.parse(event.detail_json)).toMatchObject({ provider: 'example.com', auto: true })
    sqlite.close()
  })

  it('leaves the order alone when no provider covers the domain', async () => {
    const sqlite = database()
    sqlite.exec(`UPDATE development_certhub_dns_providers SET zone_name = 'other.example' WHERE user_id = 'u1'`)
    const db = makeD1(sqlite)
    const order = { id: '01m6x7pbeg5pc4vfgqt1vtzddd' } as never
    const domains = sqlite.prepare(`SELECT id, name, challenge_mode, dns_provider_id, status FROM development_certhub_order_domains WHERE user_id = 'u1' AND order_id = '01m6x7pbeg5pc4vfgqt1vtzddd'`).all() as never
    expect(await autoBindMissingProviders(db, 'u1', order, domains, 'system')).toBe(false)
    const row = sqlite.prepare(`SELECT status FROM development_certhub_orders WHERE user_id = 'u1' AND id = '01m6x7pbeg5pc4vfgqt1vtzddd'`).get() as { status: string }
    expect(row.status).toBe('awaiting_dns')
    sqlite.close()
  })
})

describe('DNS failure classification', () => {
  it('turns Cloudflare authentication errors into a permanent, readable failure', () => {
    const failure = parseAcmeFailure(new ApiError(502, 'dns_error', 'Authentication error'))
    expect(failure).toMatchObject({ kind: 'dns_auth', retryable: false, detail: 'Authentication error' })
  })

  it('keeps other DNS errors retryable and does not classify a plain Error as DNS', () => {
    expect(parseAcmeFailure(new ApiError(502, 'dns_error', 'The DNS provider answered HTTP 500')).kind).toBe('dns')
    expect(parseAcmeFailure(new Error('network down'))).toMatchObject({ kind: 'unknown', retryable: true })
  })
})

describe('zone resolution and write probe', () => {
  it('resolves the zone id by name instead of trusting the stored id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: [{ id: 'resolved-zone', name: 'example.com' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolveZoneId('token', 'Example.com.')).resolves.toBe('resolved-zone')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a zone the token cannot see', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, result: [] }), { status: 200 })))
    await expect(resolveZoneId('token', 'example.com')).rejects.toMatchObject({ status: 422, code: 'dns_zone_mismatch' })
  })

  it('names an invalid token with 422, never the session-401 status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: false, result: null, errors: [{ code: 10000, message: 'Authentication error' }],
    }), { status: 403 })))
    await expect(verifyCloudflareToken('token')).rejects.toMatchObject({
      status: 422,
      code: 'dns_token_invalid',
      details: { endpoint: '/user/tokens/verify', upstreamStatus: 403, upstreamCodes: [10000], upstreamMessage: 'Authentication error' },
    })
  })

  it('names a zone the token cannot write to with 422, with the upstream status and code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: false, result: null, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
    }), { status: 403 })))
    await expect(probeDnsWrite('token', 'zone')).rejects.toMatchObject({
      status: 422,
      code: 'dns_zone_forbidden',
      details: { endpoint: '/zones/zone/dns_records', upstreamStatus: 403, upstreamCodes: [9109] },
    })
  })

  it('sends a pasted token without its whitespace or Bearer prefix', async () => {
    const calls: Array<{ url: string; auth?: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
      return new Response(JSON.stringify({ success: true, result: { id: 'x', status: 'active' } }), { status: 200 })
    }))
    await verifyCloudflareToken('  Bearer token-with-space\n')
    expect(calls[0].auth).toBe('Bearer token-with-space')
  })

  it('names a Global API Key before forwarding it to Cloudflare', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(verifyCloudflareToken('a'.repeat(37))).rejects.toMatchObject({
      status: 422,
      code: 'dns_global_key',
      details: { endpoint: '/user/tokens/verify', reason: 'global_api_key' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports an unreachable provider as a retryable network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down') }))
    await expect(ensureTxtRecord('token', 'zone', '_acme-challenge.example.com', 'value', 'certhub:order-1'))
      .rejects.toMatchObject({ status: 503, code: 'dns_network' })
  })

  it('creates and removes its probe record', async () => {
    const calls: Array<{ method: string; url: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url: String(url) })
      const result = (init?.method ?? 'GET').toUpperCase() === 'POST' ? { id: 'probe-id' } : {}
      return new Response(JSON.stringify({ success: true, result }), { status: 200 })
    }))
    await probeDnsWrite('token', 'zone')
    expect(calls.map((call) => call.method)).toEqual(['POST', 'DELETE'])
    expect(calls[1].url).toContain('/dns_records/probe-id')
  })
})

describe('migration lane', () => {
  it('carries the throttled-event index on version 360 and keeps numbers unique', () => {
    const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === 360)
    expect(migration).toBeTruthy()
    expect(migration?.statements.join('\n')).toContain('idx_certhub_events_user_order_kind')
    const versions = SCHEMA_MIGRATIONS.map((entry) => entry.version)
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('carries the provider zone index on version 380', () => {
    const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === 380)
    expect(migration?.statements.join('\n')).toContain('idx_certhub_dns_user_zone')
  })
})
