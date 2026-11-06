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

/** One directory entry from the W5 SFTP listing route. */
export interface WebsshSftpEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'socket' | 'block-device' | 'character-device' | 'fifo' | 'unknown'
  /** Bytes, `0` when the server did not report a size. */
  size: number
  /** Unix mtime in seconds, `null` when the server did not report one. */
  mtime: number | null
  /** `ls`-style permission string such as `drwxr-xr-x`. */
  permissions: string
  longname: string
}

export interface WebsshSftpListing {
  path: string
  entries: WebsshSftpEntry[]
}

/** A staged upload. Chunks are PUT to the transfer before `complete` writes them to the host. */
export interface WebsshSftpUploadCreated {
  transferId: string
  size: number
  /** The largest block the chunk route accepts, in bytes. */
  chunkSize: number
}

export interface WebsshSftpUploadStatus {
  transferId: string
  received: number
  size: number
}

export interface WebsshSftpMutationResult {
  ok: true
}

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
