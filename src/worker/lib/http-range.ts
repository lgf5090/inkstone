/**
 * Byte-range parsing and Content-Disposition formatting shared by the worker's file responses.
 *
 * The memo file route grew these two helpers privately; the music stream route needs exactly the
 * same answers for a 206, a 416 and a filename header, so the behaviour lives here once. A range
 * header this module cannot honour answers `'invalid'`, which the caller turns into a 416 with the
 * total size; an absent or non-`bytes` header answers `null`, which means "serve the whole object".
 */
import { isInlineSafe } from './image'

export type ParsedByteRange = { start: number; end: number } | 'invalid' | null

/**
 * Parse one RFC 7233 range against a known object size.
 *
 * A multi-range request is refused rather than answered with a body no browser asked for. Suffix
 * ranges (`bytes=-500`) count back from the end, an open-ended range runs to the last byte, and an
 * end past the object is clamped. `null` means the header is not a byte range at all.
 */
export function parseByteRange(header: string, size: number): ParsedByteRange {
  if (!header.startsWith('bytes=')) return null
  const spec = header.slice(6).trim()
  if (!spec || spec.includes(',')) return 'invalid'
  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (!match) return 'invalid'
  const startRaw = match[1]!
  const endRaw = match[2]!
  if (!startRaw && !endRaw) return 'invalid'
  if (!startRaw) {
    const suffix = Number(endRaw)
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startRaw)
  if (!Number.isSafeInteger(start) || start >= size) return 'invalid'
  const end = endRaw ? Number(endRaw) : size - 1
  if (!Number.isSafeInteger(end) || end < start) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

/**
 * `inline` for media the browser may render in place, `attachment` for everything else.
 *
 * The filename is RFC 5987 encoded so a title with quotes, semicolons or non-ASCII characters
 * cannot terminate the header value early.
 */
export function contentDisposition(contentType: string, filename: string): string {
  return `${isInlineDispositionSafe(contentType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeContentDispositionFilename(filename)}`
}

function isInlineDispositionSafe(contentType: string): boolean {
  return isInlineSafe(contentType) || contentType.startsWith('audio/') || contentType.startsWith('video/')
}

function encodeContentDispositionFilename(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}
