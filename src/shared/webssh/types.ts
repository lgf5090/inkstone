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
