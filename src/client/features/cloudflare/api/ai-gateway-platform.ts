/**
 * The read-only contract for the Cloudflare AI Gateway management panel.
 *
 * The shapes mirror the Worker routes, which in turn take their fields from the official SDK. Keeping
 * the subset here means a screen never has to know how a gateway is fetched.
 */
import { cfRequest } from './client'

export interface PlatformGateway {
  id: string
  cache_invalidate_on_update: boolean
  cache_ttl: number | null
  collect_logs: boolean
  created_at: string
  modified_at: string
  rate_limiting_interval: number | null
  rate_limiting_limit: number | null
  authentication?: boolean
  byok_only?: boolean
  is_default?: boolean
  logpush?: boolean
  logpush_public_key?: string | null
  log_management?: number | null
  log_management_strategy?: 'STOP_INSERTING' | 'DELETE_OLDEST' | null
  rate_limiting_technique?: 'fixed' | 'sliding' | null
  retry_backoff?: 'constant' | 'linear' | 'exponential' | null
  retry_delay?: number | null
  retry_max_attempts?: number | null
  workers_ai_billing_mode?: 'postpaid' | 'unified'
  zdr?: boolean
}

export interface PlatformPage<T> {
  items: T[]
  page: number
  perPage: number
  total: number
  totalPages: number
}

export interface PlatformLog {
  id: string
  cached: boolean
  created_at: string
  duration: number
  model: string
  path: string
  provider: string
  success: boolean
  tokens_in: number | null
  tokens_out: number | null
  cost?: number
  status_code?: number
  model_type?: string
  request_type?: string
  step?: number
}

export interface PlatformLogDetail extends PlatformLog {
  request_head?: string
  request_head_complete?: boolean
  request_size?: number
  response_head?: string
  response_head_complete?: boolean
  response_size?: number
}

export interface PlatformPayload {
  contentType: string
  body: string
  truncated: boolean
  size: number
}

export interface PlatformRoute {
  id: string
  name: string
  created_at: string
  modified_at: string
  deployment?: { deployment_id: string; version_id: string; created_at: string }
  version?: { version_id: string; created_at: string; active?: string }
}

export interface PlatformRouteVersion {
  version_id: string
  created_at: string
  active: 'true' | 'false'
  data: string
  is_valid?: boolean
}

export interface PlatformRouteDeployment {
  deployment_id: string
  version_id: string
  created_at: string
}

export interface PlatformProviderConfig {
  id: string
  alias: string
  provider_slug: string
  secret_preview: string
  secret_id: string
  gateway_id: string
  modified_at: string
  default_config: boolean
  rate_limit?: number
  rate_limit_period?: number
}

export interface PlatformSpendingLimit {
  enabled: boolean
  config: { amount: number | null; duration: string | null; strategy: string | null }
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

function queryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const suffix = params.toString()
  return suffix ? `?${suffix}` : ''
}

export interface PlatformGatewayInput {
  id?: string
  cache_ttl?: number
  cache_invalidate_on_update?: boolean
  collect_logs?: boolean
  rate_limiting_interval?: number
  rate_limiting_limit?: number
  rate_limiting_technique?: 'fixed' | 'sliding'
  authentication?: boolean
  byok_only?: boolean
  retry_max_attempts?: number
  retry_delay?: number
  retry_backoff?: 'constant' | 'linear' | 'exponential'
}

export const aiGatewayPlatformApi = {
  gateways: (accountId: string, query: { search?: string; page?: number; perPage?: number } = {}) =>
    cfRequest<PlatformPage<PlatformGateway>>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways${queryString(query)}`,
    ),
  gateway: (accountId: string, gatewayId: string) =>
    cfRequest<PlatformGateway>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}`,
    ),
  gatewayUrl: (accountId: string, gatewayId: string, provider: string) =>
    cfRequest<{ url: string }>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}/url/${encodeURIComponent(provider)}`,
    ),
  logs: (
    accountId: string,
    gatewayId: string,
    query: {
      page?: number
      perPage?: number
      status?: string
      cached?: string
      model?: string
      provider?: string
      from?: string
      to?: string
    } = {},
  ) => cfRequest<PlatformPage<PlatformLog>>(
    `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}/logs${queryString(query)}`,
  ),
  log: (accountId: string, gatewayId: string, logId: string) =>
    cfRequest<PlatformLogDetail>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}/logs/${encodeURIComponent(logId)}`,
    ),
  logPayload: (accountId: string, gatewayId: string, logId: string, kind: 'request' | 'response') =>
    cfRequest<PlatformPayload>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}/logs/${encodeURIComponent(logId)}/${kind}`,
    ),
  routes: (accountId: string, gatewayId: string) =>
    cfRequest<{ items: PlatformRoute[] }>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}/routes`,
    ),
  routeVersions: (accountId: string, gatewayId: string, routeId: string) =>
    cfRequest<{ items: PlatformRouteVersion[] }>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}/routes/${encodeURIComponent(routeId)}/versions`,
    ),
  routeDeployments: (accountId: string, gatewayId: string, routeId: string) =>
    cfRequest<{ items: PlatformRouteDeployment[] }>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}/routes/${encodeURIComponent(routeId)}/deployments`,
    ),
  providerConfigs: (accountId: string, gatewayId: string, query: { page?: number; perPage?: number } = {}) =>
    cfRequest<PlatformPage<PlatformProviderConfig>>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}/provider-configs${queryString(query)}`,
    ),
  spendingLimit: (accountId: string) =>
    cfRequest<PlatformSpendingLimit>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/billing/spending-limit`,
    ),
  analytics: (accountId: string, gatewayId: string, days: number) =>
    cfRequest<PlatformAnalytics>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}/analytics?days=${days}`,
    ),
  createGateway: (accountId: string, body: PlatformGatewayInput) =>
    cfRequest<{ gateway: PlatformGateway }>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways`,
      { method: 'POST', body },
    ),
  updateGateway: (accountId: string, gatewayId: string, body: PlatformGatewayInput) =>
    cfRequest<{ gateway: PlatformGateway }>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}`,
      { method: 'PUT', body },
    ),
  deleteGateway: (accountId: string, gatewayId: string) =>
    cfRequest<{ deleted: boolean }>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}`,
      { method: 'DELETE' },
    ),
  deleteRoute: (accountId: string, gatewayId: string, routeId: string) =>
    cfRequest<{ deleted: boolean }>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}/routes/${encodeURIComponent(routeId)}`,
      { method: 'DELETE' },
    ),
  createProviderConfig: (accountId: string, gatewayId: string, body: { alias: string; provider_slug: string; secret: string; default_config?: boolean }) =>
    cfRequest<{ provider: PlatformProviderConfig }>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/gateways/${encodeURIComponent(gatewayId)}/provider-configs`,
      { method: 'POST', body },
    ),
  createSpendingLimit: (accountId: string, body: { amount: number; duration: 'daily' | 'weekly' | 'monthly'; strategy: 'fixed' | 'sliding' }) =>
    cfRequest<{ limit: PlatformSpendingLimit }>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/billing/spending-limit`,
      { method: 'POST', body },
    ),
  clearSpendingLimit: (accountId: string) =>
    cfRequest<{ deleted: boolean }>(
      `/ai-gateway-platform/accounts/${encodeURIComponent(accountId)}/billing/spending-limit`,
      { method: 'DELETE' },
    ),
}
