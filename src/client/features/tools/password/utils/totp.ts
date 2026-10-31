import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6

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
 * The secret a user pastes may be bare base32 or a whole `otpauth://` URI.
 *
 * People copy whichever their provider shows them, and rejecting the URI form because it is not the
 * bare secret is a failure with no explanation. Spaces and dashes are how some providers group the
 * characters; they are not part of the secret.
 */
export function normalizeTotpSecret(input: string): string {
  const raw = input.trim()
  if (!raw) return ''

  const uriMatch = /[?&]secret=([^&]+)/i.exec(raw)
  const candidate = uriMatch ? decodeURIComponent(uriMatch[1]!) : raw
  const clean = candidate.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (!clean) return ''
  return decodeBase32(clean) ? clean : ''
}

/** RFC 6238 / RFC 4226: HMAC-SHA1 over the 8-byte time step, then dynamic truncation. */
export function totpCode(
  secret: string,
  now = Date.now(),
  digits = TOTP_DIGITS,
  period = TOTP_PERIOD_SECONDS,
): string | null {
  const key = decodeBase32(secret)
  if (!key) return null

  const counter = Math.floor(now / 1000 / period)
  const message = new Uint8Array(8)
  let remaining = counter
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = remaining & 0xff
    remaining = Math.floor(remaining / 256)
  }

  const digest = hmac(sha1, key, message)
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!
  return String(binary % 10 ** digits).padStart(digits, '0')
}

export function totpSecondsRemaining(now = Date.now(), period = TOTP_PERIOD_SECONDS): number {
  const elapsed = (now / 1000) % period
  return Math.max(1, Math.ceil(period - elapsed))
}
