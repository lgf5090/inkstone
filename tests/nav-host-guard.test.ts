import { describe, expect, it } from 'vitest'
import { resolvePublicHost, type HostLookup } from '../src/worker/lib/host-guard'

function lookup(a: string[], aaaa: string[] = []): HostLookup {
  return async (_host, type) => (type === 'A' ? a : aaaa)
}

describe('resolvePublicHost', () => {
  it('blocks a name whose A record is loopback', async () => {
    expect(await resolvePublicHost('localtest.me', lookup(['127.0.0.1']))).toBe('blocked')
  })

  it('blocks a name whose AAAA record is unique-local', async () => {
    expect(await resolvePublicHost('example.test', lookup(['93.184.216.34'], ['fd00::1']))).toBe('blocked')
  })

  it('accepts a name whose records are public', async () => {
    expect(await resolvePublicHost('example.test', lookup(['93.184.216.34'], ['2606:2800:220:1:248:1893:25c8:1946']))).toBe('ok')
  })

  it('fails closed when no address can be resolved', async () => {
    expect(await resolvePublicHost('example.test', async () => { throw new Error('dns down') })).toBe('unresolved')
  })

  it('blocks literal private addresses without a lookup', async () => {
    const never: HostLookup = async () => { throw new Error('should not resolve') }
    expect(await resolvePublicHost('127.0.0.1', never)).toBe('blocked')
    expect(await resolvePublicHost('[::1]', never)).toBe('blocked')
    expect(await resolvePublicHost('169.254.169.254', never)).toBe('blocked')
  })

  it('accepts literal public addresses without a lookup', async () => {
    const never: HostLookup = async () => { throw new Error('should not resolve') }
    expect(await resolvePublicHost('1.1.1.1', never)).toBe('ok')
    expect(await resolvePublicHost('[2606:4700:4700::1111]', never)).toBe('ok')
  })
})
