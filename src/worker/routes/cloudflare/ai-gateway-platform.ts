/**
 * `/api/cloudflare/ai-gateway-platform` — the Cloudflare AI Gateway management surface.
 *
 * Every endpoint is addressed through an account the reader owns, and the account's Cloudflare id
 * is the only thing sent upstream. Reads and writes share this router; every write reads before it
 * writes, reads the result back and rolls back when the platform did not apply it.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { readJson } from '../../lib/request'
import { assertNotDemo, loadAccount } from '../../cloudflare/accounts'
import { auditFailureDetail, createAuditLog } from '../../cloudflare/audit'
import {
  createPlatformGateway,
  createPlatformProviderConfig,
  createPlatformRoute,
  deletePlatformGateway,
  deletePlatformProviderConfig,
  deletePlatformRoute,
  deletePlatformSpendingLimit,
  getPlatformAnalytics,
  getPlatformGateway,
  getPlatformGatewayUrl,
  getPlatformLog,
  getPlatformLogPayload,
  getPlatformSpendingLimit,
  listPlatformGateways,
  listPlatformLogs,
  listPlatformProviderConfigs,
  listPlatformRouteDeployments,
  listPlatformRouteVersions,
  listPlatformRoutes,
  updatePlatformGateway,
  updatePlatformProviderConfig,
} from '../../cloudflare/ai-gateway-platform'
import type {
  AIGatewayCreateParams,
  AIGatewayGetResponse,
  AIGatewayUpdateParams,
} from 'cloudflare/resources/ai-gateway/ai-gateway'
import type { LogListParams, ProviderConfigCreateParams } from 'cloudflare/resources/ai-gateway'

export const aiGatewayPlatformRouter = new Hono<AppBindings>()

function pathId(value: string | undefined, label: string): string {
  const id = (value ?? '').trim()
  if (!id || id.length > 128 || /[/?#]/.test(id)) throw ApiError.badRequest(`Invalid ${label}`)
  return id
}

async function accountFor(c: Context<AppBindings>) {
  const id = pathId(c.req.param('id'), 'account id')
  await assertNotDemo(c.env, c.get('userId'), id)
  return await loadAccount(c.env, c.get('userId'), id)
}

function pageNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function filtersOf(c: Context<AppBindings>): LogListParams['filters'] {
  const filters: NonNullable<LogListParams['filters']> = []
  const status = c.req.query('status')
  if (status === 'success' || status === 'error') {
    filters.push({ key: 'success', operator: 'eq', value: [status === 'success'] })
  }
  const cached = c.req.query('cached')
  if (cached === 'true' || cached === 'false') {
    filters.push({ key: 'cached', operator: 'eq', value: [cached === 'true'] })
  }
  const model = c.req.query('model')
  if (model) filters.push({ key: 'model', operator: 'eq', value: [model] })
  const provider = c.req.query('provider')
  if (provider) filters.push({ key: 'provider', operator: 'eq', value: [provider] })
  const from = c.req.query('from')
  if (from) filters.push({ key: 'created_at', operator: 'gt', value: [from] })
  const to = c.req.query('to')
  if (to) filters.push({ key: 'created_at', operator: 'lt', value: [to] })
  return filters
}

aiGatewayPlatformRouter.get('/accounts/:id/gateways', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const page = pageNumber(c.req.query('page'), 1)
  const perPage = pageNumber(c.req.query('perPage'), 20)
  return c.json(await listPlatformGateways(auth, row.cf_account_id, {
    search: c.req.query('search'),
    page,
    perPage,
  }))
})

aiGatewayPlatformRouter.get('/accounts/:id/gateways/:gatewayId', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  return c.json(await getPlatformGateway(auth, row.cf_account_id, pathId(c.req.param('gatewayId'), 'gateway id')))
})

aiGatewayPlatformRouter.get('/accounts/:id/gateways/:gatewayId/url/:provider', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  return c.json({
    url: await getPlatformGatewayUrl(
      auth,
      row.cf_account_id,
      pathId(c.req.param('gatewayId'), 'gateway id'),
      pathId(c.req.param('provider'), 'provider'),
    ),
  })
})

aiGatewayPlatformRouter.get('/accounts/:id/gateways/:gatewayId/logs', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const page = pageNumber(c.req.query('page'), 1)
  const perPage = pageNumber(c.req.query('perPage'), 20)
  return c.json(await listPlatformLogs(
    auth,
    row.cf_account_id,
    pathId(c.req.param('gatewayId'), 'gateway id'),
    { page, perPage, filters: filtersOf(c) },
  ))
})

aiGatewayPlatformRouter.get('/accounts/:id/gateways/:gatewayId/logs/:logId', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  return c.json(await getPlatformLog(
    auth,
    row.cf_account_id,
    pathId(c.req.param('gatewayId'), 'gateway id'),
    pathId(c.req.param('logId'), 'log id'),
  ))
})

aiGatewayPlatformRouter.get('/accounts/:id/gateways/:gatewayId/logs/:logId/:kind', async (c) => {
  const kind = c.req.param('kind')
  if (kind !== 'request' && kind !== 'response') throw ApiError.notFound('Unknown log payload')
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  return c.json(await getPlatformLogPayload(
    auth,
    row.cf_account_id,
    pathId(c.req.param('gatewayId'), 'gateway id'),
    pathId(c.req.param('logId'), 'log id'),
    kind,
  ))
})

aiGatewayPlatformRouter.get('/accounts/:id/gateways/:gatewayId/routes', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  return c.json({
    items: await listPlatformRoutes(
      auth,
      row.cf_account_id,
      pathId(c.req.param('gatewayId'), 'gateway id'),
    ),
  })
})

aiGatewayPlatformRouter.get('/accounts/:id/gateways/:gatewayId/routes/:routeId/:section', async (c) => {
  const section = c.req.param('section')
  if (section !== 'versions' && section !== 'deployments') throw ApiError.notFound('Unknown route section')
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const gatewayId = pathId(c.req.param('gatewayId'), 'gateway id')
  const routeId = pathId(c.req.param('routeId'), 'route id')
  const items = section === 'versions'
    ? await listPlatformRouteVersions(auth, row.cf_account_id, gatewayId, routeId)
    : await listPlatformRouteDeployments(auth, row.cf_account_id, gatewayId, routeId)
  return c.json({ items })
})

aiGatewayPlatformRouter.get('/accounts/:id/gateways/:gatewayId/provider-configs', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const page = pageNumber(c.req.query('page'), 1)
  const perPage = pageNumber(c.req.query('perPage'), 20)
  return c.json(await listPlatformProviderConfigs(
    auth,
    row.cf_account_id,
    pathId(c.req.param('gatewayId'), 'gateway id'),
    { page, perPage },
  ))
})

aiGatewayPlatformRouter.get('/accounts/:id/billing/spending-limit', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  return c.json(await getPlatformSpendingLimit(auth, row.cf_account_id))
})

aiGatewayPlatformRouter.get('/accounts/:id/gateways/:gatewayId/analytics', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const days = Math.min(90, Math.max(1, pageNumber(c.req.query('days'), 7)))
  return c.json(await getPlatformAnalytics(
    auth,
    row.cf_account_id,
    pathId(c.req.param('gatewayId'), 'gateway id'),
    days,
  ))
})

function gatewayIdInput(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw ApiError.badRequest('Gateway id must be 1-64 letters, numbers, underscores or hyphens', { field: 'id' })
  }
  return id
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw ApiError.badRequest(`${field} must be an integer between ${min} and ${max}`, { field })
  }
  return parsed
}

function gatewayBody(body: Record<string, unknown>, accountId: string): AIGatewayCreateParams {
  const params: AIGatewayCreateParams = {
    account_id: accountId,
    id: gatewayIdInput(body.id),
    cache_ttl: optionalInteger(body.cache_ttl, 'cache_ttl', 0, 31_536_000) ?? 0,
    cache_invalidate_on_update: body.cache_invalidate_on_update !== false,
    collect_logs: body.collect_logs !== false,
    rate_limiting_interval: optionalInteger(body.rate_limiting_interval, 'rate_limiting_interval', 0, 86_400) ?? 0,
    rate_limiting_limit: optionalInteger(body.rate_limiting_limit, 'rate_limiting_limit', 0, 10_000_000) ?? 0,
  }
  if (body.rate_limiting_technique === 'fixed' || body.rate_limiting_technique === 'sliding') {
    params.rate_limiting_technique = body.rate_limiting_technique
  }
  if (typeof body.authentication === 'boolean') params.authentication = body.authentication
  if (typeof body.byok_only === 'boolean') params.byok_only = body.byok_only
  const attempts = optionalInteger(body.retry_max_attempts, 'retry_max_attempts', 1, 5)
  const delay = optionalInteger(body.retry_delay, 'retry_delay', 0, 60_000)
  if (attempts !== undefined) params.retry_max_attempts = attempts
  if (delay !== undefined) params.retry_delay = delay
  if (body.retry_backoff === 'constant' || body.retry_backoff === 'linear' || body.retry_backoff === 'exponential') {
    params.retry_backoff = body.retry_backoff
  }
  return params
}

function updateGatewayBody(body: Record<string, unknown>, accountId: string): AIGatewayUpdateParams {
  const params: AIGatewayUpdateParams = {
    account_id: accountId,
    cache_ttl: optionalInteger(body.cache_ttl, 'cache_ttl', 0, 31_536_000) ?? 0,
    cache_invalidate_on_update: body.cache_invalidate_on_update !== false,
    collect_logs: body.collect_logs !== false,
    rate_limiting_interval: optionalInteger(body.rate_limiting_interval, 'rate_limiting_interval', 0, 86_400) ?? 0,
    rate_limiting_limit: optionalInteger(body.rate_limiting_limit, 'rate_limiting_limit', 0, 10_000_000) ?? 0,
  }
  if (body.rate_limiting_technique === 'fixed' || body.rate_limiting_technique === 'sliding') {
    params.rate_limiting_technique = body.rate_limiting_technique
  }
  if (typeof body.authentication === 'boolean') params.authentication = body.authentication
  if (typeof body.byok_only === 'boolean') params.byok_only = body.byok_only
  const attempts = optionalInteger(body.retry_max_attempts, 'retry_max_attempts', 1, 5)
  const delay = optionalInteger(body.retry_delay, 'retry_delay', 0, 60_000)
  if (attempts !== undefined) params.retry_max_attempts = attempts
  if (delay !== undefined) params.retry_delay = delay
  if (body.retry_backoff === 'constant' || body.retry_backoff === 'linear' || body.retry_backoff === 'exponential') {
    params.retry_backoff = body.retry_backoff
  }
  return params
}

function snapshotParams(gateway: AIGatewayGetResponse, accountId: string): AIGatewayUpdateParams {
  return {
    account_id: accountId,
    cache_ttl: gateway.cache_ttl ?? 0,
    cache_invalidate_on_update: gateway.cache_invalidate_on_update,
    collect_logs: gateway.collect_logs,
    rate_limiting_interval: gateway.rate_limiting_interval ?? 0,
    rate_limiting_limit: gateway.rate_limiting_limit ?? 0,
    ...(gateway.rate_limiting_technique ? { rate_limiting_technique: gateway.rate_limiting_technique } : {}),
    ...(gateway.authentication === undefined ? {} : { authentication: gateway.authentication }),
    ...(gateway.byok_only === undefined ? {} : { byok_only: gateway.byok_only }),
    ...(gateway.retry_max_attempts === null || gateway.retry_max_attempts === undefined ? {} : { retry_max_attempts: gateway.retry_max_attempts }),
    ...(gateway.retry_delay === null || gateway.retry_delay === undefined ? {} : { retry_delay: gateway.retry_delay }),
    ...(gateway.retry_backoff ? { retry_backoff: gateway.retry_backoff } : {}),
    // Omit `store_id` on purpose: Cloudflare keeps the current store when the field is absent.
    spend_limits: gateway.spend_limits ?? { enabled: false, rules: [] },
  }
}

function configMatches(
  readBack: AIGatewayGetResponse,
  written: AIGatewayGetResponse,
  keys: string[],
): boolean {
  return keys.every((key) => JSON.stringify((readBack as unknown as Record<string, unknown>)[key])
    === JSON.stringify((written as unknown as Record<string, unknown>)[key]))
}

function isMissing(error: unknown): boolean {
  if (error instanceof ApiError) {
    return (error.details as { upstream_status?: number } | undefined)?.upstream_status === 404
  }
  return false
}

function upstreamCode(error: unknown): number | undefined {
  if (!(error instanceof ApiError)) return undefined
  return (error.details as { cf_code?: number } | undefined)?.cf_code
}

/** 9106 is Cloudflare's "missing auth headers", not a capability gate. Name it that way. */
function rethrowRouteError(error: unknown): never {
  if (upstreamCode(error) === 9106) {
    throw new ApiError(
      (error as ApiError).status,
      'cloudflare_auth_missing',
      'Cloudflare rejected the route request because the authentication headers are missing. Check the account credential and retry.',
      (error as ApiError).details,
    )
  }
  throw error
}

/** 7020 means the new secret is still propagating in Secrets Store: a retry, not a failure. */
function rethrowProviderUpdateError(error: unknown): never {
  if (upstreamCode(error) === 7020) {
    throw new ApiError(
      409,
      'cloudflare_secret_pending',
      'The new secret is not visible in Secrets Store yet. Retry in a few seconds.',
      (error as ApiError).details,
    )
  }
  throw error
}

interface SpendLimitRuleInput {
  id?: string
  limit: number
  limitType: 'cost'
  window: number
  technique?: 'fixed' | 'sliding'
}

interface SpendLimitsInput {
  enabled: boolean
  rules: SpendLimitRuleInput[]
}

/** Normalise the new gateway-level spend limits; the old `/billing/spending-limit` is deprecated. */
function spendLimitsInput(body: Record<string, unknown>): SpendLimitsInput {
  if (typeof body.enabled !== 'boolean') throw ApiError.badRequest('enabled must be a boolean')
  if (!Array.isArray(body.rules)) throw ApiError.badRequest('rules must be an array')
  if (body.rules.length > 20) throw ApiError.badRequest('At most 20 spend limit rules are allowed')
  const rules: SpendLimitRuleInput[] = body.rules.map((raw) => {
    const rule = raw as Record<string, unknown>
    const limit = Number(rule.limit)
    const window = Number(rule.window)
    if (!Number.isFinite(limit) || limit <= 0) throw ApiError.badRequest('limit must be greater than 0')
    if (!Number.isInteger(window) || window <= 0) throw ApiError.badRequest('window must be a positive whole number of seconds')
    if (rule.limitType !== undefined && rule.limitType !== 'cost') {
      throw ApiError.badRequest('limitType must be cost')
    }
    const technique = rule.technique === 'fixed' || rule.technique === 'sliding' ? rule.technique : undefined
    return {
      ...(typeof rule.id === 'string' && rule.id.trim() ? { id: rule.id.trim() } : {}),
      limit,
      limitType: 'cost',
      window,
      ...(technique ? { technique } : {}),
    }
  })
  return { enabled: body.enabled, rules: body.enabled ? rules : [] }
}

function spendLimitsMatch(
  readBack: AIGatewayGetResponse['spend_limits'],
  written: SpendLimitsInput,
): boolean {
  const actual = readBack ?? { enabled: false, rules: [] }
  if (Boolean(actual.enabled) !== written.enabled) return false
  const key = (rule: { limit?: unknown; limitType?: unknown; window?: unknown; technique?: unknown }): string =>
    `${String(rule.limit)}|${String(rule.limitType)}|${String(rule.window)}|${String(rule.technique ?? '')}`
  const actualKeys = (actual.rules ?? []).map(key).sort()
  const writtenKeys = written.rules.map(key).sort()
  return actualKeys.length === writtenKeys.length
    && actualKeys.every((value, index) => value === writtenKeys[index])
}

aiGatewayPlatformRouter.post('/accounts/:id/gateways', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const userId = c.get('userId')
  const input = await readJson<Record<string, unknown>>(c, 8192)
  const params = gatewayBody(input, row.cf_account_id)
  const existing = await listPlatformGateways(auth, row.cf_account_id, { search: params.id, perPage: 50 })
  if (existing.items.some((item) => item.id === params.id)) {
    throw ApiError.conflict(`AI Gateway ${params.id} already exists`)
  }
  try {
    await createPlatformGateway(auth, row.cf_account_id, params)
    const readBack = await getPlatformGateway(auth, row.cf_account_id, params.id).catch(() => null)
    if (!readBack) {
      await deletePlatformGateway(auth, row.cf_account_id, params.id).catch(() => undefined)
      throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare reported success but the gateway is not readable')
    }
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.gateway.create', params.id,
      JSON.stringify({ cache_ttl: readBack.cache_ttl, collect_logs: readBack.collect_logs }), 'success')
    return c.json({ gateway: readBack }, 201)
  } catch (error) {
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.gateway.create', params.id,
      auditFailureDetail(error), 'error')
    throw error
  }
})

aiGatewayPlatformRouter.put('/accounts/:id/gateways/:gatewayId', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const userId = c.get('userId')
  const gatewayId = pathId(c.req.param('gatewayId'), 'gateway id')
  const input = await readJson<Record<string, unknown>>(c, 8192)
  const before = await getPlatformGateway(auth, row.cf_account_id, gatewayId)
  const params = updateGatewayBody(input, row.cf_account_id)
  // Keep the gateway-level spend limits when this request is only editing the rest of the config.
  params.spend_limits = before.spend_limits ?? { enabled: false, rules: [] }
  try {
    const written = await updatePlatformGateway(auth, row.cf_account_id, gatewayId, params)
    const readBack = await getPlatformGateway(auth, row.cf_account_id, gatewayId)
    const keys = ['cache_ttl', 'cache_invalidate_on_update', 'collect_logs', 'rate_limiting_interval',
      'rate_limiting_limit', 'rate_limiting_technique', 'authentication', 'byok_only', 'retry_max_attempts',
      'retry_delay', 'retry_backoff']
    if (!configMatches(readBack, written, keys)) {
      await updatePlatformGateway(auth, row.cf_account_id, gatewayId, snapshotParams(before, row.cf_account_id))
        .catch(() => undefined)
      throw new ApiError(502, 'cloudflare_upstream', 'The gateway config did not read back as written; it was rolled back')
    }
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.gateway.update', gatewayId,
      JSON.stringify({ before: snapshotParams(before, row.cf_account_id), after: params }), 'success')
    return c.json({ gateway: readBack })
  } catch (error) {
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.gateway.update', gatewayId,
      auditFailureDetail(error), 'error')
    throw error
  }
})

/**
 * Gateway-level spend limits: the replacement for the deprecated account-level endpoint.
 *
 * The write is a gateway update because Cloudflare stores these rules on the gateway itself. The
 * full gateway snapshot is sent with the new rules so the rest of the config cannot be reset as a
 * side effect, and the previous snapshot is written back when the read-back does not match.
 */
aiGatewayPlatformRouter.put('/accounts/:id/gateways/:gatewayId/spend-limits', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const userId = c.get('userId')
  const gatewayId = pathId(c.req.param('gatewayId'), 'gateway id')
  const input = await readJson<Record<string, unknown>>(c, 16 * 1024)
  const spendLimits = spendLimitsInput(input)
  const before = await getPlatformGateway(auth, row.cf_account_id, gatewayId)
  try {
    const params: AIGatewayUpdateParams = {
      ...snapshotParams(before, row.cf_account_id),
      spend_limits: spendLimits,
    }
    await updatePlatformGateway(auth, row.cf_account_id, gatewayId, params)
    const readBack = await getPlatformGateway(auth, row.cf_account_id, gatewayId)
    if (!spendLimitsMatch(readBack.spend_limits, spendLimits)) {
      await updatePlatformGateway(auth, row.cf_account_id, gatewayId, snapshotParams(before, row.cf_account_id))
        .catch(() => undefined)
      throw new ApiError(502, 'cloudflare_upstream', 'The spend limits did not read back as written; they were rolled back')
    }
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.billing.spend_limits', gatewayId,
      JSON.stringify({ before: before.spend_limits ?? null, after: readBack.spend_limits ?? null }), 'success')
    return c.json({ spendLimits: readBack.spend_limits ?? { enabled: false, rules: [] } })
  } catch (error) {
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.billing.spend_limits', gatewayId,
      auditFailureDetail(error), 'error')
    throw error
  }
})

aiGatewayPlatformRouter.delete('/accounts/:id/gateways/:gatewayId', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const userId = c.get('userId')
  const gatewayId = pathId(c.req.param('gatewayId'), 'gateway id')
  const before = await getPlatformGateway(auth, row.cf_account_id, gatewayId).catch((error: unknown) => {
    if (isMissing(error)) throw ApiError.notFound('That AI Gateway does not exist')
    throw error
  })
  try {
    await deletePlatformGateway(auth, row.cf_account_id, gatewayId)
    let stillThere = false
    try {
      await getPlatformGateway(auth, row.cf_account_id, gatewayId)
      stillThere = true
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (stillThere) {
      throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare reported success but the gateway is still readable')
    }
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.gateway.delete', gatewayId,
      JSON.stringify({ cache_ttl: before.cache_ttl, collect_logs: before.collect_logs }), 'success')
    return c.json({ deleted: true })
  } catch (error) {
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.gateway.delete', gatewayId,
      auditFailureDetail(error), 'error')
    throw error
  }
})

/**
 * Creating a dynamic route is available; the earlier `400 / 9106` was a missing-auth probe, not a
 * capability gate. The single-version delete is the one real gap: deleting a route removes its
 * versions and deployments instead.
 */
aiGatewayPlatformRouter.post('/accounts/:id/gateways/:gatewayId/routes', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const userId = c.get('userId')
  const gatewayId = pathId(c.req.param('gatewayId'), 'gateway id')
  const input = await readJson<Record<string, unknown>>(c, 8192)
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 64) throw ApiError.badRequest('A route name of 1-64 characters is required')
  const elements = Array.isArray(input.elements) ? input.elements : []
  const before = await listPlatformRoutes(auth, row.cf_account_id, gatewayId)
  if (before.some((route) => route.name === name)) throw ApiError.conflict(`A route named ${name} already exists`)
  try {
    const created = await createPlatformRoute(auth, row.cf_account_id, gatewayId, { name, elements })
    const after = await listPlatformRoutes(auth, row.cf_account_id, gatewayId)
    if (!after.some((route) => route.id === created.id)) {
      await deletePlatformRoute(auth, row.cf_account_id, gatewayId, created.id).catch(() => undefined)
      throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare reported success but the route is not listed')
    }
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.route.create', `${gatewayId}/${created.id}`,
      JSON.stringify({ name }), 'success')
    return c.json({ route: created }, 201)
  } catch (error) {
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.route.create', `${gatewayId}/${name}`,
      auditFailureDetail(error), 'error')
    rethrowRouteError(error)
  }
})

aiGatewayPlatformRouter.delete('/accounts/:id/gateways/:gatewayId/routes/:routeId', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const userId = c.get('userId')
  const gatewayId = pathId(c.req.param('gatewayId'), 'gateway id')
  const routeId = pathId(c.req.param('routeId'), 'route id')
  const before = await listPlatformRoutes(auth, row.cf_account_id, gatewayId)
  const match = before.find((route) => route.id === routeId)
  if (!match) throw ApiError.notFound('That route does not exist')
  try {
    await deletePlatformRoute(auth, row.cf_account_id, gatewayId, routeId)
    const after = await listPlatformRoutes(auth, row.cf_account_id, gatewayId)
    if (after.some((route) => route.id === routeId)) {
      throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare reported success but the route is still listed')
    }
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.route.delete', `${gatewayId}/${routeId}`,
      JSON.stringify({ name: match.name }), 'success')
    return c.json({ deleted: true })
  } catch (error) {
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.route.delete', `${gatewayId}/${routeId}`,
      auditFailureDetail(error), 'error')
    throw error
  }
})

aiGatewayPlatformRouter.post('/accounts/:id/gateways/:gatewayId/provider-configs', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const userId = c.get('userId')
  const gatewayId = pathId(c.req.param('gatewayId'), 'gateway id')
  const input = await readJson<Record<string, unknown>>(c, 8192)
  const alias = typeof input.alias === 'string' ? input.alias.trim() : ''
  const providerSlug = typeof input.provider_slug === 'string' ? input.provider_slug.trim() : ''
  const secret = typeof input.secret === 'string' ? input.secret.trim() : ''
  if (!alias || !providerSlug || !secret) throw ApiError.badRequest('alias, provider_slug and secret are required')
  const before = await listPlatformProviderConfigs(auth, row.cf_account_id, gatewayId, { perPage: 50 })
  if (before.items.some((item) => item.alias === alias && item.provider_slug === providerSlug)) {
    throw ApiError.conflict('That provider key alias already exists')
  }
  const params: ProviderConfigCreateParams = {
    account_id: row.cf_account_id,
    alias,
    provider_slug: providerSlug,
    secret,
    default_config: typeof input.default_config === 'boolean' ? input.default_config : false,
  }
  try {
    const created = await createPlatformProviderConfig(auth, row.cf_account_id, gatewayId, params)
    const after = await listPlatformProviderConfigs(auth, row.cf_account_id, gatewayId, { perPage: 50 })
    if (!after.items.some((item) => item.id === created.id)) {
      throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare reported success but the provider key is not listed')
    }
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.provider.create', `${gatewayId}/${created.id}`,
      JSON.stringify({ alias, provider_slug: providerSlug, secret_preview: created.secret_preview }), 'success')
    return c.json({ provider: created }, 201)
  } catch (error) {
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.provider.create', `${gatewayId}/${alias}`,
      auditFailureDetail(error), 'error')
    throw error
  }
})

/**
 * Provider-key update and delete.
 *
 * The SDK declares only create/list for this resource, but real calls answered PUT and DELETE. A
 * field-by-field probe found that PUT only applies the secret: alias, provider slug, default flag
 * and rate limits came back unchanged. This route therefore rotates the secret only and sends the
 * current metadata back untouched.
 */
aiGatewayPlatformRouter.put('/accounts/:id/gateways/:gatewayId/provider-configs/:providerId', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const userId = c.get('userId')
  const gatewayId = pathId(c.req.param('gatewayId'), 'gateway id')
  const providerId = pathId(c.req.param('providerId'), 'provider id')
  const input = await readJson<Record<string, unknown>>(c, 8192)
  const secret = typeof input.secret === 'string' ? input.secret.trim() : ''
  if (!secret) throw ApiError.badRequest('secret is required to rotate the provider key')
  const listed = await listPlatformProviderConfigs(auth, row.cf_account_id, gatewayId, { perPage: 50 })
  const before = listed.items.find((item) => item.id === providerId)
  if (!before) throw ApiError.notFound('That provider key does not exist')
  try {
    await updatePlatformProviderConfig(auth, row.cf_account_id, gatewayId, providerId, {
      account_id: row.cf_account_id,
      alias: before.alias,
      default_config: before.default_config,
      provider_slug: before.provider_slug,
      secret,
    })
    const after = await listPlatformProviderConfigs(auth, row.cf_account_id, gatewayId, { perPage: 50 })
    const readBack = after.items.find((item) => item.id === providerId)
    if (!readBack) throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare reported success but the provider key is not listed')
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.provider.update', `${gatewayId}/${providerId}`,
      JSON.stringify({ before: before.secret_preview, after: readBack.secret_preview }), 'success')
    return c.json({ provider: readBack })
  } catch (error) {
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.provider.update', `${gatewayId}/${providerId}`,
      auditFailureDetail(error), 'error')
    rethrowProviderUpdateError(error)
  }
})

aiGatewayPlatformRouter.delete('/accounts/:id/gateways/:gatewayId/provider-configs/:providerId', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const userId = c.get('userId')
  const gatewayId = pathId(c.req.param('gatewayId'), 'gateway id')
  const providerId = pathId(c.req.param('providerId'), 'provider id')
  const before = await listPlatformProviderConfigs(auth, row.cf_account_id, gatewayId, { perPage: 50 })
  const match = before.items.find((item) => item.id === providerId)
  if (!match) throw ApiError.notFound('That provider key does not exist')
  try {
    await deletePlatformProviderConfig(auth, row.cf_account_id, gatewayId, providerId)
    const after = await listPlatformProviderConfigs(auth, row.cf_account_id, gatewayId, { perPage: 50 })
    if (after.items.some((item) => item.id === providerId)) {
      throw new ApiError(502, 'cloudflare_upstream', 'Cloudflare reported success but the provider key is still listed')
    }
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.provider.delete', `${gatewayId}/${providerId}`,
      JSON.stringify({ alias: match.alias, provider_slug: match.provider_slug }), 'success')
    return c.json({ deleted: true })
  } catch (error) {
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.provider.delete', `${gatewayId}/${providerId}`,
      auditFailureDetail(error), 'error')
    throw error
  }
})

aiGatewayPlatformRouter.delete('/accounts/:id/billing/spending-limit', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const userId = c.get('userId')
  const before = await getPlatformSpendingLimit(auth, row.cf_account_id)
  try {
    await deletePlatformSpendingLimit(auth, row.cf_account_id)
    const readBack = await getPlatformSpendingLimit(auth, row.cf_account_id)
    if (readBack.enabled) {
      // The deprecated create endpoint always answers 403, so this delete has no rollback: the old
      // limit can only be removed, not recreated. Say that plainly instead of pretending to restore.
      throw new ApiError(502, 'cloudflare_upstream', 'The old spending limit is still enabled; the deprecated create endpoint cannot recreate it, so the delete cannot be rolled back')
    }
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.billing.limit.clear', 'spending-limit',
      JSON.stringify({ before }), 'success')
    return c.json({ deleted: true })
  } catch (error) {
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.billing.limit.clear', 'spending-limit',
      auditFailureDetail(error), 'error')
    throw error
  }
})
