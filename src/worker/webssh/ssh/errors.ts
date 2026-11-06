// Inkstone WebSSH: typed protocol failures that W2 maps onto `webssh_sessions.error_code`.

export type SSHSessionErrorCode =
  | 'connection_timeout'
  | 'socket_error'
  | 'version_rejected'
  | 'kex_failed'
  | 'host_key_changed'
  | 'host_key_rejected'
  | 'host_signature_invalid'
  | 'auth_failed'
  | 'pty_rejected'
  | 'channel_rejected'
  | 'input_rejected'
  | 'input_limit'
  | 'keepalive_timeout'
  | 'protocol_error'

/**
 * `retryable` is false for defects that a reconnect cannot fix (a rejected host key or bad
 * credentials) and true for transport/protocol failures that may succeed on a fresh attempt.
 */
export class SSHSessionError extends Error {
  readonly code: SSHSessionErrorCode
  readonly retryable: boolean

  constructor(code: SSHSessionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SSHSessionError'
    this.code = code
    this.retryable = !(code === 'host_key_changed'
      || code === 'host_key_rejected'
      || code === 'host_signature_invalid'
      || code === 'auth_failed')
  }
}
