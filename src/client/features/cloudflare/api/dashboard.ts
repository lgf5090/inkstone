/**
 * The dashboard's requests, one function per route.
 *
 * Response shapes mirror the worker's own interfaces; they are not shared with it because the
 * Cloudflare module's shared contracts belong to the foundation slice and this screen is their first
 * consumer. A field added here without the route would fail the screen's own loading state, which is
 * the place a mismatch should surface.
 */
import type {
  CloudflareAuditLog,
  CloudflareQuotaResponse,
} from '@shared/cloudflare/model'
import { cfRequest } from './client'

export type ResourceCountKey = 'domains' | 'workers' | 'pages' | 'dns' | 'r2' | 'kv' | 'd1'
export type UsageKey = 'workers_requests' | 'kv_reads' | 'd1_writes' | 'r2_storage'

export interface DashboardResourceCount {
  key: ResourceCountKey
  count: number | null
}

export interface DashboardResourceUsage {
  key: UsageKey
  value: number | null
  limit: number
  isBytes: boolean
}

export interface DashboardResourcesResponse {
  accountId: string
  counts: DashboardResourceCount[]
  usage: DashboardResourceUsage[]
}

export interface DashboardZone {
  id: string
  name: string
}

export interface DashboardTrafficSeries {
  requests: number[]
  visitors: number[]
  pageViews: number[]
  bytes: number[]
}

export interface DashboardTrafficResponse {
  zoneId: string
  zoneName: string
  accountId: string
  granularity: 'hour' | 'day'
  labels: string[]
  series: DashboardTrafficSeries
}

export interface AuditLogQuery {
  action?: string
  q?: string
  from?: string
  to?: string
  page?: number
  pageSize?: number
  sort?: string
}

export interface AuditLogPage {
  logs: CloudflareAuditLog[]
  total: number
  actions: string[]
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `${path}?${query}` : path
}

export function getQuota(): Promise<CloudflareQuotaResponse> {
  return cfRequest<CloudflareQuotaResponse>('/quota')
}

export function getDashboardResources(accountId: string): Promise<DashboardResourcesResponse> {
  return cfRequest<DashboardResourcesResponse>(withQuery('/dashboard/resources', { accountId }))
}

export function getDashboardZones(accountId: string): Promise<{ zones: DashboardZone[] }> {
  return cfRequest<{ zones: DashboardZone[] }>(withQuery('/dashboard/zones', { accountId }))
}

export function getDashboardTraffic(params: {
  accountId: string
  zoneId: string
  days: number
}): Promise<DashboardTrafficResponse> {
  return cfRequest<DashboardTrafficResponse>(withQuery('/dashboard/traffic', {
    accountId: params.accountId,
    zoneId: params.zoneId,
    days: params.days,
  }))
}

export function getAuditLogs(query: AuditLogQuery): Promise<AuditLogPage> {
  return cfRequest<AuditLogPage>(withQuery('/audit-log', {
    action: query.action,
    q: query.q,
    from: query.from,
    to: query.to,
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort,
  }))
}

export function getAuditActions(): Promise<{ actions: string[] }> {
  return cfRequest<{ actions: string[] }>('/audit-log/actions')
}
