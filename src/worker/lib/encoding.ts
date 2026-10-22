

const enc = new TextEncoder()
const dec = new TextDecoder()

export function utf8(text: string): Uint8Array {
  return enc.encode(text)
}

export function fromUtf8(bytes: ArrayBuffer | Uint8Array): string {
  return dec.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < view.length; i += chunk) {
    bin += String.fromCharCode(...view.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  return fromBase64(padded + pad)
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ''
  for (const b of view) out += b.toString(16).padStart(2, '0')
  return out
}


export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? utf8(input) : input
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return toHex(digest)
}

/**
 * The five markup metacharacters, for a string headed into an HTML document.
 *
 * The share shells interpolate a note title into `<title>` and an `og:title` attribute, and a title is
 * author text: without this a title of `</title><script>` would close the tag the server just opened.
 * It lives here rather than beside each shell because three routes needed the same rule and a route may
 * not import another one.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
