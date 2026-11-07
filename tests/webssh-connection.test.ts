// @vitest-environment node
// W2 outbound gate: private/loopback/link-local/Cloudflare ranges, port 25, DNS answers and the
// development-only switch that lets a local Docker sshd be used.

import { describe, expect, it } from 'vitest'
import {
  isCloudflareAddress,
  openSshSocket,
  readDevAllowPrivateHosts,
  resolveSshTarget,
  WebsshConnectionError,
  type DohLookup,
} from '../src/worker/webssh/connection'

function lookup(map: Record<string, string[]>): DohLookup {
  return async (name) => map[name] ?? []
}

describe('address range checks', () => {
  it('recognises Cloudflare IPv4 and IPv6 ranges', () => {
    expect(isCloudflareAddress('104.16.132.229')).toBe(true)
    expect(isCloudflareAddress('172.64.0.1')).toBe(true)
    expect(isCloudflareAddress('2606:4700::1')).toBe(true)
    expect(isCloudflareAddress('1.1.1.1')).toBe(false)
    expect(isCloudflareAddress('192.0.2.1')).toBe(false)
  })

  it('arms the development switch only for the exact words 1 and true', () => {
    expect(readDevAllowPrivateHosts('1')).toBe(true)
    expect(readDevAllowPrivateHosts('true')).toBe(true)
    expect(readDevAllowPrivateHosts('0')).toBe(false)
    expect(readDevAllowPrivateHosts('yes')).toBe(false)
    expect(readDevAllowPrivateHosts(undefined)).toBe(false)
  })
})

describe('literal targets', () => {
  it('rejects loopback, private, link-local and unique-local addresses by default', async () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1']) {
      await expect(resolveSshTarget(host, 22)).rejects.toBeInstanceOf(WebsshConnectionError)
    }
  })

  it('rejects Cloudflare literal addresses even when the development switch is on', async () => {
    await expect(resolveSshTarget('104.16.132.229', 22, { allowPrivateHosts: true }))
      .rejects.toThrow('private, loopback or Cloudflare')
  })

  it('rejects port 25 even when the development switch is on', async () => {
    await expect(resolveSshTarget('127.0.0.1', 25, { allowPrivateHosts: true }))
      .rejects.toThrow('Port 25 is not allowed')
  })

  it('accepts a local literal only with the development switch and marks the override', async () => {
    const target = await resolveSshTarget('127.0.0.1', 2222, { allowPrivateHosts: true })
    expect(target).toEqual({ host: '127.0.0.1', port: 2222, address: '127.0.0.1', family: 4, devOverride: true })
  })

  it('accepts a public literal without the switch and does not mark an override', async () => {
    const target = await resolveSshTarget('93.184.216.34', 22)
    expect(target).toEqual({ host: '93.184.216.34', port: 22, address: '93.184.216.34', family: 4, devOverride: false })
  })

  it('rejects an invalid host or port', async () => {
    await expect(resolveSshTarget('not a host', 22)).rejects.toThrow('not a valid hostname')
    await expect(resolveSshTarget('93.184.216.34', 0)).rejects.toThrow('out of range')
  })
})

describe('hostname targets', () => {
  it('connects to the resolved address, never the hostname (DNS rebinding)', async () => {
    const target = await resolveSshTarget('ssh.example.com', 22, {
      lookup: lookup({ 'ssh.example.com': ['93.184.216.34'] }),
    })
    expect(target.host).toBe('ssh.example.com')
    expect(target.address).toBe('93.184.216.34')
    expect(target.family).toBe(4)
  })

  it('discards blocked answers and prefers the public one', async () => {
    const target = await resolveSshTarget('mixed.example.com', 22, {
      lookup: lookup({ 'mixed.example.com': ['127.0.0.1', '203.0.113.9'] }),
    })
    expect(target.address).toBe('203.0.113.9')
  })

  it('refuses a host that resolves only to private addresses without the switch', async () => {
    await expect(resolveSshTarget('internal.example.com', 22, {
      lookup: lookup({ 'internal.example.com': ['10.1.2.3'] }),
    })).rejects.toThrow('resolves only to blocked addresses')
  })

  it('accepts the private answer under the development switch and marks the override', async () => {
    const target = await resolveSshTarget('internal.example.com', 2222, {
      lookup: lookup({ 'internal.example.com': ['127.0.0.1'] }),
      allowPrivateHosts: true,
    })
    expect(target.address).toBe('127.0.0.1')
    expect(target.devOverride).toBe(true)
  })

  it('reports a DNS failure when no answer family resolves', async () => {
    await expect(resolveSshTarget('missing.example.com', 22, { lookup: async () => [] }))
      .rejects.toThrow('No address record')
  })

  it('rejects a Cloudflare answer for a public hostname', async () => {
    await expect(resolveSshTarget('edge.example.com', 22, {
      lookup: lookup({ 'edge.example.com': ['104.16.132.229'] }),
    })).rejects.toThrow('resolves only to blocked addresses')
  })
})

describe('socket opening', () => {
  it('opens the validated literal address rather than the configured hostname', async () => {
    const calls: Array<{ hostname: string; port: number }> = []
    const target = await resolveSshTarget('ssh.example.com', 22, {
      lookup: lookup({ 'ssh.example.com': ['93.184.216.34'] }),
    })
    const socket = await openSshSocket(target, (options) => {
      calls.push(options)
      return {} as Socket
    })
    expect(socket).toBeTruthy()
    expect(calls).toEqual([{ hostname: '93.184.216.34', port: 22 }])
  })

  it('wraps a connection failure with the connect_failed code', async () => {
    const target = await resolveSshTarget('93.184.216.34', 22)
    await expect(openSshSocket(target, () => { throw new Error('refused') }))
      .rejects.toMatchObject({ code: 'connect_failed' })
  })
})
