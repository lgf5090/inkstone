/**
 * The network screen's door to `/api/cloudflare/network`.
 *
 * Reads and the create/delete pairs the screen exposes. Every write here is a single, named action;
 * nothing is a generic proxy.
 */
import { cfRequest } from './client'

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

export interface EmailRoutingResponse {
  zoneId: string
  zoneName: string
  settings: EmailRoutingSettings
  rules: EmailRoutingRule[]
  addresses: EmailDestinationAddress[]
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

export interface SnippetsResponse {
  supported: boolean
  reason?: string
  zoneId?: string
  zoneName?: string
  snippets: Snippet[]
  rules: SnippetRule[]
}

export interface BulkRedirectsResponse {
  supported: boolean
  reason?: string
  lists: BulkRedirectList[]
}

function accountPath(accountId: string): string {
  return `/network/${encodeURIComponent(accountId)}`
}

export const networkApi = {
  pools: (accountId: string) =>
    cfRequest<{ pools: LoadBalancerPool[] }>(`${accountPath(accountId)}/load-balancer/pools`),
  monitors: (accountId: string) =>
    cfRequest<{ monitors: LoadBalancerMonitor[] }>(`${accountPath(accountId)}/load-balancer/monitors`),
  poolHealth: (accountId: string, poolId: string) =>
    cfRequest<PoolHealth>(`${accountPath(accountId)}/load-balancer/pools/${encodeURIComponent(poolId)}/health`),
  zoneLoadBalancers: (accountId: string, zoneId: string) =>
    cfRequest<{ loadBalancers: ZoneLoadBalancer[] }>(
      `${accountPath(accountId)}/load-balancer/zones/${encodeURIComponent(zoneId)}/load-balancers`,
    ),

  redirectLists: (accountId: string) =>
    cfRequest<BulkRedirectsResponse>(`${accountPath(accountId)}/bulk-redirect/lists`),
  redirectItems: (accountId: string, listId: string, cursor?: string) => {
    const query = new URLSearchParams({ per_page: '100' })
    if (cursor) query.set('cursor', cursor)
    return cfRequest<{ items: BulkRedirectItem[]; cursor: string | null }>(
      `${accountPath(accountId)}/bulk-redirect/lists/${encodeURIComponent(listId)}/items?${query.toString()}`,
    )
  },

  emailRouting: (accountId: string, zoneId: string) =>
    cfRequest<EmailRoutingResponse>(`${accountPath(accountId)}/email-routing/${encodeURIComponent(zoneId)}`),

  snippets: (accountId: string, zoneId: string) =>
    cfRequest<SnippetsResponse>(`${accountPath(accountId)}/snippets/${encodeURIComponent(zoneId)}`),

  createPool: (accountId: string, input: { name: string; address: string; monitorId?: string }) =>
    cfRequest<LoadBalancerPool>(`${accountPath(accountId)}/load-balancer/pools`, {
      method: 'POST',
      body: input,
    }),
  deletePool: (accountId: string, poolId: string) =>
    cfRequest<{ deleted: true }>(
      `${accountPath(accountId)}/load-balancer/pools/${encodeURIComponent(poolId)}`,
      { method: 'DELETE' },
    ),
  createMonitor: (accountId: string, input: {
    description: string
    type: string
    method: string
    path: string
    expectedCodes: string
    interval: number
    timeout: number
    retries: number
  }) => cfRequest<LoadBalancerMonitor>(`${accountPath(accountId)}/load-balancer/monitors`, {
    method: 'POST',
    body: input,
  }),
  deleteMonitor: (accountId: string, monitorId: string) =>
    cfRequest<{ deleted: true }>(
      `${accountPath(accountId)}/load-balancer/monitors/${encodeURIComponent(monitorId)}`,
      { method: 'DELETE' },
    ),
  createZoneLoadBalancer: (
    accountId: string,
    zoneId: string,
    input: { name: string; fallbackPool: string; defaultPools: string[] },
  ) => cfRequest<ZoneLoadBalancer>(
    `${accountPath(accountId)}/load-balancer/zones/${encodeURIComponent(zoneId)}/load-balancers`,
    { method: 'POST', body: input },
  ),
  deleteZoneLoadBalancer: (accountId: string, zoneId: string, loadBalancerId: string) =>
    cfRequest<{ deleted: true }>(
      `${accountPath(accountId)}/load-balancer/zones/${encodeURIComponent(zoneId)}/load-balancers/${encodeURIComponent(loadBalancerId)}`,
      { method: 'DELETE' },
    ),

  createRedirectList: (accountId: string, name: string) =>
    cfRequest<BulkRedirectList>(`${accountPath(accountId)}/bulk-redirect/lists`, {
      method: 'POST',
      body: { name },
    }),
  deleteRedirectList: (accountId: string, listId: string) =>
    cfRequest<{ deleted: true }>(
      `${accountPath(accountId)}/bulk-redirect/lists/${encodeURIComponent(listId)}`,
      { method: 'DELETE' },
    ),
  createRedirectItem: (accountId: string, listId: string, input: {
    sourceUrl: string
    targetUrl: string
    statusCode: number
    preserveQueryString: boolean
    includeSubdomains: boolean
  }) => cfRequest<{ saved: true }>(
    `${accountPath(accountId)}/bulk-redirect/lists/${encodeURIComponent(listId)}/items`,
    { method: 'POST', body: input },
  ),

  setEmailRoutingEnabled: (accountId: string, zoneId: string, enabled: boolean) =>
    cfRequest<EmailRoutingSettings>(
      `${accountPath(accountId)}/email-routing/${encodeURIComponent(zoneId)}/${enabled ? 'enable' : 'disable'}`,
      { method: 'POST' },
    ),
  createEmailRule: (accountId: string, zoneId: string, input: {
    name: string
    recipient: string
    action: 'drop' | 'forward'
    destination?: string
  }) => cfRequest<EmailRoutingRule>(
    `${accountPath(accountId)}/email-routing/${encodeURIComponent(zoneId)}/rules`,
    { method: 'POST', body: input },
  ),
  deleteEmailRule: (accountId: string, zoneId: string, ruleId: string) =>
    cfRequest<{ deleted: true }>(
      `${accountPath(accountId)}/email-routing/${encodeURIComponent(zoneId)}/rules/${encodeURIComponent(ruleId)}`,
      { method: 'DELETE' },
    ),
  createEmailAddress: (accountId: string, email: string) =>
    cfRequest<EmailDestinationAddress>(`${accountPath(accountId)}/email-routing/addresses`, {
      method: 'POST',
      body: { email },
    }),
  deleteEmailAddress: (accountId: string, addressId: string) =>
    cfRequest<{ deleted: true }>(
      `${accountPath(accountId)}/email-routing/addresses/${encodeURIComponent(addressId)}`,
      { method: 'DELETE' },
    ),

  createSnippet: (accountId: string, zoneId: string, input: {
    name: string
    content: string
    expression?: string
    description?: string
  }) => cfRequest<{ saved: true }>(`${accountPath(accountId)}/snippets/${encodeURIComponent(zoneId)}`, {
    method: 'POST',
    body: input,
  }),
  deleteSnippet: (accountId: string, zoneId: string, name: string) =>
    cfRequest<{ deleted: true }>(
      `${accountPath(accountId)}/snippets/${encodeURIComponent(zoneId)}/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  deleteSnippetRule: (accountId: string, zoneId: string, ruleId: string) =>
    cfRequest<{ deleted: true }>(
      `${accountPath(accountId)}/snippets/${encodeURIComponent(zoneId)}/rules/${encodeURIComponent(ruleId)}`,
      { method: 'DELETE' },
    ),
}
