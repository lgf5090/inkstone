import { z } from 'zod'
import { CERTHUB_LIMITS } from './limits'
import {
  CERTHUB_ACTIONS,
  CERTHUB_CAS,
  CERTHUB_CHALLENGE_MODES,
  CERTHUB_KEY_ALGORITHMS,
  CERTHUB_TOKEN_SCOPES,
  type CerthubChallengeMode,
  type CerthubDomainInput,
  type CerthubSubject,
} from './types'

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/
const IPV6 = /^(?:(?:[0-9a-f]{1,4}:){1,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4}|::)$/i
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export interface NormalizedDomain {
  name: string
  isIp: boolean
}

export function isIpAddress(value: string): boolean {
  return IPV4.test(value) || IPV6.test(value)
}

export function normalizeDomain(raw: string): NormalizedDomain {
  const input = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!input) throw new Error('domain_required')
  if (/[\s/@?#]/.test(input)) throw new Error('domain_invalid')
  if (isIpAddress(input)) return { name: input, isIp: true }
  let host = input.startsWith('*.') ? input.slice(2) : input
  if (!host || host.startsWith('.') || host.includes('..')) throw new Error('domain_invalid')
  try {
    host = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    throw new Error('domain_invalid')
  }
  if (host.startsWith('*') || host.includes('*')) throw new Error('domain_invalid')
  const labels = host.split('.')
  if (labels.length < 2) throw new Error('domain_invalid')
  if (!labels.every((label) => LABEL.test(label))) throw new Error('domain_invalid')
  if (host.length > 253) throw new Error('domain_invalid')
  return { name: host, isIp: false }
}

export interface ValidatedDomain {
  name: string
  wildcard: boolean
  primary: boolean
  challengeMode: CerthubChallengeMode
  dnsProviderId: string
  isIp: boolean
}

export function validateDomainRows(rows: CerthubDomainInput[], max = CERTHUB_LIMITS.maxDomainsPerOrder): ValidatedDomain[] {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('domains_required')
  if (rows.length > max) throw new Error('domains_too_many')
  const result: ValidatedDomain[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const normalized = normalizeDomain(String(row.name ?? ''))
    const wildcard = Boolean(row.wildcard) && !normalized.isIp
    if (normalized.isIp) {
      if (row.wildcard) throw new Error('wildcard_ip_invalid')
      if (row.challengeMode && row.challengeMode !== 'http-01') throw new Error('ip_requires_http01')
    }
    if (wildcard && row.challengeMode && row.challengeMode !== 'dns-01') throw new Error('wildcard_requires_dns01')
    const challengeMode: CerthubChallengeMode = normalized.isIp
      ? 'http-01'
      : wildcard
        ? 'dns-01'
        : (row.challengeMode ?? 'dns-01')
    const key = `${wildcard ? '*.' : ''}${normalized.name}`
    if (seen.has(key)) throw new Error('domain_duplicate')
    seen.add(key)
    result.push({
      name: normalized.name,
      wildcard,
      primary: Boolean(row.primary ?? false),
      challengeMode,
      dnsProviderId: challengeMode === 'dns-01' ? String(row.dnsProviderId ?? '') : '',
      isIp: normalized.isIp,
    })
  }
  if (result.length > 1 && result.filter((row) => row.primary).length !== 1) {
    if (result.filter((row) => row.primary).length === 0) result[0]!.primary = true
    else throw new Error('primary_ambiguous')
  }
  return result
}

export function certificateName(domain: Pick<ValidatedDomain, 'name' | 'wildcard'>): string {
  return domain.wildcard ? `*.${domain.name}` : domain.name
}

export function primaryCertificateName(domains: ValidatedDomain[]): string {
  const primary = domains.find((domain) => domain.primary) ?? domains[0]!
  return certificateName(primary)
}

export const subjectSchema = z
  .object({
    country: z.string().trim().max(2).optional(),
    state: z.string().trim().max(CERTHUB_LIMITS.maxSubjectFieldLength).optional(),
    locality: z.string().trim().max(CERTHUB_LIMITS.maxSubjectFieldLength).optional(),
    organization: z.string().trim().max(CERTHUB_LIMITS.maxSubjectFieldLength).optional(),
    organizationUnit: z.string().trim().max(CERTHUB_LIMITS.maxSubjectFieldLength).optional(),
  })
  .strict()
  .optional()

export const domainInputSchema = z
  .object({
    name: z.string().trim().min(1).max(253),
    wildcard: z.boolean().optional(),
    primary: z.boolean().optional(),
    challengeMode: z.enum(CERTHUB_CHALLENGE_MODES).optional(),
    dnsProviderId: z.string().trim().max(64).optional(),
  })
  .strict()

export const createOrderSchema = z
  .object({
    domains: z.array(domainInputSchema).min(1).max(CERTHUB_LIMITS.maxDomainsPerOrder),
    ca: z.enum(CERTHUB_CAS).optional(),
    keyAlgorithm: z.enum(CERTHUB_KEY_ALGORITHMS).optional(),
    autoRenew: z.boolean().optional(),
    subject: subjectSchema,
    captchaToken: z.string().trim().max(4096).optional(),
  })
  .strict()

export const actionSchema = z
  .object({
    action: z.enum(CERTHUB_ACTIONS),
    domainId: z.string().trim().max(64).optional(),
    revokeReason: z.number().int().min(0).max(10).optional(),
    confirm: z.string().trim().max(64).optional(),
  })
  .strict()

export const settingsSchema = z
  .object({
    defaultCa: z.enum(CERTHUB_CAS).optional(),
    defaultKeyAlgorithm: z.enum(CERTHUB_KEY_ALGORITHMS).optional(),
    defaultChallengeMode: z.enum(CERTHUB_CHALLENGE_MODES).optional(),
    defaultAutoRenew: z.boolean().optional(),
    renewDaysBefore: z.number().int().min(CERTHUB_LIMITS.minRenewDaysBefore).max(CERTHUB_LIMITS.maxRenewDaysBefore).optional(),
    notifyOnIssued: z.boolean().optional(),
    notifyOnFailed: z.boolean().optional(),
    notifyOnExpiring: z.boolean().optional(),
    notifyOnExpired: z.boolean().optional(),
    maxActiveCerts: z.number().int().min(0).max(CERTHUB_LIMITS.maxActiveCertsCeiling).optional(),
    requireReauthForKeys: z.boolean().optional(),
  })
  .strict()

export const accountSchema = z
  .object({
    ca: z.enum(CERTHUB_CAS),
    environment: z.enum(['production', 'staging']).optional(),
    privateKey: z.string().trim().max(16 * 1024).optional(),
  })
  .strict()

export const dnsProviderSchema = z
  .object({
    kind: z.enum(['cloudflare', 'dcv-delegate']),
    label: z.string().trim().min(1).max(CERTHUB_LIMITS.maxProviderLabelLength),
    zoneId: z.string().trim().regex(/^[a-f0-9]{32}$/i).optional().or(z.literal('')),
    zoneName: z.string().trim().max(253).optional().or(z.literal('')),
    accountEmail: z.string().trim().max(253).optional().or(z.literal('')),
    secret: z.string().trim().max(4096).optional().or(z.literal('')),
  })
  .strict()

export const tokenCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(CERTHUB_LIMITS.maxTokenNameLength),
    scopes: z.array(z.enum(CERTHUB_TOKEN_SCOPES)).min(1).optional(),
    expiresAt: z.number().int().positive().optional(),
  })
  .strict()

export const tokenPatchSchema = z
  .object({
    confirm: z.string().trim().max(64).optional(),
  })
  .strict()

export const configPatchSchema = z
  .object({
    enabledCas: z.array(z.enum(CERTHUB_CAS)).min(1).max(CERTHUB_CAS.length).optional(),
    maxOrdersPerDay: z.number().int().min(1).max(100).optional(),
    maxOrdersPerMonth: z.number().int().min(1).max(1000).optional(),
    maxPendingOrders: z.number().int().min(1).max(100).optional(),
    maxActiveCertsDefault: z.number().int().min(1).max(CERTHUB_LIMITS.maxActiveCertsCeiling).optional(),
    maxDomainsPerOrder: z.number().int().min(1).max(50).optional(),
    acmeTimeoutMs: z.number().int().min(5000).max(60000).optional(),
    jobBatchSize: z.number().int().min(1).max(60).optional(),
  })
  .strict()

export const adminUserLimitsSchema = z
  .object({
    maxActiveCerts: z.number().int().min(0).max(CERTHUB_LIMITS.maxActiveCertsCeiling),
  })
  .strict()

export function subjectFromInput(subject: CerthubSubject | undefined): CerthubSubject {
  if (!subject) return {}
  return {
    ...(subject.country ? { country: subject.country.toUpperCase() } : {}),
    ...(subject.state ? { state: subject.state } : {}),
    ...(subject.locality ? { locality: subject.locality } : {}),
    ...(subject.organization ? { organization: subject.organization } : {}),
    ...(subject.organizationUnit ? { organizationUnit: subject.organizationUnit } : {}),
  }
}
