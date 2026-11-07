import type {
  IconAssetDetail,
  IconAssetSummary,
  IconBootstrap,
  IconCollection,
  IconExport,
  IconImport,
  IconJob,
  IconJobItem,
  IconLimits,
  IconPage,
  IconSettings,
  IconTag,
  IconUploadResult,
} from '@shared/development/icons/types'
import { request } from '../../../lib/api'

const BASE = '/api/development/icons'

interface Envelope<T> {
  ok: true
  data: T
}

function readData<T>(path: string): Promise<T> {
  return request<Envelope<T>>(`${BASE}${path}`).then((response) => response.data)
}

export function fetchBootstrap(): Promise<IconBootstrap> {
  return readData('/bootstrap')
}

export function fetchAssets(query: Record<string, string | number | undefined>): Promise<IconPage<IconAssetSummary>> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  return readData(`/assets?${search.toString()}`)
}

export function fetchAsset(id: string): Promise<IconAssetDetail> {
  return readData(`/assets/${id}`)
}

export function updateAsset(id: string, patch: Record<string, unknown>): Promise<IconAssetDetail> {
  return request<Envelope<IconAssetDetail>>(`${BASE}/assets/${id}`, { method: 'PATCH', body: patch }).then((response) => response.data)
}

export function deleteAsset(id: string): Promise<void> {
  return request(`${BASE}/assets/${id}`, { method: 'DELETE' }).then(() => undefined)
}

export function uploadAsset(file: File, collectionId?: string): Promise<IconUploadResult> {
  const form = new FormData()
  form.set('file', file)
  if (collectionId) form.set('collectionId', collectionId)
  return request<Envelope<IconUploadResult>>(`${BASE}/assets`, { method: 'POST', formData: form }).then((response) => response.data)
}

export function batchAssets(action: string, ids: string[], extra: Record<string, unknown> = {}): Promise<{ results: { id: string; ok: boolean; error?: string }[] }> {
  return request<Envelope<{ results: { id: string; ok: boolean; error?: string }[] }>>(`${BASE}/assets/batch`, {
    method: 'POST',
    body: { action, ids, ...extra },
  }).then((response) => response.data)
}

export function recordUsage(id: string, action: 'copy' | 'download' | 'view'): Promise<void> {
  return request(`${BASE}/assets/${id}/usage`, { method: 'POST', body: { action } }).then(() => undefined)
}

export function fetchStats(): Promise<{ daily: { day: string; count: number }[]; top: { id: string; name: string; count: number }[] }> {
  return readData('/stats')
}

export function createCollection(input: Record<string, unknown>): Promise<IconCollection> {
  return request<Envelope<IconCollection>>(`${BASE}/collections`, { method: 'POST', body: input }).then((response) => response.data)
}

export function createTag(input: Record<string, unknown>): Promise<IconTag> {
  return request<Envelope<IconTag>>(`${BASE}/tags`, { method: 'POST', body: input }).then((response) => response.data)
}

export function fetchSettings(): Promise<{ settings: IconSettings; limits: IconLimits }> {
  return readData('/settings')
}

export function updateSettings(patch: Record<string, number>): Promise<IconSettings> {
  return request<Envelope<IconSettings>>(`${BASE}/settings`, { method: 'PATCH', body: patch }).then((response) => response.data)
}

export function createJob(assetIds: string[], options: Record<string, unknown>): Promise<IconJob> {
  return request<Envelope<IconJob>>(`${BASE}/jobs`, { method: 'POST', body: { assetIds, options } }).then((response) => response.data)
}

export function fetchJob(id: string): Promise<IconJob> {
  return readData(`/jobs/${id}`)
}

export function fetchJobItems(id: string): Promise<IconJobItem[]> {
  return readData(`/jobs/${id}/items`)
}

export function cancelJob(id: string): Promise<void> {
  return request(`${BASE}/jobs/${id}/cancel`, { method: 'POST' }).then(() => undefined)
}

export function createExport(format: string, assetIds: string[]): Promise<IconExport> {
  return request<Envelope<IconExport>>(`${BASE}/exports`, { method: 'POST', body: { format, assetIds } }).then((response) => response.data)
}

export function fetchImports(): Promise<IconImport[]> {
  return readData('/imports')
}
