import type {
  XgetResolveResult,
  XgetSettings,
  XgetSettingsConfig,
  XgetStatsRange,
  XgetStatsSummary,
} from '@shared/development/xget/types'
import type { MessageKey } from '@shared/locales/en-US'
import { ApiError, request, type RequestOptions } from '../../../lib/api'
import { t } from '../../../lib/i18n'

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

const XGET_ERROR_KEYS: Partial<Record<string, MessageKey>> = {
  xget_token_length: 'development.xget.error.token_length',
  xget_token_charset: 'development.xget.error.token_charset',
  xget_path_prefix: 'development.xget.error.path_prefix',
  xget_invalid_origin: 'development.xget.error.invalid_origin',
  xget_unsupported_method: 'development.xget.error.unsupported_method',
  xget_methods_required: 'development.xget.error.methods_required',
  xget_owner_only: 'development.xget.error.owner_only',
  xget_invalid_settings: 'development.xget.error.invalid_settings',
  xget_invalid_days: 'development.xget.error.invalid_days',
  xget_demo_readonly: 'development.xget.error.demo_readonly',
}

interface XgetErrorDetails {
  min?: number
  max?: number
  origin?: string
  method?: string
}

export function describeXgetError(error: unknown): string {
  if (error instanceof ApiError) {
    const key = XGET_ERROR_KEYS[error.code]
    if (key) {
      const details = (error.details ?? {}) as XgetErrorDetails
      return t(key, {
        min: details.min ?? 8,
        max: details.max ?? 128,
        origin: details.origin ?? '',
        method: details.method ?? '',
      })
    }
    return error.message
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
