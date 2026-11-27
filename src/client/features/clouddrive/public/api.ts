import { request } from '../api'

export interface PublicShareMeta {
  name: string
  path: string
  targetKind: 'file' | 'folder'
  size?: number | null
  mime?: string | null
  locked: boolean
  hasPassword: boolean
  expiresAt?: number | null
  allowDownload: boolean
  disabled: boolean
}

/** `path` is relative to the share root: the owner's own directory layout is never handed out. */
export interface PublicShareEntry {
  name: string
  path: string
  kind: 'file' | 'folder'
  size: number
  mime: string
  modifiedAt: number
}

export interface PublicShareListing {
  entries: PublicShareEntry[]
  cursor: string | null
  total: number
}

export interface PublicRequestInfo {
  name: string
  hasPassword: boolean
  expiresAt: number | null
  maxFiles: number
  maxBytes: number
  maxFileBytes: number
  receivedFiles: number
  receivedBytes: number
}

const SHARE_API = '/api/public/clouddrive/shares'
const REQUEST_API = '/api/public/clouddrive/requests'

function sharePath(slug: string): string {
  return `${SHARE_API}/${encodeURIComponent(slug)}`
}

function requestPath(slug: string): string {
  return `${REQUEST_API}/${encodeURIComponent(slug)}`
}

export const cloudDrivePublicApi = {
  share: (slug: string) => request<PublicShareMeta>(sharePath(slug)),
  verifyShare: (slug: string, password: string) => request<{ ok: true }>(`${sharePath(slug)}/verify`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  }),
  listShare: (slug: string, path: string, cursor: string | null) => {
    const search = new URLSearchParams({ path })
    if (cursor) search.set('cursor', cursor)
    return request<PublicShareListing>(`${sharePath(slug)}/list?${search.toString()}`)
  },
  shareContentUrl: (slug: string, path: string, download: boolean) => download
    ? `/d/${encodeURIComponent(slug)}/raw?path=${encodeURIComponent(path)}`
    : `${sharePath(slug)}/content?path=${encodeURIComponent(path)}`,
  shareZipUrl: (slug: string) => `/api/public/clouddrive/shares/${encodeURIComponent(slug)}/zip`,
  saveShare: (slug: string, toPath = '/') => request<{ saved: number; entry: { id: string; name: string; path: string } }>(
    `/api/clouddrive/shares/${encodeURIComponent(slug)}/save`,
    { method: 'POST', body: JSON.stringify({ toPath }) },
  ),

  fileRequest: (slug: string) => request<PublicRequestInfo>(requestPath(slug)),
  verifyRequest: (slug: string, password: string) => request<{ ok: true }>(`${requestPath(slug)}/verify`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  }),
  uploadToRequest: (slug: string, file: File, password: string) => request<{ name?: string }>(
    `${requestPath(slug)}/upload?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        ...(password ? { 'X-CloudDrive-Request-Password': password } : {}),
      },
      body: file,
    },
  ),
}
