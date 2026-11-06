/**
 * The read side of the Cloudflare AI Gateway management panel.
 *
 * The official `cloudflare` SDK is the field contract: response and parameter types are imported
 * from it, while every call goes through `cfFetch`, the single door that already carries account
 * headers, the timeout and the error mapping. Instantiating the SDK's client would pull every
 * Cloudflare resource into the Worker bundle, so the SDK stays type-only here.
 */
import { ApiError } from '../lib/errors'
import type { CloudflareAuth } from './cf-api'
import { cfFetch, cfFetchRaw, cfGraphQL } from './cf-api'
import type {
  DynamicRoutingListDeploymentsResponse,
  DynamicRoutingListResponse,
  DynamicRoutingListVersionsResponse,
  LogGetResponse,
  LogListParams,
  LogListResponse,
  ProviderConfigListResponse,
} from 'cloudflare/resources/ai-gateway'
import type {
  AIGatewayGetResponse,
  AIGatewayListResponse,
} from 'cloudflare/resources/ai-gateway/ai-gateway'
import type { SpendingLimitGetResponse } from 'cloudflare/resources/ai-gateway/billing'

export interface PlatformPage<T> {
  items: T[]
  page: number
  perPage: number
  total: number
  totalPages: number
}

export interface PlatformLogQuery {
  page?: number
  perPage?: number
  filters?: LogListParams['filters']
}

export interface PlatformAnalyticsPoint {
  label: string
  requests: number
  errors: number
  cost: number
  cachedTokensIn: number
  cachedTokensOut: number
  uncachedTokensIn: number
  uncachedTokensOut: number
}

export interface PlatformAnalytics {
  requests: number
  errors: number
  cost: number
  cachedTokensIn: number
  cachedTokensOut: number
  uncachedTokensIn: number
  uncachedTokensOut: number
  series: PlatformAnalyticsPoint[]
}

export interface PlatformPayload {
  contentType: string
  body: string
  truncated: boolean
  size: number
}

interface ResultInfo {
  page?: number
  per_page?: number
  count?: number
  total_count?: number
  total_pages?: number
}

interface Envelope<T> {
  result: T
  result_info?: ResultInfo
}

const MAX_PAYLOAD_BYTES = 256 * 1024

function accountPath(accountId: string): string {
  return `/accounts/${encodeURIComponent(accountId)}/ai-gateway`
}

function gatewayPath(accountId: string, gatewayId: string): string {
  return `${accountPath(accountId)}/gateways/${encodeURIComponent(gatewayId)}`
}

function pageQuery(page = 1, perPage = 20): URLSearchParams {
  const params = new URLSearchParams()
  params.set('page', String(Math.max(1, page)))
  params.set('per_page', String(Math.min(50, Math.max(1, perPage))))
  return params
}

function pageOf<T>(rows: T[], info: ResultInfo | undefined, page: number, perPage: number): PlatformPage<T> {
  return {
    items: rows,
    page: info?.page ?? page,
    perPage: info?.per_page ?? perPage,
    total: info?.total_count ?? rows.length,
    totalPages: info?.total_pages ?? 1,
  }
}

export async function listPlatformGateways(
  auth: CloudflareAuth,
  accountId: string,
  options: { search?: string; page?: number; perPage?: number } = {},
): Promise<PlatformPage<AIGatewayListResponse>> {
  const page = options.page ?? 1
  const perPage = options.perPage ?? 20
  const params = pageQuery(page, perPage)
  if (options.search) params.set('search', options.search)
  const body = await cfFetch<Envelope<AIGatewayListResponse[]>>(
    auth,
    `${accountPath(accountId)}/gateways?${params.toString()}`,
  )
  return pageOf(body.result ?? [], body.result_info, page, perPage)
}

export async function getPlatformGateway(
  auth: CloudflareAuth,
  accountId: string,
  gatewayId: string,
): Promise<AIGatewayGetResponse> {
  const body = await cfFetch<Envelope<AIGatewayGetResponse>>(auth, gatewayPath(accountId, gatewayId))
  return body.result
}

export async function getPlatformGatewayUrl(
  auth: CloudflareAuth,
  accountId: string,
  gatewayId: string,
  provider: string,
): Promise<string> {
  const body = await cfFetch<Envelope<string>>(
    auth,
    `${gatewayPath(accountId, gatewayId)}/url/${encodeURIComponent(provider)}`,
  )
  return body.result
}

export function appendLogFilters(params: URLSearchParams, filters: LogListParams['filters']): void {
  for (const filter of filters ?? []) {
    params.append('filters.key', filter.key)
    params.append('filters.operator', filter.operator)
    for (const value of filter.value) params.append('filters.value', String(value))
  }
}

export async function listPlatformLogs(
  auth: CloudflareAuth,
  accountId: string,
  gatewayId: string,
  options: PlatformLogQuery = {},
): Promise<PlatformPage<LogListResponse>> {
  const page = options.page ?? 1
  const perPage = options.perPage ?? 20
  const params = pageQuery(page, perPage)
  appendLogFilters(params, options.filters)
  const body = await cfFetch<Envelope<LogListResponse[]>>(
    auth,
    `${gatewayPath(accountId, gatewayId)}/logs?${params.toString()}`,
  )
  return pageOf(body.result ?? [], body.result_info, page, perPage)
}

export async function getPlatformLog(
  auth: CloudflareAuth,
  accountId: string,
  gatewayId: string,
  logId: string,
): Promise<LogGetResponse> {
  const body = await cfFetch<Envelope<LogGetResponse>>(
    auth,
    `${gatewayPath(accountId, gatewayId)}/logs/${encodeURIComponent(logId)}`,
  )
  return body.result
}

export async function getPlatformLogPayload(
  auth: CloudflareAuth,
  accountId: string,
  gatewayId: string,
  logId: string,
  kind: 'request' | 'response',
): Promise<PlatformPayload> {
  const response = await cfFetchRaw(
    auth,
    `${gatewayPath(accountId, gatewayId)}/logs/${encodeURIComponent(logId)}/${kind}`,
  )
  if (!response.ok) {
    throw new ApiError(502, 'cloudflare_upstream', `Cloudflare answered the log ${kind} with ${response.status}`)
  }
  const text = await response.text()
  const truncated = text.length > MAX_PAYLOAD_BYTES
  return {
    contentType: response.headers.get('content-type') ?? 'text/plain',
    body: truncated ? `${text.slice(0, MAX_PAYLOAD_BYTES)}\n\n[truncated]` : text,
    truncated,
    size: text.length,
  }
}

export async function listPlatformRoutes(
  auth: CloudflareAuth,
  accountId: string,
  gatewayId: string,
): Promise<DynamicRoutingListResponse['data']['routes']> {
  const body = await cfFetch<DynamicRoutingListResponse>(
    auth,
    `${gatewayPath(accountId, gatewayId)}/routes`,
  )
  return body.data?.routes ?? []
}

export async function listPlatformRouteVersions(
  auth: CloudflareAuth,
  accountId: string,
  gatewayId: string,
  routeId: string,
): Promise<DynamicRoutingListVersionsResponse['data']['versions']> {
  const body = await cfFetch<DynamicRoutingListVersionsResponse>(
    auth,
    `${gatewayPath(accountId, gatewayId)}/routes/${encodeURIComponent(routeId)}/versions`,
  )
  return body.data?.versions ?? []
}

export async function listPlatformRouteDeployments(
  auth: CloudflareAuth,
  accountId: string,
  gatewayId: string,
  routeId: string,
): Promise<DynamicRoutingListDeploymentsResponse['data']['deployments']> {
  const body = await cfFetch<DynamicRoutingListDeploymentsResponse>(
    auth,
    `${gatewayPath(accountId, gatewayId)}/routes/${encodeURIComponent(routeId)}/deployments`,
  )
  return body.data?.deployments ?? []
}

export async function listPlatformProviderConfigs(
  auth: CloudflareAuth,
  accountId: string,
  gatewayId: string,
  options: { page?: number; perPage?: number } = {},
): Promise<PlatformPage<ProviderConfigListResponse>> {
  const page = options.page ?? 1
  const perPage = options.perPage ?? 20
  const params = pageQuery(page, perPage)
  const body = await cfFetch<Envelope<ProviderConfigListResponse[]>>(
    auth,
    `${gatewayPath(accountId, gatewayId)}/provider_configs?${params.toString()}`,
  )
  return pageOf(body.result ?? [], body.result_info, page, perPage)
}

export async function getPlatformSpendingLimit(
  auth: CloudflareAuth,
  accountId: string,
): Promise<SpendingLimitGetResponse> {
  const body = await cfFetch<Envelope<SpendingLimitGetResponse>>(
    auth,
    `${accountPath(accountId)}/billing/spending-limit`,
  )
  return body.result
}

interface AnalyticsData {
  viewer?: {
    accounts?: Array<{
      totals?: Array<{
        count?: number
        sum?: {
          cost?: number
          erroredRequests?: number
          cachedTokensIn?: number
          cachedTokensOut?: number
          uncachedTokensIn?: number
          uncachedTokensOut?: number
        }
      }>
      series?: Array<{
        dimensions?: { date?: string; datetimeHour?: string }
        count?: number
        sum?: {
          cost?: number
          erroredRequests?: number
          cachedTokensIn?: number
          cachedTokensOut?: number
          uncachedTokensIn?: number
          uncachedTokensOut?: number
        }
      }>
    }>
  }
}

function analyticsQuery(daily: boolean): string {
  const dimension = daily ? 'date' : 'datetimeHour'
  return `query AiGatewayAnalytics($accountTag: string!, $gateway: string!, $since: Time!, $until: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        totals: aiGatewayRequestsAdaptiveGroups(
          limit: 1,
          filter: { gateway: $gateway, datetime_geq: $since, datetime_leq: $until }
        ) {
          count
          sum { cost erroredRequests cachedTokensIn cachedTokensOut uncachedTokensIn uncachedTokensOut }
        }
        series: aiGatewayRequestsAdaptiveGroups(
          limit: 1000,
          orderBy: [${dimension}_ASC],
          filter: { gateway: $gateway, datetime_geq: $since, datetime_leq: $until }
        ) {
          dimensions { ${dimension} }
          count
          sum { cost erroredRequests cachedTokensIn cachedTokensOut uncachedTokensIn uncachedTokensOut }
        }
      }
    }
  }`
}

export async function getPlatformAnalytics(
  auth: CloudflareAuth,
  accountId: string,
  gatewayId: string,
  days: number,
  now = new Date(),
): Promise<PlatformAnalytics> {
  const until = now
  const since = new Date(until.getTime() - Math.max(1, days) * 86_400_000)
  const data = await cfGraphQL<AnalyticsData>(auth, analyticsQuery(days > 1), {
    accountTag: accountId,
    gateway: gatewayId,
    since: since.toISOString(),
    until: until.toISOString(),
  })
  const account = data.viewer?.accounts?.[0]
  const total = account?.totals?.[0]?.sum
  return {
    requests: account?.totals?.[0]?.count ?? 0,
    errors: total?.erroredRequests ?? 0,
    cost: total?.cost ?? 0,
    cachedTokensIn: total?.cachedTokensIn ?? 0,
    cachedTokensOut: total?.cachedTokensOut ?? 0,
    uncachedTokensIn: total?.uncachedTokensIn ?? 0,
    uncachedTokensOut: total?.uncachedTokensOut ?? 0,
    series: (account?.series ?? [])
      .map((row) => ({
        label: (days > 1 ? row.dimensions?.date : row.dimensions?.datetimeHour) ?? '',
        requests: row.count ?? 0,
        errors: row.sum?.erroredRequests ?? 0,
        cost: row.sum?.cost ?? 0,
        cachedTokensIn: row.sum?.cachedTokensIn ?? 0,
        cachedTokensOut: row.sum?.cachedTokensOut ?? 0,
        uncachedTokensIn: row.sum?.uncachedTokensIn ?? 0,
        uncachedTokensOut: row.sum?.uncachedTokensOut ?? 0,
      }))
      .filter((row) => row.label),
  }
}
