import { passwordApi } from '../api'

/**
 * Breach lookups, browser side.
 *
 * The password is hashed here and only the first five hex characters of its SHA-1 go to our server,
 * which forwards exactly that prefix to HIBP. The suffix list comes back and the comparison happens
 * locally, so neither the full hash nor the password is ever sent. The cache below lives in memory
 * for the session only: nothing about a password is written to disk or to the vault.
 */

const prefixCache = new Map<string, Map<string, number>>()

/** Uppercase hex SHA-1, the shape the range API and our route both expect. */
export async function sha1Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

/**
 * How many times this password appears in known breaches; 0 when it does not (or when HIBP's padded
 * answer omits it). Throws when the lookup itself fails, so the caller can degrade visibly.
 */
export async function breachCount(password: string): Promise<number> {
  const hash = await sha1Hex(password)
  const prefix = hash.slice(0, 5)
  const suffix = hash.slice(5)

  let range = prefixCache.get(prefix)
  if (!range) {
    const entries = await passwordApi.checkBreach(prefix)
    range = new Map(entries.map((entry) => [entry.suffix.toUpperCase(), entry.count]))
    prefixCache.set(prefix, range)
  }
  return range.get(suffix) ?? 0
}

/** Test hook: a fresh session starts with an empty cache. */
export function resetBreachCache(): void {
  prefixCache.clear()
}
