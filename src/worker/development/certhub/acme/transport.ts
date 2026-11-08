import * as acme from 'acme-client'

interface FetchAdapterConfig {
  url?: string
  method?: string
  headers?: Record<string, string> & { toJSON?: () => Record<string, string> }
  data?: unknown
  timeout?: number
}

interface FetchAdapterResponse {
  data: unknown
  status: number
  statusText: string
  headers: Record<string, string>
  config: FetchAdapterConfig
  request: Record<string, never>
}

async function workerdFetchAdapter(config: FetchAdapterConfig): Promise<FetchAdapterResponse> {
  const url = config.url ?? ''
  if (!/^https:\/\//.test(url)) throw new Error('acme_transport_requires_https')
  const headers = config.headers?.toJSON
    ? config.headers.toJSON()
    : { ...(config.headers ?? {}) } as Record<string, string>
  const body = config.data === undefined || config.data === null
    ? undefined
    : typeof config.data === 'string'
      ? config.data
      : JSON.stringify(config.data)
  const response = await fetch(url, {
    method: (config.method ?? 'GET').toUpperCase(),
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(config.timeout ?? 15_000),
  })
  const text = await response.text()
  let data: unknown = text
  try {
    data = text ? JSON.parse(text) : ''
  } catch {
    data = text
  }
  return {
    data,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    config,
    request: {},
  }
}

const axios = acme.axios as typeof acme.axios & {
  defaults: {
    adapter: ((config: FetchAdapterConfig) => Promise<FetchAdapterResponse>) | string
    timeout: number
    maxRedirects: number
    acmeSettings: { retryMaxAttempts: number; retryDefaultDelay: number }
  }
}

(axios.defaults as unknown as { adapter: unknown }).adapter = workerdFetchAdapter
axios.defaults.timeout = 15_000
axios.defaults.maxRedirects = 0
axios.defaults.acmeSettings.retryMaxAttempts = 0
axios.defaults.acmeSettings.retryDefaultDelay = 2

export function configureAcmeTransport(timeoutMs: number): void {
  axios.defaults.timeout = Math.min(60_000, Math.max(5_000, timeoutMs))
}

export const acmeClientModule = acme
