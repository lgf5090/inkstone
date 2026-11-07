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
import { SSHSession, type SSHSubsystemChannel } from '../ssh/session'
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
import { SFTPClient, SFTPStatusError } from '../sftp/client'
import { SFTP_STATUS } from '../sftp/types'
import { listDirectory, readFileRange, writeFileChunks, SftpOperationError } from '../sftp/operations'
import { SftpPathError, normalizeSftpPath } from '../sftp/paths'
import { WEBSSH_SFTP_MAX_FILE_BYTES, WEBSSH_SFTP_MAX_UPLOAD_PARTS } from '../sftp/limits'
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
import { WebsshSessionRecorder } from '../recording/recorder'
import { isWebsshRecordingEnabled } from '../settings'
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
  private sftpClient: SFTPClient | null = null
  private sftpChannel: SSHSubsystemChannel | null = null
  private sftpChain: Promise<unknown> = Promise.resolve()
  private recorder: WebsshSessionRecorder | null = null

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
    if (url.pathname === '/internal/sftp') {
      return this.handleSftpRequest(request, sessionId, userId)
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
      await this.startRecording(runtime.config.term)
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

  /**
   * Recording is opt-in and off unless the account's explicit setting says otherwise. With it off
   * this method only reads one settings row: no recording row, no object, no extra write.
   */
  private async startRecording(term: string): Promise<void> {
    const bucket = this.env.FILES
    if (!bucket) return
    try {
      if (!(await isWebsshRecordingEnabled(this.env.DB, this.userId))) return
      this.recorder = await WebsshSessionRecorder.start({
        db: this.env.DB,
        bucket,
        userId: this.userId,
        sessionId: this.sessionId,
        hostId: this.hostId,
        cols: this.cols,
        rows: this.rows,
        term,
      })
    } catch (error) {
      console.warn('[inkstone] WebSSH recording unavailable:', failureMessage(error))
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
    let privateKeyPassphrase: string | undefined
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
        const opened = await decryptWebsshSecret(this.env, keyId, row.passphrase_ciphertext).catch(() => null)
        if (!opened?.passphrase) {
          throw new WebsshSessionFailure('key_unreadable', 'The stored key passphrase could not be opened')
        }
        privateKeyPassphrase = opened.passphrase
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
      ...(privateKeyPassphrase ? { privateKeyPassphrase } : {}),
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

  // ---- SFTP side channel (W5) ---------------------------------------------------------------

  /**
   * The SFTP REST surface reaches this object through the Worker's binding, never through a public
   * URL. Every request re-reads the session row so a closed or foreign session answers 404/409
   * before any SSH work happens.
   */
  private async handleSftpRequest(request: Request, sessionId: string, userId: string): Promise<Response> {
    if (request.method !== 'POST') return sftpJsonError(405, 'method_not_allowed', 'SFTP operations are POST-only')
    const row = await this.env.DB.prepare(
      `SELECT status, host_id FROM webssh_sessions WHERE id = ?1 AND user_id = ?2`,
    )
      .bind(sessionId, userId)
      .first<{ status: string; host_id: string }>()
    if (!row) return sftpJsonError(404, 'not_found', 'That session does not exist')
    if (row.status !== 'active' || this.finalized) {
      return sftpJsonError(409, 'session_not_ready', 'The SSH session is not active')
    }
    this.sessionId = sessionId
    this.userId = userId
    this.hostId = row.host_id
    this.touch()

    let body: Record<string, unknown>
    try {
      const parsed: unknown = await request.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid body')
      body = parsed as Record<string, unknown>
    } catch {
      return sftpJsonError(400, 'bad_request', 'The SFTP operation body must be a JSON object')
    }
    try {
      return await this.runSftp(() => this.executeSftpOperation(body))
    } catch (error) {
      return sftpErrorResponse(error)
    }
  }

  private runSftp<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.sftpChain.then(operation, operation)
    this.sftpChain = run.catch(() => undefined)
    return run
  }

  private async executeSftpOperation(body: Record<string, unknown>): Promise<Response> {
    const op = body.op
    if (op === 'list') {
      const client = await this.ensureSftpClient()
      const path = normalizeSftpPath(body.path)
      const listing = await listDirectory(client, path)
      await this.audit('file_list', {
        hostId: this.hostId,
        metadata: { path: auditPath(listing.path), count: listing.entries.length },
      })
      return sftpJson({ path: listing.path, entries: listing.entries })
    }
    if (op === 'download') {
      const client = await this.ensureSftpClient()
      const path = normalizeSftpPath(body.path)
      const offset = body.offset === undefined ? 0 : Number(body.offset)
      const length = body.length === undefined ? undefined : Number(body.length)
      const range = await readFileRange(client, path, offset, length)
      await this.audit('file_download', {
        hostId: this.hostId,
        metadata: { path: auditPath(path), offset: range.offset, bytes: range.data.length },
      })
      return new Response(range.data, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(range.data.length),
          'x-webssh-file-size': String(range.size),
          'x-webssh-range-offset': String(range.offset),
        },
      })
    }
    if (op === 'mkdir') {
      const client = await this.ensureSftpClient()
      const path = normalizeSftpPath(body.path)
      await client.mkdir(path)
      await this.audit('dir_create', { hostId: this.hostId, metadata: { path: auditPath(path) } })
      return sftpJson({ ok: true })
    }
    if (op === 'remove') {
      const client = await this.ensureSftpClient()
      const path = normalizeSftpPath(body.path)
      const kind = body.kind === 'directory' ? 'directory' : 'file'
      if (kind === 'directory') await client.rmdir(path)
      else await client.removeFile(path)
      await this.audit('file_delete', { hostId: this.hostId, metadata: { path: auditPath(path), kind } })
      return sftpJson({ ok: true })
    }
    if (op === 'rename') {
      const client = await this.ensureSftpClient()
      const from = normalizeSftpPath(body.from)
      const to = normalizeSftpPath(body.to)
      const overwrite = body.overwrite === true
      await client.rename(from, to, overwrite)
      await this.audit('file_rename', {
        hostId: this.hostId,
        metadata: { from: auditPath(from, 512), to: auditPath(to, 512), overwrite },
      })
      return sftpJson({ ok: true })
    }
    if (op === 'upload') {
      return this.executeSftpUpload(body)
    }
    return sftpJsonError(400, 'bad_request', 'Unsupported SFTP operation')
  }

  /**
   * Writes a staged upload (R2 `webssh/documents/uploads/<user>/<transfer>/parts/...`) into the
   * remote host. The Worker has already verified chunk offsets; this object re-checks size and
   * that the transfer prefix belongs to the session's owner.
   */
  private async executeSftpUpload(body: Record<string, unknown>): Promise<Response> {
    const client = await this.ensureSftpClient()
    const path = normalizeSftpPath(body.path)
    const size = Number(body.size)
    if (!Number.isSafeInteger(size) || size < 0 || size > WEBSSH_SFTP_MAX_FILE_BYTES) {
      throw new SftpOperationError('file_too_large', 'The upload size is invalid or exceeds 2 GiB')
    }
    const transferId = body.transferId
    if (typeof transferId !== 'string' || !isValidId(transferId)) {
      throw new SftpOperationError('bad_request', 'Invalid upload transfer id')
    }
    const r2 = this.env.FILES
    if (!r2) throw new SftpOperationError('storage_unavailable', 'R2 staging is not bound')
    const prefix = `webssh/documents/uploads/${this.userId}/${transferId}/`
    const parts: R2Object[] = []
    let cursor: string | undefined
    do {
      const listed = await r2.list({ prefix: `${prefix}parts/`, cursor })
      parts.push(...listed.objects)
      if (parts.length > WEBSSH_SFTP_MAX_UPLOAD_PARTS) {
        throw new SftpOperationError('too_many_entries', 'The staged upload has too many parts')
      }
      cursor = listed.truncated ? listed.cursor : undefined
    } while (cursor)
    parts.sort((left, right) => left.key.localeCompare(right.key))
    if (parts.length === 0 && size > 0) throw new SftpOperationError('size_mismatch', 'The staged upload has no parts')

    async function* readParts(): AsyncGenerator<Uint8Array> {
      for (const part of parts) {
        const object = await r2!.get(part.key)
        if (!object) throw new SftpOperationError('size_mismatch', 'A staged upload part disappeared')
        const reader = object.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value.length > 0) yield value
          }
        } finally {
          reader.releaseLock()
        }
      }
    }

    await writeFileChunks(client, path, size, readParts())
    await this.audit('file_upload', {
      hostId: this.hostId,
      metadata: { path: auditPath(path), bytes: size, transferId, parts: parts.length },
    })
    return sftpJson({ ok: true })
  }

  private async ensureSftpClient(): Promise<SFTPClient> {
    if (this.sftpClient) return this.sftpClient
    const session = this.session
    if (!session) throw new SftpOperationError('session_not_ready', 'The SSH session is not connected')
    let client: SFTPClient | null = null
    const buffered: Uint8Array[] = []
    const channel = await session.openSubsystem('sftp', {
      onData: (data) => {
        if (!client) {
          buffered.push(data)
          return
        }
        try {
          client.feed(data)
        } catch (error) {
          this.disposeSftp(error instanceof Error ? error : new Error(String(error)))
        }
      },
      onEof: () => this.disposeSftp(new Error('The SFTP subsystem ended')),
      onClose: () => this.disposeSftp(new Error('The SFTP subsystem channel closed')),
    })
    client = new SFTPClient((packet) => channel.write(packet), { requestTimeoutMs: 30_000 })
    this.sftpClient = client
    this.sftpChannel = channel
    const initialized = client.initialize()
    for (const chunk of buffered) client.feed(chunk)
    try {
      await initialized
    } catch (error) {
      this.disposeSftp(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    return client
  }

  private disposeSftp(reason: Error): void {
    const client = this.sftpClient
    const channel = this.sftpChannel
    this.sftpClient = null
    this.sftpChannel = null
    client?.dispose(reason)
    if (channel) void channel.close().catch(() => undefined)
  }

  private onOutput(data: Uint8Array): void {
    this.bytesOut += data.length
    this.recorder?.tapOutput(data)
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
    this.disposeSftp(new Error('The WebSSH session ended'))
    const now = Date.now()
    // Finish the recording before the runtime can be evicted; its own status row is authoritative.
    const recorder = this.recorder
    this.recorder = null
    if (recorder) {
      this.ctx.waitUntil(
        recorder.finish(now).catch((error) => {
          console.warn('[inkstone] WebSSH recording finish failed:', failureMessage(error))
        }),
      )
    }
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
      this.recorder?.resize(size.cols, size.rows)
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

/** Audit metadata is capped at 2 KiB, so long remote paths are shortened before they are stored. */
function auditPath(value: string, limit = 1024): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`
}

function sftpJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sftpJsonError(status: number, code: string, message: string): Response {
  return sftpJson({ error: { code, message } }, status)
}

/** Maps SFTP protocol/validation failures onto the REST status codes the Worker route forwards. */
function sftpErrorResponse(error: unknown): Response {
  if (error instanceof SftpPathError) {
    return sftpJsonError(400, error.code, error.message)
  }
  if (error instanceof SftpOperationError) {
    const status = error.code === 'file_too_large' || error.code === 'block_too_large' || error.code === 'too_many_entries'
      ? 413
      : error.code === 'session_not_ready' || error.code === 'size_mismatch' || error.code === 'is_directory'
        ? 409
        : error.code === 'storage_unavailable'
          ? 503
          : 400
    return sftpJsonError(status, error.code, error.message)
  }
  if (error instanceof SFTPStatusError) {
    const status = error.code === SFTP_STATUS.NO_SUCH_FILE
      ? 404
      : error.code === SFTP_STATUS.PERMISSION_DENIED
        ? 403
        : 409
    const code = status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'sftp_error'
    return sftpJsonError(status, code, error.description || error.message)
  }
  if (error instanceof SSHSessionError) {
    return sftpJsonError(409, error.code, error.message)
  }
  const message = failureMessage(error)
  return sftpJsonError(502, 'sftp_error', message)
}
