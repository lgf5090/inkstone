import type {
  WebsshAuditListResponse,
  WebsshCredential,
  WebsshHealthReport,
  WebsshHost,
  WebsshHostGroup,
  WebsshHostKey,
  WebsshHostKeyCheck,
  WebsshHostListResponse,
  WebsshHostPreflight,
  WebsshImportCommitResult,
  WebsshImportPreview,
  WebsshKey,
  WebsshPublicShareFrames,
  WebsshPublicShareView,
  WebsshRecordingFrames,
  WebsshRecordingSettingsView,
  WebsshRecordingView,
  WebsshSessionCreated,
  WebsshSessionStatus,
  WebsshSessionTicket,
  WebsshShareView,
  WebsshSnippet,
  WebsshSnippetListResponse,
  WebsshSftpListing,
  WebsshSftpMutationResult,
  WebsshSftpUploadCreated,
  WebsshSftpUploadStatus,
} from '@shared/webssh/types'
import { CLIENT_HEADER } from '@shared/constants'
import { ApiError, request } from '../../lib/api'

export interface WebsshHostPayload {
  name: string
  host: string
  port: number
  username: string
  groupId: string
  authMethod: 'password' | 'publickey'
  credentialId: string
  keyId: string
  encoding: string
  termType: string
  initialCommand: string
  color: string
  tags: string[]
  notes: string
  favorite: boolean
}

export const websshApi = {
  listGroups: async () => (await request<{ groups: WebsshHostGroup[] }>('/api/webssh/groups')).groups,
  createGroup: async (body: { name: string; parentId?: string; color?: string; icon?: string }) =>
    (await request<{ group: WebsshHostGroup }>('/api/webssh/groups', { method: 'POST', body })).group,
  updateGroup: async (id: string, body: { name?: string; parentId?: string; color?: string; icon?: string; position?: number }) =>
    (await request<{ group: WebsshHostGroup }>(`/api/webssh/groups/${id}`, { method: 'PATCH', body })).group,
  deleteGroup: async (id: string) => {
    await request(`/api/webssh/groups/${id}`, { method: 'DELETE' })
  },

  listHosts: async (params: { q?: string; groupId?: string; favorite?: boolean; sort?: string; page?: number; pageSize?: number }) => {
    const search = new URLSearchParams()
    if (params.q) search.set('q', params.q)
    if (params.groupId) search.set('groupId', params.groupId)
    if (params.favorite) search.set('favorite', '1')
    if (params.sort) search.set('sort', params.sort)
    if (params.page) search.set('page', String(params.page))
    if (params.pageSize) search.set('pageSize', String(params.pageSize))
    const query = search.toString()
    return await request<WebsshHostListResponse>(`/api/webssh/hosts${query ? `?${query}` : ''}`)
  },
  getHost: async (id: string) => (await request<{ host: WebsshHost }>(`/api/webssh/hosts/${id}`)).host,
  createHost: async (body: WebsshHostPayload) => (await request<{ host: WebsshHost }>('/api/webssh/hosts', { method: 'POST', body })).host,
  updateHost: async (id: string, body: WebsshHostPayload) =>
    (await request<{ host: WebsshHost }>(`/api/webssh/hosts/${id}`, { method: 'PATCH', body })).host,
  deleteHost: async (id: string) => {
    await request(`/api/webssh/hosts/${id}`, { method: 'DELETE' })
  },
  preflight: async (id: string, body: { algorithm?: string; fingerprint?: string }) =>
    await request<WebsshHostPreflight>(`/api/webssh/hosts/${id}/preflight`, { method: 'POST', body }),

  listFingerprints: async (hostId: string) =>
    (await request<{ fingerprints: WebsshHostKey[] }>(`/api/webssh/hosts/${hostId}/fingerprints`)).fingerprints,
  checkFingerprint: async (hostId: string, body: { algorithm: string; fingerprint: string }) =>
    (await request<{ check: WebsshHostKeyCheck }>(`/api/webssh/hosts/${hostId}/fingerprint/check`, { method: 'POST', body })).check,
  trustFingerprint: async (hostId: string, body: { algorithm: string; fingerprint: string }) =>
    (await request<{ check: WebsshHostKeyCheck }>(`/api/webssh/hosts/${hostId}/fingerprints/trust`, { method: 'POST', body })).check,
  revokeFingerprint: async (hostId: string, fingerprint: string) =>
    (await request<{ check: WebsshHostKeyCheck }>(`/api/webssh/hosts/${hostId}/fingerprints/revoke`, {
      method: 'POST',
      body: { fingerprint },
    })).check,

  listCredentials: async () => (await request<{ credentials: WebsshCredential[] }>('/api/webssh/credentials')).credentials,
  createCredential: async (body: { label: string; password: string }) =>
    (await request<{ credential: WebsshCredential }>('/api/webssh/credentials', { method: 'POST', body })).credential,
  updateCredential: async (id: string, body: { label?: string; password?: string }) =>
    (await request<{ credential: WebsshCredential }>(`/api/webssh/credentials/${id}`, { method: 'PATCH', body })).credential,
  deleteCredential: async (id: string) => {
    await request(`/api/webssh/credentials/${id}`, { method: 'DELETE' })
  },

  listKeys: async () => (await request<{ keys: WebsshKey[] }>('/api/webssh/keys')).keys,
  importKey: async (body: { label: string; privateKey: string; passphrase?: string }) =>
    await request<{ key: WebsshKey; encrypted: boolean }>('/api/webssh/keys', { method: 'POST', body }),
  renameKey: async (id: string, label: string) =>
    (await request<{ key: WebsshKey }>(`/api/webssh/keys/${id}`, { method: 'PATCH', body: { label } })).key,
  deleteKey: async (id: string) => {
    await request(`/api/webssh/keys/${id}`, { method: 'DELETE' })
  },
  publicKeyUrl: (id: string) => `/api/webssh/keys/${id}/public`,

  createSession: async (hostId: string, cols: number, rows: number) =>
    await request<WebsshSessionCreated>('/api/webssh/sessions', { method: 'POST', body: { hostId, cols, rows } }),
  issueTicket: async (sessionId: string) =>
    await request<WebsshSessionTicket>(`/api/webssh/sessions/${sessionId}/ticket`, { method: 'POST' }),
  sessionStatus: async (sessionId: string) =>
    await request<{ id: string; status: WebsshSessionStatus; recordingId: string }>(`/api/webssh/sessions/${sessionId}`),

  listDir: async (sessionId: string, path: string) =>
    await request<WebsshSftpListing>(`/api/webssh/sessions/${sessionId}/sftp/list?path=${encodeURIComponent(path)}`),
  download: async (sessionId: string, path: string, offset = 0, length?: number) => {
    const search = new URLSearchParams({ path, offset: String(offset) })
    if (length !== undefined) search.set('length', String(length))
    return await rawRequest(`/api/webssh/sessions/${sessionId}/sftp/download?${search.toString()}`)
  },
  mkdir: async (sessionId: string, path: string) =>
    await request<WebsshSftpMutationResult>(`/api/webssh/sessions/${sessionId}/sftp/mkdir`, { method: 'POST', body: { path } }),
  remove: async (sessionId: string, path: string, kind: 'file' | 'directory') =>
    await request<WebsshSftpMutationResult>(`/api/webssh/sessions/${sessionId}/sftp/remove`, {
      method: 'POST',
      body: { path, kind },
    }),
  rename: async (sessionId: string, from: string, to: string, overwrite = false) =>
    await request<WebsshSftpMutationResult>(`/api/webssh/sessions/${sessionId}/sftp/rename`, {
      method: 'POST',
      body: { from, to, overwrite },
    }),
  createUpload: async (sessionId: string, path: string, size: number) =>
    await request<WebsshSftpUploadCreated>(`/api/webssh/sessions/${sessionId}/sftp/uploads`, {
      method: 'POST',
      body: { path, size },
    }),
  putChunk: async (sessionId: string, transferId: string, offset: number, chunk: Blob) =>
    await rawRequest(`/api/webssh/sessions/${sessionId}/sftp/uploads/${transferId}`, {
      method: 'PUT',
      headers: { 'x-webssh-offset': String(offset) },
      body: chunk,
    }),
  uploadStatus: async (sessionId: string, transferId: string) =>
    await request<WebsshSftpUploadStatus>(`/api/webssh/sessions/${sessionId}/sftp/uploads/${transferId}`),
  completeUpload: async (sessionId: string, transferId: string) =>
    await request<WebsshSftpMutationResult>(`/api/webssh/sessions/${sessionId}/sftp/uploads/${transferId}/complete`, {
      method: 'POST',
    }),
  cancelUpload: async (sessionId: string, transferId: string) => {
    await request(`/api/webssh/sessions/${sessionId}/sftp/uploads/${transferId}`, { method: 'DELETE' })
  },

  recording: async (sessionId: string) =>
    await request<WebsshRecordingView>(`/api/webssh/sessions/${sessionId}/recording`),
  recordingFrames: async (sessionId: string, offset: number, limit = 512 * 1024) =>
    await request<WebsshRecordingFrames>(
      `/api/webssh/sessions/${sessionId}/recording/frames?offset=${offset}&limit=${limit}`,
    ),
  getShare: async (sessionId: string) =>
    (await request<{ share: WebsshShareView | null }>(`/api/webssh/sessions/${sessionId}/recording/share`)).share,
  createShare: async (sessionId: string, body: { title?: string; password?: string | null; expiresIn?: number | null; maxViews?: number | null; rotate?: boolean }) =>
    (await request<{ share: WebsshShareView }>(`/api/webssh/sessions/${sessionId}/recording/share`, {
      method: 'POST',
      body,
    })).share,
  deleteShare: async (sessionId: string) => {
    await request(`/api/webssh/sessions/${sessionId}/recording/share`, { method: 'DELETE' })
  },
  recordingSettings: async () => await request<WebsshRecordingSettingsView>('/api/webssh/settings'),
  updateRecordingSettings: async (enabled: boolean) =>
    await request<WebsshRecordingSettingsView>('/api/webssh/settings/recording', { method: 'PUT', body: { enabled } }),

  openShare: async (slug: string, password?: string) =>
    await publicRequest<WebsshPublicShareView>(`/api/public/webssh/shares/${encodeURIComponent(slug)}`, {
      method: 'POST',
      body: password ? { password } : {},
    }),
  publicFrames: async (slug: string, offset: number, limit = 512 * 1024) =>
    await publicRequest<WebsshPublicShareFrames>(
      `/api/public/webssh/shares/${encodeURIComponent(slug)}/frames?offset=${offset}&limit=${limit}`,
    ),

  listSnippets: async (params: { q?: string; favorite?: boolean; page?: number; pageSize?: number } = {}) => {
    const search = new URLSearchParams()
    if (params.q) search.set('q', params.q)
    if (params.favorite) search.set('favorite', '1')
    if (params.page) search.set('page', String(params.page))
    if (params.pageSize) search.set('pageSize', String(params.pageSize))
    const query = search.toString()
    return await request<WebsshSnippetListResponse>(`/api/webssh/snippets${query ? `?${query}` : ''}`)
  },
  createSnippet: async (body: { title: string; command: string; description?: string; tags?: string[]; shell?: string; favorite?: boolean }) =>
    (await request<{ snippet: WebsshSnippet }>('/api/webssh/snippets', { method: 'POST', body })).snippet,
  updateSnippet: async (id: string, body: Partial<{ title: string; command: string; description: string; tags: string[]; shell: string; favorite: boolean }>) =>
    (await request<{ snippet: WebsshSnippet }>(`/api/webssh/snippets/${id}`, { method: 'PATCH', body })).snippet,
  deleteSnippet: async (id: string) => {
    await request(`/api/webssh/snippets/${id}`, { method: 'DELETE' })
  },
  touchSnippet: async (id: string) =>
    (await request<{ snippet: WebsshSnippet }>(`/api/webssh/snippets/${id}/touch`, { method: 'POST' })).snippet,

  previewImport: async (content: string, format: 'auto' | 'ssh-config' | 'csv' = 'auto') =>
    await request<WebsshImportPreview>('/api/webssh/imports/preview', { method: 'POST', body: { content, format } }),
  commitImport: async (hosts: Array<{ name: string; host: string; port: number; username: string; tags: string[] }>) =>
    await request<WebsshImportCommitResult>('/api/webssh/imports', { method: 'POST', body: { hosts } }),

  listAudit: async (params: { page?: number; pageSize?: number; eventType?: string; from?: number; to?: number } = {}) => {
    const search = new URLSearchParams()
    if (params.page) search.set('page', String(params.page))
    if (params.pageSize) search.set('pageSize', String(params.pageSize))
    if (params.eventType) search.set('eventType', params.eventType)
    if (params.from) search.set('from', String(params.from))
    if (params.to) search.set('to', String(params.to))
    const query = search.toString()
    return await request<WebsshAuditListResponse>(`/api/webssh/audit${query ? `?${query}` : ''}`)
  },
  auditHealth: async () => await request<WebsshHealthReport>('/api/webssh/audit/health'),
}

async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { [CLIENT_HEADER]: '1', ...(init.headers ?? {}) },
  })
  if (!response.ok) throw await responseError(response)
  return response
}

async function publicRequest<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await rawRequest(path, {
    method: options.method,
    headers: { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return await response.json() as T
}

async function responseError(response: Response): Promise<ApiError> {
  let code = 'internal'
  let message = response.statusText || 'The request failed'
  try {
    const payload = await response.json() as { error?: { code?: string; message?: string } }
    if (typeof payload.error?.code === 'string') code = payload.error.code
    if (typeof payload.error?.message === 'string') message = payload.error.message
  } catch {
    // A binary or empty error body still maps to the status line below.
  }
  return new ApiError(response.status, code, message)
}
