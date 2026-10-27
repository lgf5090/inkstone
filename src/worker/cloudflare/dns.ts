/**
 * DNS zones and the shapes their endpoints accept.
 *
 * The reference module resolved a domain by listing every active account's zones on every call, and
 * that is kept: Cloudflare has no "zone by name" lookup, and a cached mapping would go stale exactly
 * when a reader adds or removes a zone. What is not kept is the reference's silent swallowing of
 * per-account failures — a listing keeps the other accounts, while a lookup that could not check
 * every account says so instead of reporting a 404 it cannot prove.
 */
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { cfFetchAll } from './cf-api'
import { accountHasFeature, loadActiveAccounts, type LoadedAccount } from './accounts'

export interface DnsZone {
  id: string
  name: string
  status: string
  paused: boolean
  name_servers: string[]
  original_name_servers: string[]
  created_on: string
  modified_on: string
  /** The reader's account row id, not Cloudflare's account id. */
  cfAccountId: string
  accountName: string
}

export interface ZoneTarget {
  account: LoadedAccount
  zoneId: string
  zoneName: string
}

interface CfZone {
  id?: unknown
  name?: unknown
  status?: unknown
  paused?: unknown
  name_servers?: unknown
  original_name_servers?: unknown
  created_on?: unknown
  modified_on?: unknown
}

const ZONE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function toZone(row: CfZone, account: LoadedAccount): DnsZone | null {
  const id = stringValue(row.id)
  const name = stringValue(row.name)
  if (!id || !name) return null
  return {
    id,
    name,
    status: stringValue(row.status),
    paused: row.paused === true,
    name_servers: stringList(row.name_servers),
    original_name_servers: stringList(row.original_name_servers),
    created_on: stringValue(row.created_on),
    modified_on: stringValue(row.modified_on),
    cfAccountId: account.row.id,
    accountName: account.row.name,
  }
}

/** The reader's active accounts that have the DNS feature switched on. */
export async function listDnsAccounts(env: Env, userId: string): Promise<LoadedAccount[]> {
  const accounts = await loadActiveAccounts(env, userId)
  return accounts.filter(({ row }) => accountHasFeature(row, 'dns'))
}

export interface DnsZoneList {
  zones: DnsZone[]
  accounts: LoadedAccount[]
}

/**
 * Every zone of every DNS account. One account's failure is logged and skipped: a reader with two
 * accounts should still see the second when the first token was revoked.
 */
export async function listDnsZones(env: Env, userId: string): Promise<DnsZoneList> {
  const accounts = await listDnsAccounts(env, userId)
  const zones: DnsZone[] = []
  for (const account of accounts) {
    try {
      const rows = await cfFetchAll<CfZone>(account.auth, '/zones', 50)
      for (const row of rows) {
        const zone = toZone(row, account)
        if (zone) zones.push(zone)
      }
    } catch (error) {
      console.warn(
        `[inkstone] Cloudflare zone listing failed (account ${account.row.id}):`,
        (error as Error)?.message,
      )
    }
  }
  return { zones, accounts }
}

/**
 * The account and zone id a domain belongs to. Exact name match only; Cloudflare names are already
 * lower-case and a near match would act on the wrong zone.
 */
export async function findDnsZone(env: Env, userId: string, domain: string): Promise<ZoneTarget> {
  const accounts = await listDnsAccounts(env, userId)
  let unreachable = false
  for (const account of accounts) {
    try {
      const rows = await cfFetchAll<CfZone>(account.auth, '/zones', 50)
      const row = rows.find((candidate) => stringValue(candidate.name) === domain)
      const zoneId = stringValue(row?.id)
      if (row && ZONE_ID_PATTERN.test(zoneId)) {
        return { account, zoneId, zoneName: stringValue(row.name) || domain }
      }
    } catch (error) {
      unreachable = true
      console.warn(
        `[inkstone] Cloudflare zone lookup failed (account ${account.row.id}):`,
        (error as Error)?.message,
      )
    }
  }
  if (unreachable) {
    throw new ApiError(502, 'cloudflare_upstream', 'Could not check every Cloudflare account for this domain')
  }
  throw ApiError.notFound('That domain does not belong to any of your Cloudflare accounts')
}

export const DOMAIN_BATCH_LIMIT = 50
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/i

export function parseDomainList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.badRequest(`${label} must be a non-empty array`)
  }
  const names: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw ApiError.badRequest(`${label} must contain only strings`)
    const name = item.trim().toLowerCase()
    if (!DOMAIN_PATTERN.test(name)) throw ApiError.badRequest(`Invalid domain name: ${item}`)
    if (!names.includes(name)) names.push(name)
  }
  if (names.length > DOMAIN_BATCH_LIMIT) {
    throw ApiError.badRequest(`${label} may contain at most ${DOMAIN_BATCH_LIMIT} domains`)
  }
  return names
}

export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'PTR'] as const
export type DnsRecordType = (typeof RECORD_TYPES)[number]

const PROXIABLE_TYPES: ReadonlySet<string> = new Set(['A', 'AAAA', 'CNAME'])

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

interface CfDnsRecord {
  id?: unknown
  type?: unknown
  name?: unknown
  content?: unknown
  ttl?: unknown
  proxied?: unknown
  priority?: unknown
  weight?: unknown
  port?: unknown
}

export function toDnsRecord(row: CfDnsRecord): DnsRecord {
  const record: DnsRecord = {
    id: stringValue(row.id),
    type: stringValue(row.type),
    name: stringValue(row.name),
    content: stringValue(row.content),
    ttl: typeof row.ttl === 'number' ? row.ttl : 1,
    proxied: row.proxied === true,
  }
  if (typeof row.priority === 'number') record.priority = row.priority
  if (typeof row.weight === 'number') record.weight = row.weight
  if (typeof row.port === 'number') record.port = row.port
  return record
}

function isHostname(value: string): boolean {
  const host = value.endsWith('.') ? value.slice(0, -1) : value
  if (!host || host.length > 253) return false
  return host.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?$/.test(label)
  ))
}

function isIPv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isIPv6(value: string): boolean {
  return value.includes(':') && value.length <= 45 && /^[0-9a-fA-F:.]+$/.test(value)
}

function isRecordName(value: string): boolean {
  if (value === '@' || value === '*') return true
  if (value.length > 255) return false
  return /^(\*\.)?[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/.test(value)
}

function readInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw ApiError.badRequest(`${label} must be an integer between ${min} and ${max}`)
  }
  return value
}

/** Validates one record body; every field the Cloudflare API would reject is refused here first. */
export function parseRecordInput(body: Record<string, unknown>): RecordInput {
  const rawType = typeof body.type === 'string' ? body.type.trim().toUpperCase() : ''
  if (!RECORD_TYPES.includes(rawType as DnsRecordType)) {
    throw ApiError.badRequest(`type must be one of ${RECORD_TYPES.join(', ')}`)
  }
  const type = rawType as DnsRecordType
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) throw ApiError.badRequest('A record name is required')
  if (!isRecordName(name)) throw ApiError.badRequest('The record name contains characters Cloudflare does not accept')
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (!content) throw ApiError.badRequest('Record content is required')
  if (content.length > 2048) throw ApiError.badRequest('Record content is too long')
  if (/[\u0000-\u001f\u007f]/.test(content)) throw ApiError.badRequest('Record content contains control characters')

  if (type === 'A' && !isIPv4(content)) throw ApiError.badRequest('An A record needs an IPv4 address')
  if (type === 'AAAA' && !isIPv6(content)) throw ApiError.badRequest('An AAAA record needs an IPv6 address')
  if (type === 'CNAME' || type === 'NS' || type === 'PTR' || type === 'MX' || type === 'SRV') {
    if (!isHostname(content)) throw ApiError.badRequest('The record content must be a hostname')
  }

  const ttl = body.ttl === undefined ? 1 : readInteger(body.ttl, 'TTL', 1, 86400)
  if (ttl !== 1 && ttl < 60) throw ApiError.badRequest('TTL must be 1 (automatic) or at least 60 seconds')

  if (body.proxied !== undefined && typeof body.proxied !== 'boolean') {
    throw ApiError.badRequest('proxied must be a boolean')
  }
  const proxied = body.proxied === true
  if (proxied && !PROXIABLE_TYPES.has(type)) {
    throw ApiError.badRequest(`A ${type} record cannot be proxied`)
  }

  const input: RecordInput = { type, name, content, ttl, proxied }
  if (type === 'MX') {
    input.priority = body.priority === undefined ? 10 : readInteger(body.priority, 'Priority', 0, 65535)
  }
  if (type === 'SRV') {
    input.priority = body.priority === undefined ? 0 : readInteger(body.priority, 'Priority', 0, 65535)
    input.weight = body.weight === undefined ? 0 : readInteger(body.weight, 'Weight', 0, 65535)
    input.port = body.port === undefined ? 0 : readInteger(body.port, 'Port', 0, 65535)
  }
  return input
}

/** Zone settings the screens may read and write, and the Cloudflare setting id each one maps to. */
export const SETTING_PATHS: Readonly<Record<string, string>> = {
  ssl: 'ssl',
  always_use_https: 'always_use_https',
  security_level: 'security_level',
  automatic_https_rewrites: 'automatic_https_rewrites',
  cache_level: 'cache_level',
  browser_cache_ttl: 'browser_cache_ttl',
  development_mode: 'development_mode',
  minify: 'minify',
  brotli: 'brotli',
  zero_rtt: '0rtt',
}

const SSL_MODES = ['off', 'flexible', 'full', 'strict'] as const
const SECURITY_LEVELS = ['essentially_off', 'low', 'medium', 'high', 'under_attack'] as const
const CACHE_LEVELS = ['off', 'simplify', 'aggressive'] as const
const BROWSER_TTLS: ReadonlySet<number> = new Set([0, 30, 60, 300, 1200, 1800, 3600, 7200, 10800, 14400, 28800, 43200, 57600, 86400])

export interface SettingEntry {
  key: string
  path: string
  value: unknown
}

function readEnum(value: unknown, label: string, allowed: readonly string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw ApiError.badRequest(`${label} must be one of ${allowed.join(', ')}`)
  }
  return value
}

function readSwitch(value: unknown, label: string): 'on' | 'off' {
  if (value !== 'on' && value !== 'off') throw ApiError.badRequest(`${label} must be "on" or "off"`)
  return value
}

function readMinify(value: unknown): { js: boolean; css: boolean; html: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('minify must be an object with js, css and html booleans')
  }
  const raw = value as Record<string, unknown>
  const out = { js: raw.js, css: raw.css, html: raw.html }
  if (typeof out.js !== 'boolean' || typeof out.css !== 'boolean' || typeof out.html !== 'boolean') {
    throw ApiError.badRequest('minify must be an object with js, css and html booleans')
  }
  return { js: out.js, css: out.css, html: out.html }
}

/** Validates a settings patch; unknown keys are an error rather than a silently skipped item. */
export function parseSettingsPatch(body: Record<string, unknown>): SettingEntry[] {
  const entries: SettingEntry[] = []
  const unknown: string[] = []
  for (const [key, value] of Object.entries(body)) {
    const path = SETTING_PATHS[key]
    if (!path) {
      unknown.push(key)
      continue
    }
    let normalized: unknown
    switch (key) {
      case 'ssl':
        normalized = readEnum(value, key, SSL_MODES)
        break
      case 'security_level':
        normalized = readEnum(value, key, SECURITY_LEVELS)
        break
      case 'cache_level':
        normalized = readEnum(value, key, CACHE_LEVELS)
        break
      case 'browser_cache_ttl':
        if (typeof value !== 'number' || !BROWSER_TTLS.has(value)) {
          throw ApiError.badRequest('browser_cache_ttl must be one of the Cloudflare-supported values')
        }
        normalized = value
        break
      case 'minify':
        normalized = readMinify(value)
        break
      default:
        normalized = readSwitch(value, key)
    }
    entries.push({ key, path, value: normalized })
  }
  if (unknown.length > 0) {
    throw ApiError.badRequest('Unknown zone settings', { unknown })
  }
  if (entries.length === 0) throw ApiError.badRequest('No settings were provided')
  return entries
}

export const RULE_PHASES = {
  origin: { phase: 'http_request_origin', scope: 'zone' },
  redirect: { phase: 'http_request_redirect', scope: 'account' },
  transform: { phase: 'http_request_transform', scope: 'zone' },
  request_headers: { phase: 'http_request_late_transform', scope: 'zone' },
  response_headers: { phase: 'http_response_headers_transform', scope: 'zone' },
  cache_settings: { phase: 'http_request_cache_settings', scope: 'zone' },
  firewall: { phase: 'http_request_firewall_custom', scope: 'zone' },
  rate_limit: { phase: 'http_ratelimit', scope: 'zone' },
} as const

export type RulePhase = keyof typeof RULE_PHASES

export function isRulePhase(value: string): value is RulePhase {
  return Object.hasOwn(RULE_PHASES, value)
}

export function parseRulePhase(value: string): RulePhase {
  if (!isRulePhase(value)) {
    throw ApiError.badRequest('Unknown rule phase', { allowed: Object.keys(RULE_PHASES) })
  }
  return value
}

export interface RuleInput {
  description?: string
  expression: string
  action: string
  action_parameters?: Record<string, unknown>
  enabled: boolean
}

export function parseRuleInput(body: Record<string, unknown>): RuleInput {
  const expression = typeof body.expression === 'string' ? body.expression.trim() : ''
  if (!expression) throw ApiError.badRequest('An expression is required')
  if (expression.length > 4096) throw ApiError.badRequest('The expression is too long')
  const action = typeof body.action === 'string' ? body.action.trim() : ''
  if (!action) throw ApiError.badRequest('An action is required')
  if (action.length > 64) throw ApiError.badRequest('The action is too long')
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw ApiError.badRequest('enabled must be a boolean')
  }
  const input: RuleInput = { expression, action, enabled: body.enabled !== false }
  if (typeof body.description === 'string' && body.description.trim()) {
    input.description = body.description.trim().slice(0, 256)
  }
  if (body.action_parameters !== undefined) {
    const parameters = body.action_parameters
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw ApiError.badRequest('action_parameters must be a JSON object')
    }
    if (JSON.stringify(parameters).length > 32_000) {
      throw ApiError.badRequest('action_parameters is too large')
    }
    input.action_parameters = parameters as Record<string, unknown>
  }
  return input
}

export interface DnsRule {
  id?: string
  description?: string
  expression: string
  action: string
  action_parameters?: Record<string, unknown>
  enabled?: boolean
}

/** Rule bodies come back from Cloudflare as unknown objects; keep only the fields the screens use. */
export function toDnsRule(value: unknown): DnsRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const expression = stringValue(raw.expression)
  const action = stringValue(raw.action)
  if (!expression || !action) return null
  const rule: DnsRule = { expression, action }
  if (typeof raw.id === 'string') rule.id = raw.id
  if (typeof raw.description === 'string') rule.description = raw.description
  if (typeof raw.enabled === 'boolean') rule.enabled = raw.enabled
  if (raw.action_parameters && typeof raw.action_parameters === 'object' && !Array.isArray(raw.action_parameters)) {
    rule.action_parameters = raw.action_parameters as Record<string, unknown>
  }
  return rule
}
