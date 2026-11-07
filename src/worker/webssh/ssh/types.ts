// Derived from EdgeSSH 2026-11 snapshot (Apache-2.0) src/types.ts, with Inkstone adaptations.
// RFC 4253 / RFC 4254 message numbers and the protocol-level contracts shared by the SSH core.

export interface SSHPacket {
  length: number
  paddingLength: number
  payload: Uint8Array
  mac?: Uint8Array
}

export interface KEXInitMessage {
  kexAlgorithms: string[]
  hostKeyAlgorithms: string[]
  encryptionC2S: string[]
  encryptionS2C: string[]
  macC2S: string[]
  macS2C: string[]
  compressionC2S: string[]
  compressionS2C: string[]
  firstKexPacketFollows: boolean
}

export interface SessionKeys {
  ivClientToServer: Uint8Array
  ivServerToClient: Uint8Array
  encKeyClientToServer: Uint8Array
  encKeyServerToClient: Uint8Array
  integrityKeyC2S: Uint8Array
  integrityKeyS2C: Uint8Array
  sessionID: Uint8Array
}

/** Terminal geometry negotiated with the remote PTY (RFC 4254 section 6.2). */
export interface TerminalSize {
  cols: number
  rows: number
}

/**
 * The connection contract W2 builds a Durable Object around. The SSH core never resolves a
 * hostname and never opens a socket itself: W2 performs the DoH lookup, the SSRF checks and the
 * `connect()` call, then hands the established socket to `SSHSession`.
 */
export interface SSHConnectionConfig {
  host: string
  port: number
  username: string
  authMethod: 'password' | 'publickey'
  password?: string
  privateKey?: string
  /** Passphrase for an encrypted OpenSSH private key; never sent or persisted beyond the handshake. */
  privateKeyPassphrase?: string
  cols: number
  rows: number
  term: string
  /** Fingerprint pinned by `webssh_host_keys`; absence means this is a first-seen host. */
  expectedFingerprint?: string
  /** Bound on version exchange + key exchange + authentication. Defaults to 20 seconds. */
  handshakeTimeoutMs?: number
}

/**
 * The byte transport the protocol core drives. Workers' `Socket` from `cloudflare:sockets`
 * satisfies it structurally, and so does the `node:net` adapter used by the live test.
 */
export interface SSHTransportSocket {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  close(): void | Promise<void>
}

/** Host key facts the caller must confirm before any credential is sent (D-06). */
export interface SSHHostKeyInfo {
  fingerprint: string
  keyType: string
  /** `trusted` = matches `expectedFingerprint`; `first-seen` = nothing pinned; `changed` = mismatch. */
  trust: 'trusted' | 'first-seen' | 'changed'
  expectedFingerprint?: string
}

/** Negotiated algorithms, surfaced to the UI and recorded in session metadata. */
export interface SSHReadyInfo {
  kex: string
  hostKeyAlgorithm: string
  cipherC2S: string
  cipherS2C: string
  macC2S: string
  macS2C: string
  hostKeyFingerprint: string
  hostKeyType: string
}

/**
 * Everything the protocol core reports outward. W2 implements it over the browser WebSocket;
 * W1 tests implement it in memory. `hostKey` may be async because a browser decision takes time.
 */
export interface SSHSessionSink {
  status(event: string, message: string): void
  output(data: Uint8Array): void
  hostKey(info: SSHHostKeyInfo): Promise<boolean> | boolean
  ready(info: SSHReadyInfo): void
  exit(info: { exitCode: number | null; signal: string | null }): void
  closed(reason: string, error?: Error): void
}

export const SSH_MSG_DISCONNECT = 1
export const SSH_MSG_IGNORE = 2
export const SSH_MSG_UNIMPLEMENTED = 3
export const SSH_MSG_DEBUG = 4
export const SSH_MSG_SERVICE_REQUEST = 5
export const SSH_MSG_SERVICE_ACCEPT = 6
export const SSH_MSG_EXT_INFO = 7
export const SSH_MSG_KEXINIT = 20
export const SSH_MSG_NEWKEYS = 21
export const SSH_MSG_KEX_ECDH_INIT = 30
export const SSH_MSG_KEX_ECDH_REPLY = 31
export const SSH_MSG_USERAUTH_REQUEST = 50
export const SSH_MSG_USERAUTH_FAILURE = 51
export const SSH_MSG_USERAUTH_SUCCESS = 52
export const SSH_MSG_USERAUTH_INFO_REQUEST = 60
export const SSH_MSG_GLOBAL_REQUEST = 80
export const SSH_MSG_REQUEST_SUCCESS = 81
export const SSH_MSG_REQUEST_FAILURE = 82
export const SSH_MSG_CHANNEL_OPEN = 90
export const SSH_MSG_CHANNEL_OPEN_CONFIRMATION = 91
export const SSH_MSG_CHANNEL_OPEN_FAILURE = 92
export const SSH_MSG_CHANNEL_WINDOW_ADJUST = 93
export const SSH_MSG_CHANNEL_DATA = 94
export const SSH_MSG_CHANNEL_EXTENDED_DATA = 95
export const SSH_MSG_CHANNEL_EOF = 96
export const SSH_MSG_CHANNEL_CLOSE = 97
export const SSH_MSG_CHANNEL_REQUEST = 98
export const SSH_MSG_CHANNEL_SUCCESS = 99
export const SSH_MSG_CHANNEL_FAILURE = 100

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/

/** Terminal sizes outside this range are rejected rather than clamped (RFC 4254 geometry). */
export function normalizeTerminalSize(cols: unknown, rows: unknown): TerminalSize | null {
  if (typeof cols !== 'number' || typeof rows !== 'number' || !Number.isFinite(cols) || !Number.isFinite(rows)) {
    return null
  }
  const size = { cols: Math.floor(cols), rows: Math.floor(rows) }
  return size.cols >= 10 && size.cols <= 1000 && size.rows >= 5 && size.rows <= 1000 ? size : null
}

/** Target host validation at the protocol boundary; the SSRF decision itself belongs to W2. */
export function isValidHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare.includes(':')) {
    try {
      return new URL(`http://[${bare}]`).hostname.length > 2
    } catch {
      return false
    }
  }
  if (/^[\d.]+$/.test(bare)) {
    if (!IPV4_RE.test(bare)) return false
    return bare.split('.').every((part) => Number(part) <= 255 && (part === '0' || !part.startsWith('0')))
  }
  return HOSTNAME_RE.test(bare)
}

/** Validates and normalizes the W2-owned connection contract before the handshake starts. */
export function normalizeConnectionConfig(input: SSHConnectionConfig): SSHConnectionConfig {
  if (typeof input.host !== 'string' || !isValidHost(input.host.trim())) throw new Error('Invalid SSH host')
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('Invalid SSH port')
  if (typeof input.username !== 'string' || input.username.length < 1 || input.username.length > 128 || /[\0\r\n]/.test(input.username)) {
    throw new Error('Invalid SSH username')
  }
  if (input.authMethod !== 'password' && input.authMethod !== 'publickey') throw new Error('Invalid authentication method')
  if (input.authMethod === 'password') {
    if (typeof input.password !== 'string' || input.password.length > 4096 || input.privateKey !== undefined || input.privateKeyPassphrase !== undefined) {
      throw new Error('Password authentication requires exactly one password credential')
    }
  } else {
    if (typeof input.privateKey !== 'string' || input.privateKey.length > 128 * 1024 || !input.privateKey.includes('BEGIN OPENSSH PRIVATE KEY') || input.password !== undefined) {
      throw new Error('Public-key authentication requires exactly one OpenSSH private key')
    }
    if (input.privateKeyPassphrase !== undefined
      && (typeof input.privateKeyPassphrase !== 'string' || input.privateKeyPassphrase.length > 1024)) {
      throw new Error('Invalid private key passphrase')
    }
  }
  if (input.expectedFingerprint !== undefined && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(input.expectedFingerprint)) {
    throw new Error('Invalid host key fingerprint')
  }
  if (input.handshakeTimeoutMs !== undefined && (!Number.isInteger(input.handshakeTimeoutMs) || input.handshakeTimeoutMs < 500 || input.handshakeTimeoutMs > 120_000)) {
    throw new Error('Invalid handshake timeout')
  }
  const size = normalizeTerminalSize(input.cols, input.rows)
  if (!size) throw new Error('Invalid terminal size')
  const term = /^[A-Za-z0-9._+-]{1,64}$/.test(input.term) ? input.term : 'xterm-256color'
  return {
    host: input.host.trim().replace(/^\[|\]$/g, ''),
    port: input.port,
    username: input.username,
    authMethod: input.authMethod,
    password: input.password,
    privateKey: input.privateKey,
    privateKeyPassphrase: input.privateKeyPassphrase,
    cols: size.cols,
    rows: size.rows,
    term,
    expectedFingerprint: input.expectedFingerprint,
    handshakeTimeoutMs: input.handshakeTimeoutMs,
  }
}
