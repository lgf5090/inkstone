/**
 * API client for `/api/tools/compare/*`.
 *
 * Uploads go through `request()` with a `FormData` body so the session cookie and the client header
 * are applied the same way as every other call. Reading an asset back is a plain `fetch` because the
 * answer is bytes, not JSON.
 */
import type {
  CompareAsset,
  CompareKind,
  CompareProject,
  CompareProjectInput,
  CompareProjectListItem,
  CompareRunInput,
  CompareStats,
  StatsRange,
} from '@shared/tools/compare/types'
import { request } from '../../../lib/api'

interface ApiData<T> {
  data: T
}

export const compareApi = {
  uploadAsset: async (kind: CompareKind, file: File, encoding?: string | null): Promise<CompareAsset> => {
    const form = new FormData()
    form.set('kind', kind)
    form.set('file', file)
    if (encoding) form.set('encoding', encoding)
    const response = await request<ApiData<CompareAsset>>('/api/tools/compare/assets', {
      method: 'POST',
      formData: form,
      timeoutMs: 60_000,
    })
    return response.data
  },

  assetContentUrl: (assetId: string): string => `/api/tools/compare/assets/${encodeURIComponent(assetId)}/content`,

  fetchAssetText: async (assetId: string): Promise<string> => {
    const response = await fetch(compareApi.assetContentUrl(assetId))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.text()
  },

  fetchAssetBlob: async (assetId: string): Promise<Blob> => {
    const response = await fetch(compareApi.assetContentUrl(assetId))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.blob()
  },

  listProjects: (params: { limit?: number; offset?: number; kind?: CompareKind; search?: string }) => {
    const query = new URLSearchParams()
    if (params.limit) query.set('limit', String(params.limit))
    if (params.offset) query.set('offset', String(params.offset))
    if (params.kind) query.set('kind', params.kind)
    if (params.search) query.set('search', params.search)
    const suffix = query.toString()
    return request<ApiData<{ items: CompareProjectListItem[]; total: number }>>(
      `/api/tools/compare/projects${suffix ? `?${suffix}` : ''}`,
    ).then((response) => response.data)
  },

  createProject: (input: CompareProjectInput) =>
    request<ApiData<CompareProject>>('/api/tools/compare/projects', { method: 'POST', body: input })
      .then((response) => response.data),

  getProject: (id: number) =>
    request<ApiData<CompareProject>>(`/api/tools/compare/projects/${id}`).then((response) => response.data),

  updateProject: (id: number, patch: { name?: string; options?: CompareProject['options']; summary?: CompareProject['summary'] }) =>
    request<ApiData<CompareProject>>(`/api/tools/compare/projects/${id}`, { method: 'PATCH', body: patch })
      .then((response) => response.data),

  deleteProject: (id: number) =>
    request<ApiData<{ removed: number }>>(`/api/tools/compare/projects/${id}`, { method: 'DELETE' })
      .then((response) => response.data),

  shareProject: (id: number) =>
    request<ApiData<{ slug: string }>>(`/api/tools/compare/projects/${id}/share`, { method: 'POST' })
      .then((response) => response.data),

  unshareProject: (id: number) =>
    request<ApiData<{ shared: boolean }>>(`/api/tools/compare/projects/${id}/share`, { method: 'DELETE' })
      .then((response) => response.data),

  recordRun: (input: CompareRunInput) =>
    request<ApiData<{ recorded: boolean }>>('/api/tools/compare/runs', { method: 'POST', body: input })
      .then((response) => response.data),

  getStats: (range: StatsRange) =>
    request<ApiData<CompareStats>>(`/api/tools/compare/stats?range=${range}`).then((response) => response.data),
}

/** The address a shared comparison opens at. */
export function sharePageUrl(slug: string): string {
  return `${location.origin}/tc/${slug}`
}
