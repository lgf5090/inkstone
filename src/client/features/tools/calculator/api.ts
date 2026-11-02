import type {
  CalculatorAsset,
  CalculatorSettings,
  CurrencyRates,
  GraphSession,
  HistoryEntry,
  MemoryEntry,
  UnitPreference,
} from '@shared/tools/calculator/types'

const BASE_URL = '/api/tools/calculator'

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set('X-Inkstone-Client', '1')
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${BASE_URL}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers,
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const payload = (await response.json()) as { error?: { message?: string }; message?: string }
      message = payload.error?.message || payload.message || message
    } catch {
      // The status is still a usable message when the body is not JSON.
    }
    throw new Error(message)
  }
  const payload = (await response.json()) as { ok?: boolean; data?: T }
  return (payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload) as T
}

export const calculatorApi = {
  getSettings: () => request<CalculatorSettings>('/settings'),
  updateSettings: (partial: Partial<CalculatorSettings>) =>
    request<CalculatorSettings>('/settings', { method: 'PUT', body: JSON.stringify(partial) }),

  listHistory: (mode?: 'standard' | 'scientific') =>
    request<HistoryEntry[]>(`/history${mode ? `?mode=${mode}` : ''}`),
  appendHistory: (entry: HistoryEntry) =>
    request<HistoryEntry[]>('/history', { method: 'POST', body: JSON.stringify(entry) }),
  deleteHistory: (id: string) => request<{ ok: boolean }>(`/history/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearHistory: (mode?: 'standard' | 'scientific') =>
    request<{ ok: boolean }>(`/history${mode ? `?mode=${mode}` : ''}`, { method: 'DELETE' }),

  listMemory: () => request<MemoryEntry[]>('/memory'),
  replaceMemory: (entries: MemoryEntry[]) =>
    request<MemoryEntry[]>('/memory', { method: 'PUT', body: JSON.stringify(entries) }),
  clearMemory: () => request<{ ok: boolean }>('/memory', { method: 'DELETE' }),

  getGraph: () => request<GraphSession>('/graph'),
  updateGraph: (session: GraphSession) =>
    request<GraphSession>('/graph', { method: 'PUT', body: JSON.stringify(session) }),

  getCurrencyRates: (force = false) => request<CurrencyRates>(`/rates${force ? '?force=1' : ''}`),
  listUnitPreferences: () => request<UnitPreference[]>('/unit-preferences'),
  replaceUnitPreferences: (entries: UnitPreference[]) =>
    request<UnitPreference[]>('/unit-preferences', { method: 'PUT', body: JSON.stringify(entries) }),

  listAssets: (kind?: CalculatorAsset['kind']) =>
    request<CalculatorAsset[]>(`/assets${kind ? `?kind=${kind}` : ''}`),
  uploadAsset: (input: {
    kind: CalculatorAsset['kind']
    fileFormat: CalculatorAsset['fileFormat']
    dataBase64: string
    metadata?: Record<string, unknown>
  }) => request<CalculatorAsset>('/assets', { method: 'POST', body: JSON.stringify(input) }),
  deleteAsset: (id: string) => request<{ ok: boolean }>(`/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  assetUrl: (id: string) => `${BASE_URL}/assets/${encodeURIComponent(id)}/file`,
}
