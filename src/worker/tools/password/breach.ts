/**
 * HIBP range lookups for the health view.
 *
 * Privacy boundary: the browser hashes the password and sends only the first five hex characters of
 * its SHA-1. That prefix is forwarded to Have I Been Pwned's range API unchanged; neither the prefix
 * nor the answer is written to D1, to the console or to any log — an audit trail of "which prefixes
 * this account asked about" would narrow down its passwords. The suffix list comes back whole and
 * the comparison happens in the browser, so a full hash or a password never leaves it.
 */

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/'
const TIMEOUT_MS = 2500
/** The range API answers a few thousand suffix lines at most; anything larger is not an answer. */
const MAX_BODY_BYTES = 512 * 1024

export interface BreachRangeEntry {
  suffix: string
  count: number
}

/** One `SUFFIX:COUNT` per line; padding lines carry count 0 and are kept out of the answer. */
export function parseBreachRange(text: string): BreachRangeEntry[] {
  const entries: BreachRangeEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf(':')
    if (separator <= 0) continue
    const suffix = trimmed.slice(0, separator).trim().toUpperCase()
    const count = Number(trimmed.slice(separator + 1).trim())
    if (!/^[0-9A-F]{35}$/.test(suffix)) continue
    if (!Number.isFinite(count) || count <= 0) continue
    entries.push({ suffix, count: Math.floor(count) })
  }
  return entries
}

/**
 * Fetches the suffix range for a prefix. Returns null for any failure — offline, timeout, a non-200,
 * a body that is not the expected shape — so the caller can degrade instead of blocking health.
 */
export async function fetchBreachRange(prefix: string): Promise<BreachRangeEntry[] | null> {
  try {
    const response = await fetch(`${HIBP_RANGE_URL}${prefix}`, {
      // No credentials, no redirects: this is one fixed host and one fixed path.
      redirect: 'manual',
      headers: {
        // Padding makes every prefix look the same size to an observer of the response, and the
        // zero-count lines are dropped by the parser.
        'Add-Padding': 'true',
        'User-Agent': 'inkstone-password-health',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null

    const text = await response.text()
    if (text.length > MAX_BODY_BYTES) return null
    return parseBreachRange(text)
  } catch {
    return null
  }
}
