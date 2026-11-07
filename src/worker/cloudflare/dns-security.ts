/**
 * Zone-level security extras that Cloudflare keeps outside the ruleset engine: legacy Page Rules,
 * URL normalization, SSL certificate packs and legacy IP Access Rules.
 *
 * Each converter keeps only the fields the screen shows. Cloudflare returns many more (certificate
 * bundles, rule targets with unknown shapes); passing them through would invite the screen to render
 * values it never modelled, while dropping them entirely would leave an edit unable to round-trip.
 */
import { ApiError } from '../lib/errors'

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

export const IP_RULE_MODES = ['block', 'challenge', 'js_challenge', 'managed_challenge', 'whitelist'] as const
export type IpRuleMode = (typeof IP_RULE_MODES)[number]

export const IP_RULE_TARGETS = ['ip', 'ip6', 'ip_range', 'country', 'asn'] as const
export type IpRuleTarget = (typeof IP_RULE_TARGETS)[number]

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

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** One row of Cloudflare's Page Rules list; the target and action ids are all the table shows. */
export function toPageRule(value: unknown): PageRule | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  const targets = asArray(row.targets).map((item) => asRecord(item))
  const constraint = asRecord(targets[0]?.constraint)
  return {
    id,
    status: textOf(row.status),
    priority: typeof row.priority === 'number' ? row.priority : null,
    target: textOf(constraint.value),
    constraint_operator: textOf(constraint.operator),
    action_ids: asArray(row.actions)
      .map((item) => textOf(asRecord(item).id))
      .filter(Boolean),
  }
}

/** Cloudflare's URL normalization result is a small enum pair, not an object of settings. */
export function toUrlNormalization(value: unknown): UrlNormalization {
  const row = asRecord(value)
  const type = row.type === 'rfc3986' ? 'rfc3986' : 'cloudflare'
  const scope = row.scope === 'both' ? 'both' : 'incoming'
  return { type, scope }
}

export function toCertificatePack(value: unknown): SslCertificatePack | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  return {
    id,
    type: textOf(row.type),
    hosts: asArray(row.hosts).filter((item): item is string => typeof item === 'string'),
    status: textOf(row.status),
    certificate_authority: textOf(row.certificate_authority),
    certificates: asArray(row.certificates).map((item) => {
      const entry = asRecord(item)
      return {
        id: textOf(entry.id),
        issuer: textOf(entry.issuer),
        status: textOf(entry.status),
        expires_on: textOf(entry.expires_on),
      }
    }).filter((entry) => entry.id || entry.issuer),
  }
}

export function toUniversalSsl(value: unknown): UniversalSslSettings {
  return { enabled: asRecord(value).enabled === true }
}

export function toIpAccessRule(value: unknown): IpAccessRule | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  const mode = textOf(row.mode)
  if (!id || !IP_RULE_MODES.includes(mode as IpRuleMode)) return null
  const configuration = asRecord(row.configuration)
  const target = textOf(configuration.target)
  if (!IP_RULE_TARGETS.includes(target as IpRuleTarget)) return null
  return {
    id,
    mode: mode as IpRuleMode,
    target: target as IpRuleTarget,
    value: textOf(configuration.value),
    notes: textOf(row.notes),
    created_on: textOf(row.created_on),
    modified_on: textOf(row.modified_on),
  }
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
function isIpv4(value: string): boolean {
  return IPV4.test(value) && value.split('.').every((part) => Number(part) <= 255)
}

function isIpv6(value: string): boolean {
  return value.includes(':') && value.length <= 45 && /^[0-9a-fA-F:.]+$/.test(value)
}

function isIpRange(value: string): boolean {
  const [address, prefix, extra] = value.split('/')
  if (extra !== undefined || !address || !prefix) return false
  const bits = Number(prefix)
  if (!Number.isInteger(bits)) return false
  if (isIpv4(address)) return bits >= 0 && bits <= 32
  if (isIpv6(address)) return bits >= 0 && bits <= 128
  return false
}

function isCountry(value: string): boolean {
  return /^[A-Za-z]{2}$/.test(value)
}

/** Validates an IP Access Rule body before it reaches Cloudflare. */
export function parseIpAccessRuleInput(body: Record<string, unknown>, partial: boolean): Partial<IpAccessRuleInput> {
  const out: Partial<IpAccessRuleInput> = {}

  if (body.mode !== undefined || !partial) {
    const mode = textOf(body.mode)
    if (!IP_RULE_MODES.includes(mode as IpRuleMode)) {
      throw ApiError.badRequest(`mode must be one of ${IP_RULE_MODES.join(', ')}`)
    }
    out.mode = mode as IpRuleMode
  }

  if (body.target !== undefined || !partial) {
    const target = textOf(body.target)
    if (!IP_RULE_TARGETS.includes(target as IpRuleTarget)) {
      throw ApiError.badRequest(`target must be one of ${IP_RULE_TARGETS.join(', ')}`)
    }
    out.target = target as IpRuleTarget
  }

  const value = textOf(body.value).trim()
  if (value || !partial) {
    if (!value) throw ApiError.badRequest('value is required')
    const target = out.target
    if (target === 'ip' && !isIpv4(value)) throw ApiError.badRequest('An ip rule needs an IPv4 address')
    if (target === 'ip6' && !isIpv6(value)) throw ApiError.badRequest('An ip6 rule needs an IPv6 address')
    if (target === 'ip_range' && !isIpRange(value)) throw ApiError.badRequest('An ip_range rule needs a CIDR range')
    if (target === 'country' && !isCountry(value)) throw ApiError.badRequest('A country rule needs an ISO country code')
    if (target === 'asn' && !/^\d{1,10}$/.test(value)) throw ApiError.badRequest('An asn rule needs a number')
    out.value = value
  }

  if (body.notes !== undefined || !partial) {
    const notes = textOf(body.notes).trim()
    if (notes.length > 500) throw ApiError.badRequest('notes may be at most 500 characters')
    out.notes = notes
  }

  return out
}

/** The Cloudflare body for create/update: exactly the fields that were supplied. */
export function ipAccessRulePayload(input: Partial<IpAccessRuleInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (input.mode) body.mode = input.mode
  if (input.target && input.value) {
    body.configuration = { target: input.target, value: input.value }
  }
  if (input.notes !== undefined) body.notes = input.notes
  return body
}

export const URL_NORMALIZATION_TYPES = ['cloudflare', 'rfc3986'] as const
export const URL_NORMALIZATION_SCOPES = ['incoming', 'both'] as const
