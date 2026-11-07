import { checkTarget } from '../../lib/outbound'

const MAX_ICON_BYTES = 64 * 1024
const TIMEOUT_MS = 5_000

export interface FaviconResult {
  bytes: ArrayBuffer
  contentType: string
}

/**
 * The host a favicon may be fetched for: a bare DNS name, nothing else.
 *
 * Accepting a URL would let the caller pick a scheme, a path or a port, and the point of this
 * endpoint is that it only ever asks one host for `/favicon.ico`. `checkTarget` then applies the
 * same private-address refusal the rest of the deployment uses.
 */
export function parseFaviconDomain(raw: string): string | null {
  const value = raw.trim().toLowerCase()
  if (!value || value.length > 253) return null
  if (!/^[a-z0-9.-]+$/.test(value)) return null
  if (!value.includes('.')) return null
  const target = checkTarget(`https://${value}/`)
  return target.url ? target.url.hostname : null
}

/**
 * Reads a site's own `/favicon.ico` from the worker.
 *
 * The client used to ask a third-party favicon service, which handed that service the list of every
 * site the vault holds. Redirects are not followed (the guard checked the address that was asked
 * for), the answer must say `image/*`, and the body is capped. Anything unexpected answers null and
 * the caller falls back to the letter tile.
 */
export async function fetchFavicon(domain: string): Promise<FaviconResult | null> {
  const target = checkTarget(`https://${domain}/favicon.ico`)
  if (!target.url) return null

  try {
    const response = await fetch(target.url.toString(), {
      redirect: 'manual',
      headers: { accept: 'image/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null

    const contentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase()
    if (!contentType.startsWith('image/')) return null

    // The cap is applied while reading: reading the whole body first let a host answer with an
    // arbitrarily large image and only then be rejected, which is a memory exhaustion primitive.
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_ICON_BYTES) {
          await reader.cancel().catch(() => {})
          return null
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    if (total === 0) return null

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes: bytes.buffer, contentType }
  } catch {
    // Offline, timed out, DNS failure, or a body that never finished: the caller draws a letter.
    return null
  }
}
