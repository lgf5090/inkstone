/**
 * Cloudflare Tunnels, the origin wizard, and the zone rules engine the tunnel screen also drives.
 *
 * A tunnel is addressed through the reader's own Cloudflare account, so every helper here receives an
 * already-owner-checked account row. Zone lookups and rulesets are exported too: the DNS surface needs
 * the same phase mapping, and keeping one copy means the two screens cannot drift apart.
 *
 * The reference wizard appended a catch-all only when the last row happened to carry a hostname, and
 * kept whatever the existing list ended with. Here the catch-all is an invariant: exactly one
 * `http_status:404` entry, always last, on every read and every write.
 */
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { cfFetch, cfFetchAll, upstreamApiError } from './cf-api'
import { accountHasFeature, loadActiveAccounts, type LoadedAccount } from './accounts'

export const CATCH_ALL_SERVICE = 'http_status:404'
const MAX_INGRESS_RULES = 100
const TUNNEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const TUNNEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/
const ZONE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const CF_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const HOST_LABEL_PATTERN = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?$/

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isHostname(value: string): boolean {
  const host = value.endsWith('.') ? value.slice(0, -1) : value
  if (!host || host.length > 253) return false
  return host.split('.').every((label) => label.length > 0 && label.length <= 63 && HOST_LABEL_PATTERN.test(label))
}

function validatePath(value: string, label: string): string {
  if (!value.startsWith('/')) throw ApiError.badRequest(`${label} must start with /`)
  if (value.length > 255) throw ApiError.badRequest(`${label} is too long`)
  if (/[\s\u0000-\u001f\u007f]/.test(value)) throw ApiError.badRequest(`${label} contains characters Cloudflare does not accept`)
  return value
}

/* -------------------------------------------------------------------------------------------------
 * Accounts and zones
 * ---------------------------------------------------------------------------------------------- */

export interface TunnelAccount {
  id: string
  name: string
  cf_account_id: string | null
}

/** The reader's active accounts that can carry a tunnel and own the zones a wizard needs. */
export async function listTunnelAccounts(env: Env, userId: string): Promise<TunnelAccount[]> {
  const accounts = await loadActiveAccounts(env, userId)
  return accounts
    .filter(({ row }) => Boolean(row.cf_account_id) && accountHasFeature(row, 'dns'))
    .map(({ row }) => ({ id: row.id, name: row.name, cf_account_id: row.cf_account_id }))
}

export interface TunnelZone {
  id: string
  name: string
  status: string
}

function toTunnelZone(value: unknown): TunnelZone | null {
  if (!isPlainObject(value)) return null
  const id = stringValue(value.id)
  const name = stringValue(value.name)
  if (!id || !name) return null
  return { id, name, status: stringValue(value.status) }
}

export async function listZonesForAccount(account: LoadedAccount): Promise<TunnelZone[]> {
  const rows = await cfFetchAll<unknown>(account.auth, '/zones', 50)
  return rows.map(toTunnelZone).filter((zone): zone is TunnelZone => zone !== null)
}

/** The zone must sit in this account; another account's id is a 404 even when both belong to the reader. */
export async function requireAccountZone(account: LoadedAccount, zoneId: string): Promise<TunnelZone> {
  const id = zoneId.trim()
  if (!ZONE_ID_PATTERN.test(id)) throw ApiError.notFound('That zone does not belong to this Cloudflare account')
  const zones = await listZonesForAccount(account)
  const zone = zones.find((candidate) => candidate.id === id)
  if (!zone) throw ApiError.notFound('That zone does not belong to this Cloudflare account')
  return zone
}

/** The longest zone name that is the hostname itself or its suffix. */
export function findZoneForHostname(zones: readonly TunnelZone[], hostname: string): TunnelZone | null {
  const host = hostname.toLowerCase()
  const matches = zones.filter((zone) => host === zone.name || host.endsWith(`.${zone.name}`))
  matches.sort((a, b) => b.name.length - a.name.length)
  return matches[0] ?? null
}

export function requireCfAccountId(account: LoadedAccount): string {
  const id = account.row.cf_account_id?.trim() ?? ''
  if (!id) throw ApiError.badRequest('This account has no Cloudflare account id yet; tunnels cannot be managed')
  if (!CF_ACCOUNT_ID_PATTERN.test(id)) throw ApiError.badRequest('This account has an invalid Cloudflare account id')
  return id
}

function tunnelApiPath(account: LoadedAccount, suffix = ''): string {
  return `/accounts/${requireCfAccountId(account)}/cfd_tunnel${suffix}`
}

export function parseTunnelId(value: string): string {
  const id = value.trim()
  if (!TUNNEL_ID_PATTERN.test(id)) throw ApiError.badRequest('Invalid tunnel id')
  return id
}

export function parseTunnelName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw ApiError.badRequest('A tunnel name is required')
  if (!TUNNEL_NAME_PATTERN.test(name)) {
    throw ApiError.badRequest('A tunnel name may contain letters, digits, dots, dashes, underscores and spaces')
  }
  return name
}

/* -------------------------------------------------------------------------------------------------
 * Tunnels
 * ---------------------------------------------------------------------------------------------- */

export interface TunnelConnection {
  id: string
  colo_name: string
  version: string
  ip: string
  opened_at?: string
}

export interface Tunnel {
  id: string
  name: string
  status: string
  created_at: string
  connections: TunnelConnection[]
}

function toTunnelConnection(value: unknown): TunnelConnection | null {
  if (!isPlainObject(value)) return null
  const id = stringValue(value.id)
  if (!id) return null
  const connection: TunnelConnection = {
    id,
    colo_name: stringValue(value.colo_name),
    version: stringValue(value.version),
    ip: stringValue(value.ip),
  }
  const openedAt = stringValue(value.opened_at)
  if (openedAt) connection.opened_at = openedAt
  return connection
}

export function toTunnel(value: unknown): Tunnel | null {
  if (!isPlainObject(value)) return null
  const id = stringValue(value.id)
  if (!id) return null
  const rawConnections = Array.isArray(value.connections) ? value.connections : []
  return {
    id,
    name: stringValue(value.name),
    status: stringValue(value.status),
    created_at: stringValue(value.created_at),
    connections: rawConnections
      .map(toTunnelConnection)
      .filter((connection): connection is TunnelConnection => connection !== null),
  }
}

export async function listTunnels(account: LoadedAccount): Promise<Tunnel[]> {
  const rows = await cfFetchAll<unknown>(account.auth, tunnelApiPath(account), 50)
  return rows.map(toTunnel).filter((tunnel): tunnel is Tunnel => tunnel !== null)
}

export async function createTunnel(account: LoadedAccount, name: string): Promise<Tunnel> {
  const response = await cfFetch<{ result?: unknown }>(account.auth, tunnelApiPath(account), {
    method: 'POST',
    body: { name, config_src: 'cloudflare' },
  })
  const tunnel = toTunnel(response.result)
  if (!tunnel) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not return the created tunnel')
  return tunnel
}

export async function deleteTunnel(account: LoadedAccount, tunnelId: string): Promise<void> {
  await cfFetch(account.auth, tunnelApiPath(account, `/${tunnelId}`), { method: 'DELETE' })
}

export async function tunnelToken(account: LoadedAccount, tunnelId: string): Promise<string> {
  const response = await cfFetch<{ result?: unknown }>(
    account.auth,
    tunnelApiPath(account, `/${tunnelId}/token`),
  )
  if (typeof response.result !== 'string' || !response.result) {
    throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not return a tunnel token')
  }
  return response.result
}

export async function listTunnelConnections(
  account: LoadedAccount,
  tunnelId: string,
): Promise<TunnelConnection[]> {
  const response = await cfFetch<{ result?: unknown }>(
    account.auth,
    tunnelApiPath(account, `/${tunnelId}/connections`),
  )
  const rows = Array.isArray(response.result) ? response.result : []
  return rows.map(toTunnelConnection).filter((connection): connection is TunnelConnection => connection !== null)
}

/* -------------------------------------------------------------------------------------------------
 * Ingress configuration
 * ---------------------------------------------------------------------------------------------- */

export interface IngressRule {
  hostname?: string
  path?: string
  service: string
  originRequest?: Record<string, unknown>
}

const SERVICE_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i
const HTTP_STATUS_PATTERN = /^http_status:(\d{3})$/

function validateService(value: string): string {
  const service = value.trim()
  if (!service) throw ApiError.badRequest('An ingress rule needs a service')
  if (service.length > 512) throw ApiError.badRequest('The ingress service is too long')
  if (/[\u0000-\u001f\u007f]/.test(service)) {
    throw ApiError.badRequest('The ingress service contains control characters')
  }
  const status = HTTP_STATUS_PATTERN.exec(service)
  if (status) {
    const code = Number(status[1])
    if (code < 100 || code > 599) throw ApiError.badRequest('An http_status service needs a valid status code')
    return service
  }
  if (/^unix(\+tls)?:\/\/?\/[^\s]*$/.test(service)) return service
  if (!SERVICE_URL_PATTERN.test(service)) {
    throw ApiError.badRequest('An ingress service must be a URL, unix socket or http_status code')
  }
  const portMatch = /:(\d{1,5})(?:\/|$)/.exec(service.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''))
  if (portMatch && Number(portMatch[1]) > 65_535) {
    throw ApiError.badRequest('The ingress service port is out of range')
  }
  return service
}

function toIngressRule(value: unknown): IngressRule | null {
  if (!isPlainObject(value)) return null
  const service = stringValue(value.service).trim()
  if (!service) return null
  const rule: IngressRule = { service }
  const hostname = stringValue(value.hostname).trim()
  if (hostname) rule.hostname = hostname.toLowerCase()
  const path = stringValue(value.path).trim()
  if (path) rule.path = path
  if (isPlainObject(value.originRequest)) rule.originRequest = value.originRequest
  return rule
}

/** Reads a stored configuration leniently: only the shape the screen can edit is kept. */
export function readIngress(value: unknown): IngressRule[] {
  const rows = Array.isArray(value) ? value : []
  return rows.map(toIngressRule).filter((rule): rule is IngressRule => rule !== null)
}

/**
 * Validates the list a reader wants to save, and guarantees the catch-all.
 *
 * An empty list is legal input and becomes the catch-only list Cloudflare requires. A catch-all in
 * the middle is refused rather than silently moved: it would change which rules ever match.
 */
export function parseIngress(value: unknown): IngressRule[] {
  if (!Array.isArray(value)) throw ApiError.badRequest('ingress must be an array')
  if (value.length > MAX_INGRESS_RULES) {
    throw ApiError.badRequest(`ingress may contain at most ${MAX_INGRESS_RULES} rules`)
  }
  const rules: IngressRule[] = []
  for (const item of value) {
    const rule = toIngressRule(item)
    if (!rule) throw ApiError.badRequest('Each ingress rule needs a service')
    rule.service = validateService(rule.service)
    if (rule.hostname !== undefined) {
      if (!isHostname(rule.hostname)) throw ApiError.badRequest(`Invalid ingress hostname: ${rule.hostname}`)
    }
    if (rule.path !== undefined) rule.path = validatePath(rule.path, 'An ingress path')
    if (rule.hostname === undefined) {
      if (rule.service !== CATCH_ALL_SERVICE) {
        throw ApiError.badRequest(`The catch-all ingress rule must be ${CATCH_ALL_SERVICE}`)
      }
      if (rule.path !== undefined) throw ApiError.badRequest('The catch-all ingress rule cannot have a path')
    }
    rules.push(rule)
  }

  const catchAllIndex = rules.findIndex((rule) => rule.hostname === undefined)
  if (catchAllIndex !== -1) {
    if (catchAllIndex !== rules.length - 1) {
      throw ApiError.badRequest('The catch-all ingress rule must be last')
    }
    return rules
  }
  return [...rules, { service: CATCH_ALL_SERVICE }]
}

export async function tunnelConfig(account: LoadedAccount, tunnelId: string): Promise<IngressRule[]> {
  const response = await cfFetch<{ result?: { config?: { ingress?: unknown } } }>(
    account.auth,
    tunnelApiPath(account, `/${tunnelId}/configurations`),
  )
  return readIngress(response.result?.config?.ingress)
}

export async function saveTunnelConfig(
  account: LoadedAccount,
  tunnelId: string,
  ingress: IngressRule[],
): Promise<IngressRule[]> {
  const response = await cfFetch<{ result?: { config?: { ingress?: unknown } } }>(
    account.auth,
    tunnelApiPath(account, `/${tunnelId}/configurations`),
    { method: 'PUT', body: { config: { ingress } } },
  )
  const saved = readIngress(response.result?.config?.ingress)
  return saved.length > 0 ? saved : ingress
}

/** Hostnames already pointing at this tunnel, across every zone of the account. */
export async function listTunnelHostnames(account: LoadedAccount, tunnelId: string): Promise<string[]> {
  const suffix = `.${tunnelId}.cfargotunnel.com`
  const zones = await listZonesForAccount(account)
  const hostnames: string[] = []
  let failures = 0
  for (const zone of zones) {
    try {
      const records = await cfFetchAll<{ type?: unknown; content?: unknown; name?: unknown }>(
        account.auth,
        `/zones/${zone.id}/dns_records?type=CNAME`,
        100,
      )
      for (const record of records) {
        const content = stringValue(record.content)
        const name = stringValue(record.name)
        if (stringValue(record.type) === 'CNAME' && content.endsWith(suffix) && name && !hostnames.includes(name)) {
          hostnames.push(name)
        }
      }
    } catch (error) {
      failures += 1
      console.warn(`[inkstone] Cloudflare CNAME scan failed (zone ${zone.id}):`, (error as Error)?.message)
    }
  }
  if (zones.length > 0 && failures === zones.length) {
    throw new ApiError(502, 'cloudflare_upstream', 'Could not read the DNS records of any zone in this account')
  }
  return hostnames
}

/* -------------------------------------------------------------------------------------------------
 * Origin wizard
 * ---------------------------------------------------------------------------------------------- */

export const WIZARD_PROTOCOLS = ['http', 'https', 'tcp'] as const
export type WizardProtocol = (typeof WIZARD_PROTOCOLS)[number]

export interface WizardInput {
  mode: 'create' | 'reuse'
  tunnelId?: string
  tunnelName?: string
  hostname: string
  protocol: WizardProtocol
  port: number
  path?: string
}

export interface WizardResult {
  tunnelId: string
  hostname: string
  cnameTarget: string
  mode: WizardInput['mode']
}

export function parseWizardInput(body: Record<string, unknown>): WizardInput {
  const mode = body.mode === undefined ? 'create' : body.mode
  if (mode !== 'create' && mode !== 'reuse') throw ApiError.badRequest('mode must be create or reuse')

  const rawHostname = typeof body.hostname === 'string' ? body.hostname.trim().toLowerCase() : ''
  const hostname = rawHostname.endsWith('.') ? rawHostname.slice(0, -1) : rawHostname
  if (!isHostname(hostname)) throw ApiError.badRequest('hostname must be a valid hostname')

  const port = body.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw ApiError.badRequest('port must be an integer between 1 and 65535')
  }

  const rawProtocol = typeof body.protocol === 'string' ? body.protocol.trim().toLowerCase() : 'http'
  if (!WIZARD_PROTOCOLS.includes(rawProtocol as WizardProtocol)) {
    throw ApiError.badRequest(`protocol must be one of ${WIZARD_PROTOCOLS.join(', ')}`)
  }
  const protocol = rawProtocol as WizardProtocol

  const input: WizardInput = { mode, hostname, protocol, port }
  if (typeof body.path === 'string' && body.path.trim()) {
    input.path = validatePath(body.path.trim(), 'path')
  }
  if (mode === 'reuse') {
    const tunnelId = typeof body.tunnelId === 'string' ? body.tunnelId.trim() : ''
    if (!tunnelId) throw ApiError.badRequest('tunnelId is required when mode is reuse')
    input.tunnelId = parseTunnelId(tunnelId)
  }
  if (typeof body.tunnelName === 'string' && body.tunnelName.trim()) {
    input.tunnelName = parseTunnelName(body.tunnelName)
  }
  return input
}

/** Keeps the existing hostname rules, replaces the wizard's host, and re-anchors the catch-all. */
export function mergeWizardIngress(existing: readonly IngressRule[], rule: IngressRule): IngressRule[] {
  const kept = existing.filter((item) => (
    item.hostname !== undefined && item.hostname.toLowerCase() !== rule.hostname
  ))
  return [...kept, rule, { service: CATCH_ALL_SERVICE }]
}

function wizardService(input: WizardInput): string {
  return `${input.protocol}://localhost:${input.port}`
}

export async function runOriginWizard(account: LoadedAccount, input: WizardInput): Promise<WizardResult> {
  const zones = await listZonesForAccount(account)
  const zone = findZoneForHostname(zones, input.hostname)
  if (!zone) {
    throw ApiError.badRequest('That hostname does not belong to any zone in this Cloudflare account')
  }

  let createdTunnelId: string | null = null
  let createdCnameId: string | null = null
  const rule: IngressRule = { hostname: input.hostname, service: wizardService(input) }
  if (input.path !== undefined) rule.path = input.path

  try {
    let tunnelId: string
    if (input.mode === 'create') {
      const fallbackName = `tunnel-${input.hostname}`.slice(0, 64)
      const tunnel = await createTunnel(account, input.tunnelName ?? parseTunnelName(fallbackName))
      tunnelId = tunnel.id
      createdTunnelId = tunnel.id
    } else {
      if (!input.tunnelId) throw ApiError.badRequest('tunnelId is required when mode is reuse')
      tunnelId = input.tunnelId
      const tunnels = await listTunnels(account)
      if (!tunnels.some((tunnel) => tunnel.id === tunnelId)) {
        throw ApiError.notFound('That tunnel does not belong to this Cloudflare account')
      }
    }

    const cnameTarget = `${tunnelId}.cfargotunnel.com`
    const created = await cfFetch<{ result?: { id?: unknown } }>(
      account.auth,
      `/zones/${zone.id}/dns_records`,
      {
        method: 'POST',
        body: { type: 'CNAME', name: input.hostname, content: cnameTarget, ttl: 1, proxied: true },
      },
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : ''
      if (/already exists|81053|record.*exists/i.test(message)) {
        throw ApiError.conflict('That hostname already has a DNS record; remove or change it before running the wizard')
      }
      throw error
    })
    createdCnameId = typeof created.result?.id === 'string' ? created.result.id : null

    const existing = input.mode === 'reuse' ? await tunnelConfig(account, tunnelId) : []
    const ingress = mergeWizardIngress(existing, rule)
    await saveTunnelConfig(account, tunnelId, ingress)

    return { tunnelId, hostname: input.hostname, cnameTarget, mode: input.mode }
  } catch (error) {
    const rollbackErrors: string[] = []
    if (createdCnameId) {
      try {
        await cfFetch(account.auth, `/zones/${zone.id}/dns_records/${createdCnameId}`, { method: 'DELETE' })
      } catch (rollbackError) {
        rollbackErrors.push(`CNAME ${createdCnameId}: ${(rollbackError as Error)?.message ?? 'unknown error'}`)
      }
    }
    if (createdTunnelId) {
      try {
        await deleteTunnel(account, createdTunnelId)
      } catch (rollbackError) {
        rollbackErrors.push(`Tunnel ${createdTunnelId}: ${(rollbackError as Error)?.message ?? 'unknown error'}`)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new ApiError(
        502,
        'cloudflare_upstream',
        'The origin wizard failed and its rollback did not finish',
        { cause: error instanceof Error ? error.message : 'unknown error', rollbackErrors },
      )
    }
    throw upstreamApiError(error)
  }
}

/* -------------------------------------------------------------------------------------------------
 * Rules engine
 * ---------------------------------------------------------------------------------------------- */

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
    if (!isPlainObject(body.action_parameters)) {
      throw ApiError.badRequest('action_parameters must be a JSON object')
    }
    if (JSON.stringify(body.action_parameters).length > 32_000) {
      throw ApiError.badRequest('action_parameters is too large')
    }
    input.action_parameters = body.action_parameters
  }
  return input
}

export interface TunnelRule {
  id?: string
  description?: string
  expression: string
  action: string
  action_parameters?: Record<string, unknown>
  enabled?: boolean
}

export function toTunnelRule(value: unknown): TunnelRule | null {
  if (!isPlainObject(value)) return null
  const expression = stringValue(value.expression)
  const action = stringValue(value.action)
  if (!expression || !action) return null
  const rule: TunnelRule = { expression, action }
  if (typeof value.id === 'string') rule.id = value.id
  if (typeof value.description === 'string') rule.description = value.description
  if (typeof value.enabled === 'boolean') rule.enabled = value.enabled
  if (isPlainObject(value.action_parameters)) rule.action_parameters = value.action_parameters
  return rule
}

export interface RulesetTarget {
  scope: string
  kind: 'zone' | 'root'
  phase: string
}

export function resolveRulesetTarget(
  account: LoadedAccount,
  zoneId: string,
  phase: RulePhase,
): RulesetTarget {
  const definition = RULE_PHASES[phase]
  if (definition.scope === 'account') {
    return {
      scope: `/accounts/${requireCfAccountId(account)}/rulesets`,
      kind: 'root',
      phase: definition.phase,
    }
  }
  if (!ZONE_ID_PATTERN.test(zoneId)) throw ApiError.notFound('That zone does not belong to this Cloudflare account')
  return { scope: `/zones/${zoneId}/rulesets`, kind: 'zone', phase: definition.phase }
}

interface LoadedRuleset {
  target: RulesetTarget
  rulesetId: string
  rules: TunnelRule[]
}

async function loadRuleset(account: LoadedAccount, target: RulesetTarget): Promise<LoadedRuleset> {
  const listed = await cfFetch<{ result?: Array<{ id?: unknown; phase?: unknown }> }>(account.auth, target.scope)
  const existing = (listed.result ?? []).find((item) => item.phase === target.phase && typeof item.id === 'string')
  if (existing && typeof existing.id === 'string') {
    const detail = await cfFetch<{ result?: { rules?: unknown } }>(
      account.auth,
      `${target.scope}/${existing.id}`,
    )
    const rules = (Array.isArray(detail.result?.rules) ? detail.result.rules : [])
      .map(toTunnelRule)
      .filter((rule): rule is TunnelRule => rule !== null)
    return { target, rulesetId: existing.id, rules }
  }
  const created = await cfFetch<{ result?: { id?: unknown } }>(account.auth, target.scope, {
    method: 'POST',
    body: { kind: target.kind, phase: target.phase, name: `${target.phase} rules`, rules: [] },
  })
  const rulesetId = typeof created.result?.id === 'string' ? created.result.id : ''
  if (!rulesetId) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not return a ruleset id')
  return { target, rulesetId, rules: [] }
}

async function writeRules(
  account: LoadedAccount,
  ruleset: LoadedRuleset,
  rules: TunnelRule[],
): Promise<TunnelRule[]> {
  const response = await cfFetch<{ result?: { rules?: unknown } }>(
    account.auth,
    `${ruleset.target.scope}/${ruleset.rulesetId}`,
    { method: 'PUT', body: { rules } },
  )
  if (!response.result) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare did not return the ruleset')
  return (Array.isArray(response.result.rules) ? response.result.rules : [])
    .map(toTunnelRule)
    .filter((rule): rule is TunnelRule => rule !== null)
}

function rulePayload(input: RuleInput): TunnelRule {
  const rule: TunnelRule = {
    expression: input.expression,
    action: input.action,
    enabled: input.enabled,
  }
  if (input.description !== undefined) rule.description = input.description
  if (input.action_parameters !== undefined) rule.action_parameters = input.action_parameters
  return rule
}

export interface ZoneRuleList {
  zone: TunnelZone
  rules: TunnelRule[]
}

export async function listZoneRules(
  account: LoadedAccount,
  zoneId: string,
  phase: RulePhase,
): Promise<ZoneRuleList> {
  const zone = await requireAccountZone(account, zoneId)
  const ruleset = await loadRuleset(account, resolveRulesetTarget(account, zone.id, phase))
  return { zone, rules: ruleset.rules }
}

export async function createZoneRule(
  account: LoadedAccount,
  zoneId: string,
  phase: RulePhase,
  input: RuleInput,
): Promise<ZoneRuleList> {
  const zone = await requireAccountZone(account, zoneId)
  const ruleset = await loadRuleset(account, resolveRulesetTarget(account, zone.id, phase))
  const rules = await writeRules(account, ruleset, [...ruleset.rules, rulePayload(input)])
  return { zone, rules }
}

export async function updateZoneRule(
  account: LoadedAccount,
  zoneId: string,
  phase: RulePhase,
  ruleId: string,
  input: RuleInput,
): Promise<ZoneRuleList> {
  const zone = await requireAccountZone(account, zoneId)
  const ruleset = await loadRuleset(account, resolveRulesetTarget(account, zone.id, phase))
  if (!ruleset.rules.some((rule) => rule.id === ruleId)) {
    throw ApiError.notFound('That rule does not exist in this phase')
  }
  const rules = await writeRules(
    account,
    ruleset,
    ruleset.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...rulePayload(input) } : rule)),
  )
  return { zone, rules }
}

export async function deleteZoneRule(
  account: LoadedAccount,
  zoneId: string,
  phase: RulePhase,
  ruleId: string,
): Promise<{ zone: TunnelZone; deleted: string }> {
  const zone = await requireAccountZone(account, zoneId)
  const ruleset = await loadRuleset(account, resolveRulesetTarget(account, zone.id, phase))
  if (!ruleset.rules.some((rule) => rule.id === ruleId)) {
    throw ApiError.notFound('That rule does not exist in this phase')
  }
  await writeRules(
    account,
    ruleset,
    ruleset.rules.filter((rule) => rule.id !== ruleId),
  )
  return { zone, deleted: ruleId }
}
