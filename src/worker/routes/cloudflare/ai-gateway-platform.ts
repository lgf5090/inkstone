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
import { assertNotDemo, loadAccount } from '../../cloudflare/accounts'
import {
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
} from '../../cloudflare/ai-gateway-platform'
import type { LogListParams } from 'cloudflare/resources/ai-gateway'

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
