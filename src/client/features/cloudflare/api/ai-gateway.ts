/**
 * The management-side contract for the self-hosted gateway. Only session-authenticated calls live
 * here; the public `gw_` data plane is consumed by external clients, not by this screen.
 */
import { cfRequest } from './client'

export interface GatewayAccountView {
  id: string
  name: string
  status: 'active' | 'cooling' | 'exhausted_today' | 'disabled' | 'auth_error'
  usedNeurons: number
  remainingNeurons: number
  requests: number
  cooldownUntil: number
  errorCode: string | null
  selectionCount: number
  scheduleScore: number
}

export interface GatewayKeyView {
  id: string
  name: string
  prefix: string
  allowedModels: string[]
  dailyRequestLimit: number
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
  todayRequests: number
  todayNeurons: number
  todayTokens: number
}

export interface GatewayLogView {
  id: string
  keyId: string
  keyName: string
  accountId: string
  format: 'chat' | 'responses'
  stream: boolean
  model: string
  status: string
  httpStatus: number
  upstreamStatus: number | null
  reservedNeurons: number
  actualNeurons: number
  promptTokens: number
  completionTokens: number
  durationMs: number
  errorCode: string | null
  createdAt: number
}

export interface GatewayReconcileView {
  id: string
  accountId: string
  day: string
  authoritative: number
  localEffective: number
  delta: number
  outcome: string
  checkedAt: number
  note: string | null
}

export interface GatewayOverview {
  day: string
  limit: number
  hardLimit: number
  accounts: GatewayAccountView[]
  totals: { used: number; remaining: number }
  keys: GatewayKeyView[]
  recentReconcile: Array<{
    accountId: string
    authoritative: number
    localEffective: number
    delta: number
    outcome: string
    checkedAt: number
  }>
}

export const aiGatewayApi = {
  overview: () => cfRequest<GatewayOverview>('/ai-gateway/overview', { timeoutMs: 60_000 }),
  createKey: (body: { name: string; allowedModels?: string[]; dailyRequestLimit?: number }) =>
    cfRequest<{ key: GatewayKeyView; token: string }>('/ai-gateway/keys', { method: 'POST', body }),
  revokeKey: (id: string) =>
    cfRequest<{ revoked: boolean }>(`/ai-gateway/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  logs: (query: {
    page?: number
    pageSize?: number
    status?: string
    format?: string
    keyId?: string
    accountId?: string
    model?: string
    since?: number
    until?: number
  }) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    const suffix = params.toString()
    return cfRequest<{ items: GatewayLogView[]; total: number }>(`/ai-gateway/logs${suffix ? `?${suffix}` : ''}`)
  },
  reconcile: () =>
    cfRequest<{ results: Array<{ accountId: string; accountName: string; authoritative: number; localEffective: number; outcome: string; note?: string }> }>(
      '/ai-gateway/reconcile',
      { method: 'POST', timeoutMs: 120_000 },
    ),
  reconcileHistory: (query: { page?: number; pageSize?: number; accountId?: string }) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    const suffix = params.toString()
    return cfRequest<{ items: GatewayReconcileView[]; total: number }>(`/ai-gateway/reconcile${suffix ? `?${suffix}` : ''}`)
  },
  access: () => cfRequest<{
    baseUrl: string
    models: Array<{ id: string; worker_model: string }>
    endpoints: string[]
  }>('/ai-gateway/access'),
}
