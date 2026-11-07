// The per-session Durable Object: one SSH terminal, one WebSocket, one state row.
//
// The Worker route has already authenticated the owner and consumed the one-time ticket. This object
// re-reads the session row, refuses anything that is not pending, attaches the browser socket, and only
// then resolves/opens the SSH connection. Frames are the frozen W4 text protocol; terminal bytes are
// never interpreted here.

import type { WebsshServerFrame, WebsshSessionStatus } from '@shared/webssh/types'
import type { Env } from '../../env'
import { decryptWebsshSecret } from '../../lib/crypto'
import { isValidId } from '../../lib/id'
import { SSHSession } from '../ssh/session'
import { SSHSessionError } from '../ssh/errors'
import type {
  SSHConnectionConfig,
  SSHHostKeyInfo,
  SSHReadyInfo,
  SSHSessionSink,
  SSHTransportSocket,
  TerminalSize,
} from '../ssh/types'
import { normalizeTerminalSize } from '../ssh/types'
import {
  openSshSocket,
  readDevAllowPrivateHosts,
  resolveSshTarget,
  WebsshConnectionError,
  type SshTarget,
} from '../connection'
import {
  WEBSSH_ACTIVITY_PERSIST_MS,
  WEBSSH_IDLE_TIMEOUT_MS,
  WEBSSH_MAX_FRAME_BYTES,
  WEBSSH_MAX_INITIAL_COMMAND_LENGTH,
  WEBSSH_PRE_READY_OUTPUT_LIMIT,
} from '../constants'
import { recordAudit } from '../audit'
import {
  hostKeyDecision,
  markHostConnected,
  recordHostKeySighting,
  trustedFingerprint,
} from './host-key'

/** A failure that belongs to this runtime rather than to the SSH protocol core. */
class WebsshSessionFailure extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WebsshSessionFailure'
  }
}

interface HostRow {
  id: string
  host: string
  port: number
  username: string
  auth_method: string
  credential_id: string
  key_id: string
  encoding: string
  term_type: string
  initial_command: string
}

interface RuntimeConfig {
  config: SSHConnectionConfig
  initialCommand: string
  credentialId: string
  keyId: string
}

const HANDSHAKE_TIMEOUT_MS = 20_000
const TERM_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/

function failureCode(error: unknown): string {
  if (error instanceof SSHSessionError) return error.code
  if (error instanceof WebsshConnectionError) return error.code
  if (error instanceof WebsshSessionFailure) return error.code
  return 'internal'
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class WebsshSession implements DurableObject {
  private readonly ctx: DurableObjectState
  private readonly env: Env

  private ws: WebSocket | null = null
  private session: SSHSession | null = null
  private sessionId = ''
  private userId = ''
  private hostId = ''

  private cols = 120
  private rows = 40
  private pendingResize: TerminalSize | null = null
  private readySent = false
  private preReadyOutput: Uint8Array[] = []
  private preReadyBytes = 0
  private readonly outputDecoder = new TextDecoder()

  private bytesIn = 0
  private bytesOut = 0
  private exitInfo: { exitCode: number | null; signal: string | null } | null = null
  private lastPersistedAt = 0
  private idleArmedAt = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  private finalized = false
  private initialCommand = ''
  private credentialId = ''
  private keyId = ''

  constructor(state: DurableObjectState, env: Env) {
    this.ctx = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('s') ?? ''
    const userId = url.searchParams.get('u') ?? ''
    if (!isValidId(sessionId) || !isValidId(userId)) {
      return new Response('Invalid WebSSH session request', { status: 400 })
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('This session runtime accepts only WebSocket upgrades', { status: 426 })
    }

    let attached = false
    let status = 409
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.ws) return
      const row = await this.env.DB.prepare(
        `SELECT status, host_id FROM webssh_sessions WHERE id = ?1 AND user_id = ?2`,
      )
        .bind(sessionId, userId)
        .first<{ status: string; host_id: string }>()
      if (!row) {
        status = 404
        return
      }
      const now = Date.now()
      const claimed = await this.env.DB.prepare(
        `UPDATE webssh_sessions
            SET status = 'connecting', last_activity_at = ?3
          WHERE id = ?1 AND user_id = ?2 AND status = 'pending' AND ended_at IS NULL
          RETURNING id`,
      )
        .bind(sessionId, userId, now)
        .first<{ id: string }>()
      if (!claimed) {
        status = 409
        return
      }
      this.sessionId = sessionId
      this.userId = userId
      this.hostId = row.host_id
      this.lastPersistedAt = now
      attached = true
    })
    if (!attached) {
      return new Response(status === 404 ? 'That WebSSH session does not exist' : 'That WebSSH session is already attached', { status })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()
    this.ws = server
    server.addEventListener('message', (event) => this.onMessage(event))
    server.addEventListener('close', () => { this.onSocketClosed('client_closed') })
    server.addEventListener('error', () => { this.onSocketClosed('socket_error', 'WebSocket error') })
    this.touch()
    this.armIdle()
    this.ctx.waitUntil(this.runConnection())
    return new Response(null, { status: 101, webSocket: client })
  }

  private async runConnection(): Promise<void> {
    try {
      const runtime = await this.loadRuntimeConfig()
      const allowPrivate = readDevAllowPrivateHosts(this.env.WEBSSH_DEV_ALLOW_PRIVATE_HOSTS)
      let target: SshTarget
      try {
        target = await resolveSshTarget(runtime.config.host, runtime.config.port, {
          allowPrivateHosts: allowPrivate,
          dohUrl: this.env.WEBSSH_DOH_URL,
        })
      } catch (error) {
        await this.audit('connect_blocked', {
          hostId: this.hostId,
          metadata: { code: failureCode(error), message: failureMessage(error) },
        })
        throw error
      }
      await this.audit('connect', {
        hostId: this.hostId,
        metadata: {
          port: runtime.config.port,
          address: target.address,
          family: target.family,
          devOverride: target.devOverride,
        },
      })
      const socket = await openSshSocket(target)
      const session = new SSHSession(socket as SSHTransportSocket, runtime.config, this.createSink())
      this.session = session
      this.initialCommand = runtime.initialCommand
      this.credentialId = runtime.credentialId
      this.keyId = runtime.keyId
      await session.start()
    } catch (error) {
      this.fail(error)
    }
  }

  private async loadRuntimeConfig(): Promise<RuntimeConfig> {
    const host = await this.env.DB.prepare(
      `SELECT id, host, port, username, auth_method, credential_id, key_id, encoding, term_type, initial_command
         FROM webssh_hosts
        WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
    )
      .bind(this.userId, this.hostId)
      .first<HostRow>()
    if (!host) throw new WebsshSessionFailure('host_unavailable', 'The host behind this session no longer exists')
    if (host.encoding !== 'utf-8') {
      throw new WebsshSessionFailure('unsupported_encoding', 'Only UTF-8 terminals are supported in this batch')
    }
    if (host.auth_method !== 'password' && host.auth_method !== 'publickey') {
      throw new WebsshSessionFailure('invalid_auth_method', 'The host names an unsupported authentication method')
    }

    let password: string | undefined
    let privateKey: string | undefined
    let credentialId = ''
    let keyId = ''
    if (host.auth_method === 'password') {
      if (!isValidId(host.credential_id)) throw new WebsshSessionFailure('credential_missing', 'The host has no password credential')
      credentialId = host.credential_id
      const row = await this.env.DB.prepare(
        `SELECT password_ciphertext FROM webssh_credentials
          WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
      )
        .bind(this.userId, credentialId)
        .first<{ password_ciphertext: string }>()
      if (!row) throw new WebsshSessionFailure('credential_missing', 'The host password credential no longer exists')
      const secret = await decryptWebsshSecret(this.env, credentialId, row.password_ciphertext).catch(() => null)
      if (!secret?.password) throw new WebsshSessionFailure('credential_unreadable', 'The stored host password could not be opened')
      password = secret.password
    } else {
      if (!isValidId(host.key_id)) throw new WebsshSessionFailure('key_missing', 'The host has no private key')
      keyId = host.key_id
      const row = await this.env.DB.prepare(
        `SELECT private_key_ciphertext, passphrase_ciphertext FROM webssh_keys
          WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
      )
        .bind(this.userId, keyId)
        .first<{ private_key_ciphertext: string; passphrase_ciphertext: string }>()
      if (!row) throw new WebsshSessionFailure('key_missing', 'The host private key no longer exists')
      const secret = await decryptWebsshSecret(this.env, keyId, row.private_key_ciphertext).catch(() => null)
      if (!secret?.privateKey) throw new WebsshSessionFailure('key_unreadable', 'The stored private key could not be opened')
      if (row.passphrase_ciphertext) {
        // W1's container parser rejects encrypted keys until the W3 parser merge; say so explicitly
        // instead of letting the handshake fail with an opaque protocol error.
        throw new WebsshSessionFailure(
          'unsupported_encrypted_key',
          'Encrypted private keys cannot be used until the W3 key parser is merged',
        )
      }
      privateKey = secret.privateKey
    }

    const expectedFingerprint = await trustedFingerprint(this.env.DB, this.userId, this.hostId)
    const term = TERM_PATTERN.test(host.term_type) ? host.term_type : 'xterm-256color'
    const config: SSHConnectionConfig = {
      host: host.host,
      port: host.port,
      username: host.username,
      authMethod: host.auth_method,
      ...(password ? { password } : {}),
      ...(privateKey ? { privateKey } : {}),
      cols: this.cols,
      rows: this.rows,
      term,
      ...(expectedFingerprint ? { expectedFingerprint } : {}),
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    }
    return { config, initialCommand: host.initial_command, credentialId, keyId }
  }

  private createSink(): SSHSessionSink {
    return {
      status: () => this.touch(),
      output: (data) => this.onOutput(data),
      hostKey: (info) => this.onHostKey(info),
      ready: (info) => { void this.onReady(info).catch((error) => this.fail(error)) },
      exit: (info) => {
        this.exitInfo = info
      },
      closed: (reason, error) => {
        void this.onClosed(reason, error).catch((failure) => {
          console.warn('[inkstone] WebSSH close handler failed:', failureMessage(failure))
        })
      },
    }
  }

  private async onHostKey(info: SSHHostKeyInfo): Promise<boolean> {
    await this.audit(info.trust === 'changed' ? 'host_key_changed' : 'host_key_new', {
      hostId: this.hostId,
      metadata: { algorithm: info.keyType, fingerprint: info.fingerprint, trust: info.trust },
    })
    try {
      await recordHostKeySighting(this.env.DB, this.userId, this.hostId, info.keyType, info.fingerprint)
      const decision = await hostKeyDecision(this.env.DB, this.userId, this.hostId, info.keyType, info.fingerprint)
      // This runtime never grants trust on its own: the user's explicit trust action (W3's
      // fingerprint route) is what turns a first-seen or changed key into an allowed one.
      if (decision.state === 'revoked') {
        await this.audit('host_key_changed', {
          hostId: this.hostId,
          metadata: { algorithm: info.keyType, fingerprint: info.fingerprint, state: decision.state },
        })
      }
      return false
    } catch (error) {
      console.warn('[inkstone] WebSSH host key record failed:', failureMessage(error))
      return false
    }
  }

  private async onReady(info: SSHReadyInfo): Promise<void> {
    if (this.finalized) return
    const now = Date.now()
    this.touch(false, now)
    await this.env.DB.prepare(
      `UPDATE webssh_sessions
          SET status = 'active', connected_at = COALESCE(connected_at, ?3), last_activity_at = ?3
        WHERE id = ?1 AND user_id = ?2 AND ended_at IS NULL`,
    )
      .bind(this.sessionId, this.userId, now)
      .run()
    await recordHostKeySighting(
      this.env.DB,
      this.userId,
      this.hostId,
      info.hostKeyType,
      info.hostKeyFingerprint,
      now,
    ).catch((error) => console.warn('[inkstone] WebSSH host key sighting failed:', failureMessage(error)))
    await markHostConnected(this.env.DB, this.userId, this.hostId, now)
      .catch((error) => console.warn('[inkstone] WebSSH host connected marker failed:', failureMessage(error)))
    await this.markCredentialUsed(now)
    await this.audit('session_ready', {
      hostId: this.hostId,
      metadata: {
        kex: info.kex,
        cipherC2S: info.cipherC2S,
        cipherS2C: info.cipherS2C,
        hostKeyType: info.hostKeyType,
        fingerprint: info.hostKeyFingerprint,
      },
    })

    if (this.ws) {
      this.sendFrame({ type: 'ready', cols: this.cols, rows: this.rows })
      this.readySent = true
      for (const chunk of this.preReadyOutput) this.writeOutput(chunk)
      this.preReadyOutput = []
      this.preReadyBytes = 0
      if (this.pendingResize) {
        const size = this.pendingResize
        this.pendingResize = null
        void this.session?.resize(size.cols, size.rows).catch(() => undefined)
      }
      if (this.initialCommand && this.initialCommand.length <= WEBSSH_MAX_INITIAL_COMMAND_LENGTH) {
        const command = this.initialCommand.endsWith('\n') ? this.initialCommand : `${this.initialCommand}\r`
        this.writeInput(command)
      }
    }
  }

  private async markCredentialUsed(now: number): Promise<void> {
    if (this.credentialId) {
      await this.env.DB.prepare(
        `UPDATE webssh_credentials SET last_used_at = ?3
          WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
      )
        .bind(this.userId, this.credentialId, now)
        .run()
        .catch(() => undefined)
    }
    if (this.keyId) {
      await this.env.DB.prepare(
        `UPDATE webssh_keys SET last_used_at = ?3
          WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
      )
        .bind(this.userId, this.keyId, now)
        .run()
        .catch(() => undefined)
    }
  }

  private onOutput(data: Uint8Array): void {
    this.bytesOut += data.length
    this.touch()
    if (this.readySent) {
      this.writeOutput(data)
      return
    }
    if (this.preReadyBytes + data.length > WEBSSH_PRE_READY_OUTPUT_LIMIT) {
      this.fail(new WebsshSessionFailure('protocol_error', 'Terminal output arrived before the shell was ready'))
      return
    }
    this.preReadyOutput.push(data)
    this.preReadyBytes += data.length
  }

  private writeOutput(data: Uint8Array): void {
    const text = this.outputDecoder.decode(data, { stream: true })
    if (text) this.sendFrame({ type: 'output', data: text })
  }

  private writeInput(text: string): void {
    if (!text) return
    try {
      this.session?.write(new TextEncoder().encode(text))
      this.bytesIn += new TextEncoder().encode(text).length
    } catch (error) {
      this.sendFrame({ type: 'error', code: failureCode(error), message: failureMessage(error) })
    }
  }

  private async onClosed(reason: string, error?: Error): Promise<void> {
    if (this.finalized) return
    const tail = this.outputDecoder.decode()
    if (tail && this.readySent) this.sendFrame({ type: 'output', data: tail })

    if (error) {
      const code = failureCode(error)
      this.sendFrame({ type: 'error', code, message: failureMessage(error) })
      await this.audit(code === 'auth_failed' ? 'auth_fail' : 'session_error', {
        hostId: this.hostId,
        metadata: { code, message: failureMessage(error) },
      })
      this.finalize('error', 'error', code, failureMessage(error), 1011)
      return
    }

    const exitReason = 'eof'
    this.sendFrame({
      type: 'exit',
      reason: exitReason,
      ...(this.exitInfo ? { exitCode: this.exitInfo.exitCode, signal: this.exitInfo.signal } : {}),
    })
    await this.audit('disconnect', {
      hostId: this.hostId,
      metadata: { reason, exitCode: this.exitInfo?.exitCode ?? null, bytesIn: this.bytesIn, bytesOut: this.bytesOut },
    })
    this.finalize('closed', reason, '', undefined, 1000)
  }

  private fail(error: unknown): void {
    if (this.finalized) return
    const code = failureCode(error)
    const message = failureMessage(error)
    this.sendFrame({ type: 'error', code, message })
    void this.audit(code === 'auth_failed' ? 'auth_fail' : 'session_error', {
      hostId: this.hostId,
      metadata: { code, message },
    })
    this.finalize('error', 'error', code, message, 1011)
  }

  private finalize(
    status: WebsshSessionStatus,
    closeReason: string,
    errorCode: string,
    errorMessage: string | undefined,
    closeCode: number,
  ): void {
    if (this.finalized) return
    this.finalized = true
    this.clearTimers()
    const now = Date.now()
    const session = this.session
    this.session = null
    try {
      session?.close()
    } catch {
      // The SSH core is idempotent; a second close is a no-op.
    }
    this.ctx.waitUntil(
      this.env.DB.prepare(
        `UPDATE webssh_sessions
            SET status = ?3, ended_at = ?4, last_activity_at = ?4, bytes_in = ?5, bytes_out = ?6,
                close_reason = ?7, error_code = ?8
          WHERE id = ?1 AND user_id = ?2 AND ended_at IS NULL`,
      )
        .bind(this.sessionId, this.userId, status, now, this.bytesIn, this.bytesOut, closeReason, errorCode)
        .run()
        .then(() => {
          if (errorMessage) console.warn('[inkstone] WebSSH session ended:', errorCode, errorMessage)
        })
        .catch((error) => console.warn('[inkstone] WebSSH session finalize failed:', failureMessage(error))),
    )
    try {
      this.ws?.close(closeCode, closeReason)
    } catch {
      // The browser may already be gone; the finalize row above is the authoritative end state.
    }
    this.ws = null
  }

  private onSocketClosed(reason: string, errorCode = ''): void {
    if (this.finalized) return
    const session = this.session
    this.session = null
    try {
      session?.close()
    } catch {
      // Same idempotent close as finalize.
    }
    if (errorCode) {
      this.finalize('error', reason, errorCode, undefined, 1011)
      return
    }
    this.finalize('closed', reason, '', undefined, 1000)
  }

  private onMessage(event: MessageEvent): void {
    if (this.finalized) return
    const data: unknown = event.data
    if (typeof data !== 'string') {
      this.sendFrame({ type: 'error', code: 'bad_request', message: 'Binary frames are not supported' })
      this.finalize('error', 'frame_rejected', 'bad_request', undefined, 1003)
      return
    }
    if (new TextEncoder().encode(data).byteLength > WEBSSH_MAX_FRAME_BYTES) {
      this.sendFrame({ type: 'error', code: 'payload_too_large', message: 'The frame exceeds 64 KiB' })
      this.finalize('error', 'frame_rejected', 'payload_too_large', undefined, 1009)
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      this.sendFrame({ type: 'error', code: 'bad_request', message: 'Invalid JSON frame' })
      this.finalize('error', 'frame_rejected', 'bad_request', undefined, 1008)
      return
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof (frame as { type?: unknown }).type !== 'string') {
      this.sendFrame({ type: 'error', code: 'bad_request', message: 'Invalid frame' })
      return
    }
    this.touch()
    const run = this.queue.then(() => this.handleFrame(frame as Record<string, unknown>))
    this.queue = run.catch((error) => {
      this.sendFrame({ type: 'error', code: failureCode(error), message: failureMessage(error) })
    })
    void run
  }

  private async handleFrame(frame: Record<string, unknown>): Promise<void> {
    if (this.finalized) return
    if (frame.type === 'ping') {
      this.sendFrame({ type: 'pong' })
      return
    }
    if (frame.type === 'resize') {
      const size = normalizeTerminalSize(frame.cols, frame.rows)
      if (!size) {
        this.sendFrame({ type: 'error', code: 'bad_request', message: 'Invalid terminal size' })
        return
      }
      this.cols = size.cols
      this.rows = size.rows
      if (!this.readySent) {
        this.pendingResize = size
        return
      }
      try {
        await this.session?.resize(size.cols, size.rows)
      } catch (error) {
        this.sendFrame({ type: 'error', code: failureCode(error), message: failureMessage(error) })
      }
      return
    }
    if (frame.type === 'input') {
      if (typeof frame.data !== 'string') {
        this.sendFrame({ type: 'error', code: 'bad_request', message: 'Terminal input must be a string' })
        return
      }
      if (!this.readySent) {
        this.sendFrame({ type: 'error', code: 'input_rejected', message: 'The shell is not ready yet' })
        return
      }
      const bytes = new TextEncoder().encode(frame.data)
      if (bytes.byteLength > WEBSSH_MAX_FRAME_BYTES) {
        this.sendFrame({ type: 'error', code: 'payload_too_large', message: 'Input exceeds 64 KiB' })
        return
      }
      try {
        this.session?.write(bytes)
        this.bytesIn += bytes.byteLength
      } catch (error) {
        this.sendFrame({ type: 'error', code: failureCode(error), message: failureMessage(error) })
      }
      return
    }
    this.sendFrame({ type: 'error', code: 'bad_request', message: 'Unsupported frame type' })
  }

  private sendFrame(frame: WebsshServerFrame): void {
    const ws = this.ws
    if (!ws) return
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      this.onSocketClosed('send_failed', 'socket_error')
    }
  }

  private touch(persist = false, now = Date.now()): number {
    if (now - this.idleArmedAt >= 1_000) {
      this.idleArmedAt = now
      this.armIdle()
    }
    if (persist || now - this.lastPersistedAt >= WEBSSH_ACTIVITY_PERSIST_MS) {
      this.lastPersistedAt = now
      this.ctx.waitUntil(
        this.env.DB.prepare(
          `UPDATE webssh_sessions SET last_activity_at = ?3
            WHERE id = ?1 AND user_id = ?2 AND ended_at IS NULL`,
        )
          .bind(this.sessionId, this.userId, now)
          .run()
          .catch((error) => console.warn('[inkstone] WebSSH activity write failed:', failureMessage(error))),
      )
    }
    return now
  }

  private armIdle(): void {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      if (this.finalized) return
      this.sendFrame({ type: 'exit', reason: 'idle', message: 'The session was idle for twenty minutes' })
      this.finalize('closed', 'idle', 'idle_timeout', 'idle timeout', 1000)
    }, WEBSSH_IDLE_TIMEOUT_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private clearTimers(): void {
    this.clearIdle()
  }

  private async audit(
    eventType: Parameters<typeof recordAudit>[1]['eventType'],
    input: { hostId?: string; metadata?: Record<string, string | number | boolean | null> },
  ): Promise<void> {
    await recordAudit(this.env.DB, {
      userId: this.userId,
      sessionId: this.sessionId,
      hostId: input.hostId,
      eventType,
      metadata: input.metadata,
    }).catch((error) => console.warn('[inkstone] WebSSH audit write failed:', failureMessage(error)))
  }
}
