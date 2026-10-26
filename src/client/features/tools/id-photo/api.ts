import type {
  IdPhotoRecord,
  IdPhotoSpec,
  IdPhotoUserSettings,
  IdPhotoCategory,
  IdPhotoExportFormat,
} from '@shared/tools/id-photo/types'

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set('X-Inkstone-Client', '1')
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }

  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    let errorMsg = `Request failed: ${res.status}`
    try {
      const err = await res.json()
      if (err.message) errorMsg = err.message
    } catch {
      // fallback
    }
    throw new Error(errorMsg)
  }

  const json = await res.json()
  return (json.data ?? json) as T
}

export async function listIdPhotoRecords(query: {
  specId?: string
  limit?: number
  offset?: number
  search?: string
} = {}): Promise<{ records: IdPhotoRecord[]; total: number }> {
  const params = new URLSearchParams()
  if (query.specId) params.set('specId', query.specId)
  if (query.limit) params.set('limit', String(query.limit))
  if (query.offset) params.set('offset', String(query.offset))
  if (query.search) params.set('search', query.search)

  const qs = params.toString()
  return request<{ records: IdPhotoRecord[]; total: number }>(
    `/api/tools/id-photo/records${qs ? `?${qs}` : ''}`,
  )
}

export async function createIdPhotoRecord(payload: {
  title?: string
  specId: string
  specName: string
  widthPx: number
  heightPx: number
  widthMm?: number
  heightMm?: number
  dpi?: number
  bgColor: string
  options?: Record<string, unknown>
  fileData: string
  printFileData?: string
  fileType: IdPhotoExportFormat
}): Promise<IdPhotoRecord> {
  return request<IdPhotoRecord>('/api/tools/id-photo/records', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function deleteIdPhotoRecord(id: string): Promise<void> {
  await request<{ deleted: boolean }>(`/api/tools/id-photo/records/${id}`, {
    method: 'DELETE',
  })
}

export async function listCustomSpecs(): Promise<IdPhotoSpec[]> {
  return request<IdPhotoSpec[]>('/api/tools/id-photo/specs')
}

export async function createCustomSpec(spec: {
  name: string
  category?: IdPhotoCategory
  countryCode?: string
  widthMm: number
  heightMm: number
  dpi?: number
  recommendedBgColors?: string[]
  faceRatioMin?: number
  faceRatioMax?: number
  fileSizeMaxKb?: number
}): Promise<IdPhotoSpec> {
  return request<IdPhotoSpec>('/api/tools/id-photo/specs', {
    method: 'POST',
    body: JSON.stringify(spec),
  })
}

export async function deleteCustomSpec(id: string): Promise<void> {
  await request<{ deleted: boolean }>(`/api/tools/id-photo/specs/${id}`, {
    method: 'DELETE',
  })
}

export async function getIdPhotoSettings(): Promise<IdPhotoUserSettings> {
  return request<IdPhotoUserSettings>('/api/tools/id-photo/settings')
}

export async function updateIdPhotoSettings(
  patch: Partial<Omit<IdPhotoUserSettings, 'userId' | 'updatedAt'>>,
): Promise<IdPhotoUserSettings> {
  return request<IdPhotoUserSettings>('/api/tools/id-photo/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}
