/**
 * Color Assistant Client REST API
 */

import type {
  AiPaletteRequest,
  AiPaletteResult,
  ColorHistoryItem,
  ColorSettings,
  PaletteColorItem,
  PoeticColorInterpretation,
  UserColorFavorite,
  UserColorPalette,
} from '@shared/tools/color/types'

const BASE_URL = '/api/tools/color'

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Inkstone-Client': '1',
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...HEADERS,
      ...(options.headers || {}),
    },
  })

  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`
    try {
      const data = (await res.json()) as { error?: string; message?: string }
      if (data && (data.error || data.message)) {
        errorMsg = data.error || data.message || errorMsg
      }
    } catch {
      // Ignored
    }
    throw new Error(errorMsg)
  }

  const json = (await res.json()) as { ok?: boolean; data?: T }
  if (json && typeof json === 'object' && 'data' in json && json.ok === true) {
    return json.data as T
  }
  return json as unknown as T
}

export const colorApi = {
  // Settings
  getSettings: () => request<ColorSettings>('/settings'),
  updateSettings: (partial: Partial<ColorSettings>) =>
    request<ColorSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(partial),
    }),

  // Favorites
  listFavorites: (tag?: string) =>
    request<UserColorFavorite[]>(`/favorites${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`),
  createFavorite: (data: { name?: string; hex: string; tags?: string[]; note?: string }) =>
    request<UserColorFavorite>('/favorites', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateFavorite: (id: string, data: { name?: string; tags?: string[]; note?: string }) =>
    request<UserColorFavorite>(`/favorites/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteFavorite: (id: string) =>
    request<{ ok: boolean }>(`/favorites/${id}`, {
      method: 'DELETE',
    }),

  // Palettes (Multi-color palette sets)
  listPalettes: (filter?: { sourceType?: string; tag?: string; onlyFavorites?: boolean }) => {
    const params = new URLSearchParams()
    if (filter?.sourceType) params.set('sourceType', filter.sourceType)
    if (filter?.tag) params.set('tag', filter.tag)
    if (filter?.onlyFavorites) params.set('onlyFavorites', 'true')
    const qs = params.toString()
    return request<UserColorPalette[]>(`/palettes${qs ? `?${qs}` : ''}`)
  },
  createPalette: (data: {
    title: string
    colors: PaletteColorItem[]
    sourceType?: UserColorPalette['sourceType']
    description?: string
    tags?: string[]
    likesCount?: number
    previewSvg?: string
    isFavorite?: boolean
  }) =>
    request<UserColorPalette>('/palettes', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updatePalette: (
    id: string,
    data: {
      title?: string
      colors?: PaletteColorItem[]
      description?: string
      tags?: string[]
      isFavorite?: boolean
    },
  ) =>
    request<UserColorPalette>(`/palettes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deletePalette: (id: string) =>
    request<{ ok: boolean }>(`/palettes/${id}`, {
      method: 'DELETE',
    }),
  togglePaletteFavorite: (id: string) =>
    request<UserColorPalette>(`/palettes/${id}/favorite`, {
      method: 'POST',
    }),

  // History
  listHistory: (limit?: number) =>
    request<ColorHistoryItem[]>(`/history${limit ? `?limit=${limit}` : ''}`),
  addHistory: (hex: string, source?: string) =>
    request<ColorHistoryItem>('/history', {
      method: 'POST',
      body: JSON.stringify({ hex, source }),
    }),
  clearHistory: () =>
    request<{ ok: boolean }>('/history', {
      method: 'DELETE',
    }),

  // AI
  generateAiPalette: (body: AiPaletteRequest) =>
    request<AiPaletteResult>('/ai/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  interpretColors: (colors: string[], theme?: string) =>
    request<PoeticColorInterpretation[]>('/ai/interpret', {
      method: 'POST',
      body: JSON.stringify({ colors, theme }),
    }),

  // Assets (R2)
  uploadAsset: (data: {
    assetType: 'image_card' | 'palette_poster' | 'gradient_export' | 'ase'
    fileFormat: 'png' | 'jpg' | 'svg' | 'ase'
    data: string
    metadata?: Record<string, unknown>
  }) =>
    request<{
      id: string
      r2Key: string
      fileSize: number
      fileFormat: string
      downloadUrl: string
    }>('/assets/upload', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
}
