// Derived from EdgeSSH 2026-11 snapshot (Apache-2.0) src/backend/session.ts, with Inkstone adaptations.
// W1 scope: version exchange, KEX, host-key trust, authentication, PTY/shell and flow control.
// The WebSocket, Durable Object, SFTP, process monitor and port forwarding of the source project
// deliberately stay out of this module; W2 wraps this protocol core in a Durable Object.

import {
  SSH_MSG_CHANNEL_CLOSE,
  SSH_MSG_CHANNEL_DATA,
  SSH_MSG_CHANNEL_EOF,
  SSH_MSG_CHANNEL_EXTENDED_DATA,
  SSH_MSG_CHANNEL_FAILURE,
  SSH_MSG_CHANNEL_OPEN_CONFIRMATION,
  SSH_MSG_CHANNEL_OPEN_FAILURE,
  SSH_MSG_CHANNEL_REQUEST,
  SSH_MSG_CHANNEL_SUCCESS,
  SSH_MSG_CHANNEL_WINDOW_ADJUST,
  SSH_MSG_DEBUG,
  SSH_MSG_DISCONNECT,
  SSH_MSG_EXT_INFO,
  SSH_MSG_GLOBAL_REQUEST,
  SSH_MSG_IGNORE,
  SSH_MSG_KEXINIT,
  SSH_MSG_KEX_ECDH_REPLY,
  SSH_MSG_NEWKEYS,
  SSH_MSG_REQUEST_FAILURE,
  SSH_MSG_REQUEST_SUCCESS,
  SSH_MSG_SERVICE_ACCEPT,
  SSH_MSG_SERVICE_REQUEST,
  SSH_MSG_UNIMPLEMENTED,
  SSH_MSG_USERAUTH_FAILURE,
  SSH_MSG_USERAUTH_INFO_REQUEST,
  SSH_MSG_USERAUTH_SUCCESS,
  type SSHConnectionConfig,
  type SSHPacket,
  type SSHSessionSink,
  type SSHTransportSocket,
  type SessionKeys,
  normalizeConnectionConfig,
} from './types'
import { isSSH2Identification, SSHTransport } from './transport'
import { SSHPacketBuilder, SSHPacketParser, nextSequenceNumber } from './packet'
import { KEXInitBuilder, filterExtInfo, negotiate, parseKEXInit, parseServerSigAlgs } from './kex'
import { KEX_ALGORITHM_ECDH_NISTP256, getCipherSpec, getMacSpec, isCurve25519KEXAlgorithm } from './algorithms'
import { ECDHKeyExchange } from './kex-ecdh'
import { Curve25519KeyExchange, type Curve25519KeyPair } from './kex-curve25519'
import { KeyDerivation } from './keys'
import { SSHAESCTRCipher, SSHAESGCMCipher, SSHHMAC } from './crypto'
import { SSHAuth } from './auth'
import { SSHChannel, type ChannelDataChunk } from './channel'
import { classifyHostKey } from './host-key'
import { encodeString, readUint32, toBufferSource } from './utils'
import { SSHSessionError } from './errors'
import { WEBSSH_MAX_QUEUED_INPUT_BYTES } from '../constants'

type Cipher = SSHAESGCMCipher | SSHAESCTRCipher
type Phase = 'version' | 'kex' | 'host-confirm' | 'auth' | 'pty' | 'shell' | 'ready' | 'closed'

const LOCAL_WINDOW_THRESHOLD = 512 * 1024
const MAX_VERSION_BYTES = 8192
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000
const HOST_CONFIRM_TIMEOUT_MS = 30_000
const KEEPALIVE_INTERVAL_MS = 25_000
const MAX_KEEPALIVE_PENDING = 3
const SHELL_READY_FALLBACK_MS = 3_000
const SUBSYSTEM_OPEN_TIMEOUT_MS = 30_000
const KEEPALIVE_NAME = new TextEncoder().encode('keepalive@openssh.com')

/** Handlers a subsystem consumer (currently SFTP) receives from the channel table. */
export interface SSHSubsystemHandlers {
  onData(data: Uint8Array): void
  onEof?(): void
  onClose?(): void
}

/** The handle returned by `openSubsystem`: one local channel with its own queue and window. */
export interface SSHSubsystemChannel {
  readonly localId: number
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
}

/** Handlers a one-shot exec consumer receives. stderr arrives through `onExtendedData`. */
export interface SSHExecHandlers {
  onData(data: Uint8Array): void
  onExtendedData?(data: Uint8Array): void
  onExit?(exitCode: number | null, signal: string | null): void
  onEof?(): void
  onClose?(): void
}

/** The handle returned by `openExec`; no input is written, only the channel can be closed early. */
export interface SSHExecChannel {
  readonly localId: number
  close(): Promise<void>
}

interface AuxHandlers {
  onData(data: Uint8Array): void
  onExtendedData?(data: Uint8Array): void
  onExit?(exitCode: number | null, signal: string | null): void
  onEof?(): void
  onClose?(): void
}

export type SSHDirectTCPIPHandlers = SSHSubsystemHandlers
export type SSHDirectTCPIPChannel = SSHSubsystemChannel

interface ShellEntry {
  kind: 'shell'
  channel: SSHChannel
}

interface AuxiliaryEntry {
  kind: 'subsystem' | 'exec' | 'tcpip'
  localId: number
  /** Empty for exec channels. */
  name: string
  /** Empty for subsystem channels. */
  command: string
  channel: SSHChannel
  handlers: AuxHandlers
  stage: 'opening' | 'requesting' | 'ready' | 'closed'
  openResolve: (() => void) | null
  openReject: ((error: Error) => void) | null
  timer: ReturnType<typeof setTimeout> | null
  queue: Uint8Array[]
  headOffset: number
  flushing: boolean
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>
  exitCode: number | null
  exitSignal: string | null
}

type ChannelEntry = ShellEntry | AuxiliaryEntry

/**
 * A single SSH terminal session over an already-connected TCP socket. `start()` returns once the
 * identification line is queued; the rest of the handshake advances through `sink` callbacks.
 */
export class SSHSession {
  private readonly decoder = new TextDecoder()
  private readonly transport = new SSHTransport()
  private readonly parser = new SSHPacketParser()
  private readonly shellChannel = new SSHChannel()
  /** Local channel id → channel state. Id 0 is the shell; subsystems (SFTP) start at 1. */
  private readonly channels = new Map<number, ChannelEntry>()
  private nextSubsystemChannelId = 1
  private readonly config: SSHConnectionConfig
  private readonly socket: SSHTransportSocket
  private readonly sink: SSHSessionSink

  private phase: Phase = 'version'
  private versionBuffer = new Uint8Array()
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private sendSequence = 0
  private sendChain: Promise<void> = Promise.resolve()
  private localKex: Uint8Array | null = null
  private remoteKex: Uint8Array | null = null
  private kexName: string | null = null
  private hostKeyAlgorithm: string | null = null
  private hostKeyFingerprint = ''
  private hostKeyType = ''
  private ecdhPair: CryptoKeyPair | null = null
  private curvePair: Curve25519KeyPair | null = null
  private clientPublic: Uint8Array | null = null
  private sessionId: Uint8Array | null = null
  private keys: SessionKeys | null = null
  private cipherC2S = 'aes128-gcm@openssh.com'
  private cipherS2C = 'aes128-gcm@openssh.com'
  private macC2S = 'none'
  private macS2C = 'none'
  private encryptor: Cipher | null = null
  private decryptor: Cipher | null = null
  private signer: SSHHMAC | null = null
  private verifier: SSHHMAC | null = null
  private serverSigAlgs: string[] = []
  private authRequestSent = false
  private passwordAuthMethod: 'password' | 'keyboard-interactive' = 'password'
  private keyboardInteractiveRounds = 0
  private keyboardInteractivePasswordSent = false
  private pendingChannelRequest: 'pty' | 'shell' | null = null
  private inputQueue: Uint8Array[] = []
  private queueHeadOffset = 0
  private queuedBytes = 0
  private flushingInput = false
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private keepalivePending = 0
  private ignoreNextKexPacket = false
  private shellTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private exitCode: number | null = null
  private exitSignal: string | null = null
  private readTask: Promise<void> | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private closedReported = false

  constructor(socket: SSHTransportSocket, config: SSHConnectionConfig, sink: SSHSessionSink) {
    this.socket = socket
    this.config = normalizeConnectionConfig(config)
    this.sink = sink
  }

  async start(): Promise<void> {
    this.handshakeTimer = setTimeout(() => {
      this.fail(new SSHSessionError('connection_timeout', 'The SSH handshake did not complete in time'))
    }, this.config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS)
    this.sink.status('version_exchange', 'Exchanging SSH protocol versions')
    try {
      await this.writePacket(this.transport.getLocalIdentification())
    } catch (error) {
      this.fail(error)
      return
    }
    this.readTask = this.readLoop()
  }

  /** Queue terminal input; the caller may burst faster than the remote window allows. */
  write(data: Uint8Array): void {
    if (this.phase !== 'ready') throw new SSHSessionError('input_rejected', 'Terminal is not ready')
    if (data.length === 0) return
    if (this.queuedBytes + data.length > WEBSSH_MAX_QUEUED_INPUT_BYTES) {
      throw new SSHSessionError('input_limit', 'Terminal input queue limit exceeded')
    }
    this.inputQueue.push(data)
    this.queuedBytes += data.length
    void this.flushInput().catch((error) => this.fail(error))
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 1000 || rows < 5 || rows > 1000) {
      throw new SSHSessionError('protocol_error', 'Invalid terminal size')
    }
    if (this.phase === 'ready') await this.sendEncrypted(this.shellChannel.buildWindowChange(cols, rows))
  }

  /**
   * Opens an RFC 4254 `session` channel and requests a subsystem on it (W5 uses `sftp`). The
   * returned handle owns its own send queue and remote window; the shell channel keeps behaving
   * exactly as it did before the channel table existed.
   */
  async openSubsystem(name: string, handlers: SSHSubsystemHandlers): Promise<SSHSubsystemChannel> {
    if (!/^[A-Za-z0-9@._+-]{1,64}$/.test(name)) throw new SSHSessionError('channel_rejected', 'Invalid SSH subsystem name')
    return this.openAuxiliaryChannel('subsystem', name, handlers, (channel, localId) => channel.buildOpenSession(localId))
  }

  async openForward(host: string, port: number, handlers: SSHDirectTCPIPHandlers): Promise<SSHDirectTCPIPChannel> {
    if (typeof host !== 'string' || host.length === 0 || host.length > 255 || /[\0\r\n]/.test(host)) {
      throw new SSHSessionError('channel_rejected', 'Invalid forward target host')
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SSHSessionError('channel_rejected', 'Invalid forward target port')
    }
    return this.openAuxiliaryChannel('tcpip', `${host}:${port}`, handlers, (channel, localId) => channel.buildOpenDirectTCPIP(localId, host, port))
  }

  private async openAuxiliaryChannel(
    kind: 'subsystem' | 'exec' | 'tcpip',
    name: string,
    handlers: AuxHandlers,
    buildOpen: (channel: SSHChannel, localId: number) => Uint8Array,
    command = '',
  ): Promise<SSHSubsystemChannel> {
    if (this.phase !== 'ready') throw new SSHSessionError('channel_rejected', 'The SSH session is not ready for an auxiliary channel')
    const localId = this.nextSubsystemChannelId++
    if (localId > 0xffffffff) throw new SSHSessionError('protocol_error', 'SSH channel identifiers are exhausted')
    if (this.channels.has(localId)) throw new SSHSessionError('protocol_error', 'SSH channel identifier collision')

    const channel = new SSHChannel()
    const entry: AuxiliaryEntry = {
      kind,
      localId,
      name,
      command,
      channel,
      handlers,
      stage: 'opening',
      openResolve: null,
      openReject: null,
      timer: null,
      queue: [],
      headOffset: 0,
      flushing: false,
      waiters: [],
      exitCode: null,
      exitSignal: null,
    }
    this.channels.set(localId, entry)
    const opened = new Promise<void>((resolve, reject) => {
      entry.openResolve = resolve
      entry.openReject = reject
    })
    entry.timer = setTimeout(() => {
      this.failAuxiliary(entry, new SSHSessionError('channel_rejected', `The SSH server did not open the ${name} channel in time`))
    }, SUBSYSTEM_OPEN_TIMEOUT_MS)

    try {
      await this.sendEncrypted(buildOpen(channel, localId))
      await opened
    } catch (error) {
      this.removeAuxiliary(entry)
      throw error instanceof SSHSessionError
        ? error
        : new SSHSessionError('channel_rejected', error instanceof Error ? error.message : String(error), { cause: error })
    }
    return {
      localId,
      write: (data) => this.writeAuxiliary(entry, data),
      close: () => this.closeAuxiliary(entry),
    }
  }

  /**
   * Opens an RFC 4254 `session` channel and runs one command on it (the connection protocol's `exec`
   * request). Output streams through the handlers; `onExit` reports the channel's exit status. The
   * command is a single line because `buildExecRequest` refuses CR/LF and NUL.
   */
  async openExec(command: string, handlers: SSHExecHandlers): Promise<SSHExecChannel> {
    if (this.phase !== 'ready') throw new SSHSessionError('channel_rejected', 'The SSH session is not ready for an exec channel')
    if (typeof command !== 'string' || command.length === 0 || command.length > 4096 || /[\0\r\n]/.test(command)) {
      throw new SSHSessionError('channel_rejected', 'Invalid SSH exec command')
    }
    return this.openAuxiliaryChannel('exec', 'exec', handlers, (channel, localId) => channel.buildOpenSession(localId), command)
  }

  close(): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    this.clearTimers()
    this.failAuxiliaryChannels(new SSHSessionError('channel_rejected', 'The SSH session is closed'))
    this.inputQueue = []
    this.queuedBytes = 0
    this.config.password = undefined
    this.config.privateKey = undefined
    this.config.privateKeyPassphrase = undefined
    try {
      this.reader?.cancel().catch(() => undefined)
    } catch {
      // A cancelled reader is already finished; nothing else to release.
    }
    this.reader = null
    try {
      this.writer?.releaseLock()
    } catch {
      // The writer may already be released by the socket closing underneath it.
    }
    this.writer = null
    try {
      Promise.resolve(this.socket.close()).catch(() => undefined)
    } catch {
      // A socket that is already gone needs no second close.
    }
  }

  /** Resolves once the read loop stops; W2 uses it to release the session row. */
  async waitForReadLoop(): Promise<void> {
    if (this.readTask) await this.readTask
  }

  private clearTimers(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    if (this.shellTimer) clearTimeout(this.shellTimer)
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.keepaliveTimer = null
    this.shellTimer = null
    this.handshakeTimer = null
  }

  private async readLoop(): Promise<void> {
    const reader = this.socket.readable.getReader()
    this.reader = reader
    try {
      while (this.phase !== 'closed') {
        const { value, done } = await reader.read()
        // A local close cancels the reader; its resolution must not be reported as a remote close.
        if (this.isClosed()) return
        if (done) {
          this.sink.status('remote_closed', 'The SSH server closed the connection')
          this.finish('remote_closed')
          return
        }
        if (value.length > 0) await this.consume(value)
      }
    } catch (error) {
      this.fail(error)
    } finally {
      if (this.reader === reader) this.reader = null
      try {
        reader.releaseLock()
      } catch {
        // Releasing twice is harmless; the loop is the only holder.
      }
    }
  }

  private async consume(data: Uint8Array): Promise<void> {
    if (this.phase === 'version') {
      const merged = new Uint8Array(this.versionBuffer.length + data.length)
      merged.set(this.versionBuffer)
      merged.set(data, this.versionBuffer.length)
      if (merged.length > MAX_VERSION_BYTES) throw new SSHSessionError('version_rejected', 'SSH identification banner is too large')
      this.versionBuffer = merged
      let start = 0
      while (true) {
        const newline = this.versionBuffer.indexOf(0x0a, start)
        if (newline < 0) return
        const bytes = this.versionBuffer.subarray(start, newline + 1)
        start = newline + 1
        const line = this.decoder.decode(bytes).replace(/\r?\n$/, '')
        if (!line.startsWith('SSH-')) continue
        if (!isSSH2Identification(line)) {
          throw new SSHSessionError('version_rejected', 'The server does not support SSH 2.0')
        }
        this.transport.setRemoteVersion(line)
        const remaining = this.versionBuffer.subarray(start)
        this.versionBuffer = new Uint8Array()
        this.phase = 'kex'
        this.sink.status('version_ready', 'Version exchange complete; negotiating keys')
        await this.startKex()
        if (remaining.length > 0) {
          this.parser.feed(remaining)
          await this.processPackets()
        }
        return
      }
    }
    this.parser.feed(data)
    await this.processPackets()
  }

  private async startKex(): Promise<void> {
    this.localKex = KEXInitBuilder.build()
    await this.sendPlain(this.localKex)
  }

  private async processPackets(): Promise<void> {
    while (this.phase !== 'closed') {
      // NEWKEYS may enable inbound encryption while this same TCP chunk still contains
      // encrypted packets, so framing is recomputed on every iteration.
      const spec = this.decryptor ? getCipherSpec(this.cipherS2C) : null
      const macLength = this.decryptor && !spec?.aead ? getMacSpec(this.macS2C).length : 0
      const packet = await this.parser.nextPacket(
        spec?.blockSize ?? 8,
        this.decryptor ? (data, sequence, aad, commit) => this.decryptor!.decrypt(data, sequence, aad, commit) : (data) => data,
        Boolean(spec?.aead),
        macLength,
        this.verifier ? (data, mac, sequence) => this.verifier!.verify(data, sequence, mac) : undefined,
      )
      if (!packet) return
      await this.handlePacket(packet)
    }
  }

  private async handlePacket(packet: SSHPacket): Promise<void> {
    const type = packet.payload[0]
    if (type === SSH_MSG_DISCONNECT) {
      this.validateDisconnect(packet.payload)
      this.sink.status('remote_closed', 'The SSH server closed the connection')
      this.finish('remote_closed')
      return
    }
    if (type === SSH_MSG_IGNORE) {
      const data = this.readBytes(packet.payload, 1)
      if (data.next !== packet.payload.length) throw new SSHSessionError('protocol_error', 'Malformed SSH ignore message')
      return
    }
    if (type === SSH_MSG_DEBUG) {
      this.validateDebug(packet.payload)
      return
    }
    if (type === SSH_MSG_UNIMPLEMENTED) {
      if (packet.payload.length !== 5) throw new SSHSessionError('protocol_error', 'Malformed SSH unimplemented message')
      return
    }
    if (type === SSH_MSG_GLOBAL_REQUEST) {
      await this.handleGlobalRequest(packet.payload)
      return
    }
    if (type === SSH_MSG_REQUEST_SUCCESS || type === SSH_MSG_REQUEST_FAILURE) {
      this.keepalivePending = 0
      return
    }
    if (type === SSH_MSG_KEXINIT && this.phase !== 'kex' && this.phase !== 'host-confirm') {
      throw new SSHSessionError('protocol_error', 'Server-initiated SSH rekey is not supported')
    }
    if (this.phase === 'kex' || this.phase === 'host-confirm') await this.handleKex(type, packet.payload)
    else if (this.phase === 'auth') await this.handleAuth(type, packet.payload)
    else if (this.phase === 'pty' || this.phase === 'shell' || this.phase === 'ready') await this.handleChannel(type, packet.payload)
  }

  private async handleKex(type: number, payload: Uint8Array): Promise<void> {
    // RFC 4253 section 7.1: when the server guesses `first_kex_packet_follows` and its first
    // choice is not what negotiation selected, the guessed packet must be discarded.
    if (this.ignoreNextKexPacket) {
      this.ignoreNextKexPacket = false
      return
    }
    if (type === SSH_MSG_KEXINIT) {
      if (this.encryptor) throw new SSHSessionError('kex_failed', 'SSH rekey is not supported by this terminal session')
      this.remoteKex = payload
      const client = parseKEXInit(this.localKex!)
      const server = parseKEXInit(payload)
      this.kexName = negotiate(filterExtInfo(client.kexAlgorithms), filterExtInfo(server.kexAlgorithms), 'key exchange algorithm')
      this.hostKeyAlgorithm = negotiate(client.hostKeyAlgorithms, server.hostKeyAlgorithms, 'host key algorithm')
      this.ignoreNextKexPacket = server.firstKexPacketFollows
        && (filterExtInfo(server.kexAlgorithms)[0] !== this.kexName || server.hostKeyAlgorithms[0] !== this.hostKeyAlgorithm)
      this.cipherC2S = negotiate(client.encryptionC2S, server.encryptionC2S, 'client cipher')
      this.cipherS2C = negotiate(client.encryptionS2C, server.encryptionS2C, 'server cipher')
      // RFC 4253 negotiates MAC lists even when the chosen AEAD cipher does not use the result.
      const negotiatedMacC2S = negotiate(client.macC2S, server.macC2S, 'client MAC')
      const negotiatedMacS2C = negotiate(client.macS2C, server.macS2C, 'server MAC')
      this.macC2S = getCipherSpec(this.cipherC2S).aead ? 'none' : negotiatedMacC2S
      this.macS2C = getCipherSpec(this.cipherS2C).aead ? 'none' : negotiatedMacS2C
      if (negotiate(client.compressionC2S, server.compressionC2S, 'client compression') !== 'none'
        || negotiate(client.compressionS2C, server.compressionS2C, 'server compression') !== 'none') {
        throw new SSHSessionError('kex_failed', 'SSH compression is not supported')
      }
      await this.sendEcdhInit()
      return
    }
    if (type === SSH_MSG_KEX_ECDH_REPLY) {
      await this.handleEcdhReply(payload)
      return
    }
    if (type === SSH_MSG_NEWKEYS) {
      if (!this.keys || !this.encryptor) throw new SSHSessionError('kex_failed', 'Received NEWKEYS before completing key exchange')
      // The server's new keys apply only to subsequent inbound packets.
      await this.enableInboundEncryption()
      this.phase = 'auth'
      this.sink.status('authenticating', 'Encrypted transport established; authenticating')
      await this.sendEncrypted(new Uint8Array([SSH_MSG_SERVICE_REQUEST, ...encodeString('ssh-userauth')]))
    }
  }

  private async sendEcdhInit(): Promise<void> {
    if (this.kexName && isCurve25519KEXAlgorithm(this.kexName)) {
      this.curvePair = await Curve25519KeyExchange.generateKeyPair()
      this.clientPublic = await Curve25519KeyExchange.exportRawPublicKey(this.curvePair)
      await this.sendPlain(Curve25519KeyExchange.buildInit(this.clientPublic))
      return
    }
    if (this.kexName === KEX_ALGORITHM_ECDH_NISTP256) {
      this.ecdhPair = await ECDHKeyExchange.generateKeyPair()
      this.clientPublic = await ECDHKeyExchange.exportRawPublicKey(this.ecdhPair)
      await this.sendPlain(ECDHKeyExchange.buildInit(this.clientPublic))
      return
    }
    throw new SSHSessionError('kex_failed', `Unsupported key exchange algorithm: ${this.kexName ?? 'none'}`)
  }

  private async handleEcdhReply(payload: Uint8Array): Promise<void> {
    if (!this.kexName || !this.clientPublic || !this.localKex || !this.remoteKex) {
      throw new SSHSessionError('kex_failed', 'Unexpected key exchange reply')
    }
    const { hostKey, serverRawPublicKey, signature } = ECDHKeyExchange.parseReply(payload)
    let sharedSecret: Uint8Array
    let hash: Uint8Array
    if (isCurve25519KEXAlgorithm(this.kexName)) {
      if (!this.curvePair) throw new SSHSessionError('kex_failed', 'Missing Curve25519 key')
      sharedSecret = await Curve25519KeyExchange.computeSharedSecret(this.curvePair.privateKey, serverRawPublicKey)
      hash = await Curve25519KeyExchange.computeExchangeHash(
        this.transport.getLocalVersion(),
        this.transport.getRemoteVersion(),
        this.localKex,
        this.remoteKex,
        hostKey,
        this.clientPublic,
        serverRawPublicKey,
        sharedSecret,
      )
    } else {
      if (!this.ecdhPair) throw new SSHSessionError('kex_failed', 'Missing ECDH key')
      sharedSecret = await ECDHKeyExchange.computeSharedSecret(this.ecdhPair.privateKey, serverRawPublicKey)
      hash = await ECDHKeyExchange.computeExchangeHash(
        this.transport.getLocalVersion(),
        this.transport.getRemoteVersion(),
        this.localKex,
        this.remoteKex,
        hostKey,
        this.clientPublic,
        serverRawPublicKey,
        sharedSecret,
      )
    }
    const keyTypeLength = readUint32(hostKey, 0)
    if (keyTypeLength > 128 || keyTypeLength + 4 > hostKey.length) throw new SSHSessionError('kex_failed', 'Malformed SSH host key')
    this.hostKeyType = this.decoder.decode(hostKey.subarray(4, 4 + keyTypeLength))
    if (!this.isHostKeyAlgorithmCompatible(this.hostKeyAlgorithm, this.hostKeyType)) {
      throw new SSHSessionError('host_signature_invalid', `Server used ${this.hostKeyType}, but negotiated ${this.hostKeyAlgorithm ?? 'no host key algorithm'}`)
    }
    const fingerprint = `SHA256:${this.base64(new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(hostKey))))}`
    if (!await this.verifyHostSignature(hostKey, signature, hash)) {
      throw new SSHSessionError('host_signature_invalid', 'SSH host key signature verification failed')
    }
    const trust = classifyHostKey(this.config.expectedFingerprint, fingerprint)
    if (trust === 'trusted') {
      this.sink.status('host_key_verified', `Host key verified (${this.hostKeyType})`)
    } else if (!await this.confirmHostKey(fingerprint, trust === 'changed' ? this.config.expectedFingerprint : undefined)) {
      throw new SSHSessionError(
        trust === 'changed' ? 'host_key_changed' : 'host_key_rejected',
        trust === 'changed' ? 'The host key changed and the new fingerprint was not accepted' : 'The host key was not accepted',
      )
    }
    this.hostKeyFingerprint = fingerprint

    this.sessionId ??= hash
    const c2s = getCipherSpec(this.cipherC2S)
    const s2c = getCipherSpec(this.cipherS2C)
    this.keys = await KeyDerivation.deriveKeys(
      sharedSecret,
      hash,
      this.sessionId,
      c2s.ivLength,
      s2c.ivLength,
      getMacSpec(this.macC2S).keyLength,
      getMacSpec(this.macS2C).keyLength,
      c2s.keyLength,
      s2c.keyLength,
    )
    // Each direction switches independently at its NEWKEYS boundary. Sending ours now also
    // works with servers that wait before sending their NEWKEYS.
    await this.sendPlain(new Uint8Array([SSH_MSG_NEWKEYS]))
    await this.enableOutboundEncryption()
  }

  private async confirmHostKey(fingerprint: string, expectedFingerprint?: string): Promise<boolean> {
    this.phase = 'host-confirm'
    this.sink.status('host_key_confirmation', 'Confirm this host key before credentials are sent')
    const decision = Promise.resolve()
      .then(() => this.sink.hostKey({
        fingerprint,
        keyType: this.hostKeyType,
        trust: expectedFingerprint ? 'changed' : 'first-seen',
        expectedFingerprint,
      }))
      .catch(() => false)
    let timeout: ReturnType<typeof setTimeout> | null = null
    const bounded = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), HOST_CONFIRM_TIMEOUT_MS)
    })
    const accepted = await Promise.race([decision, bounded])
    if (timeout) clearTimeout(timeout)
    if (accepted && !this.isClosed()) this.phase = 'kex'
    return accepted && !this.isClosed()
  }

  private isClosed(): boolean {
    return this.phase === 'closed'
  }

  private async verifyHostSignature(hostKey: Uint8Array, signature: Uint8Array, hash: Uint8Array): Promise<boolean> {
    let offset = 0
    const keyType = this.readString(hostKey, offset)
    offset = keyType.next
    let sigOffset = 0
    const signatureType = this.readString(signature, sigOffset)
    sigOffset = signatureType.next
    const signatureField = this.readBytes(signature, sigOffset)
    if (signatureField.next !== signature.length) throw new SSHSessionError('host_signature_invalid', 'Malformed SSH host signature')
    const rawSignature = signatureField.value
    if (keyType.value === 'ssh-ed25519') {
      if (this.hostKeyAlgorithm !== 'ssh-ed25519' || signatureType.value !== 'ssh-ed25519') {
        throw new SSHSessionError('host_signature_invalid', 'Ed25519 host key or signature does not match the negotiated algorithm')
      }
      const keyField = this.readBytes(hostKey, offset)
      if (keyField.next !== hostKey.length || keyField.value.length !== 32 || rawSignature.length !== 64) {
        throw new SSHSessionError('host_signature_invalid', 'Malformed Ed25519 host key or signature')
      }
      const key = await crypto.subtle.importKey('raw', toBufferSource(keyField.value), { name: 'Ed25519' }, false, ['verify'])
      return crypto.subtle.verify('Ed25519', key, toBufferSource(rawSignature), toBufferSource(hash))
    }
    if (keyType.value.startsWith('ecdsa-sha2-nistp')) {
      if (this.hostKeyAlgorithm !== keyType.value || signatureType.value !== keyType.value) {
        throw new SSHSessionError('host_signature_invalid', 'ECDSA host key or signature does not match the negotiated algorithm')
      }
      const curveName = this.readString(hostKey, offset)
      offset = curveName.next
      const keyField = this.readBytes(hostKey, offset)
      if (keyField.next !== hostKey.length) throw new SSHSessionError('host_signature_invalid', 'Malformed ECDSA host key')
      const curve = keyType.value.endsWith('256') ? 'P-256' : keyType.value.endsWith('384') ? 'P-384' : 'P-521'
      if (curveName.value !== keyType.value.replace('ecdsa-sha2-', '')) {
        throw new SSHSessionError('host_signature_invalid', 'ECDSA curve name does not match the host key type')
      }
      const digest = curve === 'P-256' ? 'SHA-256' : curve === 'P-384' ? 'SHA-384' : 'SHA-512'
      const coordinateBytes = curve === 'P-256' ? 32 : curve === 'P-384' ? 48 : 66
      const key = await crypto.subtle.importKey('raw', toBufferSource(keyField.value), { name: 'ECDSA', namedCurve: curve }, false, ['verify'])
      return crypto.subtle.verify({ name: 'ECDSA', hash: digest }, key, toBufferSource(this.sshEcdsaToRaw(rawSignature, coordinateBytes)), toBufferSource(hash))
    }
    if (keyType.value === 'ssh-rsa') {
      if (signatureType.value !== 'rsa-sha2-256' && signatureType.value !== 'rsa-sha2-512') {
        throw new SSHSessionError('host_signature_invalid', `Unsupported RSA host signature type: ${signatureType.value}`)
      }
      if (signatureType.value !== this.hostKeyAlgorithm) {
        throw new SSHSessionError('host_signature_invalid', `RSA signature ${signatureType.value} does not match negotiated ${this.hostKeyAlgorithm}`)
      }
      const exponent = this.readBytes(hostKey, offset)
      offset = exponent.next
      const modulusField = this.readBytes(hostKey, offset)
      if (modulusField.next !== hostKey.length || exponent.value.length === 0 || modulusField.value.length === 0) {
        throw new SSHSessionError('host_signature_invalid', 'Malformed RSA host key')
      }
      const digest = signatureType.value === 'rsa-sha2-512' ? 'SHA-512' : 'SHA-256'
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', e: this.base64UrlUnsigned(exponent.value), n: this.base64UrlUnsigned(modulusField.value), ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: digest },
        false,
        ['verify'],
      )
      return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, toBufferSource(rawSignature), toBufferSource(hash))
    }
    throw new SSHSessionError('host_signature_invalid', `Unsupported host key type: ${keyType.value}`)
  }

  private async enableOutboundEncryption(): Promise<void> {
    if (!this.keys) throw new SSHSessionError('kex_failed', 'Session keys are not available')
    const c2s = getCipherSpec(this.cipherC2S)
    this.encryptor = c2s.mode === 'gcm'
      ? new SSHAESGCMCipher(this.keys.encKeyClientToServer.subarray(0, c2s.keyLength), this.keys.ivClientToServer)
      : new SSHAESCTRCipher(this.keys.encKeyClientToServer.subarray(0, c2s.keyLength), this.keys.ivClientToServer)
    await this.encryptor.init()
    if (!c2s.aead) {
      this.signer = new SSHHMAC(this.macC2S, this.keys.integrityKeyC2S)
      await this.signer.init()
    }
  }

  private async enableInboundEncryption(): Promise<void> {
    if (!this.keys) throw new SSHSessionError('kex_failed', 'Session keys are not available')
    const s2c = getCipherSpec(this.cipherS2C)
    this.decryptor = s2c.mode === 'gcm'
      ? new SSHAESGCMCipher(this.keys.encKeyServerToClient.subarray(0, s2c.keyLength), this.keys.ivServerToClient)
      : new SSHAESCTRCipher(this.keys.encKeyServerToClient.subarray(0, s2c.keyLength), this.keys.ivServerToClient)
    await this.decryptor.init()
    if (!s2c.aead) {
      this.verifier = new SSHHMAC(this.macS2C, this.keys.integrityKeyS2C)
      await this.verifier.init()
    }
  }

  private async handleAuth(type: number, payload: Uint8Array): Promise<void> {
    if (type === SSH_MSG_EXT_INFO) {
      if (this.authRequestSent) throw new SSHSessionError('protocol_error', 'Unexpected SSH extension information after authentication started')
      this.serverSigAlgs = parseServerSigAlgs(payload)
      return
    }
    if (type === SSH_MSG_SERVICE_ACCEPT) {
      const service = this.readString(payload, 1)
      if (service.next !== payload.length || service.value !== 'ssh-userauth') {
        throw new SSHSessionError('auth_failed', 'Invalid SSH user authentication service acceptance')
      }
      if (this.authRequestSent) throw new SSHSessionError('protocol_error', 'Duplicate SSH user authentication service acceptance')
      const request = this.config.authMethod === 'publickey'
        ? await SSHAuth.buildPublicKeyAuthRequest(
          this.config.username,
          this.config.privateKey!,
          this.sessionId!,
          this.serverSigAlgs,
          this.config.privateKeyPassphrase,
        )
        : SSHAuth.buildPasswordAuthRequest(this.config.username, this.config.password!)
      this.authRequestSent = true
      // The private key is cleared as soon as its signature exists.
      if (this.config.authMethod === 'publickey') {
        this.config.privateKey = undefined
        this.config.privateKeyPassphrase = undefined
      }
      await this.sendEncrypted(request)
      return
    }
    if (type === SSH_MSG_USERAUTH_INFO_REQUEST) {
      if (this.config.authMethod !== 'password' || this.passwordAuthMethod !== 'keyboard-interactive' || !this.authRequestSent) {
        throw new SSHSessionError('protocol_error', 'Unexpected SSH keyboard-interactive challenge')
      }
      this.keyboardInteractiveRounds++
      if (this.keyboardInteractiveRounds > 16) throw new SSHSessionError('auth_failed', 'Too many SSH keyboard-interactive challenge rounds')
      const challenge = SSHAuth.parseKeyboardInteractiveChallenge(payload)
      let responses: string[]
      if (challenge.prompts.length === 0) {
        responses = []
      } else {
        if (this.keyboardInteractivePasswordSent || this.config.password === undefined) {
          throw new SSHSessionError('auth_failed', 'SSH keyboard-interactive requested credentials more than once')
        }
        responses = SSHAuth.passwordResponsesForChallenge(challenge, this.config.password, {
          username: this.config.username,
          host: this.config.host,
        })
      }
      const response = SSHAuth.buildKeyboardInteractiveResponse(responses)
      if (responses.length > 0) {
        this.keyboardInteractivePasswordSent = true
        this.config.password = undefined
      }
      await this.sendEncrypted(response)
      return
    }
    if (type === SSH_MSG_USERAUTH_SUCCESS) {
      if (payload.length !== 1) throw new SSHSessionError('auth_failed', 'Malformed SSH authentication success')
      if (!this.authRequestSent) throw new SSHSessionError('auth_failed', 'SSH authentication completed before credentials were sent')
      this.config.password = undefined
      this.config.privateKey = undefined
      this.config.privateKeyPassphrase = undefined
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
      this.sink.status('auth_success', 'SSH authentication succeeded; opening terminal')
      this.phase = 'pty'
      this.startKeepalive()
      // The shell keeps local channel id 0 so its on-the-wire behaviour is unchanged.
      this.channels.set(0, { kind: 'shell', channel: this.shellChannel })
      await this.sendEncrypted(this.shellChannel.buildOpenSession(0))
      return
    }
    if (type === SSH_MSG_USERAUTH_FAILURE) {
      if (!this.authRequestSent) throw new SSHSessionError('auth_failed', 'SSH authentication failed before credentials were sent')
      const methods = this.validateAuthFailure(payload)
      if (this.config.authMethod === 'password'
        && this.passwordAuthMethod === 'password'
        && this.config.password !== undefined
        && methods.includes('keyboard-interactive')) {
        this.passwordAuthMethod = 'keyboard-interactive'
        await this.sendEncrypted(SSHAuth.buildKeyboardInteractiveAuthRequest(this.config.username))
        return
      }
      this.config.password = undefined
      throw new SSHSessionError('auth_failed', 'SSH authentication failed')
    }
  }

  private async handleChannel(type: number, payload: Uint8Array): Promise<void> {
    if (payload.length < 5) throw new SSHSessionError('protocol_error', 'Malformed SSH channel message')
    const channelID = readUint32(payload, 1)
    const entry = this.channels.get(channelID)
    if (!entry) throw new SSHSessionError('protocol_error', 'SSH channel message has an unknown recipient')
    if (entry.kind === 'shell') {
      await this.handleShellChannel(type, payload, entry.channel)
      return
    }
    await this.handleAuxiliaryChannel(type, payload, entry)
  }

  private async handleShellChannel(type: number, payload: Uint8Array, channel: SSHChannel): Promise<void> {
    if (type === SSH_MSG_CHANNEL_OPEN_CONFIRMATION) {
      channel.handleOpenConfirmation(payload)
      if (this.phase !== 'pty') throw new SSHSessionError('protocol_error', 'Unexpected shell channel open confirmation')
      this.pendingChannelRequest = 'pty'
      await this.sendEncrypted(channel.buildPTYRequest(this.config.cols, this.config.rows, this.config.term))
      return
    }
    if (type === SSH_MSG_CHANNEL_OPEN_FAILURE) {
      channel.handleOpenFailure(payload)
      throw new SSHSessionError('channel_rejected', 'SSH server rejected the session channel')
    }
    if (type === SSH_MSG_CHANNEL_SUCCESS || type === SSH_MSG_CHANNEL_FAILURE) {
      channel.handleRequestResult(payload)
      const pending = this.pendingChannelRequest
      if (!pending) {
        // A server may stream MOTD data before it answers the shell request; the fallback timer
        // has already marked the session ready, so a late request result is harmless.
        if (this.phase === 'ready') return
        throw new SSHSessionError('protocol_error', 'Unexpected SSH channel request result')
      }
      if (pending !== this.phase) throw new SSHSessionError('protocol_error', 'Unexpected SSH channel request result')
      this.pendingChannelRequest = null
      if (type === SSH_MSG_CHANNEL_FAILURE) {
        throw new SSHSessionError(pending === 'pty' ? 'pty_rejected' : 'channel_rejected', `SSH server rejected the ${pending === 'pty' ? 'PTY' : pending} request`)
      }
      if (pending === 'pty') {
        this.phase = 'shell'
        this.pendingChannelRequest = 'shell'
        await this.sendEncrypted(channel.buildShellRequest())
        this.shellTimer = setTimeout(() => this.markReady(), SHELL_READY_FALLBACK_MS)
      } else {
        this.markReady()
      }
      return
    }
    if (type === SSH_MSG_CHANNEL_DATA) {
      const output = channel.handleChannelData(payload)
      if (this.phase === 'shell') this.markReady()
      this.sink.output(output)
      await this.adjustLocalWindow(channel)
      return
    }
    if (type === SSH_MSG_CHANNEL_EXTENDED_DATA) {
      const output = channel.handleExtendedData(payload)
      if (this.phase === 'shell') this.markReady()
      // stderr and stdout reach the terminal in arrival order, exactly as a real tty does.
      this.sink.output(output)
      await this.adjustLocalWindow(channel)
      return
    }
    if (type === SSH_MSG_CHANNEL_REQUEST) {
      await this.handleChannelRequest(channel, payload)
      return
    }
    if (type === SSH_MSG_CHANNEL_WINDOW_ADJUST) {
      channel.handleWindowAdjust(payload)
      void this.flushInput().catch((error) => this.fail(error))
      return
    }
    if (type === SSH_MSG_CHANNEL_EOF) {
      channel.handleEof(payload)
      this.sink.status('remote_eof', 'SSH server finished sending output')
      return
    }
    if (type === SSH_MSG_CHANNEL_CLOSE) {
      channel.handleClose(payload)
      if (!channel.hasSentClose()) {
        // The peer may drop the TCP socket in the same breath as CLOSE; the session still ends.
        await this.sendEncrypted(channel.buildClose()).catch(() => undefined)
      }
      this.finish('session_ended')
      return
    }
  }

  private async handleAuxiliaryChannel(type: number, payload: Uint8Array, entry: AuxiliaryEntry): Promise<void> {
    if (type === SSH_MSG_CHANNEL_OPEN_CONFIRMATION) {
      entry.channel.handleOpenConfirmation(payload)
      if (entry.stage !== 'opening') throw new SSHSessionError('protocol_error', 'Unexpected auxiliary channel open confirmation')
      if (entry.kind === 'tcpip') {
        this.markAuxiliaryReady(entry)
        return
      }
      entry.stage = 'requesting'
      await this.sendEncrypted(entry.kind === 'exec'
        ? entry.channel.buildExecRequest(entry.command)
        : entry.channel.buildSubsystemRequest(entry.name))
      return
    }
    if (type === SSH_MSG_CHANNEL_OPEN_FAILURE) {
      entry.channel.handleOpenFailure(payload)
      this.failAuxiliary(entry, new SSHSessionError('channel_rejected', `SSH server rejected the ${entry.name} channel`))
      return
    }
    if (type === SSH_MSG_CHANNEL_SUCCESS || type === SSH_MSG_CHANNEL_FAILURE) {
      entry.channel.handleRequestResult(payload)
      if (entry.kind === 'tcpip' || entry.stage !== 'requesting') {
        throw new SSHSessionError('protocol_error', 'Unexpected auxiliary channel request result')
      }
      if (type === SSH_MSG_CHANNEL_FAILURE) {
        const label = entry.kind === 'exec' ? 'exec' : `${entry.name} subsystem`
        this.failAuxiliary(entry, new SSHSessionError('channel_rejected', `SSH server rejected the ${label} request`))
        return
      }
      this.markAuxiliaryReady(entry)
      return
    }
    if (type === SSH_MSG_CHANNEL_DATA || type === SSH_MSG_CHANNEL_EXTENDED_DATA) {
      const output = type === SSH_MSG_CHANNEL_DATA
        ? entry.channel.handleChannelData(payload)
        : entry.channel.handleExtendedData(payload)
      try {
        if (type === SSH_MSG_CHANNEL_EXTENDED_DATA && entry.handlers.onExtendedData) {
          entry.handlers.onExtendedData(output)
        } else {
          entry.handlers.onData(output)
        }
      } catch (error) {
        this.failAuxiliary(entry, error)
        return
      }
      await this.adjustLocalWindow(entry.channel)
      return
    }
    if (type === SSH_MSG_CHANNEL_REQUEST) {
      await this.handleChannelRequest(entry.channel, payload, entry)
      return
    }
    if (type === SSH_MSG_CHANNEL_WINDOW_ADJUST) {
      entry.channel.handleWindowAdjust(payload)
      void this.drainAuxiliary(entry)
      return
    }
    if (type === SSH_MSG_CHANNEL_EOF) {
      entry.channel.handleEof(payload)
      entry.handlers.onEof?.()
      return
    }
    if (type === SSH_MSG_CHANNEL_CLOSE) {
      entry.channel.handleClose(payload)
      if (!entry.channel.hasSentClose()) {
        await this.sendEncrypted(entry.channel.buildClose()).catch(() => undefined)
      }
      this.removeAuxiliary(entry)
      entry.handlers.onExit?.(entry.exitCode, entry.exitSignal)
      entry.handlers.onClose?.()
      return
    }
  }

  private markAuxiliaryReady(entry: AuxiliaryEntry): void {
    entry.stage = 'ready'
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    const resolve = entry.openResolve
    entry.openResolve = null
    entry.openReject = null
    resolve?.()
  }

  /** Writes a subsystem packet, waiting for the remote window when it is full. */
  private writeAuxiliary(entry: AuxiliaryEntry, data: Uint8Array): Promise<void> {
    if (entry.stage !== 'ready' || this.phase === 'closed') {
      return Promise.reject(new SSHSessionError('channel_rejected', 'The auxiliary channel is not ready'))
    }
    if (data.length === 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      entry.waiters.push({ resolve, reject })
      entry.queue.push(new Uint8Array(data))
      void this.drainAuxiliary(entry)
    })
  }

  private async drainAuxiliary(entry: AuxiliaryEntry): Promise<void> {
    if (entry.flushing || entry.stage === 'closed' || this.phase === 'closed') return
    entry.flushing = true
    try {
      while (entry.queue.length > 0) {
        const first = entry.queue[0]
        const chunk = entry.channel.takeChannelDataChunk(first, entry.headOffset)
        if (!chunk) break
        await this.sendChannelData(entry.channel, chunk)
        entry.headOffset += chunk.bytesConsumed
        if (entry.headOffset === first.length) {
          entry.queue.shift()
          entry.headOffset = 0
        }
      }
    } catch (error) {
      this.failAuxiliary(entry, error)
      return
    } finally {
      entry.flushing = false
    }
    if (entry.queue.length === 0) this.resolveAuxiliaryWaiters(entry)
  }

  private resolveAuxiliaryWaiters(entry: AuxiliaryEntry): void {
    const waiters = entry.waiters
    entry.waiters = []
    for (const waiter of waiters) waiter.resolve()
  }

  private rejectAuxiliaryWaiters(entry: AuxiliaryEntry, error: unknown): void {
    const waiters = entry.waiters
    entry.waiters = []
    for (const waiter of waiters) waiter.reject(error)
  }

  private async closeAuxiliary(entry: AuxiliaryEntry): Promise<void> {
    if (entry.stage === 'closed') return
    entry.stage = 'closed'
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    try {
      if (entry.channel.isOpen() && !entry.channel.hasSentClose()) {
        await this.sendEncrypted(entry.channel.buildClose())
      }
    } catch {
      // The socket may already be gone; the session-level close reports it.
    }
    this.rejectAuxiliaryWaiters(entry, new SSHSessionError('channel_rejected', 'The auxiliary channel was closed'))
    entry.timer = setTimeout(() => this.removeAuxiliary(entry), 5_000)
  }

  private failAuxiliary(entry: AuxiliaryEntry, error: unknown): void {
    const normalized = error instanceof SSHSessionError
      ? error
      : new SSHSessionError('protocol_error', error instanceof Error ? error.message : String(error), { cause: error })
    this.removeAuxiliary(entry)
    const reject = entry.openReject
    entry.openResolve = null
    entry.openReject = null
    reject?.(normalized)
    this.rejectAuxiliaryWaiters(entry, normalized)
    entry.handlers.onClose?.()
  }

  private removeAuxiliary(entry: AuxiliaryEntry): void {
    entry.stage = 'closed'
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    this.channels.delete(entry.localId)
  }

  private failAuxiliaryChannels(error: Error): void {
    for (const entry of this.channels.values()) {
      if (entry.kind === 'shell') continue
      entry.openReject?.(error)
      entry.openResolve = null
      entry.openReject = null
      this.rejectAuxiliaryWaiters(entry, error)
      entry.handlers.onExit?.(entry.exitCode, entry.exitSignal)
      entry.handlers.onClose?.()
    }
    this.channels.clear()
  }

  private async handleChannelRequest(channel: SSHChannel, payload: Uint8Array, entry?: AuxiliaryEntry): Promise<void> {
    const request = this.readString(payload, 5)
    const offset = request.next
    if (offset >= payload.length || payload[offset] > 1) {
      throw new SSHSessionError('protocol_error', 'Malformed channel request')
    }
    if (request.value === 'exit-status') {
      if (payload.length !== offset + 5) throw new SSHSessionError('protocol_error', 'Malformed exit status')
      const exitCode = readUint32(payload, offset + 1)
      if (entry) entry.exitCode = exitCode
      else this.exitCode = exitCode
    } else if (request.value === 'exit-signal') {
      const signal = this.readString(payload, offset + 1).value
      if (entry) entry.exitSignal = signal
      else this.exitSignal = signal
    }
    if (payload[offset]) {
      const reply = new Uint8Array(5)
      reply[0] = SSH_MSG_CHANNEL_FAILURE
      new DataView(reply.buffer).setUint32(1, channel.getRemoteChannelID())
      await this.sendEncrypted(reply)
    }
  }

  private markReady(): void {
    if (this.phase === 'ready' || this.phase === 'closed') return
    if (this.shellTimer) clearTimeout(this.shellTimer)
    this.shellTimer = null
    this.pendingChannelRequest = null
    this.phase = 'ready'
    this.sink.ready({
      kex: this.kexName ?? '',
      hostKeyAlgorithm: this.hostKeyAlgorithm ?? '',
      cipherC2S: this.cipherC2S,
      cipherS2C: this.cipherS2C,
      macC2S: this.macC2S,
      macS2C: this.macS2C,
      hostKeyFingerprint: this.hostKeyFingerprint,
      hostKeyType: this.hostKeyType,
    })
    this.sink.status('shell_ready', 'Shell is ready')
    void this.flushInput().catch((error) => this.fail(error))
  }

  private async handleGlobalRequest(payload: Uint8Array): Promise<void> {
    if (payload.length < 6) throw new SSHSessionError('protocol_error', 'Malformed global request')
    const nameLength = readUint32(payload, 1)
    if (5 + nameLength >= payload.length) throw new SSHSessionError('protocol_error', 'Malformed global request')
    try {
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(payload.subarray(5, 5 + nameLength))
    } catch {
      throw new SSHSessionError('protocol_error', 'Malformed global request name')
    }
    if (payload[5 + nameLength] > 1) throw new SSHSessionError('protocol_error', 'Malformed global request reply flag')
    const wantsReply = payload[5 + nameLength] === 1
    if (wantsReply && this.encryptor) await this.sendEncrypted(new Uint8Array([SSH_MSG_REQUEST_FAILURE]))
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      if (this.phase === 'closed') return
      if (this.keepalivePending >= MAX_KEEPALIVE_PENDING) {
        this.fail(new SSHSessionError('keepalive_timeout', 'SSH keepalive timed out'))
        return
      }
      this.keepalivePending++
      const payload = new Uint8Array(1 + 4 + KEEPALIVE_NAME.length + 1)
      payload[0] = SSH_MSG_GLOBAL_REQUEST
      new DataView(payload.buffer).setUint32(1, KEEPALIVE_NAME.length, false)
      payload.set(KEEPALIVE_NAME, 5)
      payload[payload.length - 1] = 1
      void this.sendEncrypted(payload).catch((error) => this.fail(error))
    }, KEEPALIVE_INTERVAL_MS)
  }

  private async flushInput(): Promise<void> {
    if (this.flushingInput || this.phase !== 'ready') return
    this.flushingInput = true
    try {
      while (this.inputQueue.length > 0 && this.phase === 'ready') {
        const first = this.inputQueue[0]
        const chunk = this.shellChannel.takeChannelDataChunk(first, this.queueHeadOffset)
        if (!chunk) return
        await this.sendChannelData(this.shellChannel, chunk)
        this.queueHeadOffset += chunk.bytesConsumed
        this.queuedBytes -= chunk.bytesConsumed
        if (this.queueHeadOffset === first.length) {
          this.inputQueue.shift()
          this.queueHeadOffset = 0
        }
      }
    } finally {
      this.flushingInput = false
    }
  }

  private async adjustLocalWindow(channel: SSHChannel): Promise<void> {
    const amount = channel.takeLocalWindowAdjustment(LOCAL_WINDOW_THRESHOLD)
    if (amount !== null) await this.sendEncrypted(channel.buildWindowAdjust(amount))
  }

  private async sendPlain(payload: Uint8Array): Promise<void> {
    await this.serialSend(async () => {
      const packet = await SSHPacketBuilder.build(payload, 8, null, this.sendSequence)
      this.sendSequence = nextSequenceNumber(this.sendSequence)
      await this.writePacket(packet)
    })
  }

  private async sendEncrypted(payload: Uint8Array): Promise<void> {
    await this.serialSend(async () => {
      if (!this.encryptor) throw new SSHSessionError('protocol_error', 'SSH encryption is not initialized')
      const spec = getCipherSpec(this.cipherC2S)
      const packet = await SSHPacketBuilder.build(
        payload,
        spec.blockSize,
        (data, sequence, aad) => this.encryptor!.encrypt(data, sequence, aad),
        this.sendSequence,
        spec.aead,
        this.signer ? (data, sequence) => this.signer!.sign(data, sequence) : undefined,
      )
      this.sendSequence = nextSequenceNumber(this.sendSequence)
      await this.writePacket(packet)
    })
  }

  private async sendChannelData(channel: SSHChannel, chunk: ChannelDataChunk): Promise<void> {
    await this.serialSend(async () => {
      if (!this.encryptor) throw new SSHSessionError('protocol_error', 'SSH encryption is not initialized')
      const spec = getCipherSpec(this.cipherC2S)
      const packet = await SSHPacketBuilder.buildWithPayloadWriter(
        chunk.payloadLength,
        (target, offset) => channel.writeChannelDataPayload(target, offset, chunk.source, chunk.sourceOffset, chunk.bytesConsumed),
        spec.blockSize,
        (data, sequence, aad) => this.encryptor!.encrypt(data, sequence, aad),
        this.sendSequence,
        spec.aead,
        this.signer ? (data, sequence) => this.signer!.sign(data, sequence) : undefined,
      )
      this.sendSequence = nextSequenceNumber(this.sendSequence)
      await this.writePacket(packet)
    })
  }

  private async serialSend(operation: () => Promise<void>): Promise<void> {
    const next = this.sendChain.then(operation)
    this.sendChain = next.catch(() => undefined)
    await next
  }

  private async writePacket(data: Uint8Array): Promise<void> {
    const writer = this.writer ?? this.socket.writable.getWriter()
    this.writer = writer
    await writer.write(data)
  }

  private readBytes(bytes: Uint8Array, offset: number): { value: Uint8Array; next: number } {
    if (offset + 4 > bytes.length) throw new SSHSessionError('protocol_error', 'Malformed SSH key data')
    const length = readUint32(bytes, offset)
    if (length > bytes.length - offset - 4) throw new SSHSessionError('protocol_error', 'Malformed SSH key data')
    return { value: bytes.subarray(offset + 4, offset + 4 + length), next: offset + 4 + length }
  }

  private readString(bytes: Uint8Array, offset: number): { value: string; next: number } {
    const field = this.readBytes(bytes, offset)
    try {
      return { value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(field.value), next: field.next }
    } catch {
      throw new SSHSessionError('protocol_error', 'Malformed SSH text field')
    }
  }

  private sshEcdsaToRaw(signature: Uint8Array, coordinateBytes: number): Uint8Array {
    const rField = this.readBytes(signature, 0)
    const sField = this.readBytes(signature, rField.next)
    if (sField.next !== signature.length) throw new SSHSessionError('host_signature_invalid', 'Malformed ECDSA signature trailing data')
    const trim = (value: Uint8Array): Uint8Array => {
      if (value.length === 0 || (value[0] & 0x80) !== 0) throw new SSHSessionError('host_signature_invalid', 'ECDSA signature integers must be positive')
      if (value.length > 1 && value[0] === 0 && (value[1] & 0x80) === 0) throw new SSHSessionError('host_signature_invalid', 'ECDSA signature integer is not minimally encoded')
      const normalized = value.length > 1 && value[0] === 0 ? value.subarray(1) : value
      if (normalized.every((byte) => byte === 0)) throw new SSHSessionError('host_signature_invalid', 'ECDSA signature integers must be non-zero')
      return normalized
    }
    const r = trim(rField.value)
    const s = trim(sField.value)
    if (r.length > coordinateBytes || s.length > coordinateBytes) throw new SSHSessionError('host_signature_invalid', 'Invalid ECDSA signature')
    const result = new Uint8Array(coordinateBytes * 2)
    result.set(r, coordinateBytes - r.length)
    result.set(s, coordinateBytes * 2 - s.length)
    return result
  }

  private base64(bytes: Uint8Array): string {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/=+$/, '')
  }

  private base64UrlUnsigned(bytes: Uint8Array): string {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    return this.base64(bytes.subarray(start)).replace(/\+/g, '-').replace(/\//g, '_')
  }

  private validateDisconnect(payload: Uint8Array): void {
    if (payload.length < 13) throw new SSHSessionError('protocol_error', 'Malformed SSH disconnect message')
    let offset = 5
    offset = this.readBytes(payload, offset).next
    offset = this.readBytes(payload, offset).next
    if (offset !== payload.length) throw new SSHSessionError('protocol_error', 'Malformed SSH disconnect message')
  }

  private validateDebug(payload: Uint8Array): void {
    if (payload.length < 10 || payload[1] > 1) throw new SSHSessionError('protocol_error', 'Malformed SSH debug message')
    let offset = 2
    offset = this.readBytes(payload, offset).next
    offset = this.readBytes(payload, offset).next
    if (offset !== payload.length) throw new SSHSessionError('protocol_error', 'Malformed SSH debug message')
  }

  private validateAuthFailure(payload: Uint8Array): string[] {
    if (payload.length < 6) throw new SSHSessionError('auth_failed', 'Malformed SSH authentication failure')
    const methodsLength = readUint32(payload, 1)
    if (methodsLength > payload.length - 6 || methodsLength + 6 !== payload.length) {
      throw new SSHSessionError('auth_failed', 'Malformed SSH authentication failure')
    }
    const partialSuccess = payload[payload.length - 1]
    if (partialSuccess > 1) throw new SSHSessionError('auth_failed', 'Malformed SSH authentication partial-success flag')
    if (partialSuccess === 1) throw new SSHSessionError('auth_failed', 'Multi-factor SSH authentication is not supported')
    let methods: string
    try {
      methods = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(payload.subarray(5, 5 + methodsLength))
    } catch {
      throw new SSHSessionError('auth_failed', 'Malformed SSH authentication methods')
    }
    if (methods && methods.split(',').some((method) => method.length === 0 || !/^[A-Za-z0-9@._+-]+$/.test(method))) {
      throw new SSHSessionError('auth_failed', 'Malformed SSH authentication methods')
    }
    return methods ? methods.split(',') : []
  }

  private isHostKeyAlgorithmCompatible(negotiated: string | null, keyType: string): boolean {
    if (!negotiated) return false
    if (negotiated === keyType) return true
    return keyType === 'ssh-rsa' && (negotiated === 'rsa-sha2-256' || negotiated === 'rsa-sha2-512')
  }

  private finish(reason: string): void {
    if (this.closedReported) return
    this.closedReported = true
    this.sink.exit({ exitCode: this.exitCode, signal: this.exitSignal })
    this.close()
    this.sink.closed(reason)
  }

  private fail(error: unknown): void {
    if (this.closedReported) return
    this.closedReported = true
    const normalized = error instanceof SSHSessionError
      ? error
      : new SSHSessionError('socket_error', error instanceof Error ? error.message : String(error), { cause: error })
    this.close()
    this.sink.closed('error', normalized)
  }
}
