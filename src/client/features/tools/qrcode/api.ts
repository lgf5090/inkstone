import type {
  QrCodeRecord,
  QrCodeSettings,
  QrCodeTemplate,
  QrExportFormat,
  QrStylingOptions,
} from '../../../../shared/tools/qrcode/types'

const BASE_URL = '/api/tools/qrcode'

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
}): Promise<{ records: QrCodeRecord[]; total: number }> {
  const query = new URLSearchParams()
  if (params?.contentType) query.set('contentType', params.contentType)
  if (params?.query) query.set('query', params.query)
  if (params?.limit) query.set('limit', String(params.limit))
  if (params?.offset) query.set('offset', String(params.offset))

  const res = await fetch(`${BASE_URL}/records?${query.toString()}`)
  if (!res.ok) {
    throw new Error('Failed to fetch QR records')
  }
  const json = await res.json()
  return json.data
}

export async function saveQrRecord(payload: SaveRecordPayload): Promise<QrCodeRecord> {
  const res = await fetch(`${BASE_URL}/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error('Failed to save QR record')
  }
  const json = await res.json()
  return json.data
}

export async function deleteQrRecord(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/records/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    throw new Error('Failed to delete QR record')
  }
}

export async function fetchQrTemplates(): Promise<{ templates: QrCodeTemplate[] }> {
  const res = await fetch(`${BASE_URL}/templates`)
  if (!res.ok) {
    throw new Error('Failed to fetch QR templates')
  }
  const json = await res.json()
  return json.data
}

export async function saveQrTemplate(payload: {
  id?: string
  name: string
  category: string
  previewSvg?: string
  options: QrStylingOptions
}): Promise<QrCodeTemplate> {
  const res = await fetch(`${BASE_URL}/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error('Failed to save QR template')
  }
  const json = await res.json()
  return json.data
}

export async function deleteQrTemplate(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    throw new Error('Failed to delete QR template')
  }
}

export async function fetchQrSettings(): Promise<QrCodeSettings> {
  const res = await fetch(`${BASE_URL}/settings`)
  if (!res.ok) {
    throw new Error('Failed to fetch QR settings')
  }
  const json = await res.json()
  return json.data
}

export async function updateQrSettings(payload: Partial<QrCodeSettings>): Promise<QrCodeSettings> {
  const res = await fetch(`${BASE_URL}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error('Failed to update QR settings')
  }
  const json = await res.json()
  return json.data
}

export async function uploadQrLogo(fileData: string, format = 'png'): Promise<{ id: string; url: string }> {
  const res = await fetch(`${BASE_URL}/upload-logo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileData, format }),
  })
  if (!res.ok) {
    throw new Error('Failed to upload logo')
  }
  const json = await res.json()
  return json.data
}
