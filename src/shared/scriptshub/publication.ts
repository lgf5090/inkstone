/**
 * The answers a published script gives a `curl`, as pure functions.
 *
 * A distribution is a cacheable public resource, so its identity is the content's SHA-256: the same
 * bytes always answer with the same `ETag`, a conditional request can be told "nothing changed"
 * without sending the body, and the checksum header is the digest a reader can compare against the
 * one their package manager printed. Keeping these here lets the tests prove the byte-level contract
 * without booting a Worker.
 */

import { dispositionFileName, dispositionFileNameStar } from './path'

/** A strong validator, quoted as RFC 7232 requires. */
export function scriptEtag(sha256: string): string {
  return `"sha256:${sha256}"`
}

/**
 * Whether `If-None-Match` names this validator.
 *
 * A list, weak tags, and `*` are all legal inputs; comparing them literally is how a client that sent
 * a weak tag gets a 200 with identical bytes on every poll.
 */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false
  const bare = etag.replace(/^W\//, '')
  for (const raw of ifNoneMatch.split(',')) {
    const candidate = raw.trim()
    if (!candidate) continue
    if (candidate === '*') return true
    if (candidate.replace(/^W\//, '') === bare) return true
  }
  return false
}

/** `inline; filename="…"` with the RFC 5987 form for a name that is not ASCII. */
export function contentDisposition(name: string): string {
  const plain = dispositionFileName(name).replace(/[^\x20-\x7e]/g, '_')
  return `inline; filename="${plain.replace(/["\\]/g, '_')}"; filename*=UTF-8''${dispositionFileNameStar(name)}`
}

/**
 * The version a request pins, from `?v=` first and the `@N` suffix second.
 *
 * Both are accepted because both are easy to type beside a URL; when a caller sends both, the query
 * wins, which is the same precedence a route usually gives an explicit parameter over a path
 * convention.
 */
export function requestedRevision(queryValue: string | null, suffixValue: number | null): number | null {
  if (queryValue && /^[1-9][0-9]{0,6}$/.test(queryValue)) return Number(queryValue)
  return suffixValue
}

/** The one cache policy a public download gets: short, public, and revalidated by ETag. */
export function scriptCacheControl(visibility: 'public' | 'token', enabled: boolean): string {
  if (!enabled) return 'no-store'
  return visibility === 'token' ? 'private, no-store' : 'public, max-age=60, must-revalidate'
}

/** The headers every script response carries, before its body-specific ones. */
export function scriptResponseHeaders(input: {
  contentType: string
  fileName: string
  sha256: string
  visibility: 'public' | 'token'
  enabled: boolean
}): Record<string, string> {
  return {
    'Content-Type': input.contentType,
    'Content-Disposition': contentDisposition(input.fileName),
    'ETag': scriptEtag(input.sha256),
    'X-Checksum-Sha256': input.sha256,
    'Cache-Control': scriptCacheControl(input.visibility, input.enabled),
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
  }
}
