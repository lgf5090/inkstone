import { CLIENT_HEADER } from '@shared/constants'
import type {
  CloudDriveBootstrap,
  CloudDriveEntry,
  CloudDriveListing,
  CloudDrivePrefs,
  CloudDriveSortDirection,
  CloudDriveSortKey,
} from '@shared/clouddrive/model'
import type { CloudDrivePublicSettings, CloudDriveSettingsPatch } from '@shared/clouddrive/settings'

export class CloudDriveApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = 'CloudDriveApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set(CLIENT_HEADER, '1')
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  const type = response.headers.get('content-type') ?? ''
  const body = type.includes('application/json') ? await response.json().catch(() => null) : null
  if (!response.ok) {
    const error = body as { error?: { code?: string; message?: string } } | null
    throw new CloudDriveApiError(error?.error?.code ?? 'internal', error?.error?.message ?? response.statusText, response.status)
  }
  return body as T
}

function json(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) }
}

export interface CloudDriveListParams {
  mountId?: string
  path?: string
  sort?: CloudDriveSortKey
  dir?: CloudDriveSortDirection
  foldersFirst?: boolean
  cursor?: string | null
  limit?: number
  q?: string
  type?: string
  starred?: boolean
  tag?: string
}

export const clouddriveApi = {
  bootstrap: () => request<CloudDriveBootstrap>('/api/clouddrive/bootstrap'),

  list: (params: CloudDriveListParams) => {
    const search = new URLSearchParams()
    if (params.mountId) search.set('mount', params.mountId)
    if (params.path) search.set('path', params.path)
    if (params.sort) search.set('sort', params.sort)
    if (params.dir) search.set('dir', params.dir)
    if (params.foldersFirst !== undefined) search.set('foldersFirst', params.foldersFirst ? '1' : '0')
    if (params.cursor) search.set('cursor', params.cursor)
    if (params.limit) search.set('limit', String(params.limit))
    if (params.q) search.set('q', params.q)
    if (params.type) search.set('type', params.type)
    if (params.starred) search.set('starred', '1')
    if (params.tag) search.set('tag', params.tag)
    return request<CloudDriveListing>(`/api/clouddrive/files?${search.toString()}`)
  },

  entry: (id: string) => request<{ entry: CloudDriveEntry; parts?: unknown[] }>(`/api/clouddrive/files/${encodeURIComponent(id)}`),
  mkdir: (body: { mountId: string; parentPath: string; name: string }) => request<{ entry: CloudDriveEntry }>('/api/clouddrive/folders', json(body)),
  patch: (id: string, body: { name?: string; starred?: boolean; color?: string | null }) => request<{ entry: CloudDriveEntry }>(`/api/clouddrive/files/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  move: (body: { ids: string[]; toPath: string; conflict?: 'rename' | 'overwrite' | 'skip' }) => request<{ results: unknown[]; taskId?: string }>('/api/clouddrive/files/move', json(body)),
  copy: (body: { ids: string[]; toPath: string; conflict?: 'rename' | 'overwrite' | 'skip' }) => request<{ results: unknown[]; taskId?: string }>('/api/clouddrive/files/copy', json(body)),
  remove: (ids: string[]) => request<{ deleted: number; taskId?: string }>('/api/clouddrive/files', { method: 'DELETE', body: JSON.stringify({ ids }) }),
  trash: (cursor?: string | null) => request<CloudDriveListing>(`/api/clouddrive/trash?${new URLSearchParams(cursor ? { cursor } : {}).toString()}`),
  restore: (ids: string[]) => request<{ results: unknown[] }>('/api/clouddrive/files/restore', json({ ids })),
  purge: (body: { ids?: string[]; all?: boolean }) => request<{ deleted: number; failed: number; taskId?: string }>('/api/clouddrive/files/purge', { method: 'DELETE', body: JSON.stringify(body) }),
  search: (params: { q: string; mountId?: string; type?: string; starred?: boolean; cursor?: string | null }) => {
    const search = new URLSearchParams({ q: params.q })
    if (params.mountId) search.set('mount', params.mountId)
    if (params.type) search.set('type', params.type)
    if (params.starred) search.set('starred', '1')
    if (params.cursor) search.set('cursor', params.cursor)
    return request<{ files: CloudDriveEntry[]; cursor: string | null; total: number | null }>(`/api/clouddrive/search?${search.toString()}`)
  },
  recent: (kind: 'viewed' | 'uploaded') => request<{ files: CloudDriveEntry[]; cursor: string | null }>(`/api/clouddrive/recent?kind=${kind}`),
  album: (cursor?: string | null) => request<{ groups: { month: string; files: CloudDriveEntry[] }[]; cursor: string | null }>(`/api/clouddrive/album?${new URLSearchParams(cursor ? { cursor } : {}).toString()}`),

  initUpload: (body: { mountId: string; parentPath: string; name: string; size: number; mime: string; conflict?: string }) => request<{
    session: { id: string; strategy: string; partSize: number; totalParts: number; uploadedParts?: number }
    entryPath: string
    existing?: CloudDriveEntry
  }>('/api/clouddrive/uploads', json(body)),
  completeUpload: (id: string) => request<{ entry: CloudDriveEntry }>(`/api/clouddrive/uploads/${encodeURIComponent(id)}/complete`, json({})),
  abortUpload: (id: string) => request<{ ok: true }>(`/api/clouddrive/uploads/${encodeURIComponent(id)}/abort`, json({})),
  uploadSessions: () => request<{ sessions: unknown[] }>('/api/clouddrive/uploads?status=active'),

  contentUrl: (id: string, download = false) => `/api/clouddrive/files/${encodeURIComponent(id)}/content${download ? '?download=1' : ''}`,
  thumbnailUrl: (id: string, width = 320) => `/api/clouddrive/files/${encodeURIComponent(id)}/thumbnail?w=${width}`,
  zipUrl: (params: { mountId: string; path: string }) => `/api/clouddrive/download/zip?${new URLSearchParams(params).toString()}`,

  tasks: () => request<{ tasks: { id: string; type: string; status: string; payload: Record<string, unknown>; progress: Record<string, unknown>; error: string | null; createdAt: number; startedAt: number | null; finishedAt: number | null }[] }>('/api/clouddrive/tasks'),
  cancelTask: (id: string) => request<{ ok: true }>(`/api/clouddrive/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),

  clipboard: () => request<{ clipboard: { mode: 'copy' | 'cut'; mountId: string; sourcePath: string; ids: string[]; updatedAt: number } | null }>('/api/clouddrive/clipboard'),
  setClipboard: (body: { mode: 'copy' | 'cut'; mountId: string; sourcePath: string; ids: string[] }) => request<{ clipboard: { mode: 'copy' | 'cut'; mountId: string; sourcePath: string; ids: string[]; updatedAt: number } }>('/api/clouddrive/clipboard', { method: 'PUT', body: JSON.stringify(body) }),
  clearClipboard: () => request<{ ok: true }>('/api/clouddrive/clipboard', { method: 'DELETE' }),

  tags: () => request<{ tags: { name: string; color: string; count: number }[] }>('/api/clouddrive/tags'),
  addTag: (id: string, body: { tag: string; color: string }) => request<{ entry: CloudDriveEntry }>(`/api/clouddrive/files/${encodeURIComponent(id)}/tags`, json(body)),
  removeTag: (id: string, tag: string) => request<{ entry: CloudDriveEntry }>(`/api/clouddrive/files/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' }),

  mounts: () => request<{ mounts: { id: string; storageId: string; name: string; mountPath: string; readOnly: boolean; cacheTtl: number; sortOrder: number; enabled: boolean }[] }>('/api/clouddrive/mounts'),
  createMount: (body: unknown) => request<{ mount: unknown }>('/api/clouddrive/mounts', json(body)),
  patchMount: (id: string, body: unknown) => request<{ mount: unknown }>(`/api/clouddrive/mounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteMount: (id: string) => request<{ ok: true }>(`/api/clouddrive/mounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testMount: (id: string) => request<{ ok: boolean; message: string }>(`/api/clouddrive/mounts/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' }),
  storages: () => request<{ storages: { id: string; name: string; type: string; config: Record<string, unknown>; status: string; isDefault: boolean; hasCredentials: boolean; lastUsedAt: number | null; createdAt: number }[] }>('/api/clouddrive/storages'),
  createStorage: (body: unknown) => request<{ storage: unknown }>('/api/clouddrive/storages', json(body)),
  patchStorage: (id: string, body: unknown) => request<{ storage: unknown }>(`/api/clouddrive/storages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteStorage: (id: string) => request<{ ok: true }>(`/api/clouddrive/storages/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  defaultStorage: (id: string) => request<{ ok: true }>(`/api/clouddrive/storages/${encodeURIComponent(id)}/default`, { method: 'POST', body: '{}' }),
  testStorage: (id: string) => request<{ ok: boolean; message: string }>(`/api/clouddrive/storages/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' }),

  capacity: () => request<{ used: number; trashBytes: number; quota: number | null; mounts: unknown[] }>('/api/clouddrive/capacity'),
  settings: () => request<{ settings: CloudDrivePublicSettings }>('/api/clouddrive/settings'),
  patchSettings: (patch: CloudDriveSettingsPatch) => request<{ settings: CloudDrivePublicSettings }>('/api/clouddrive/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  keys: () => request<{ keys: { id: string; name: string; prefix: string; scopes: string[]; pathPrefix: string; expiresAt: number | null; lastUsedAt: number | null; createdAt: number }[] }>('/api/clouddrive/api-keys'),
  createKey: (body: { name: string; scopes: string[]; pathPrefix?: string; expiresAt?: number | null }) => request<{ key: unknown; token: string }>('/api/clouddrive/api-keys', json(body)),
  revokeKey: (id: string) => request<{ ok: true }>(`/api/clouddrive/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  shares: () => request<{ shares: unknown[] }>('/api/clouddrive/shares'),
  createShare: (body: unknown) => request<{ share: { slug: string; url: string } }>('/api/clouddrive/shares', json(body)),
  patchShare: (slug: string, body: unknown) => request<{ share: unknown }>(`/api/clouddrive/shares/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  revokeShare: (slug: string) => request<{ ok: true }>(`/api/clouddrive/shares/${encodeURIComponent(slug)}`, { method: 'DELETE' }),

  savePrefs: (_prefs: CloudDrivePrefs) => Promise.resolve(),
}

export function cloudDriveErrorKey(error: unknown): string {
  if (error instanceof CloudDriveApiError) return `clouddrive.error.${error.code.replace(/^clouddrive_/, '')}`
  if (error instanceof Error && error.message === 'invalid_path') return 'clouddrive.error.path_invalid'
  return 'clouddrive.error.internal'
}
