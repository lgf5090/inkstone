// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { toAlertPolicy } from '../src/worker/cloudflare/alerting'
import {
  buildCountriesQuery,
  mapCountryGroups,
} from '../src/worker/cloudflare/dashboard'
import {
  toDurableObjectNamespace,
  toHyperdriveConfig,
  toQueue,
} from '../src/worker/cloudflare/platform'
import { parseCidr } from '../src/client/features/cloudflare/lib/cidr'

describe('phase 3 converters', () => {
  it('keeps queue producers, consumers and settings', () => {
    const queue = toQueue({
      queue_id: 'q1',
      queue_name: 'jobs',
      created_on: '2026-11-01T00:00:00Z',
      producers: [{ type: 'worker', script: 'sender' }],
      consumers: [{ type: 'worker', script: 'worker' }],
      settings: { delivery_delay: 5, message_retention_period: 60, delivery_paused: true },
    })
    expect(queue).toMatchObject({
      id: 'q1',
      name: 'jobs',
      producerCount: 1,
      consumerCount: 1,
      settings: { deliveryDelay: 5, messageRetention: 60, deliveryPaused: true },
    })
  })

  it('drops a queue row that Cloudflare answered without an id', () => {
    expect(toQueue({ queue_name: 'no-id' })).toBeNull()
  })

  it('never exposes a password when converting a Hyperdrive config', () => {
    const config = toHyperdriveConfig({
      id: 'h1',
      name: 'main',
      origin: { scheme: 'postgres', host: 'db.example', port: 5432, database: 'app', user: 'reader', password: 'secret' },
      caching: { disabled: true },
    })
    expect(config).toEqual({
      id: 'h1',
      name: 'main',
      scheme: 'postgres',
      host: 'db.example',
      port: 5432,
      database: 'app',
      user: 'reader',
      cachingDisabled: true,
      maxAge: null,
      createdOn: '',
      modifiedOn: '',
    })
    expect(JSON.stringify(config)).not.toContain('secret')
  })

  it('maps Durable Object namespaces and SQLite flags', () => {
    expect(toDurableObjectNamespace({ id: 'n1', name: 'room', class: 'Room', script: 'chat', use_sqlite: true }))
      .toEqual({ id: 'n1', name: 'room', className: 'Room', script: 'chat', useSqlite: true })
  })

  it('keeps alert recipients as email mechanism ids', () => {
    const policy = toAlertPolicy({
      id: 'p1',
      name: 'Budget',
      enabled: true,
      alert_type: 'billing_budget_alert',
      mechanisms: { email: [{ id: 'reader@example.com' }] },
    })
    expect(policy?.emails).toEqual(['reader@example.com'])
    expect(policy?.alertType).toBe('billing_budget_alert')
  })
})

describe('country analytics', () => {
  it('queries the adaptive dataset with the country dimension', () => {
    const query = buildCountriesQuery('zone-1', 7, new Date('2026-11-07T00:00:00Z'))
    expect(query.query).toContain('httpRequestsAdaptiveGroups')
    expect(query.query).toContain('clientCountryName')
    expect(query.variables.zoneTag).toBe('zone-1')
  })

  it('sorts countries by sampled requests and drops empty codes', () => {
    expect(mapCountryGroups([
      { count: 10, dimensions: { clientCountryName: 'US' } },
      { count: 30, dimensions: { clientCountryName: 'BE' } },
      { count: 5, dimensions: { clientCountryName: '' } },
    ])).toEqual([
      { code: 'BE', requests: 30 },
      { code: 'US', requests: 10 },
    ])
  })
})

describe('CIDR calculator', () => {
  it('reports IPv4 network, broadcast and usable hosts', () => {
    expect(parseCidr('192.168.1.10/24')).toMatchObject({
      version: 4,
      network: '192.168.1.0/24',
      first: '192.168.1.0',
      last: '192.168.1.255',
      broadcast: '192.168.1.255',
      usableHosts: '254',
    })
  })

  it('handles IPv6 prefixes without a broadcast address', () => {
    const result = parseCidr('2001:db8::1/64')
    expect(result.version).toBe(6)
    expect(result.broadcast).toBeNull()
    expect(result.network).toBe('2001:db8:0:0:0:0:0:0/64')
  })

  it('rejects malformed input', () => {
    expect(() => parseCidr('not-a-cidr')).toThrow('invalid_cidr')
  })
})
