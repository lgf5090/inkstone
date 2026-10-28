import type {
  XgetResolveResult,
  XgetSettings,
  XgetSettingsConfig,
  XgetStatsRange,
  XgetStatsSummary,
} from '@shared/development/xget/types'
import { ApiError, request, type RequestOptions } from '../../../lib/api'

const BASE = '/api/development/xget'

async function requestData<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const payload = await request<{ ok?: boolean; data?: T } | T>(`${BASE}${path}`, options)
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload) && 'ok' in payload) {
    const envelope = payload as { ok?: boolean; data?: T }
    if (envelope.ok === false) {
      throw new ApiError(502, 'invalid_response', 'The server rejected the request without an error.')
    }
    return envelope.data as T
  }
  return payload as T
}

export function describeXgetError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.serverMessage && error.serverMessage !== error.message
      ? `${error.message} — ${error.serverMessage}`
      : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export const xgetApi = {
  getSettings: () => requestData<XgetSettings>('/settings'),
  saveSettings: (config: Partial<XgetSettingsConfig>) =>
    requestData<{ config: XgetSettingsConfig }>('/settings', {
      method: 'PUT',
      body: config,
    }),
  setToken: (token: string) =>
    requestData<{ has_proxy_token: boolean }>('/settings/token', {
      method: 'PUT',
      body: { token },
    }),
  testTarget: (path: string) =>
    requestData<XgetResolveResult>('/settings/test', {
      method: 'POST',
      body: { path },
    }),
  getStats: (days: XgetStatsRange) =>
    requestData<XgetStatsSummary>(`/stats/summary?days=${encodeURIComponent(String(days))}`),
}
