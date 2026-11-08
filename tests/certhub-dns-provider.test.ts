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
import { ensureTxtRecord } from '../src/worker/development/certhub/dns/cloudflare'
import { bindOrderDomainProvider, domainsWithoutProvider } from '../src/worker/development/certhub/state-machine'
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

describe('migration lane', () => {
  it('carries the throttled-event index on version 360 and keeps numbers unique', () => {
    const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === 360)
    expect(migration).toBeTruthy()
    expect(migration?.statements.join('\n')).toContain('idx_certhub_events_user_order_kind')
    const versions = SCHEMA_MIGRATIONS.map((entry) => entry.version)
    expect(new Set(versions).size).toBe(versions.length)
  })
})
