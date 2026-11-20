// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseTrustedProxyCidrs, requestClientIp, resolveClientIp } from '../src/worker/lib/request'

describe('self-hosted client IP resolution', () => {
  it('shares one key when no trusted proxy is declared', () => {
    expect(resolveClientIp({
      forwardedFor: '203.0.113.9', cfPresent: false, trustedProxyCidrs: undefined,
    })).toBe('local')
  })

  it('still refuses a client-controlled CF-Connecting-IP without an edge object', () => {
    expect(resolveClientIp({
      cfIp: '198.51.100.4', forwardedFor: '203.0.113.9', cfPresent: false,
      trustedProxyCidrs: '10.0.0.0/8',
    })).toBe('203.0.113.9')
  })

  it('prefers the edge-injected address on Cloudflare', () => {
    expect(resolveClientIp({
      cfIp: '198.51.100.4', forwardedFor: '203.0.113.9', cfPresent: true,
      trustedProxyCidrs: '10.0.0.0/8',
    })).toBe('198.51.100.4')
  })

  it('takes the rightmost hop a trusted proxy did not add', () => {
    expect(resolveClientIp({
      forwardedFor: '198.51.100.1, 203.0.113.9, 10.1.2.3, 10.1.2.4',
      cfPresent: false, trustedProxyCidrs: '10.0.0.0/8',
    })).toBe('203.0.113.9')
  })

  it('matches IPv6 proxy ranges as well as IPv4 CIDRs', () => {
    expect(resolveClientIp({
      forwardedFor: '2001:db8::9, ::1', cfPresent: false,
      trustedProxyCidrs: '::1, 10.0.0.1/32',
    })).toBe('2001:db8::9')
    expect(parseTrustedProxyCidrs('::1/128, 2001:db8::/32')).toHaveLength(2)
  })

  it('discards malformed ranges rather than trusting everything', () => {
    expect(parseTrustedProxyCidrs('10.0.0.0/33, not-an-ip, , 127.0.0.1')).toHaveLength(1)
    expect(resolveClientIp({
      forwardedFor: '203.0.113.9', cfPresent: false, trustedProxyCidrs: '10.0.0.0/33',
    })).toBe('local')
  })

  it('reads the deployment setting from the Hono context', () => {
    const context = {
      req: {
        header: (name: string): string | undefined => ({
          'x-forwarded-for': '198.51.100.1, 203.0.113.9',
          'cf-connecting-ip': undefined,
        })[name.toLowerCase()],
        raw: undefined,
      },
      env: { TRUSTED_PROXY_CIDRS: '10.0.0.0/8' },
    }
    expect(requestClientIp(context)).toBe('203.0.113.9')
  })
})
