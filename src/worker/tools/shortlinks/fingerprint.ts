/**
 * Privacy-respecting visitor fingerprinting.
 *
 * Daily salt rotation ensures IDs cannot be correlated across days.
 * Raw IP is never stored.
 */

const encoder = new TextEncoder()

function toHex(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes)
  let out = ''
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, '0')
  }
  return out
}

function utcDateKey(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export async function dailySaltFor(date: Date, serverSecret?: string | null): Promise<string> {
  const dateKey = utcDateKey(date)
  if (!serverSecret) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`inkstone-shortlinks:${dateKey}`))
    return toHex(digest)
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(serverSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dateKey))
  return toHex(sig)
}

export async function computeVisitorFingerprint(
  ip: string | null | undefined,
  userAgent: string | null | undefined,
  serverSecret?: string | null | undefined,
  now: Date = new Date(),
): Promise<string | null> {
  const ipStr = (ip ?? '').trim()
  const uaStr = (userAgent ?? '').trim()
  if (ipStr.length === 0 && uaStr.length === 0) return null

  const salt = await dailySaltFor(now, serverSecret ?? null)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${ipStr}|${uaStr}|${salt}`),
  )
  return toHex(digest).slice(0, 16)
}
