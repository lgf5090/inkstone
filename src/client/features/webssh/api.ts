import type {
  WebsshCredential,
  WebsshHost,
  WebsshHostGroup,
  WebsshHostKey,
  WebsshHostKeyCheck,
  WebsshHostListResponse,
  WebsshHostPreflight,
  WebsshKey,
} from '@shared/webssh/types'
import { request } from '../../lib/api'

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
}
