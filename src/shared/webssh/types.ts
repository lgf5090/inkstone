export interface WebsshHealth {
  ok: true
  module: 'webssh'
}

export type WebsshSessionStatus = 'pending' | 'connecting' | 'active' | 'closed' | 'error'

/** The session row as the owner-facing status route returns it. */
export interface WebsshSessionView {
  id: string
  hostId: string
  status: WebsshSessionStatus
  startedAt: number
  connectedAt: number | null
  endedAt: number | null
  lastActivityAt: number
  closeReason: string
  errorCode: string
}

export interface WebsshSessionCreated {
  sessionId: string
  status: WebsshSessionStatus
}

export interface WebsshSessionTicket {
  ticket: string
  /** The finished same-origin WebSocket URL, ticket included. */
  url: string
  expiresAt: number
}

export type WebsshCloseReason = 'eof' | 'idle' | 'error'

/** Client -> server frames; every frame is JSON text on the same-origin socket. */
export type WebsshClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }

/**
 * Server -> client frames.
 *
 * `exitCode`/`signal` are additive fields on `exit`: the frozen frame set names only `reason` and
 * `message`, while an interactive shell's real status is worth carrying for the status bar.
 */
export type WebsshServerFrame =
  | { type: 'ready'; cols: number; rows: number }
  | { type: 'output'; data: string }
  | { type: 'exit'; reason: WebsshCloseReason; message?: string; exitCode?: number | null; signal?: string | null }
  | { type: 'error'; code: string; message?: string }
  | { type: 'pong' }

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
