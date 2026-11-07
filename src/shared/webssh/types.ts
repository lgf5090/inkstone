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

/**
 * The owner-facing view of one public replay link. `url` is the `/w/<slug>` address a browser opens
 * and `hasPassword` says whether a passcode stands in front of it; the recording's R2 key is never
 * part of this shape.
 */
export interface WebsshShareView {
  slug: string
  recordingId: string
  title: string
  url: string
  hasPassword: boolean
  expiresAt: number
  maxViews: number
  views: number
  isEnabled: boolean
  createdAt: number
  lastViewedAt: number | null
}

/** What a visitor is told about a recording once the link's gate has been passed. */
export interface WebsshPublicShareRecording {
  format: 'cast'
  sizeBytes: number
  durationMs: number
  cols: number
  rows: number
  createdAt: number
  finalizedAt: number | null
}

/**
 * The public metadata read. It names the share, never the session: no recording id, session id, host
 * id, account id, R2 key or host address reaches a visitor.
 */
export interface WebsshPublicShareView {
  share: {
    slug: string
    title: string
    createdAt: number
    expiresAt: number
    maxViews: number
    views: number
  }
  recording: WebsshPublicShareRecording
}

/**
 * One byte-addressed slice of a shared cast. The slicing rules are the owner-side replay's, but the
 * answer carries no recording or session identity.
 */
export interface WebsshPublicShareFrames {
  offset: number
  startOffset: number
  nextOffset: number
  totalSize: number
  complete: boolean
  header?: WebsshCastHeader
  frames: WebsshCastEvent[]
}
