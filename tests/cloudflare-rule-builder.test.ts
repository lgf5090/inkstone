/**
 * The rule form's pure half.
 *
 * A rule is an expression plus a phase-shaped action object, and the dialog's fields are a friendlier
 * way to say both. These cases pin the exact strings Cloudflare receives — a filter language is not
 * something a reader can proofread by eye, so the test is the only place the wording is checked — and
 * they pin the reverse direction, because an edit that silently loses a rule's shape is worse than a
 * dialog that refuses to open.
 */
import { describe, expect, it } from 'vitest'
import type { DnsRule } from '../src/client/features/cloudflare/api/dns'
import {
  buildPayload,
  emptyRuleForm,
  formFromRule,
  type RuleFormState,
} from '../src/client/features/cloudflare/screens/dns/rule-builder'

const ZONE = 'example.com'

function form(over: Partial<RuleFormState> = {}): RuleFormState {
  return { ...emptyRuleForm(), ...over }
}

describe('the rule form', () => {
  it('builds each match kind from the same two fields', () => {
    expect(buildPayload('firewall', form(), ZONE, 'block')?.expression)
      .toBe('(http.host eq "example.com")')
    expect(buildPayload('firewall', form({ subdomain: 'blog' }), ZONE, 'block')?.expression)
      .toBe('(http.host eq "blog.example.com")')
    expect(buildPayload('firewall', form({ matchType: 'pathPrefix', path: '/docs' }), ZONE, 'block')?.expression)
      .toBe('(http.request.uri.path matches "^/docs.*")')
    expect(buildPayload('firewall', form({ matchType: 'pathRegex', path: '^/v[0-9]+/' }), ZONE, 'block')?.expression)
      .toBe('(http.request.uri.path matches "^/v[0-9]+/")')
    expect(buildPayload('firewall', form({ matchType: 'hostAndPath', subdomain: 'api', path: '/v1' }), ZONE, 'block')?.expression)
      .toBe('(http.host eq "api.example.com" and http.request.uri.path matches "^/v1.*")')
    expect(buildPayload('firewall', form({ matchType: 'custom', expression: '(ip.geoip.country eq "CN")' }), ZONE, 'block')?.expression)
      .toBe('(ip.geoip.country eq "CN")')
  })

  it('escapes a literal path so it does not become a wider regex', () => {
    expect(buildPayload('firewall', form({ matchType: 'pathPrefix', path: '/a.b' }), ZONE, 'block')?.expression)
      .toBe('(http.request.uri.path matches "^/a\\.b.*")')
  })

  it('refuses to send a rule the fields cannot describe', () => {
    expect(buildPayload('firewall', form({ matchType: 'custom', expression: '   ' }), ZONE, 'block')).toBeNull()
    expect(buildPayload('firewall', form({ matchType: 'pathPrefix' }), ZONE, 'block')).toBeNull()
    expect(buildPayload('firewall', form({ matchType: 'hostAndPath', subdomain: 'api' }), ZONE, 'block')).toBeNull()
  })

  it('shapes the action the way the phase expects', () => {
    expect(buildPayload('origin', form({ port: 8080 }), ZONE, 'route')?.action_parameters)
      .toEqual({ origin: { port: 8080 } })
    expect(buildPayload('redirect', form({ redirectUrl: 'https://new.example.com/x', redirectStatus: 302 }), ZONE, 'redirect')?.action_parameters)
      .toEqual({ from_value: { target: { url: 'https://new.example.com/x' }, status_code: 302 } })
    expect(buildPayload('transform', form({ rewriteTarget: 'query', rewriteValue: 'concat("a=", http.request.uri.args.a)' }), ZONE, 'rewrite')?.action_parameters)
      .toEqual({ uri: { query: { expression: 'concat("a=", http.request.uri.args.a)' } } })
    expect(buildPayload('request_headers', form({ headerOp: 'set', headerName: 'X-Frame-Options', headerValue: 'DENY' }), ZONE, 'rewrite')?.action_parameters)
      .toEqual({ headers: { request: { set: { 'X-Frame-Options': 'DENY' } } } })
    expect(buildPayload('response_headers', form({ headerOp: 'remove', headerName: 'X-Powered-By' }), ZONE, 'rewrite')?.action_parameters)
      .toEqual({ headers: { response: { remove: ['X-Powered-By'] } } })
    expect(buildPayload('cache_settings', form({ cacheEnabled: true }), ZONE, 'set_cache_settings')?.action_parameters)
      .toEqual({ cache: true, edge_ttl: { mode: 'respect_origin_ttl' } })
    expect(buildPayload('cache_settings', form({ cacheEnabled: false, ttlMode: 'custom', ttlSeconds: 600 }), ZONE, 'set_cache_settings')?.action_parameters)
      .toEqual({ cache: false, edge_ttl: { mode: 'override', value: 600 } })
    expect(buildPayload('rate_limit', form({ limitAction: 'challenge', limitPeriod: 60, limitRequests: 20, limitMitigation: 600 }), ZONE, 'challenge')?.action_parameters)
      .toEqual({ characteristics: ['ip'], period: 60, requests_per_period: 20, mitigation_timeout: 600 })
  })

  it('reads a stored rule back into the fields it came from', () => {
    const rule: DnsRule = {
      expression: '(http.host eq "api.example.com" and http.request.uri.path matches "^/v1.*")',
      action: 'rewrite',
      action_parameters: { headers: { request: { set: { 'X-Env': 'prod' } } } },
    }
    const parsed = formFromRule(rule, 'request_headers', ZONE)
    expect(parsed.matchType).toBe('hostAndPath')
    expect(parsed.subdomain).toBe('api')
    expect(parsed.path).toBe('/v1')
    expect(parsed.headerOp).toBe('set')
    expect(parsed.headerName).toBe('X-Env')
    expect(parsed.headerValue).toBe('prod')
    // And round-trips: what the form would send is what the rule said.
    expect(buildPayload('request_headers', parsed, ZONE, 'rewrite')).toEqual({
      expression: rule.expression,
      action: 'rewrite',
      action_parameters: { headers: { request: { set: { 'X-Env': 'prod' } } } },
    })
  })

  it('keeps an expression the fields cannot describe', () => {
    const rule: DnsRule = { expression: '(ip.geoip.country eq "CN")', action: 'block' }
    const parsed = formFromRule(rule, 'firewall', ZONE)
    expect(parsed.matchType).toBe('custom')
    expect(parsed.expression).toBe('(ip.geoip.country eq "CN")')
    expect(buildPayload('firewall', parsed, ZONE, 'block')?.expression).toBe('(ip.geoip.country eq "CN")')
  })
})
