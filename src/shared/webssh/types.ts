export interface WebsshHealth {
  ok: true
  module: 'webssh'
}

export type WebsshSessionStatus = 'pending' | 'connecting' | 'active' | 'closed' | 'error'

export type WebsshAuthMethod = 'password' | 'publickey'

export interface WebsshHostGroup {
  id: string
  parentId: string
  name: string
  color: string
  icon: string
  position: number
  createdAt: number
  updatedAt: number
}

export interface WebsshHost {
  id: string
  name: string
  host: string
  port: number
  username: string
  groupId: string
  authMethod: WebsshAuthMethod
  credentialId: string
  keyId: string
  encoding: string
  termType: string
  initialCommand: string
  color: string
  tags: string[]
  notes: string
  favorite: boolean
  sortOrder: number
  lastConnectedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface WebsshHostListResponse {
  items: WebsshHost[]
  total: number
  page: number
  pageSize: number
}

export interface WebsshCredential {
  id: string
  label: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  hostCount: number
}

export interface WebsshKey {
  id: string
  label: string
  algorithm: string
  publicKey: string
  fingerprint: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  hostCount: number
}

export type WebsshHostKeyState = 'untrusted' | 'trusted' | 'changed' | 'revoked'

export interface WebsshHostKey {
  algorithm: string
  fingerprint: string
  firstSeenAt: number
  lastSeenAt: number
  trustedAt: number | null
  revokedAt: number | null
}

export interface WebsshHostKeyCheck {
  state: WebsshHostKeyState
  algorithm: string
  fingerprint: string
  trustedFingerprint: string | null
}

export interface WebsshHostPreflight {
  hostId: string
  host: string
  port: number
  username: string
  authMethod: WebsshAuthMethod
  ready: boolean
  issues: string[]
  credentialLabel: string | null
  keyLabel: string | null
  hostKey: WebsshHostKeyCheck | null
}
