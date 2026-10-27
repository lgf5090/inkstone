/**
 * The fixed value tables the DNS screen draws.
 *
 * These are Cloudflare's own identifiers (SSL modes, cache levels, rule actions), not prose: they
 * are shown as the API spells them so what a reader picks is what the request carries.
 */
import type { DnsRecordType, RulePhase } from '../../api/dns'
import type { CloudflareMessageKey } from '../../i18n'

export interface Choice<T extends string | number = string> {
  value: T
  label: string
}

export const RECORD_TYPE_CHOICES: readonly Choice<DnsRecordType>[] = [
  { value: 'A', label: 'A' },
  { value: 'AAAA', label: 'AAAA' },
  { value: 'CNAME', label: 'CNAME' },
  { value: 'MX', label: 'MX' },
  { value: 'TXT', label: 'TXT' },
  { value: 'NS', label: 'NS' },
  { value: 'SRV', label: 'SRV' },
  { value: 'CAA', label: 'CAA' },
  { value: 'PTR', label: 'PTR' },
]

export const PROXIABLE_TYPES: ReadonlySet<string> = new Set(['A', 'AAAA', 'CNAME'])

export function isProxiable(type: string): boolean {
  return PROXIABLE_TYPES.has(type)
}

export const SSL_CHOICES: readonly Choice[] = [
  { value: 'off', label: 'Off' },
  { value: 'flexible', label: 'Flexible' },
  { value: 'full', label: 'Full' },
  { value: 'strict', label: 'Full (strict)' },
]

export const SECURITY_CHOICES: readonly Choice[] = [
  { value: 'essentially_off', label: 'Essentially off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'under_attack', label: 'Under attack' },
]

export const CACHE_LEVEL_CHOICES: readonly Choice[] = [
  { value: 'off', label: 'Off' },
  { value: 'simplify', label: 'Simplify' },
  { value: 'aggressive', label: 'Aggressive' },
]

export const BROWSER_TTL_CHOICES: readonly Choice<number>[] = [
  { value: 0, label: 'Respect existing' },
  { value: 30, label: '30 s' },
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
  { value: 1200, label: '20 min' },
  { value: 1800, label: '30 min' },
  { value: 3600, label: '1 h' },
  { value: 7200, label: '2 h' },
  { value: 10800, label: '3 h' },
  { value: 14400, label: '4 h' },
  { value: 28800, label: '8 h' },
  { value: 43200, label: '12 h' },
  { value: 57600, label: '16 h' },
  { value: 86400, label: '1 d' },
]

export const RULE_PHASE_CHOICES: ReadonlyArray<{ value: RulePhase; labelKey: CloudflareMessageKey }> = [
  { value: 'origin', labelKey: 'cloudflare.tunnels.rule_phases.origin' },
  { value: 'redirect', labelKey: 'cloudflare.tunnels.rule_phases.redirect' },
  { value: 'transform', labelKey: 'cloudflare.tunnels.rule_phases.transform' },
  { value: 'request_headers', labelKey: 'cloudflare.tunnels.rule_phases.request_headers' },
  { value: 'response_headers', labelKey: 'cloudflare.tunnels.rule_phases.response_headers' },
  { value: 'cache_settings', labelKey: 'cloudflare.tunnels.rule_phases.cache_settings' },
  { value: 'firewall', labelKey: 'cloudflare.tunnels.rule_phases.firewall' },
  { value: 'rate_limit', labelKey: 'cloudflare.tunnels.rule_phases.rate_limit' },
]

/** Actions Cloudflare accepts for each phase; the dialog offers only these. */
export const RULE_PHASE_ACTIONS: Readonly<Record<RulePhase, readonly string[]>> = {
  origin: ['route'],
  redirect: ['redirect'],
  transform: ['rewrite'],
  request_headers: ['rewrite'],
  response_headers: ['rewrite'],
  cache_settings: ['set_cache_settings'],
  firewall: ['block', 'managed_challenge', 'js_challenge', 'challenge', 'log'],
  rate_limit: ['block', 'managed_challenge', 'js_challenge', 'challenge'],
}

export const STATUS_LABEL_KEYS: Readonly<Record<string, CloudflareMessageKey>> = {
  active: 'cloudflare.dns.status_active',
  pending: 'cloudflare.dns.status_pending',
  paused: 'cloudflare.dns.status_paused',
  moved: 'cloudflare.dns.status_moved',
  initializing: 'cloudflare.dns.status_initializing',
}

export function statusTone(status: string): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'active': return 'success'
    case 'pending': return 'warning'
    case 'moved': return 'danger'
    case 'initializing': return 'accent'
    default: return 'neutral'
  }
}

/** The translated status, or Cloudflare's own word when it is one this build does not know. */
export function statusText(translate: (key: CloudflareMessageKey) => string, status: string): string {
  const key = STATUS_LABEL_KEYS[status]
  return key ? translate(key) : status
}
