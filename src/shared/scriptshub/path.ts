/**
 * The rules a distribution path obeys.
 *
 * A published path becomes a public URL, so it is a trust boundary rather than a label: it must not
 * carry `..`, an empty segment, a leading or trailing slash, a backslash, a query or fragment, a
 * percent sign, or the `@` reserved for a version suffix. The rules are shared with the client so the
 * form can refuse the same input the route refuses, and with the tests so both sides are proved
 * against one table.
 */

import type { ParsedPublicationPath } from './types'

export const PUBLICATION_PATH_MAX = 200
export const PUBLICATION_SEGMENT_MAX = 64
export const PUBLICATION_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const VERSION_SUFFIX = /@([1-9][0-9]{0,6})$/

/** Whether one path segment is something we are willing to put after `/sc/`. */
export function publicationSegmentProblem(segment: string): string | null {
  if (!segment) return 'An empty path segment is not allowed'
  if (segment.length > PUBLICATION_SEGMENT_MAX) return `A path segment may hold at most ${PUBLICATION_SEGMENT_MAX} characters`
  if (segment === '.' || segment.includes('..')) return 'A path segment cannot contain "." or ".."'
  if (segment.startsWith('.')) return 'A path segment cannot start with a dot'
  if (!PUBLICATION_SEGMENT_PATTERN.test(segment)) {
    return 'A path segment may use letters, digits, dots, dashes and underscores, and must start with a letter or digit'
  }
  return null
}

/**
 * The path as stored, or the reason it cannot be stored.
 *
 * A leading or trailing slash is refused rather than trimmed: `/system/linux/setup.sh` and
 * `system/linux/setup.sh` look the same in a browser but are different strings in the database, and
 * one of them would resolve to the other only by accident.
 */
export function publicationPathProblem(raw: string): string | null {
  if (typeof raw !== 'string') return 'A path is required'
  const path = raw
  if (!path) return 'A path is required'
  if (path !== path.trim()) return 'A path cannot start or end with whitespace'
  if (path.length > PUBLICATION_PATH_MAX) return `A path may hold at most ${PUBLICATION_PATH_MAX} characters`
  if (path.startsWith('/') || path.endsWith('/')) return 'A path cannot start or end with a slash'
  if (path.includes('\\')) return 'A path cannot contain a backslash'
  if (/[?#%]/.test(path)) return 'A path cannot contain a query, fragment or percent escape'
  if (path.includes('@')) return 'A path cannot contain "@", which is reserved for a version suffix'
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'A path cannot contain control characters'
  const segments = path.split('/')
  if (segments.some((segment) => segment === '')) return 'A path cannot contain an empty segment'
  for (const segment of segments) {
    const problem = publicationSegmentProblem(segment)
    if (problem) return problem
  }
  if (segments.length > 8) return 'A path may hold at most 8 segments'
  return null
}

/**
 * Split the `@3` suffix from a request path, after the same validation a stored path gets.
 *
 * The suffix is only a version marker when it is the last segment and is a positive integer; `@`
 * inside a path is refused at publish time, so there is no ambiguity to resolve here.
 */
export function parsePublicationRequestPath(raw: string): ParsedPublicationPath | null {
  const versioned = VERSION_SUFFIX.exec(raw)
  const path = versioned ? raw.slice(0, versioned.index) : raw
  if (publicationPathProblem(path)) return null
  const version = versioned ? Number(versioned[1]) : null
  return { path, version: version && Number.isSafeInteger(version) ? version : null }
}

/** The `/sc/` URL a publication is served at. */
export function publicationUrlPath(path: string): string {
  const encoded = path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `/sc/${encoded}`
}

/** The public detail page for one publication. */
export function publicationDetailPath(id: string): string {
  return `/sc-view/${encodeURIComponent(id)}`
}

/** A filename safe for `Content-Disposition`, without trusting the name a reader typed. */
export function dispositionFileName(name: string): string {
  const base = name.trim().replace(/[\r\n"]/g, '').replace(/[\\/]/g, '_')
  return base || 'script.txt'
}

/** An RFC 5987 filename for names that are not plain ASCII. */
export function dispositionFileNameStar(name: string): string {
  return encodeURIComponent(dispositionFileName(name))
}
