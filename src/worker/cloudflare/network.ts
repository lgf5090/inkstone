/**
 * The read shapes and the write calls for the four network surfaces added in Phase 2.
 *
 * Cloudflare returns much more than each table shows; every converter here keeps the fields the
 * screen actually draws. Missing values stay `null`/`''` instead of becoming a plausible default,
 * because "Cloudflare did not say" and "Cloudflare said zero" are different answers. Writes are
 * only the create/delete pairs the screens expose; a reader never gets a half-implemented editor.
 */
import type { CloudflareAuth } from './cf-api'
import {
  authHeaders,
  cfFetch,
  CF_API_BASE,
  CloudflareApiError,
  upstreamApiError,
} from './cf-api'
import { ApiError } from '../lib/errors'

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

export interface LoadBalancerPool {
  id: string
  name: string
  enabled: boolean
  originCount: number
  monitorId: string
  notificationEmail: string
}

export interface LoadBalancerMonitor {
  id: string
  description: string
  type: string
  method: string
  path: string
  expectedCodes: string
  interval: number | null
  timeout: number | null
  retries: number | null
}

export interface ZoneLoadBalancer {
  id: string
  name: string
  enabled: boolean
  proxied: boolean
  ttl: number | null
  fallbackPool: string
  defaultPools: string[]
  steeringPolicy: string
  description: string
}

export interface PoolHealthOrigin {
  address: string
  healthy: boolean
  disabled: boolean
}

export interface PoolHealth {
  poolId: string
  healthy: boolean
  origins: PoolHealthOrigin[]
}

export function toPool(value: unknown): LoadBalancerPool | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  return {
    id,
    name: textOf(row.name),
    enabled: row.enabled !== false,
    originCount: asArray(row.origins).length,
    monitorId: textOf(row.monitor),
    notificationEmail: textOf(row.notification_email),
  }
}

export function toMonitor(value: unknown): LoadBalancerMonitor | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  const header = asRecord(row.header)
  return {
    id,
    description: textOf(row.description),
    type: textOf(row.type),
    method: textOf(row.method),
    path: textOf(row.path) || textOf(header.path),
    expectedCodes: textOf(row.expected_codes),
    interval: typeof row.interval === 'number' ? row.interval : null,
    timeout: typeof row.timeout === 'number' ? row.timeout : null,
    retries: typeof row.retries === 'number' ? row.retries : null,
  }
}

export function toZoneLoadBalancer(value: unknown): ZoneLoadBalancer | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  return {
    id,
    name: textOf(row.name),
    enabled: row.enabled !== false,
    proxied: row.proxied === true,
    ttl: typeof row.ttl === 'number' ? row.ttl : null,
    fallbackPool: textOf(row.fallback_pool),
    defaultPools: asArray(row.default_pools).filter((item): item is string => typeof item === 'string'),
    steeringPolicy: textOf(row.steering_policy),
    description: textOf(row.description),
  }
}

export function toPoolHealth(value: unknown, poolId: string): PoolHealth {
  const row = asRecord(value)
  const origins = asArray(row.origins).map((item) => {
    const origin = asRecord(item)
    return {
      address: textOf(origin.address),
      healthy: origin.healthy === true,
      disabled: origin.disabled === true,
    }
  }).filter((origin) => origin.address)
  return { poolId, healthy: row.healthy === true, origins }
}

export interface BulkRedirectList {
  id: string
  name: string
  kind: string
  itemCount: number
  description: string
}

export interface BulkRedirectItem {
  id: string
  sourceUrl: string
  targetUrl: string
  statusCode: number | null
  preserveQueryString: boolean
  includeSubdomains: boolean
  enabled: boolean
}

export function toBulkRedirectList(value: unknown): BulkRedirectList | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  return {
    id,
    name: textOf(row.name),
    kind: textOf(row.kind),
    itemCount: typeof row.num_items === 'number' ? row.num_items : asArray(row.items).length,
    description: textOf(row.description),
  }
}

export function toBulkRedirectItem(value: unknown): BulkRedirectItem | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  const redirect = asRecord(row.redirect)
  return {
    id,
    sourceUrl: textOf(redirect.source_url),
    targetUrl: textOf(redirect.target_url),
    statusCode: typeof redirect.status_code === 'number' ? redirect.status_code : null,
    preserveQueryString: redirect.preserve_query_string === true,
    includeSubdomains: redirect.include_subdomains === true,
    enabled: redirect.enabled !== false,
  }
}

export interface EmailRoutingSettings {
  enabled: boolean
  status: string
  name: string
}

export interface EmailRoutingMatcher {
  type: string
  field: string
  value: string
}

export interface EmailRoutingAction {
  type: string
  value: string[]
}

export interface EmailRoutingRule {
  id: string
  name: string
  enabled: boolean
  priority: number | null
  matchers: EmailRoutingMatcher[]
  actions: EmailRoutingAction[]
}

export interface EmailDestinationAddress {
  id: string
  email: string
  verified: boolean
  created: string
}

export function toEmailRoutingSettings(value: unknown): EmailRoutingSettings {
  const row = asRecord(value)
  return { enabled: row.enabled === true, status: textOf(row.status), name: textOf(row.name) }
}

export function toEmailRoutingRule(value: unknown): EmailRoutingRule | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  return {
    id,
    name: textOf(row.name),
    enabled: row.enabled !== false,
    priority: typeof row.priority === 'number' ? row.priority : null,
    matchers: asArray(row.matchers).map((item) => {
      const matcher = asRecord(item)
      return { type: textOf(matcher.type), field: textOf(matcher.field), value: textOf(matcher.value) }
    }),
    actions: asArray(row.actions).map((item) => {
      const action = asRecord(item)
      return { type: textOf(action.type), value: asArray(action.value).filter((v): v is string => typeof v === 'string') }
    }),
  }
}

export function toEmailDestination(value: unknown): EmailDestinationAddress | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  const email = textOf(row.email)
  if (!id || !email) return null
  return { id, email, verified: Boolean(textOf(row.verified)), created: textOf(row.created) }
}

export interface Snippet {
  id: string
  name: string
  createdOn: string
  modifiedOn: string
}

export interface SnippetRule {
  id: string
  snippetName: string
  phase: string
  expression: string
  description: string
  enabled: boolean
}

export function toSnippet(value: unknown): Snippet | null {
  const row = asRecord(value)
  const name = textOf(row.snippet_name) || textOf(row.name)
  if (!name) return null
  return {
    id: name,
    name,
    createdOn: textOf(row.created_on),
    modifiedOn: textOf(row.modified_on),
  }
}

export function toSnippetRule(value: unknown): SnippetRule | null {
  const row = asRecord(value)
  const id = textOf(row.id)
  if (!id) return null
  return {
    id,
    snippetName: textOf(row.snippet_name),
    phase: textOf(row.phase),
    expression: textOf(row.expression),
    description: textOf(row.description),
    enabled: row.enabled !== false,
  }
}

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/
const POOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
const LOAD_BALANCER_NAME = /^[A-Za-z0-9._-]{1,64}$/
const SNIPPET_NAME = /^[A-Za-z0-9_-]{1,32}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function networkAccountPath(cfAccountId: string, rest: string): string {
  if (!ACCOUNT_ID.test(cfAccountId)) throw ApiError.badRequest('Invalid account id')
  return `/accounts/${encodeURIComponent(cfAccountId)}/${rest}`
}

function networkZonePath(zoneId: string, rest: string): string {
  if (!ACCOUNT_ID.test(zoneId)) throw ApiError.badRequest('Invalid zone id')
  return `/zones/${encodeURIComponent(zoneId)}/${rest}`
}

function requiredText(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim()) throw ApiError.badRequest(`${label} is required`)
  const text = value.trim()
  if (text.length > max) throw ApiError.badRequest(`${label} is too long`)
  return text
}

function wholeNumber(value: unknown, label: string, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw ApiError.badRequest(`${label} must be a whole number between ${min} and ${max}`)
  }
  return number
}

export interface CreatePoolInput {
  name: string
  address: string
  monitorId?: string
}

export async function createLoadBalancerPool(
  auth: CloudflareAuth,
  cfAccountId: string,
  input: CreatePoolInput,
): Promise<LoadBalancerPool> {
  const name = requiredText(input.name, 'Pool name', 64)
  if (!POOL_NAME.test(name)) throw ApiError.badRequest('A pool name may contain letters, numbers, hyphens and underscores')
  const address = requiredText(input.address, 'Origin address', 255)
  const monitorId = input.monitorId?.trim() ?? ''
  if (monitorId && !ACCOUNT_ID.test(monitorId)) throw ApiError.badRequest('Invalid monitor id')
  const body = await cfFetch<{ result?: unknown }>(auth, networkAccountPath(cfAccountId, 'load_balancers/pools'), {
    method: 'POST',
    body: {
      name,
      origins: [{ name: 'origin-1', address, enabled: true, weight: 1 }],
      ...(monitorId ? { monitor: monitorId } : {}),
    },
  })
  const pool = toPool(body.result)
  if (!pool) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a pool without answering with it')
  return pool
}

export async function deleteLoadBalancerPool(
  auth: CloudflareAuth,
  cfAccountId: string,
  poolId: string,
): Promise<void> {
  if (!ACCOUNT_ID.test(poolId)) throw ApiError.badRequest('Invalid pool id')
  await cfFetch(auth, networkAccountPath(cfAccountId, `load_balancers/pools/${encodeURIComponent(poolId)}`), {
    method: 'DELETE',
  })
}

export interface CreateMonitorInput {
  description: string
  type: string
  method: string
  path: string
  expectedCodes: string
  interval: number
  timeout: number
  retries: number
}

export async function createLoadBalancerMonitor(
  auth: CloudflareAuth,
  cfAccountId: string,
  input: CreateMonitorInput,
): Promise<LoadBalancerMonitor> {
  const description = requiredText(input.description, 'Monitor description', 128)
  if (!['http', 'https'].includes(input.type)) throw ApiError.badRequest('A monitor type must be http or https')
  const method = requiredText(input.method, 'Monitor method', 16).toUpperCase()
  if (!['GET', 'HEAD'].includes(method)) throw ApiError.badRequest('A monitor method must be GET or HEAD')
  const path = requiredText(input.path, 'Monitor path', 255)
  if (!path.startsWith('/')) throw ApiError.badRequest('A monitor path must start with /')
  const expectedCodes = requiredText(input.expectedCodes, 'Expected codes', 32)
  const interval = wholeNumber(input.interval, 'Interval', 1, 3600)
  const timeout = wholeNumber(input.timeout, 'Timeout', 1, 30)
  const retries = wholeNumber(input.retries, 'Retries', 0, 10)
  const body = await cfFetch<{ result?: unknown }>(auth, networkAccountPath(cfAccountId, 'load_balancers/monitors'), {
    method: 'POST',
    body: { description, type: input.type, method, path, expected_codes: expectedCodes, interval, timeout, retries },
  })
  const monitor = toMonitor(body.result)
  if (!monitor) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a monitor without answering with it')
  return monitor
}

export async function deleteLoadBalancerMonitor(
  auth: CloudflareAuth,
  cfAccountId: string,
  monitorId: string,
): Promise<void> {
  if (!ACCOUNT_ID.test(monitorId)) throw ApiError.badRequest('Invalid monitor id')
  await cfFetch(auth, networkAccountPath(cfAccountId, `load_balancers/monitors/${encodeURIComponent(monitorId)}`), {
    method: 'DELETE',
  })
}

export interface CreateLoadBalancerInput {
  name: string
  fallbackPool: string
  defaultPools: string[]
}

export async function createZoneLoadBalancer(
  auth: CloudflareAuth,
  zoneId: string,
  input: CreateLoadBalancerInput,
): Promise<ZoneLoadBalancer> {
  const name = requiredText(input.name, 'Load balancer name', 64)
  if (!LOAD_BALANCER_NAME.test(name)) throw ApiError.badRequest('A load balancer name may contain letters, numbers, dots, hyphens and underscores')
  if (!ACCOUNT_ID.test(input.fallbackPool)) throw ApiError.badRequest('A fallback pool is required')
  if (input.defaultPools.length === 0) throw ApiError.badRequest('At least one default pool is required')
  for (const poolId of input.defaultPools) {
    if (!ACCOUNT_ID.test(poolId)) throw ApiError.badRequest('Invalid default pool id')
  }
  const body = await cfFetch<{ result?: unknown }>(auth, networkZonePath(zoneId, 'load_balancers'), {
    method: 'POST',
    body: {
      name,
      fallback_pool: input.fallbackPool,
      default_pools: input.defaultPools,
      proxied: true,
    },
  })
  const loadBalancer = toZoneLoadBalancer(body.result)
  if (!loadBalancer) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a load balancer without answering with it')
  return loadBalancer
}

export async function deleteZoneLoadBalancer(
  auth: CloudflareAuth,
  zoneId: string,
  loadBalancerId: string,
): Promise<void> {
  if (!ACCOUNT_ID.test(loadBalancerId)) throw ApiError.badRequest('Invalid load balancer id')
  await cfFetch(auth, networkZonePath(zoneId, `load_balancers/${encodeURIComponent(loadBalancerId)}`), {
    method: 'DELETE',
  })
}

export async function createBulkRedirectList(
  auth: CloudflareAuth,
  cfAccountId: string,
  name: string,
): Promise<BulkRedirectList> {
  const listName = requiredText(name, 'List name', 50)
  if (!/^[A-Za-z0-9_ ]+$/.test(listName)) {
    throw ApiError.badRequest('A list name may contain letters, numbers, underscores and spaces')
  }
  const body = await cfFetch<{ result?: unknown }>(auth, networkAccountPath(cfAccountId, 'rules/lists'), {
    method: 'POST',
    body: { name: listName, kind: 'redirect' },
  })
  const list = toBulkRedirectList(body.result)
  if (!list) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a list without answering with it')
  return list
}

export async function deleteBulkRedirectList(
  auth: CloudflareAuth,
  cfAccountId: string,
  listId: string,
): Promise<void> {
  if (!ACCOUNT_ID.test(listId)) throw ApiError.badRequest('Invalid list id')
  await cfFetch(auth, networkAccountPath(cfAccountId, `rules/lists/${encodeURIComponent(listId)}`), {
    method: 'DELETE',
  })
}

export interface CreateRedirectItemInput {
  sourceUrl: string
  targetUrl: string
  statusCode: number
  preserveQueryString: boolean
  includeSubdomains: boolean
}

export async function createBulkRedirectItem(
  auth: CloudflareAuth,
  cfAccountId: string,
  listId: string,
  input: CreateRedirectItemInput,
): Promise<void> {
  if (!ACCOUNT_ID.test(listId)) throw ApiError.badRequest('Invalid list id')
  const sourceUrl = requiredText(input.sourceUrl, 'Source URL', 1024)
  const targetUrl = requiredText(input.targetUrl, 'Target URL', 1024)
  if (!/^https?:\/\//i.test(sourceUrl) || !/^https?:\/\//i.test(targetUrl)) {
    throw ApiError.badRequest('Both URLs must start with http:// or https://')
  }
  if (![301, 302, 307, 308].includes(input.statusCode)) {
    throw ApiError.badRequest('A redirect status code must be 301, 302, 307 or 308')
  }
  await cfFetch(auth, networkAccountPath(cfAccountId, `rules/lists/${encodeURIComponent(listId)}/items`), {
    method: 'POST',
    body: [{
      redirect: {
        source_url: sourceUrl,
        target_url: targetUrl,
        status_code: input.statusCode,
        preserve_query_string: input.preserveQueryString,
        include_subdomains: input.includeSubdomains,
        subpath_matching: false,
      },
    }],
  })
}

export interface CreateEmailRuleInput {
  name: string
  recipient: string
  action: 'drop' | 'forward'
  destination?: string
}

export async function createEmailRoutingRule(
  auth: CloudflareAuth,
  zoneId: string,
  input: CreateEmailRuleInput,
): Promise<EmailRoutingRule> {
  const recipient = requiredText(input.recipient, 'Recipient address', 90)
  if (!EMAIL.test(recipient)) throw ApiError.badRequest('A recipient must be an email address')
  if (input.action !== 'drop' && input.action !== 'forward') throw ApiError.badRequest('Unsupported email action')
  let destination = ''
  if (input.action === 'forward') {
    destination = requiredText(input.destination, 'Destination address', 90)
    if (!EMAIL.test(destination)) throw ApiError.badRequest('A destination must be an email address')
  }
  const name = input.name.trim().slice(0, 256)
  const body = await cfFetch<{ result?: unknown }>(auth, networkZonePath(zoneId, 'email/routing/rules'), {
    method: 'POST',
    body: {
      ...(name ? { name } : {}),
      enabled: true,
      priority: 0,
      matchers: [{ type: 'literal', field: 'to', value: recipient }],
      actions: input.action === 'forward'
        ? [{ type: 'forward', value: [destination] }]
        : [{ type: 'drop' }],
      source: 'api',
    },
  })
  const rule = toEmailRoutingRule(body.result)
  if (!rule) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created a rule without answering with it')
  return rule
}

export async function deleteEmailRoutingRule(
  auth: CloudflareAuth,
  zoneId: string,
  ruleId: string,
): Promise<void> {
  if (!ACCOUNT_ID.test(ruleId)) throw ApiError.badRequest('Invalid rule id')
  await cfFetch(auth, networkZonePath(zoneId, `email/routing/rules/${encodeURIComponent(ruleId)}`), {
    method: 'DELETE',
  })
}

export async function createEmailDestination(
  auth: CloudflareAuth,
  cfAccountId: string,
  email: string,
): Promise<EmailDestinationAddress> {
  const address = requiredText(email, 'Destination email', 90)
  if (!EMAIL.test(address)) throw ApiError.badRequest('A destination must be an email address')
  const body = await cfFetch<{ result?: unknown }>(
    auth,
    networkAccountPath(cfAccountId, 'email/routing/addresses'),
    { method: 'POST', body: { email: address } },
  )
  const destination = toEmailDestination(body.result)
  if (!destination) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare created an address without answering with it')
  return destination
}

/** Enable adds and locks MX/SPF records; disable removes the extra MX records Cloudflare added. */
export async function setEmailRoutingEnabled(
  auth: CloudflareAuth,
  zoneId: string,
  enabled: boolean,
): Promise<EmailRoutingSettings> {
  const body = await cfFetch<{ result?: unknown }>(
    auth,
    networkZonePath(zoneId, `email/routing/${enabled ? 'enable' : 'disable'}`),
    { method: 'POST', body: {} },
  )
  if (body.result) return toEmailRoutingSettings(body.result)
  const settings = await cfFetch<{ result?: unknown }>(auth, networkZonePath(zoneId, 'email/routing'))
  return toEmailRoutingSettings(settings.result)
}

export async function deleteEmailDestination(
  auth: CloudflareAuth,
  cfAccountId: string,
  addressId: string,
): Promise<void> {
  if (!ACCOUNT_ID.test(addressId)) throw ApiError.badRequest('Invalid address id')
  await cfFetch(auth, networkAccountPath(cfAccountId, `email/routing/addresses/${encodeURIComponent(addressId)}`), {
    method: 'DELETE',
  })
}

export interface CreateSnippetInput {
  name: string
  content: string
  expression?: string
  description?: string
}

/** Snippet uploads are multipart, so this one call does not go through `cfFetch`'s JSON body handling. */
export async function createZoneSnippet(
  auth: CloudflareAuth,
  zoneId: string,
  input: CreateSnippetInput,
): Promise<void> {
  const name = requiredText(input.name, 'Snippet name', 32)
  if (!SNIPPET_NAME.test(name)) throw ApiError.badRequest('A snippet name may contain letters, numbers, hyphens and underscores')
  const content = requiredText(input.content, 'Snippet content', 32 * 1024)
  const expression = input.expression?.trim() ?? ''
  if (expression.length > 1024) throw ApiError.badRequest('A snippet expression is too long')

  const form = new FormData()
  form.append('metadata', JSON.stringify({ main_module: 'snippet.js' }))
  form.append('snippet.js', new Blob([content], { type: 'application/javascript' }), 'snippet.js')
  const response = await fetch(`${CF_API_BASE}${networkZonePath(zoneId, `snippets/${encodeURIComponent(name)}`)}`, {
    method: 'PUT',
    headers: authHeaders(auth),
    body: form,
  })
  if (!response.ok) {
    throw upstreamApiError(new CloudflareApiError({ status: response.status, body: await response.text() }))
  }

  if (expression) {
    const rules = await readSnippetRules(auth, zoneId)
    await writeSnippetRules(auth, zoneId, [
      ...rules,
      { expression, snippet_name: name, enabled: true, ...(input.description ? { description: input.description } : {}) },
    ])
  }
}

async function readSnippetRules(auth: CloudflareAuth, zoneId: string): Promise<Record<string, unknown>[]> {
  try {
    const body = await cfFetch<{ result?: unknown[] }>(auth, networkZonePath(zoneId, 'snippets/snippet_rules'))
    return asArray(body.result)
      .map((rule) => asRecord(rule))
      .filter((rule) => Boolean(rule))
  } catch (error) {
    if (error instanceof ApiError) {
      const status = (error.details as { upstream_status?: unknown } | undefined)?.upstream_status
      if (status === 404) return []
    }
    throw error
  }
}

async function writeSnippetRules(
  auth: CloudflareAuth,
  zoneId: string,
  rules: Record<string, unknown>[],
): Promise<void> {
  await cfFetch(auth, networkZonePath(zoneId, 'snippets/snippet_rules'), {
    method: 'PUT',
    body: { rules },
  })
}

export async function deleteZoneSnippet(
  auth: CloudflareAuth,
  zoneId: string,
  name: string,
): Promise<void> {
  if (!SNIPPET_NAME.test(name)) throw ApiError.badRequest('Invalid snippet name')
  const rules = await readSnippetRules(auth, zoneId)
  const remaining = rules.filter((rule) => textOf(rule.snippet_name) !== name)
  if (remaining.length !== rules.length) await writeSnippetRules(auth, zoneId, remaining)
  await cfFetch(auth, networkZonePath(zoneId, `snippets/${encodeURIComponent(name)}`), { method: 'DELETE' })
}

export async function deleteZoneSnippetRule(
  auth: CloudflareAuth,
  zoneId: string,
  ruleId: string,
): Promise<void> {
  if (!ACCOUNT_ID.test(ruleId)) throw ApiError.badRequest('Invalid rule id')
  const rules = await readSnippetRules(auth, zoneId)
  await writeSnippetRules(auth, zoneId, rules.filter((rule) => textOf(rule.id) !== ruleId))
}
