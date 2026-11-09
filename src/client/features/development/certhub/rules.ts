import { validateDomainRows } from '@shared/development/certhub/validation'

export interface ApplyDomainInput {
  name: string
  wildcard: boolean
  primary: boolean
  challengeMode: 'dns-01' | 'http-01'
  dnsProviderId: string
}

const ERROR_KEYS: Record<string, string> = {
  domains_required: 'development.certhub.apply.error.domains_required',
  domains_too_many: 'development.certhub.apply.error.domains_too_many',
  domain_required: 'development.certhub.apply.error.domain_required',
  domain_invalid: 'development.certhub.apply.error.domain_invalid',
  domain_duplicate: 'development.certhub.apply.error.domain_duplicate',
  wildcard_ip_invalid: 'development.certhub.apply.error.wildcard_ip_invalid',
  ip_requires_http01: 'development.certhub.apply.error.ip_requires_http01',
  wildcard_requires_dns01: 'development.certhub.apply.error.wildcard_requires_dns01',
  primary_ambiguous: 'development.certhub.apply.error.primary_ambiguous',
}

export function applyDomainErrorKey(rows: ApplyDomainInput[]): string | null {
  try {
    validateDomainRows(rows.map((row) => ({
      name: row.name,
      wildcard: row.wildcard,
      primary: row.primary,
      challengeMode: row.challengeMode,
      dnsProviderId: row.dnsProviderId || undefined,
    })))
    return null
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    return ERROR_KEYS[reason] ?? 'development.certhub.apply.error.domain_invalid'
  }
}

export function applyChallengeOptions(wildcard: boolean): Array<{ value: 'dns-01' | 'http-01'; labelKey: string; disabled?: boolean }> {
  return [
    { value: 'dns-01', labelKey: 'development.certhub.apply.dns_manual' },
    { value: 'http-01', labelKey: 'development.certhub.apply.http_manual', ...(wildcard ? { disabled: true } : {}) },
  ]
}

export type DnsKind = 'cloudflare' | 'dcv-delegate'

// The matching rule lives in the shared layer because the worker repairs stored orders with it too;
// a client-only copy would let the form and the repair path disagree about a domain's zone.
export { matchProviderForDomain } from '@shared/development/certhub/provider-match'

const ZONE_ID = /^[a-f0-9]{32}$/i

export function dnsLabelErrorKey(label: string): string | null {
  return label.trim() ? null : 'development.certhub.dns.error.label_required'
}

export function dnsConnectionErrorKeys(kind: DnsKind, zoneId: string, token: string): { zoneId?: string; token?: string } {
  if (kind !== 'cloudflare') return {}
  const next: { zoneId?: string; token?: string } = {}
  if (!zoneId.trim()) next.zoneId = 'development.certhub.dns.error.zone_id_required'
  else if (!ZONE_ID.test(zoneId.trim())) next.zoneId = 'development.certhub.dns.error.zone_id_invalid'
  if (!token.trim()) next.token = 'development.certhub.dns.error.token_required'
  return next
}
