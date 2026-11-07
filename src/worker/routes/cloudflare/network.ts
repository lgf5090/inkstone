/**
 * `/api/cloudflare/network` — the four network surfaces added in Phase 2.
 *
 * Account-level resources (pools, monitors, redirect lists) need the reader's own account row; zone
 * resources (zone load balancers, email routing, snippets) also need the zone to belong to that
 * account, which `loadZoneForAccount` proves. Every write is audited and refused for a demo account.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { readJson } from '../../lib/request'
import { assertNotDemo, loadAccount, type LoadedAccount } from '../../cloudflare/accounts'
import { createAuditLog } from '../../cloudflare/audit'
import { cfFetch } from '../../cloudflare/cf-api'
import { loadZoneForAccount } from '../../cloudflare/dashboard'
import {
  createBulkRedirectItem,
  createBulkRedirectList,
  createEmailDestination,
  createEmailRoutingRule,
  createLoadBalancerMonitor,
  createLoadBalancerPool,
  createZoneLoadBalancer,
  createZoneSnippet,
  deleteBulkRedirectList,
  setEmailRoutingEnabled,
  deleteEmailDestination,
  deleteEmailRoutingRule,
  deleteLoadBalancerMonitor,
  deleteLoadBalancerPool,
  deleteZoneLoadBalancer,
  deleteZoneSnippet,
  deleteZoneSnippetRule,
  toBulkRedirectItem,
  toBulkRedirectList,
  toEmailDestination,
  toEmailRoutingRule,
  toEmailRoutingSettings,
  toMonitor,
  toPool,
  toPoolHealth,
  toSnippet,
  toSnippetRule,
  toZoneLoadBalancer,
} from '../../cloudflare/network'

export const networkRouter = new Hono<AppBindings>()

type AppContext = import('hono').Context<AppBindings>

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

function pathId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw ApiError.badRequest(`Invalid ${label}`)
  return value
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Cloudflare refused the request'
}

function upstreamStatus(error: unknown): number | undefined {
  if (!(error instanceof ApiError)) return undefined
  return (error.details as { upstream_status?: number } | undefined)?.upstream_status
}

async function loadNetworkAccount(c: AppContext): Promise<LoadedAccount> {
  const account = await loadAccount(c.env, c.get('userId'), c.req.param('accountId') ?? '')
  if (!account.row.cf_account_id) throw ApiError.badRequest('That account has no Cloudflare account id yet')
  return account
}

// ---------------------------------------------------------------------------------------------
// Load balancing: account pools/monitors, zone load balancers, pool health.
// ---------------------------------------------------------------------------------------------

networkRouter.get('/:accountId/load-balancer/pools', async (c) => {
  const account = await loadNetworkAccount(c)
  const body = await cfFetch<{ result?: unknown[] }>(
    account.auth,
    `/accounts/${encodeURIComponent(account.row.cf_account_id ?? '')}/load_balancers/pools`,
  )
  return c.json({ pools: (body.result ?? []).map(toPool).filter((pool) => pool !== null) })
})

networkRouter.get('/:accountId/load-balancer/monitors', async (c) => {
  const account = await loadNetworkAccount(c)
  const body = await cfFetch<{ result?: unknown[] }>(
    account.auth,
    `/accounts/${encodeURIComponent(account.row.cf_account_id ?? '')}/load_balancers/monitors`,
  )
  return c.json({ monitors: (body.result ?? []).map(toMonitor).filter((monitor) => monitor !== null) })
})

networkRouter.get('/:accountId/load-balancer/pools/:poolId/health', async (c) => {
  const account = await loadNetworkAccount(c)
  const poolId = pathId(c.req.param('poolId'), 'pool id')
  const body = await cfFetch<{ result?: unknown }>(
    account.auth,
    `/accounts/${encodeURIComponent(account.row.cf_account_id ?? '')}/load_balancers/pools/${encodeURIComponent(poolId)}/health`,
  )
  return c.json(toPoolHealth(body.result, poolId))
})

networkRouter.get('/:accountId/load-balancer/zones/:zoneId/load-balancers', async (c) => {
  const account = await loadNetworkAccount(c)
  const zoneId = pathId(c.req.param('zoneId'), 'zone id')
  await loadZoneForAccount(account.auth, account.row.cf_account_id ?? '', zoneId)
  const body = await cfFetch<{ result?: unknown[] }>(
    account.auth,
    `/zones/${encodeURIComponent(zoneId)}/load_balancers`,
  )
  return c.json({ loadBalancers: (body.result ?? []).map(toZoneLoadBalancer).filter((lb) => lb !== null) })
})

// ---------------------------------------------------------------------------------------------
// Bulk Redirects: account-level lists and their items.
// ---------------------------------------------------------------------------------------------

networkRouter.get('/:accountId/bulk-redirect/lists', async (c) => {
  const account = await loadNetworkAccount(c)
  try {
    const body = await cfFetch<{ result?: unknown[] }>(
      account.auth,
      `/accounts/${encodeURIComponent(account.row.cf_account_id ?? '')}/rules/lists`,
    )
    const lists = (body.result ?? [])
      .map(toBulkRedirectList)
      .filter((list) => list !== null)
      .filter((list) => list.kind === 'redirect' || list.kind === '')
    return c.json({ supported: true, lists })
  } catch (error) {
    const status = upstreamStatus(error)
    if (status === 403 || status === 404) {
      return c.json({
        supported: false,
        reason: errorText(error),
        lists: [],
      })
    }
    throw error
  }
})

networkRouter.get('/:accountId/bulk-redirect/lists/:listId/items', async (c) => {
  const account = await loadNetworkAccount(c)
  const listId = pathId(c.req.param('listId'), 'list id')
  const cursor = (c.req.query('cursor') ?? '').trim()
  if (cursor && !SAFE_ID.test(cursor)) throw ApiError.badRequest('Invalid cursor')
  const perPage = Math.min(Math.max(Number(c.req.query('per_page') ?? 100), 1), 100)
  const query = new URLSearchParams({ per_page: String(perPage) })
  if (cursor) query.set('cursor', cursor)
  const body = await cfFetch<{
    result?: unknown[]
    result_info?: { cursor?: string | null }
  }>(
    account.auth,
    `/accounts/${encodeURIComponent(account.row.cf_account_id ?? '')}/rules/lists/${encodeURIComponent(listId)}/items?${query.toString()}`,
  )
  return c.json({
    items: (body.result ?? []).map(toBulkRedirectItem).filter((item) => item !== null),
    cursor: body.result_info?.cursor ?? null,
  })
})

// ---------------------------------------------------------------------------------------------
// Email routing: settings, rules and account-level destination addresses.
// ---------------------------------------------------------------------------------------------

networkRouter.get('/:accountId/email-routing/:zoneId', async (c) => {
  const account = await loadNetworkAccount(c)
  const zoneId = pathId(c.req.param('zoneId'), 'zone id')
  const zone = await loadZoneForAccount(account.auth, account.row.cf_account_id ?? '', zoneId)
  const [settingsBody, rulesBody, addressesBody] = await Promise.all([
    cfFetch<{ result?: unknown }>(account.auth, `/zones/${encodeURIComponent(zone.id)}/email/routing`),
    cfFetch<{ result?: unknown[] }>(account.auth, `/zones/${encodeURIComponent(zone.id)}/email/routing/rules`),
    cfFetch<{ result?: unknown[] }>(
      account.auth,
      `/accounts/${encodeURIComponent(account.row.cf_account_id ?? '')}/email/routing/addresses`,
    ).catch((error: unknown) => {
      console.warn('[inkstone] Email routing destination addresses failed:', errorText(error))
      return { result: [] as unknown[] }
    }),
  ])
  return c.json({
    zoneId: zone.id,
    zoneName: zone.name,
    settings: toEmailRoutingSettings(settingsBody.result),
    rules: (rulesBody.result ?? []).map(toEmailRoutingRule).filter((rule) => rule !== null),
    addresses: (addressesBody.result ?? []).map(toEmailDestination).filter((address) => address !== null),
  })
})

// ---------------------------------------------------------------------------------------------
// Snippets: zone snippets and the rules that select them.
// ---------------------------------------------------------------------------------------------

networkRouter.get('/:accountId/snippets/:zoneId', async (c) => {
  const account = await loadNetworkAccount(c)
  const zoneId = pathId(c.req.param('zoneId'), 'zone id')
  const zone = await loadZoneForAccount(account.auth, account.row.cf_account_id ?? '', zoneId)
  let snippetsBody: { result?: unknown[] }
  try {
    snippetsBody = await cfFetch<{ result?: unknown[] }>(
      account.auth,
      `/zones/${encodeURIComponent(zone.id)}/snippets`,
    )
  } catch (error) {
    const status = upstreamStatus(error)
    if (status === 403 || status === 404) {
      return c.json({
        supported: false,
        reason: errorText(error),
        zoneId: zone.id,
        zoneName: zone.name,
        snippets: [],
        rules: [],
      })
    }
    throw error
  }

  // A zone that never created a snippet rule has no entrypoint ruleset; Cloudflare answers the rules
  // endpoint with a 404 envelope. That is an empty list, not an unsupported product.
  let rulesBody: { result?: unknown[] } = { result: [] }
  try {
    rulesBody = await cfFetch<{ result?: unknown[] }>(
      account.auth,
      `/zones/${encodeURIComponent(zone.id)}/snippets/snippet_rules`,
    )
  } catch (error) {
    const status = upstreamStatus(error)
    const message = errorText(error)
    if (!(status === 403 || status === 404) || !/entrypoint ruleset|not found/i.test(message)) throw error
  }

  return c.json({
    supported: true,
    zoneId: zone.id,
    zoneName: zone.name,
    snippets: (snippetsBody.result ?? []).map(toSnippet).filter((snippet) => snippet !== null),
    rules: (rulesBody.result ?? []).map(toSnippetRule).filter((rule) => rule !== null),
  })
})

// ---------------------------------------------------------------------------------------------
// Writes: create/delete only, so every control the screen draws has one endpoint behind it.
// ---------------------------------------------------------------------------------------------

function fieldText(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === 'string' ? body[key] as string : ''
}

function fieldNumber(body: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(body[key])
  return Number.isFinite(value) ? value : fallback
}

function fieldBoolean(body: Record<string, unknown>, key: string): boolean {
  return body[key] === true
}

async function auditWrite(
  c: AppContext,
  accountId: string,
  action: string,
  target: string,
  detail: string,
): Promise<void> {
  await createAuditLog(c.env, c.get('userId'), accountId, action, target, detail, 'success')
}

/** A load-balancer write refused with "Access Failed" means the account lacks the product, not a bad payload. */
function rethrowLoadBalancingEntitlement(error: unknown): never {
  if (error instanceof ApiError) {
    const upstream = (error.details as { upstream_status?: unknown } | undefined)?.upstream_status
    if (
      (upstream === 400 || upstream === 403)
      && /access failed|not enabled|not entitled|entitlement|interval is not in range \[1, ?1\]/i.test(error.message)
    ) {
      throw new ApiError(
        403,
        'cloudflare_load_balancing_unavailable',
        'Load Balancing is not enabled for this Cloudflare account',
      )
    }
  }
  throw error
}

networkRouter.post('/:accountId/load-balancer/pools', async (c) => {
  const account = await loadNetworkAccount(c)
  const body = await readJson<Record<string, unknown>>(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const pool = await createLoadBalancerPool(account.auth, account.row.cf_account_id ?? '', {
    name: fieldText(body, 'name'),
    address: fieldText(body, 'address'),
    ...(fieldText(body, 'monitorId') ? { monitorId: fieldText(body, 'monitorId') } : {}),
  }).catch((error: unknown) => rethrowLoadBalancingEntitlement(error))
  await auditWrite(c, account.row.id, 'create_lb_pool', pool.id, pool.name)
  return c.json(pool, 201)
})

networkRouter.delete('/:accountId/load-balancer/pools/:poolId', async (c) => {
  const account = await loadNetworkAccount(c)
  const poolId = pathId(c.req.param('poolId'), 'pool id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteLoadBalancerPool(account.auth, account.row.cf_account_id ?? '', poolId)
  await auditWrite(c, account.row.id, 'delete_lb_pool', poolId, 'pool deleted')
  return c.json({ deleted: true })
})

networkRouter.post('/:accountId/load-balancer/monitors', async (c) => {
  const account = await loadNetworkAccount(c)
  const body = await readJson<Record<string, unknown>>(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const monitor = await createLoadBalancerMonitor(account.auth, account.row.cf_account_id ?? '', {
    description: fieldText(body, 'description'),
    type: fieldText(body, 'type') || 'http',
    method: fieldText(body, 'method') || 'GET',
    path: fieldText(body, 'path') || '/',
    expectedCodes: fieldText(body, 'expectedCodes') || '200',
    interval: fieldNumber(body, 'interval', 60),
    timeout: fieldNumber(body, 'timeout', 5),
    retries: fieldNumber(body, 'retries', 2),
  }).catch((error: unknown) => rethrowLoadBalancingEntitlement(error))
  await auditWrite(c, account.row.id, 'create_lb_monitor', monitor.id, monitor.description)
  return c.json(monitor, 201)
})

networkRouter.delete('/:accountId/load-balancer/monitors/:monitorId', async (c) => {
  const account = await loadNetworkAccount(c)
  const monitorId = pathId(c.req.param('monitorId'), 'monitor id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteLoadBalancerMonitor(account.auth, account.row.cf_account_id ?? '', monitorId)
  await auditWrite(c, account.row.id, 'delete_lb_monitor', monitorId, 'monitor deleted')
  return c.json({ deleted: true })
})

networkRouter.post('/:accountId/load-balancer/zones/:zoneId/load-balancers', async (c) => {
  const account = await loadNetworkAccount(c)
  const zoneId = pathId(c.req.param('zoneId'), 'zone id')
  const zone = await loadZoneForAccount(account.auth, account.row.cf_account_id ?? '', zoneId)
  const body = await readJson<Record<string, unknown>>(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const poolIds = Array.isArray(body.defaultPools)
    ? body.defaultPools.filter((poolId): poolId is string => typeof poolId === 'string')
    : []
  const loadBalancer = await createZoneLoadBalancer(account.auth, zone.id, {
    name: fieldText(body, 'name'),
    fallbackPool: fieldText(body, 'fallbackPool'),
    defaultPools: poolIds,
  }).catch((error: unknown) => rethrowLoadBalancingEntitlement(error))
  await auditWrite(c, account.row.id, 'create_zone_lb', loadBalancer.id, `${zone.name}/${loadBalancer.name}`)
  return c.json(loadBalancer, 201)
})

networkRouter.delete('/:accountId/load-balancer/zones/:zoneId/load-balancers/:loadBalancerId', async (c) => {
  const account = await loadNetworkAccount(c)
  const zoneId = pathId(c.req.param('zoneId'), 'zone id')
  const loadBalancerId = pathId(c.req.param('loadBalancerId'), 'load balancer id')
  const zone = await loadZoneForAccount(account.auth, account.row.cf_account_id ?? '', zoneId)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteZoneLoadBalancer(account.auth, zone.id, loadBalancerId)
  await auditWrite(c, account.row.id, 'delete_zone_lb', `${zone.name}/${loadBalancerId}`, 'load balancer deleted')
  return c.json({ deleted: true })
})

networkRouter.post('/:accountId/bulk-redirect/lists', async (c) => {
  const account = await loadNetworkAccount(c)
  const body = await readJson<Record<string, unknown>>(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const list = await createBulkRedirectList(account.auth, account.row.cf_account_id ?? '', fieldText(body, 'name'))
  await auditWrite(c, account.row.id, 'create_bulk_list', list.id, list.name)
  return c.json(list, 201)
})

networkRouter.delete('/:accountId/bulk-redirect/lists/:listId', async (c) => {
  const account = await loadNetworkAccount(c)
  const listId = pathId(c.req.param('listId'), 'list id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteBulkRedirectList(account.auth, account.row.cf_account_id ?? '', listId)
  await auditWrite(c, account.row.id, 'delete_bulk_list', listId, 'redirect list deleted')
  return c.json({ deleted: true })
})

networkRouter.post('/:accountId/bulk-redirect/lists/:listId/items', async (c) => {
  const account = await loadNetworkAccount(c)
  const listId = pathId(c.req.param('listId'), 'list id')
  const body = await readJson<Record<string, unknown>>(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await createBulkRedirectItem(account.auth, account.row.cf_account_id ?? '', listId, {
    sourceUrl: fieldText(body, 'sourceUrl'),
    targetUrl: fieldText(body, 'targetUrl'),
    statusCode: fieldNumber(body, 'statusCode', 301),
    preserveQueryString: fieldBoolean(body, 'preserveQueryString'),
    includeSubdomains: fieldBoolean(body, 'includeSubdomains'),
  })
  await auditWrite(c, account.row.id, 'create_bulk_item', listId, `${fieldText(body, 'sourceUrl')} -> ${fieldText(body, 'targetUrl')}`)
  return c.json({ saved: true }, 201)
})

networkRouter.post('/:accountId/email-routing/:zoneId/rules', async (c) => {
  const account = await loadNetworkAccount(c)
  const zoneId = pathId(c.req.param('zoneId'), 'zone id')
  const zone = await loadZoneForAccount(account.auth, account.row.cf_account_id ?? '', zoneId)
  const body = await readJson<Record<string, unknown>>(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const action = fieldText(body, 'action') === 'forward' ? 'forward' : 'drop'
  const rule = await createEmailRoutingRule(account.auth, zone.id, {
    name: fieldText(body, 'name'),
    recipient: fieldText(body, 'recipient'),
    action,
    ...(action === 'forward' ? { destination: fieldText(body, 'destination') } : {}),
  })
  await auditWrite(c, account.row.id, 'create_email_rule', rule.id, `${zone.name}/${rule.name || rule.id}`)
  return c.json(rule, 201)
})

networkRouter.delete('/:accountId/email-routing/:zoneId/rules/:ruleId', async (c) => {
  const account = await loadNetworkAccount(c)
  const zoneId = pathId(c.req.param('zoneId'), 'zone id')
  const ruleId = pathId(c.req.param('ruleId'), 'rule id')
  const zone = await loadZoneForAccount(account.auth, account.row.cf_account_id ?? '', zoneId)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteEmailRoutingRule(account.auth, zone.id, ruleId)
  await auditWrite(c, account.row.id, 'delete_email_rule', `${zone.name}/${ruleId}`, 'routing rule deleted')
  return c.json({ deleted: true })
})

networkRouter.post('/:accountId/email-routing/:zoneId/enable', async (c) => {
  const account = await loadNetworkAccount(c)
  const zoneId = pathId(c.req.param('zoneId'), 'zone id')
  const zone = await loadZoneForAccount(account.auth, account.row.cf_account_id ?? '', zoneId)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const settings = await setEmailRoutingEnabled(account.auth, zone.id, true)
  await auditWrite(c, account.row.id, 'enable_email_routing', zone.name, 'email routing enabled')
  return c.json(settings)
})

networkRouter.post('/:accountId/email-routing/:zoneId/disable', async (c) => {
  const account = await loadNetworkAccount(c)
  const zoneId = pathId(c.req.param('zoneId'), 'zone id')
  const zone = await loadZoneForAccount(account.auth, account.row.cf_account_id ?? '', zoneId)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const settings = await setEmailRoutingEnabled(account.auth, zone.id, false)
  await auditWrite(c, account.row.id, 'disable_email_routing', zone.name, 'email routing disabled')
  return c.json(settings)
})

networkRouter.post('/:accountId/email-routing/addresses', async (c) => {
  const account = await loadNetworkAccount(c)
  const body = await readJson<Record<string, unknown>>(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  const destination = await createEmailDestination(account.auth, account.row.cf_account_id ?? '', fieldText(body, 'email'))
  await auditWrite(c, account.row.id, 'create_email_address', destination.id, destination.email)
  return c.json(destination, 201)
})

networkRouter.delete('/:accountId/email-routing/addresses/:addressId', async (c) => {
  const account = await loadNetworkAccount(c)
  const addressId = pathId(c.req.param('addressId'), 'address id')
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteEmailDestination(account.auth, account.row.cf_account_id ?? '', addressId)
  await auditWrite(c, account.row.id, 'delete_email_address', addressId, 'destination address deleted')
  return c.json({ deleted: true })
})

networkRouter.post('/:accountId/snippets/:zoneId', async (c) => {
  const account = await loadNetworkAccount(c)
  const zoneId = pathId(c.req.param('zoneId'), 'zone id')
  const zone = await loadZoneForAccount(account.auth, account.row.cf_account_id ?? '', zoneId)
  const body = await readJson<Record<string, unknown>>(c)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await createZoneSnippet(account.auth, zone.id, {
    name: fieldText(body, 'name'),
    content: fieldText(body, 'content'),
    ...(fieldText(body, 'expression') ? { expression: fieldText(body, 'expression') } : {}),
    ...(fieldText(body, 'description') ? { description: fieldText(body, 'description') } : {}),
  })
  await auditWrite(c, account.row.id, 'create_snippet', `${zone.name}/${fieldText(body, 'name')}`, 'snippet saved')
  return c.json({ saved: true }, 201)
})

networkRouter.delete('/:accountId/snippets/:zoneId/rules/:ruleId', async (c) => {
  const account = await loadNetworkAccount(c)
  const zoneId = pathId(c.req.param('zoneId'), 'zone id')
  const ruleId = pathId(c.req.param('ruleId'), 'rule id')
  const zone = await loadZoneForAccount(account.auth, account.row.cf_account_id ?? '', zoneId)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteZoneSnippetRule(account.auth, zone.id, ruleId)
  await auditWrite(c, account.row.id, 'delete_snippet_rule', `${zone.name}/${ruleId}`, 'snippet rule deleted')
  return c.json({ deleted: true })
})

networkRouter.delete('/:accountId/snippets/:zoneId/:name', async (c) => {
  const account = await loadNetworkAccount(c)
  const zoneId = pathId(c.req.param('zoneId'), 'zone id')
  const name = c.req.param('name')
  const zone = await loadZoneForAccount(account.auth, account.row.cf_account_id ?? '', zoneId)
  await assertNotDemo(c.env, c.get('userId'), account.row.id)
  await deleteZoneSnippet(account.auth, zone.id, name)
  await auditWrite(c, account.row.id, 'delete_snippet', `${zone.name}/${name}`, 'snippet deleted')
  return c.json({ deleted: true })
})
