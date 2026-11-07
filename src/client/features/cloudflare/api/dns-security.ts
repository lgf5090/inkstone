/**
 * The DNS screen's door to the zone-level extras: Page Rules, URL normalization, SSL packs and IP
 * Access Rules. Every path is encoded here, and the domain is part of the path, never of a body.
 */
import { cfRequest } from './client'

export interface PageRule {
  id: string
  status: string
  priority: number | null
  target: string
  constraint_operator: string
  action_ids: string[]
}

export interface UrlNormalization {
  type: 'cloudflare' | 'rfc3986'
  scope: 'incoming' | 'both'
}

export interface SslCertificateEntry {
  id: string
  issuer: string
  status: string
  expires_on: string
}

export interface SslCertificatePack {
  id: string
  type: string
  hosts: string[]
  status: string
  certificate_authority: string
  certificates: SslCertificateEntry[]
}

export interface UniversalSslSettings {
  enabled: boolean
}

export type IpRuleMode = 'block' | 'challenge' | 'js_challenge' | 'managed_challenge' | 'whitelist'
export type IpRuleTarget = 'ip' | 'ip6' | 'ip_range' | 'country' | 'asn'

export interface IpAccessRule {
  id: string
  mode: IpRuleMode
  target: IpRuleTarget
  value: string
  notes: string
  created_on: string
  modified_on: string
}

export interface IpAccessRuleInput {
  mode: IpRuleMode
  target: IpRuleTarget
  value: string
  notes: string
}

export const IP_RULE_MODES: readonly IpRuleMode[] = [
  'block', 'challenge', 'js_challenge', 'managed_challenge', 'whitelist',
]

export const IP_RULE_TARGETS: readonly IpRuleTarget[] = ['ip', 'ip6', 'ip_range', 'country', 'asn']

function domainPath(domain: string): string {
  return `/dns/domains/${encodeURIComponent(domain)}`
}

export const dnsSecurityApi = {
  listPageRules: (domain: string) =>
    cfRequest<{ pageRules: PageRule[] }>(`${domainPath(domain)}/page-rules`),
  updatePageRuleStatus: (domain: string, ruleId: string, status: 'active' | 'disabled') =>
    cfRequest<PageRule>(`${domainPath(domain)}/page-rules/${encodeURIComponent(ruleId)}`, {
      method: 'PATCH',
      body: { status },
    }),
  deletePageRule: (domain: string, ruleId: string) =>
    cfRequest<{ deleted: string }>(`${domainPath(domain)}/page-rules/${encodeURIComponent(ruleId)}`, {
      method: 'DELETE',
    }),

  getUrlNormalization: (domain: string) =>
    cfRequest<UrlNormalization>(`${domainPath(domain)}/url-normalization`),
  updateUrlNormalization: (domain: string, input: UrlNormalization) =>
    cfRequest<UrlNormalization>(`${domainPath(domain)}/url-normalization`, { method: 'PUT', body: input }),

  listSslCertificates: (domain: string) =>
    cfRequest<{ certificates: SslCertificatePack[] }>(`${domainPath(domain)}/ssl/certificates`),
  deleteSslCertificate: (domain: string, packId: string) =>
    cfRequest<{ deleted: string }>(
      `${domainPath(domain)}/ssl/certificates/${encodeURIComponent(packId)}`,
      { method: 'DELETE' },
    ),
  getUniversalSsl: (domain: string) =>
    cfRequest<UniversalSslSettings>(`${domainPath(domain)}/ssl/universal`),
  updateUniversalSsl: (domain: string, enabled: boolean) =>
    cfRequest<UniversalSslSettings>(`${domainPath(domain)}/ssl/universal`, {
      method: 'PATCH',
      body: { enabled },
    }),

  listIpAccessRules: (domain: string) =>
    cfRequest<{ rules: IpAccessRule[]; truncated: boolean }>(`${domainPath(domain)}/ip-access-rules`),
  createIpAccessRule: (domain: string, input: IpAccessRuleInput) =>
    cfRequest<IpAccessRule>(`${domainPath(domain)}/ip-access-rules`, { method: 'POST', body: input }),
  updateIpAccessRule: (domain: string, ruleId: string, input: Partial<IpAccessRuleInput>) =>
    cfRequest<IpAccessRule>(`${domainPath(domain)}/ip-access-rules/${encodeURIComponent(ruleId)}`, {
      method: 'PATCH',
      body: input,
    }),
  deleteIpAccessRule: (domain: string, ruleId: string) =>
    cfRequest<{ deleted: string }>(`${domainPath(domain)}/ip-access-rules/${encodeURIComponent(ruleId)}`, {
      method: 'DELETE',
    }),
}
