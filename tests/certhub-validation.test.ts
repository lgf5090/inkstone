// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  certificateName,
  normalizeDomain,
  validateDomainRows,
} from '../src/shared/development/certhub/validation'

describe('certificate hub domain validation', () => {
  it('normalises case, trailing dots and international names', () => {
    expect(normalizeDomain(' Example.COM. ')).toEqual({ name: 'example.com', isIp: false })
    expect(normalizeDomain('例子.测试')).toEqual({ name: 'xn--fsqu00a.xn--0zwm56d', isIp: false })
  })

  it('accepts a mixed root and wildcard pair with one primary', () => {
    const domains = validateDomainRows([
      { name: 'example.com', primary: true },
      { name: 'example.com', wildcard: true },
    ])
    expect(domains.map(certificateName)).toEqual(['example.com', '*.example.com'])
    expect(domains.filter((domain) => domain.primary)).toHaveLength(1)
  })

  it('refuses wildcard over HTTP and IP over DNS', () => {
    expect(() => validateDomainRows([{ name: 'example.com', wildcard: true, challengeMode: 'http-01' }]))
      .toThrow('wildcard_requires_dns01')
    expect(() => validateDomainRows([{ name: '203.0.113.10', challengeMode: 'dns-01' }]))
      .toThrow('ip_requires_http01')
  })

  it('refuses duplicate names and ambiguous primaries', () => {
    expect(() => validateDomainRows([{ name: 'example.com' }, { name: 'EXAMPLE.com' }]))
      .toThrow('domain_duplicate')
    expect(() => validateDomainRows([
      { name: 'a.example.com', primary: true },
      { name: 'b.example.com', primary: true },
    ])).toThrow('primary_ambiguous')
  })
})
