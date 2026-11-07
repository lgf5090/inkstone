import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'

export interface TotpConfig {
  /** Bare base32 secret, without grouping characters or padding. */
  secret: string
  digits: number
  period: number
  algorithm: TotpAlgorithm
}

const DEFAULT_TOTP: Omit<TotpConfig, 'secret'> = {
  digits: TOTP_DIGITS,
  period: TOTP_PERIOD_SECONDS,
  algorithm: 'SHA1',
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'


/** RFC 4648 base32, which is what every authenticator app exports. */
export function decodeBase32(input: string): Uint8Array | null {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (!clean) return null

  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index < 0) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 0xff)
    }
  }
  return bytes.length ? new Uint8Array(bytes) : null
}

/**
 * Reads the parameters an account's secret carries.
 *
 * Providers that hand out an `otpauth://` URI may use eight digits, a 60-second step or SHA-256.
 * Dropping those parameters produced codes that looked well-formed and were rejected by the site,
 * so the URI form is interpreted rather than stripped to its secret.
 */
export function parseTotpConfig(input: string): TotpConfig | null {
  const raw = input.trim()
  if (!raw) return null

  let candidate = raw
  let digits = DEFAULT_TOTP.digits
  let period = DEFAULT_TOTP.period
  let algorithm: TotpAlgorithm = DEFAULT_TOTP.algorithm

  const queryStart = raw.indexOf('?')
  if (/^otpauth:\/\//i.test(raw)) {
    const params = new URLSearchParams(queryStart >= 0 ? raw.slice(queryStart + 1) : '')
    candidate = params.get('secret') ?? ''
    const parsedDigits = Number(params.get('digits'))
    if (Number.isInteger(parsedDigits) && parsedDigits >= 6 && parsedDigits <= 10) digits = parsedDigits
    const parsedPeriod = Number(params.get('period'))
    if (Number.isInteger(parsedPeriod) && parsedPeriod > 0 && parsedPeriod <= 300) period = parsedPeriod
    const parsedAlgorithm = (params.get('algorithm') ?? '').toUpperCase()
    if (parsedAlgorithm === 'SHA256' || parsedAlgorithm === 'SHA512') algorithm = parsedAlgorithm
  } else if (queryStart >= 0) {
    // Some providers paste just the query part; keep accepting that, but without inventing params.
    const match = /[?&]secret=([^&]+)/i.exec(raw)
    if (match) candidate = decodeURIComponent(match[1]!)
  }

  const clean = candidate.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (!clean || !decodeBase32(clean)) return null
  return { secret: clean, digits, period, algorithm }
}

/**
 * The value stored for an account.
 *
 * A bare secret is stored as-is, so existing rows and any tool that expects base32 keep working.
 * Only a non-default digit count, period or algorithm needs the URI wrapper, and then it is written
 * in a canonical form this module can read back.
 */
export function normalizeTotpSecret(input: string): string {
  const config = parseTotpConfig(input)
  if (!config) return ''
  if (
    config.digits === DEFAULT_TOTP.digits &&
    config.period === DEFAULT_TOTP.period &&
    config.algorithm === DEFAULT_TOTP.algorithm
  ) {
    return config.secret
  }

  const params = new URLSearchParams({
    secret: config.secret,
    digits: String(config.digits),
    period: String(config.period),
    algorithm: config.algorithm,
  })
  return `otpauth://totp/inkstone?${params.toString()}`
}

/** RFC 6238 / RFC 4226: HMAC over the 8-byte time step, then dynamic truncation. */
export function totpCode(
  secret: string,
  now = Date.now(),
  digits?: number,
  period?: number,
  algorithm?: TotpAlgorithm,
): string | null {
  const config = parseTotpConfig(secret)
  if (!config) return null

  const key = decodeBase32(config.secret)!
  const step = period ?? config.period
  const length = digits ?? config.digits
  const hash = algorithm ?? config.algorithm

  const counter = Math.floor(now / 1000 / step)
  const message = new Uint8Array(8)
  let remaining = counter
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = remaining & 0xff
    remaining = Math.floor(remaining / 256)
  }

  const digest = hmac(hash === 'SHA256' ? sha256 : hash === 'SHA512' ? sha512 : sha1, key, message)
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!
  return String(binary % 10 ** length).padStart(length, '0')
}

export function totpSecondsRemaining(now = Date.now(), period = TOTP_PERIOD_SECONDS): number {
  const elapsed = (now / 1000) % period
  return Math.max(1, Math.ceil(period - elapsed))
}
