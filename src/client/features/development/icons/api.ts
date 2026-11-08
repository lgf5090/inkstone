import type {
  IconAssetDetail,
  IconAssetSummary,
  IconBootstrap,
  IconCollection,
  IconCollectionStats,
  IconExport,
  IconImport,
  IconImportItem,
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

export function updateCollection(id: string, input: Record<string, unknown>): Promise<void> {
  return request(`${BASE}/collections/${id}`, { method: 'PATCH', body: input }).then(() => undefined)
}

export function deleteCollection(id: string): Promise<void> {
  return request(`${BASE}/collections/${id}`, { method: 'DELETE' }).then(() => undefined)
}

export function createTag(input: Record<string, unknown>): Promise<IconTag> {
  return request<Envelope<IconTag>>(`${BASE}/tags`, { method: 'POST', body: input }).then((response) => response.data)
}

export function updateTag(id: string, input: Record<string, unknown>): Promise<void> {
  return request(`${BASE}/tags/${id}`, { method: 'PATCH', body: input }).then(() => undefined)
}

export function deleteTag(id: string): Promise<void> {
  return request(`${BASE}/tags/${id}`, { method: 'DELETE' }).then(() => undefined)
}

export function fetchSettings(): Promise<{ settings: IconSettings; limits: IconLimits }> {
  return readData('/settings')
}

export function updateSettings(patch: Record<string, number>): Promise<IconSettings> {
  return request<Envelope<IconSettings>>(`${BASE}/settings`, { method: 'PATCH', body: patch }).then((response) => response.data)
}

export function updateGlobalLimits(patch: Record<string, number>): Promise<IconLimits> {
  return request<Envelope<IconLimits>>(`${BASE}/settings/global`, { method: 'PATCH', body: patch }).then((response) => response.data)
}

export function fetchJobs(): Promise<IconJob[]> {
  return readData('/jobs')
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

export function retryJob(id: string): Promise<void> {
  return request(`${BASE}/jobs/${id}/retry`, { method: 'POST' }).then(() => undefined)
}

export function uploadJobItemOutputs(
  jobId: string,
  assetId: string,
  kind: 'png' | 'ico',
  sizes: number[],
  files: Blob[],
): Promise<{ outputs: Record<string, string>; status: string }> {
  const form = new FormData()
  form.set('kind', kind)
  form.set('sizes', JSON.stringify(sizes))
  if (kind === 'ico') {
    form.set('file', files[0]!, 'icon.ico')
  } else {
    files.forEach((file, index) => form.append('f', file, `${sizes[index] ?? index}.png`))
  }
  return request<Envelope<{ outputs: Record<string, string>; status: string }>>(`${BASE}/jobs/${jobId}/items/${assetId}/outputs`, { method: 'POST', formData: form }).then((response) => response.data)
}

export function uploadJobSprite(jobId: string, setHash: string, files: Record<string, Blob>): Promise<{ outputs: Record<string, string>; status: string }> {
  const form = new FormData()
  form.set('setHash', setHash)
  for (const [field, blob] of Object.entries(files)) form.set(field, blob, `${field}.bin`)
  return request<Envelope<{ outputs: Record<string, string>; status: string }>>(`${BASE}/jobs/${jobId}/sprite`, { method: 'POST', formData: form }).then((response) => response.data)
}

export function finishJob(id: string): Promise<{ status: string; job: IconJob }> {
  return request<Envelope<{ status: string; job: IconJob }>>(`${BASE}/jobs/${id}/finish`, { method: 'POST' }).then((response) => response.data)
}

export function createExport(format: string, assetIds: string[], options?: Record<string, unknown>): Promise<IconExport> {
  return request<Envelope<IconExport>>(`${BASE}/exports`, { method: 'POST', body: { format, assetIds, options } }).then((response) => response.data)
}

export function fetchImports(): Promise<IconImport[]> {
  return readData('/imports')
}

export function startBulkImport(prefix: string, mode: 'full' | 'missing' | 'seed' = 'full'): Promise<IconImport> {
  return request<Envelope<IconImport>>(`${BASE}/imports/bulk`, { method: 'POST', body: { prefix, mode } }).then((response) => response.data)
}

export function stepBulkImport(id: string): Promise<{ import: IconImport; failures: IconImportItem[] }> {
  return request<Envelope<{ import: IconImport; failures: IconImportItem[] }>>(`${BASE}/imports/${id}/step`, { method: 'POST' }).then((response) => response.data)
}

export function cancelBulkImport(id: string): Promise<void> {
  return request(`${BASE}/imports/${id}/cancel`, { method: 'POST' }).then(() => undefined)
}

export function fetchImportFailures(id: string): Promise<IconImportItem[]> {
  return readData(`/imports/${id}/items?status=failed&limit=100`)
}

export function fetchCollectionStats(id: string): Promise<IconCollectionStats> {
  return readData(`/collections/${id}/stats`)
}
