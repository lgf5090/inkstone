/**
 * The replaceable transport layer between the terminal UI and a WebSSH session.
 *
 * The terminal never imports a concrete implementation directly — it receives a factory — so the
 * session wiring can change without touching the terminal, tabs or status surface.
 *
 * Wire contract (same-origin WebSocket, text frames, JSON):
 *
 *   GET /api/webssh/sessions/:sessionId/ws?ticket=<one-time ticket>
 *
 *   Client -> server
 *     { "type": "input",  "data": "<raw terminal bytes>" }
 *     { "type": "resize", "cols": 120, "rows": 32 }
 *     { "type": "ping" }
 *
 *   Server -> client
 *     { "type": "ready",  "cols": 120, "rows": 32 }
 *     { "type": "output", "data": "<raw terminal bytes>" }
 *     { "type": "exit",   "reason": "eof" | "idle" | "error", "message": "<optional>" }
 *     { "type": "error",  "code": "<api error code>", "message": "<optional>" }
 *     { "type": "pong" }
 *
 * `input` carries bytes exactly as xterm produced them (including control sequences and `\r`),
 * so the server can write them to the SSH channel unchanged. `output` carries bytes exactly as the
 * SSH channel produced them. No terminal text is ever interpreted on the server.
 *
 * The ticket is minted over REST, consumed once on upgrade, and never reused by this client;
 * `WebSocketTerminalTransport` accepts the finished URL rather than a session id so the UI layer
 * does not need to know how tickets are issued.
 */

export type TerminalTransportKind = 'fake' | 'websocket'

/** What happened to the link, as the UI needs to hear it. */
export type TransportPhase = 'connecting' | 'open' | 'closed' | 'error'

export interface TransportPhaseEvent {
  phase: TransportPhase
  /** Server-provided code or reason, for the status text and diagnostics. */
  reason?: string
  message?: string
}

export interface TerminalTransportHandlers {
  onPhase: (event: TransportPhaseEvent) => void
  /** Raw bytes from the shell. They are written to xterm untouched. */
  onOutput: (data: string) => void
  /** The session the server created for this transport, once it exists. */
  onSession?: (sessionId: string) => void
}

export interface TransportConnectOptions {
  cols: number
  rows: number
}

export interface TerminalTransport {
  readonly kind: TerminalTransportKind
  connect: (options: TransportConnectOptions) => void
  send: (data: string) => void
  resize: (cols: number, rows: number) => void
  /** Deliberate close: no reconnect should follow it. */
  close: () => void
  dispose: () => void
  /**
   * Demo transports only: drop the link as if the server went away, so the reconnect path can be
   * exercised before W2 exists. A real transport omits it and the UI hides the control.
   */
  simulateDrop?: () => void
}

export type TerminalTransportFactory = (handlers: TerminalTransportHandlers) => TerminalTransport
