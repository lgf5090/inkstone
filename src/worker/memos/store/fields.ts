import {
  MEMO_CIPHER_MAX_BYTES,
  MEMO_CIPHER_PREFIX,
  MEMO_CONTENT_MAX_BYTES,
  MEMO_ENCRYPTED_CONTENT_MAX_BYTES,
  MEMO_TAGS_MAX,
  MEMO_TAG_NAME_MAX_LENGTH,
} from '@shared/memos/constants'
import {
  MEMO_STATES,
  MEMO_VISIBILITIES,
  type MemoLocation,
  type MemoState,
  type MemoVisibility,
} from '@shared/memos/types'
import { utf8ByteLength } from '@shared/text-utils'
import { ApiError } from '../../lib/errors'
import { isValidId } from '../../lib/id'

export function parseContent(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('content must be a string')
  if (utf8ByteLength(value) > MEMO_CONTENT_MAX_BYTES) {
    throw ApiError.tooLarge(`Memo content exceeds the ${MEMO_CONTENT_MAX_BYTES / 1_000_000} MB limit`)
  }
  return value
}

export function parseVisibility(value: unknown): MemoVisibility {
  if (typeof value !== 'string' || !(MEMO_VISIBILITIES as readonly string[]).includes(value)) {
    throw ApiError.badRequest('visibility must be private, protected, or public')
  }
  return value as MemoVisibility
}

export function parseState(value: unknown): MemoState {
  if (typeof value !== 'string' || !(MEMO_STATES as readonly string[]).includes(value)) {
    throw ApiError.badRequest('state must be normal or archived')
  }
  return value as MemoState
}

export function parseId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidId(value)) {
    throw ApiError.badRequest(`${field} must be a memo id`)
  }
  return value
}

export function parseNullableId(value: unknown, field: string): string | null {
  if (value === null) return null
  return parseId(value, field)
}

export function parseIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw ApiError.badRequest(`${field} must be an array of ids`)
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !isValidId(entry)) {
      throw ApiError.badRequest(`${field} must contain memo ids`)
    }
    if (!ids.includes(entry)) ids.push(entry)
  }
  return ids
}

export function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw ApiError.badRequest(`${field} must be a Unix timestamp in seconds`)
  }
  return value
}

export function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${field} must be a boolean`)
  return value
}

/**
 * The sealed value the browser sends: `<prefix><salt>:<nonce>:<ciphertext>`.
 *
 * The server never inspects or opens it; it only refuses a value that is too large for the row or
 * that does not even carry the envelope. A forged value is useless because only the reader's key
 * can open it, and the browser reports a failed open rather than rendering garbage.
 */
export function parseContentCipher(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith(MEMO_CIPHER_PREFIX)) {
    throw ApiError.badRequest('contentCipher must be a sealed memo body')
  }
  if (utf8ByteLength(value) > MEMO_CIPHER_MAX_BYTES) {
    throw ApiError.tooLarge('The sealed memo body is too large to store')
  }
  return value
}

/**
 * A plaintext that is about to be sealed: only its size ceiling matters, because the value never
 * reaches the row. Returns the empty string so a caller cannot accidentally store it.
 */
export function parseEncryptedContent(value: unknown): string {
  const content = parseContent(value)
  if (utf8ByteLength(content) > MEMO_ENCRYPTED_CONTENT_MAX_BYTES) {
    throw ApiError.tooLarge(
      `A memo can be sealed only below ${MEMO_ENCRYPTED_CONTENT_MAX_BYTES} bytes; this one is longer`,
    )
  }
  return ''
}

/**
 * Tags a sealed memo carries: the browser cannot be trusted to have parsed Markdown, but it can send
 * the names it scanned. Each is normalized the way `scanMemoTags` normalizes one, and the result is
 * capped, deduplicated and kept free of whitespace.
 */
export function parseTagList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw ApiError.badRequest(`${field} must be an array of tag names`)
  const tags: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') throw ApiError.badRequest(`${field} must contain tag names`)
    const name = entry
      .trim()
      .replace(/^#/, '')
      .replace(/[/\-_\u00B7]+$/u, '')
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join('/')
    if (!name) continue
    if (/\s/.test(name)) throw ApiError.badRequest(`A tag cannot contain spaces: "${name}"`)
    if (name.length > MEMO_TAG_NAME_MAX_LENGTH) {
      throw ApiError.badRequest(`${field} contains a tag longer than ${MEMO_TAG_NAME_MAX_LENGTH} characters`)
    }
    let prefix = ''
    for (const segment of name.split('/')) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      if (prefix.length > MEMO_TAG_NAME_MAX_LENGTH) break
      if (seen.has(prefix)) continue
      seen.add(prefix)
      tags.push(prefix)
      if (tags.length >= MEMO_TAGS_MAX) return tags
    }
  }
  return tags
}

export function parseRev(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw ApiError.badRequest('rev must be a positive integer')
  }
  return value
}

export function parseLocation(value: unknown): MemoLocation | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('location must be an object or null')
  }
  const record = value as Record<string, unknown>
  if (typeof record.placeholder !== 'string') {
    throw ApiError.badRequest('location.placeholder must be a string')
  }
  if (
    typeof record.latitude !== 'number'
    || !Number.isFinite(record.latitude)
    || record.latitude < -90
    || record.latitude > 90
  ) {
    throw ApiError.badRequest('location.latitude must be between -90 and 90')
  }
  if (
    typeof record.longitude !== 'number'
    || !Number.isFinite(record.longitude)
    || record.longitude < -180
    || record.longitude > 180
  ) {
    throw ApiError.badRequest('location.longitude must be between -180 and 180')
  }
  return {
    placeholder: record.placeholder,
    latitude: record.latitude,
    longitude: record.longitude,
  }
}
