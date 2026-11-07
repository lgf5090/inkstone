/**
 * The Zero Trust screen's door to `/api/cloudflare/zero-trust`.
 */
import { cfRequest } from './client'

export interface AccessApp {
  id: string
  name: string
  domain: string
  type: string
  sessionDuration: string
  createdAt: string
  updatedAt: string
}

export interface AccessPolicy {
  id: string
  name: string
  decision: string
}

export interface AccessGroup {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface IdentityProvider {
  id: string
  name: string
  type: string
}

export interface ServiceToken {
  id: string
  name: string
  clientId: string
  expiresAt: string
  createdAt: string
  clientSecret?: string
}

export interface AccessOrganization {
  name: string
  authDomain: string
  createdAt: string
  updatedAt: string
  denyUnmatchedRequests: boolean
  strictServiceTokenAuth: boolean
}

export interface AccessDevice {
  id: string
  name: string
  deviceType: string
  osVersion: string
  lastSeen: string
}

export interface DevicePolicy {
  id: string
  default: boolean
  enabled: boolean
  profileType: string
}

const BASE = '/zero-trust'

export const zeroTrustApi = {
  apps: (accountId: string) => cfRequest<{ apps: AccessApp[] }>(`${BASE}/${accountId}/apps`),
  appPolicies: (accountId: string, appId: string) =>
    cfRequest<{ policies: AccessPolicy[] }>(`${BASE}/${accountId}/apps/${encodeURIComponent(appId)}/policies`),
  createApp: (accountId: string, name: string, domain: string) =>
    cfRequest<AccessApp>(`${BASE}/${accountId}/apps`, { method: 'POST', body: { name, domain } }),
  deleteApp: (accountId: string, appId: string) =>
    cfRequest<{ deleted: true }>(`${BASE}/${accountId}/apps/${encodeURIComponent(appId)}`, { method: 'DELETE' }),

  groups: (accountId: string) => cfRequest<{ groups: AccessGroup[] }>(`${BASE}/${accountId}/groups`),
  createGroup: (accountId: string, name: string, email: string) =>
    cfRequest<AccessGroup>(`${BASE}/${accountId}/groups`, { method: 'POST', body: { name, email } }),
  deleteGroup: (accountId: string, groupId: string) =>
    cfRequest<{ deleted: true }>(`${BASE}/${accountId}/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' }),

  providers: (accountId: string) =>
    cfRequest<{ providers: IdentityProvider[] }>(`${BASE}/${accountId}/identity-providers`),

  tokens: (accountId: string) => cfRequest<{ tokens: ServiceToken[] }>(`${BASE}/${accountId}/service-tokens`),
  createToken: (accountId: string, name: string) =>
    cfRequest<ServiceToken>(`${BASE}/${accountId}/service-tokens`, { method: 'POST', body: { name } }),
  deleteToken: (accountId: string, tokenId: string) =>
    cfRequest<{ deleted: true }>(`${BASE}/${accountId}/service-tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' }),

  organization: (accountId: string) =>
    cfRequest<{ organization: AccessOrganization }>(`${BASE}/${accountId}/organization`),

  devices: (accountId: string) => cfRequest<{ devices: AccessDevice[] }>(`${BASE}/${accountId}/devices`),
  devicePolicies: (accountId: string) =>
    cfRequest<{ policies: DevicePolicy[] }>(`${BASE}/${accountId}/device-policies`),
}
