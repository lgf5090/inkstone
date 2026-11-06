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
  /** Empty when this session was not recorded (recording is off by default). */
  recordingId: string
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

/**
 * An asciinema cast v2 header. `timestamp` is in whole seconds; terminal output and resize events
 * follow as one JSON tuple per line.
 */
export interface WebsshCastHeader {
  version: 2
  width: number
  height: number
  timestamp: number
  env?: Record<string, string>
}

/** `[seconds since the recording started, kind, payload]` — `o` output text, `r` `colsxrows`. */
export type WebsshCastEvent =
  | [number, 'o', string]
  | [number, 'r', string]

export type WebsshRecordingStatus = 'recording' | 'finalizing' | 'ready' | 'failed' | 'deleted'

/** The owner-facing metadata of one session recording. */
export interface WebsshRecordingView {
  id: string
  sessionId: string
  hostId: string
  format: 'cast'
  status: WebsshRecordingStatus
  sizeBytes: number
  durationMs: number
  cols: number
  rows: number
  createdAt: number
  finalizedAt: number | null
  expiresAt: number
}

/**
 * One byte-addressed slice of a cast file. `offset` is the requested offset, `startOffset` the byte
 * the first returned line begins at (a partial first line is skipped), and `nextOffset` the byte
 * after the last complete line — the value to pass as `offset` for the next slice.
 */
export interface WebsshRecordingFrames {
  recordingId: string
  sessionId: string
  offset: number
  startOffset: number
  nextOffset: number
  totalSize: number
  complete: boolean
  header?: WebsshCastHeader
  frames: WebsshCastEvent[]
}

export interface WebsshRecordingSettingsView {
  recording: {
    enabled: boolean
    retentionDays: number
  }
}
