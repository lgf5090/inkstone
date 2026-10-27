/**
 * The DNS screen's door to `/api/cloudflare/dns`.
 *
 * The screen never builds a URL beyond a domain or a rule id, and both are encoded here so a name a
 * reader typed cannot change which endpoint a call reaches.
 */
import { cfRequest } from './client'

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV' | 'CAA' | 'PTR'

export interface DnsZone {
  id: string
  name: string
  status: string
  paused: boolean
  name_servers: string[]
  original_name_servers: string[]
  created_on: string
  modified_on: string
  cfAccountId: string
  accountName: string
}

export interface DnsAccountOption {
  id: string
  name: string
  canCreateZone: boolean
}

export interface DnsDomainsResponse {
  domains: DnsZone[]
  accounts: DnsAccountOption[]
}

export interface DnsRecord {
  id: string
  type: string
  name: string
  content: string
  ttl: number
  proxied: boolean
  priority?: number
  weight?: number
  port?: number
}

export interface RecordInput {
  type: DnsRecordType
  name: string
  content: string
  ttl: number
  proxied: boolean
  priority?: number
  weight?: number
  port?: number
}

export interface ZoneMinify {
  js?: boolean
  css?: boolean
  html?: boolean
}

export interface ZoneSettings {
  ssl?: string
  always_use_https?: string
  automatic_https_rewrites?: string
  security_level?: string
  cache_level?: string
  browser_cache_ttl?: number
  development_mode?: string
  minify?: ZoneMinify
  brotli?: string
  zero_rtt?: string
}

export interface UpdateSettingsResult {
  updated: string[]
  failed: string[]
}

export interface DomainResult {
  name: string
  success: boolean
  zone_id?: string
  name_servers?: string[]
  error?: string
}

export interface DomainBatchResult {
  total: number
  succeeded: number
  failed: number
  results: DomainResult[]
}

export interface CreateDomainsInput {
  names: string[]
  account_id: string
  type: 'full' | 'partial'
}

export interface PurgeCacheInput {
  purge_everything?: boolean
  files?: string[]
}

export type RulePhase =
  | 'origin'
  | 'redirect'
  | 'transform'
  | 'request_headers'
  | 'response_headers'
  | 'cache_settings'
  | 'firewall'
  | 'rate_limit'

export interface DnsRule {
  id?: string
  description?: string
  expression: string
  action: string
  action_parameters?: Record<string, unknown>
  enabled?: boolean
}

export interface RuleInput {
  description?: string
  expression: string
  action: string
  action_parameters?: Record<string, unknown>
  enabled: boolean
}

export interface RulesResponse {
  rules: DnsRule[]
}

function domainPath(domain: string): string {
  return `/dns/domains/${encodeURIComponent(domain)}`
}

export const dnsApi = {
  listDomains: () => cfRequest<DnsDomainsResponse>('/dns/domains'),
  createDomains: (input: CreateDomainsInput) =>
    cfRequest<DomainBatchResult>('/dns/domains', { method: 'POST', body: input }),
  deleteDomains: (domains: string[]) =>
    cfRequest<DomainBatchResult>('/dns/domains', { method: 'DELETE', body: { domains } }),

  listRecords: (domain: string) => cfRequest<DnsRecord[]>(`${domainPath(domain)}/records`),
  createRecord: (domain: string, input: RecordInput) =>
    cfRequest<DnsRecord>(`${domainPath(domain)}/records`, { method: 'POST', body: input }),
  updateRecord: (domain: string, recordId: string, input: RecordInput) =>
    cfRequest<DnsRecord>(`${domainPath(domain)}/records/${encodeURIComponent(recordId)}`, {
      method: 'PUT',
      body: input,
    }),
  deleteRecord: (domain: string, recordId: string) =>
    cfRequest<{ id: string }>(`${domainPath(domain)}/records/${encodeURIComponent(recordId)}`, {
      method: 'DELETE',
    }),
  updateProxy: (domain: string, recordId: string, proxied: boolean) =>
    cfRequest<{ success: true }>(`${domainPath(domain)}/proxy`, {
      method: 'PATCH',
      body: { record_id: recordId, proxied },
    }),

  getSettings: (domain: string) => cfRequest<ZoneSettings>(`${domainPath(domain)}/settings`),
  updateSettings: (domain: string, settings: ZoneSettings) =>
    cfRequest<UpdateSettingsResult>(`${domainPath(domain)}/settings`, {
      method: 'PATCH',
      body: settings,
    }),
  purgeCache: (domain: string, input: PurgeCacheInput) =>
    cfRequest<{ id: string }>(`${domainPath(domain)}/purge-cache`, { method: 'POST', body: input }),
  updateStatus: (domain: string, paused: boolean) =>
    cfRequest<{ success: true }>(`${domainPath(domain)}/status`, {
      method: 'PATCH',
      body: { paused },
    }),

  listRules: (domain: string, phase: RulePhase) =>
    cfRequest<RulesResponse>(`${domainPath(domain)}/rules/${phase}`),
  createRule: (domain: string, phase: RulePhase, input: RuleInput) =>
    cfRequest<RulesResponse>(`${domainPath(domain)}/rules/${phase}`, { method: 'POST', body: input }),
  updateRule: (domain: string, phase: RulePhase, ruleId: string, input: RuleInput) =>
    cfRequest<RulesResponse>(`${domainPath(domain)}/rules/${phase}/${encodeURIComponent(ruleId)}`, {
      method: 'PUT',
      body: input,
    }),
  deleteRule: (domain: string, phase: RulePhase, ruleId: string) =>
    cfRequest<{ deleted: string }>(
      `${domainPath(domain)}/rules/${phase}/${encodeURIComponent(ruleId)}`,
      { method: 'DELETE' },
    ),
}
