/**
 * The real terminal transport: create a WebSSH session over REST, mint a one-time ticket, then
 * exchange JSON text frames on the same-origin socket. `open` is only reported after the server's
 * `ready` frame, so the status surface never claims a connection that has not finished its handshake.
 */
import type { WebsshServerFrame } from '@shared/webssh/types'
import { ApiError } from '../../../lib/api'
import { t } from '../../../lib/i18n'
import { formatEgressFailure } from '../egress-error'
import { websshApi } from '../api'
import { regionRetryTarget } from './region-retry'
import type { TerminalTransport, TerminalTransportHandlers } from './types'

export interface WebSocketTransportOptions {
  hostId: string
  cols: number
  rows: number
}

const PING_INTERVAL_MS = 30_000

function socketUrl(path: string): string {
  const url = new URL(path, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export class WebSocketTerminalTransport implements TerminalTransport {
  readonly kind = 'websocket' as const

  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private deliberate = false
  private disposed = false
  private ready = false
  private reported = false
  private sizes: { cols: number; rows: number }
  private region: string | undefined
  private currentRegion: string | undefined
  private retryFrom: string | undefined
  private regionRetryUsed = false

  constructor(
    private readonly handlers: TerminalTransportHandlers,
    private readonly options: WebSocketTransportOptions,
  ) {
    this.sizes = { cols: options.cols, rows: options.rows }
  }

  connect(options: { cols: number; rows: number }): void {
    if (this.ws) return
    this.sizes = { cols: options.cols, rows: options.rows }
    this.handlers.onPhase({ phase: 'connecting' })
    void this.open()
  }

  private async open(): Promise<void> {
    try {
      const created = await websshApi.createSession(this.options.hostId, this.sizes.cols, this.sizes.rows, {
        ...(this.region ? { region: this.region } : {}),
        ...(this.retryFrom ? { retryFromRegion: this.retryFrom } : {}),
      })
      if (this.disposed) return
      this.currentRegion = created.region
      this.retryFrom = undefined
      this.handlers.onSession?.(created.sessionId)
      const ticket = await websshApi.issueTicket(created.sessionId)
      if (this.disposed) return
      this.attach(ticket.url)
    } catch (error) {
      if (this.disposed) return
      const message = error instanceof ApiError ? error.message : 'The session could not be created'
      this.handlers.onPhase({ phase: 'error', reason: 'session_create_failed', message })
    }
  }

  private attach(url: string): void {
    const socket = new WebSocket(socketUrl(url))
    this.ws = socket

    socket.onopen = () => {
      if (this.ws !== socket) return
      if (!this.ready) this.handlers.onPhase({ phase: 'connecting' })
      this.sendFrame({ type: 'resize', cols: this.sizes.cols, rows: this.sizes.rows })
      this.pingTimer = setInterval(() => this.sendFrame({ type: 'ping' }), PING_INTERVAL_MS)
    }

    socket.onmessage = (event) => {
      if (this.ws !== socket) return
      let frame: WebsshServerFrame
      try {
        frame = JSON.parse(String(event.data)) as WebsshServerFrame
      } catch {
        this.handlers.onPhase({ phase: 'error', reason: 'bad_frame', message: 'The server sent an invalid frame' })
        return
      }
      if (frame.type === 'ready') {
        this.ready = true
        this.sizes = { cols: frame.cols, rows: frame.rows }
        this.handlers.onPhase({ phase: 'open' })
        this.sendFrame({ type: 'resize', cols: this.sizes.cols, rows: this.sizes.rows })
        return
      }
      if (frame.type === 'output') {
        this.handlers.onOutput(frame.data)
        return
      }
      if (frame.type === 'exit') {
        this.reported = true
        this.handlers.onPhase({ phase: 'closed', reason: frame.reason, message: frame.message })
        return
      }
      if (frame.type === 'error') {
        const retryRegion = regionRetryTarget(frame.egress, this.regionRetryUsed)
        if (retryRegion) {
          this.regionRetryUsed = true
          this.retryFrom = this.currentRegion
          this.region = retryRegion
          this.ready = false
          this.reported = false
          this.stopPing()
          this.ws = null
          try {
            socket.close()
          } catch {
            // The old socket is already going away; the new session is the next attempt.
          }
          this.handlers.onPhase({ phase: 'connecting' })
          this.handlers.onOutput(`\r\n\x1b[33m${t('webssh.egress.region.retry_note', { region: retryRegion })}\x1b[0m\r\n`)
          void this.open()
          return
        }
        this.reported = true
        const message = frame.egress ? formatEgressFailure(frame.egress, frame.message) : frame.message
        this.handlers.onPhase({ phase: 'error', reason: frame.code, message })
      }
    }

    socket.onerror = () => {
      if (this.ws !== socket) return
      if (!this.deliberate && !this.reported) this.handlers.onPhase({ phase: 'error', reason: 'socket_error' })
    }

    socket.onclose = (event) => {
      if (this.ws !== socket) return
      this.stopPing()
      if (this.deliberate || this.reported) return
      this.reported = true
      this.handlers.onPhase({
        phase: 'closed',
        reason: this.ready ? 'socket_closed' : 'socket_error',
        message: event.reason || undefined,
      })
    }
  }

  send(data: string): void {
    this.sendFrame({ type: 'input', data })
  }

  resize(cols: number, rows: number): void {
    this.sizes = { cols, rows }
    if (this.ready) this.sendFrame({ type: 'resize', cols, rows })
  }

  close(): void {
    this.deliberate = true
    this.stopPing()
    this.ws?.close()
    this.ws = null
  }

  dispose(): void {
    this.disposed = true
    this.close()
  }

  private sendFrame(frame: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame))
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }
}
