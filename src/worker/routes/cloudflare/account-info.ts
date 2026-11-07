/**
 * `/api/cloudflare/dashboard` account information: the Cloudflare plan/subscriptions and the public
 * service-status page.
 *
 * The status page is the only call here that does not need the reader's credential; it is cached for
 * five minutes because it is a public feed and the dashboard is the only consumer. The subscription
 * list is account-scoped and needs the account row, like every other dashboard call.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { loadAccount } from '../../cloudflare/accounts'
import { cfFetch } from '../../cloudflare/cf-api'

export const accountInfoRouter = new Hono<AppBindings>()

const STATUS_BASE = 'https://www.cloudflarestatus.com/api/v2'
const STATUS_CACHE_MS = 5 * 60_000

export interface SubscriptionRow {
  id: string
  name: string
  state: string
  price: number | null
  currency: string
  frequency: string
}

export interface StatusComponent {
  id: string
  name: string
  status: string
  group: string
}

export interface StatusIncident {
  id: string
  name: string
  status: string
  impact: string
  created_at: string
  shortlink: string
}

export interface StatusSummary {
  indicator: string
  description: string
  components: StatusComponent[]
  incidents: StatusIncident[]
  fetched_at: number
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`Status page answered HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

let statusCache: { at: number; value: StatusSummary } | null = null

accountInfoRouter.get('/subscription', async (c) => {
  const userId = c.get('userId')
  const accountId = (c.req.query('accountId') ?? '').trim()
  if (!accountId) throw ApiError.badRequest('accountId is required')
  const account = await loadAccount(c.env, userId, accountId)
  const cfAccountId = account.row.cf_account_id?.trim()
  if (!cfAccountId) {
    throw new ApiError(400, 'cloudflare_not_configured', 'This account has no Cloudflare account id')
  }

  const body = await cfFetch<{ result?: Array<Record<string, unknown>> }>(
    account.auth,
    `/accounts/${encodeURIComponent(cfAccountId)}/subscriptions`,
  )
  const subscriptions = (body.result ?? []).map((row): SubscriptionRow => {
    const plan = asRecord(row.rate_plan)
    return {
      id: textOf(row.id),
      name: textOf(plan.name) || textOf(plan.id),
      state: textOf(row.state),
      price: typeof plan.price === 'number' ? plan.price : null,
      currency: textOf(plan.currency),
      frequency: textOf(plan.frequency),
    }
  })
  return c.json({ accountId: account.row.id, subscriptions })
})

accountInfoRouter.get('/status', async (c) => {
  const now = Date.now()
  if (statusCache && now - statusCache.at < STATUS_CACHE_MS) {
    return c.json(statusCache.value)
  }

  const [statusRaw, componentsRaw, incidentsRaw] = await Promise.allSettled([
    fetchJson(`${STATUS_BASE}/status.json`),
    fetchJson(`${STATUS_BASE}/components.json`),
    fetchJson(`${STATUS_BASE}/incidents/unresolved.json`),
  ])
  if (statusRaw.status === 'rejected' && componentsRaw.status === 'rejected' && incidentsRaw.status === 'rejected') {
    throw new ApiError(
      502,
      'cloudflare_upstream',
      `The Cloudflare status page could not be reached: ${(statusRaw.reason as Error)?.message ?? 'network error'}`,
    )
  }

  const status = statusRaw.status === 'fulfilled' ? asRecord(asRecord(statusRaw.value).status) : {}
  const components = componentsRaw.status === 'fulfilled'
    ? (asRecord(componentsRaw.value).components as unknown[] | undefined ?? [])
    : []
  const incidents = incidentsRaw.status === 'fulfilled'
    ? (asRecord(incidentsRaw.value).incidents as unknown[] | undefined ?? [])
    : []

  const summary: StatusSummary = {
    indicator: textOf(status.indicator) || 'unknown',
    description: textOf(status.description) || 'unknown',
    components: components
      .map((item) => asRecord(item))
      .map((item) => ({
        id: textOf(item.id),
        name: textOf(item.name),
        status: textOf(item.status),
        group: textOf(item.group),
      }))
      .filter((item) => item.name && item.status !== 'operational'),
    incidents: incidents
      .map((item) => asRecord(item))
      .map((item) => ({
        id: textOf(item.id),
        name: textOf(item.name),
        status: textOf(item.status),
        impact: textOf(item.impact),
        created_at: textOf(item.created_at),
        shortlink: textOf(item.shortlink),
      }))
      .filter((item) => item.name),
    fetched_at: now,
  }
  statusCache = { at: now, value: summary }
  return c.json(summary)
})
