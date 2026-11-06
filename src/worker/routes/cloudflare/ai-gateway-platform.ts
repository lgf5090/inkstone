/**
 * `/api/cloudflare/ai-gateway-platform` — the Cloudflare AI Gateway management surface.
 *
 * Every endpoint is addressed through an account the reader owns, and the account's Cloudflare id
 * is the only thing sent upstream. This router is read-only on purpose: the write endpoints and
 * their confirmation, audit and rollback live in a separate change.
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
  createPlatformSpendingLimit,
  deletePlatformGateway,
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
} from '../../cloudflare/ai-gateway-platform'
import type {
  AIGatewayCreateParams,
  AIGatewayGetResponse,
  AIGatewayUpdateParams,
} from 'cloudflare/resources/ai-gateway/ai-gateway'
import type { LogListParams, ProviderConfigCreateParams } from 'cloudflare/resources/ai-gateway'
import type { SpendingLimitCreateParams } from 'cloudflare/resources/ai-gateway/billing'

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

aiGatewayPlatformRouter.post('/accounts/:id/billing/spending-limit', async (c) => {
  const { auth, row } = await accountFor(c)
  if (!row.cf_account_id) throw ApiError.badRequest('This account has no Cloudflare account id')
  const userId = c.get('userId')
  const input = await readJson<Record<string, unknown>>(c, 4096)
  const amount = optionalInteger(input.amount, 'amount', 100, 100_000_000)
  if (amount === undefined) throw ApiError.badRequest('amount is required and must be at least 100 cents')
  const duration = input.duration
  if (duration !== 'daily' && duration !== 'weekly' && duration !== 'monthly') {
    throw ApiError.badRequest('duration must be daily, weekly or monthly', { field: 'duration' })
  }
  const strategy = input.strategy
  if (strategy !== 'fixed' && strategy !== 'sliding') {
    throw ApiError.badRequest('strategy must be fixed or sliding', { field: 'strategy' })
  }
  const before = await getPlatformSpendingLimit(auth, row.cf_account_id).catch(() => null)
  const params: SpendingLimitCreateParams = {
    account_id: row.cf_account_id,
    amount,
    duration,
    strategy,
  }
  try {
    await createPlatformSpendingLimit(auth, row.cf_account_id, params)
    const readBack = await getPlatformSpendingLimit(auth, row.cf_account_id)
    if (!readBack.enabled || readBack.config.amount !== amount
      || readBack.config.duration !== duration || readBack.config.strategy !== strategy) {
      if (before?.enabled && before.config.amount && before.config.duration && before.config.strategy) {
        await createPlatformSpendingLimit(auth, row.cf_account_id, {
          account_id: row.cf_account_id,
          amount: before.config.amount,
          duration: before.config.duration as SpendingLimitCreateParams['duration'],
          strategy: before.config.strategy as SpendingLimitCreateParams['strategy'],
        }).catch(() => undefined)
      } else {
        await deletePlatformSpendingLimit(auth, row.cf_account_id).catch(() => undefined)
      }
      throw new ApiError(502, 'cloudflare_upstream', 'The spending limit did not read back as written; it was rolled back')
    }
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.billing.limit', 'spending-limit',
      JSON.stringify({ before: before ?? null, after: readBack }), 'success')
    return c.json({ limit: readBack })
  } catch (error) {
    await createAuditLog(c.env, userId, row.id, 'ai_gateway.billing.limit', 'spending-limit',
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
      if (before.enabled && before.config.amount && before.config.duration && before.config.strategy) {
        await createPlatformSpendingLimit(auth, row.cf_account_id, {
          account_id: row.cf_account_id,
          amount: before.config.amount,
          duration: before.config.duration as SpendingLimitCreateParams['duration'],
          strategy: before.config.strategy as SpendingLimitCreateParams['strategy'],
        }).catch(() => undefined)
      }
      throw new ApiError(502, 'cloudflare_upstream', 'The spending limit is still enabled; the previous value was restored')
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
