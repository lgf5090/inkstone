import type {
  QrCodeRecord,
  QrCodeSettings,
  QrCodeTemplate,
  QrExportFormat,
  QrStylingOptions,
} from '../../../../shared/tools/qrcode/types'

const BASE_URL = '/api/tools/qrcode'

const CLIENT_HEADERS = {
  'Content-Type': 'application/json',
  'X-Inkstone-Client': '1',
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...CLIENT_HEADERS,
      ...(init.headers || {}),
    },
  })
  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`
    try {
      const data = await res.json()
      if (data && (data.error || data.message)) {
        errorMsg = data.error || data.message
      }
    } catch {
    }
    throw new Error(errorMsg)
  }
  const json = await res.json()
  return json.data
}

export interface SaveRecordPayload {
  title?: string
  contentType: string
  contentRaw: string
  options: QrStylingOptions
  fileData?: string
  fileType: QrExportFormat
  width: number
  height: number
}

export async function fetchQrRecords(params?: {
  contentType?: string
  query?: string
  limit?: number
  offset?: number
}): Promise<{ items: QrCodeRecord[]; records: QrCodeRecord[]; total: number }> {
  const query = new URLSearchParams()
  if (params?.contentType) query.set('contentType', params.contentType)
  if (params?.query) query.set('query', params.query)
  if (params?.limit) query.set('limit', String(params.limit))
  if (params?.offset) query.set('offset', String(params.offset))

  const qs = query.toString()
  const data = await request<any>(`/records${qs ? `?${qs}` : ''}`)
  const items: QrCodeRecord[] = Array.isArray(data) ? data : data?.items || data?.records || []
  const total: number = typeof data?.total === 'number' ? data.total : items.length
  return { items, records: items, total }
}

export async function saveQrRecord(payload: SaveRecordPayload): Promise<QrCodeRecord> {
  return request<QrCodeRecord>('/records', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function deleteQrRecord(id: string): Promise<void> {
  await request<void>(`/records/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function fetchQrTemplates(): Promise<{ templates: QrCodeTemplate[] }> {
  return request<{ templates: QrCodeTemplate[] }>('/templates')
}

export async function saveQrTemplate(payload: {
  id?: string
  name: string
  category: string
  previewSvg?: string
  options: QrStylingOptions
}): Promise<QrCodeTemplate> {
  return request<QrCodeTemplate>('/templates', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function deleteQrTemplate(id: string): Promise<void> {
  await request<void>(`/templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function fetchQrSettings(): Promise<QrCodeSettings> {
  return request<QrCodeSettings>('/settings')
}

export async function updateQrSettings(payload: Partial<QrCodeSettings>): Promise<QrCodeSettings> {
  return request<QrCodeSettings>('/settings', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function uploadQrLogo(fileData: string, format = 'png'): Promise<{ id: string; url: string }> {
  return request<{ id: string; url: string }>('/upload-logo', {
    method: 'POST',
    body: JSON.stringify({ fileData, format }),
  })
}
