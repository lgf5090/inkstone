/** The limits and validators every YouTube input passes before it reaches D1 or the upstream. */
import { ORGANIZER_COLORS } from '../organizer-colors'

export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/
export const YOUTUBE_MAX_QUERY_LENGTH = 200
export const YOUTUBE_MAX_PAGE_TOKEN_LENGTH = 512
export const YOUTUBE_MAX_TAG_NAME_LENGTH = 32
export const YOUTUBE_MAX_TAGS_PER_VIDEO = 50
export const YOUTUBE_MAX_NOTES_LENGTH = 2_000
export const YOUTUBE_MAX_DATA_BYTES = 32 * 1024
export const YOUTUBE_MAX_TITLE_LENGTH = 500
export const YOUTUBE_MAX_THUMBNAIL_LENGTH = 2_048
export const YOUTUBE_DEFAULT_TAG_COLOR = '#64748b'

export function isYoutubeId(value: unknown): value is string {
  return typeof value === 'string' && YOUTUBE_ID_RE.test(value)
}

export function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, YOUTUBE_MAX_QUERY_LENGTH)
}

export function isSafePageToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= YOUTUBE_MAX_PAGE_TOKEN_LENGTH
    && /^[A-Za-z0-9_=-]*$/.test(value)
}

export function normalizeTagName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!name || name.length > YOUTUBE_MAX_TAG_NAME_LENGTH) return null
  return name
}

export function isYoutubeColor(value: unknown): value is string {
  return typeof value === 'string' && (ORGANIZER_COLORS as readonly string[]).includes(value)
}

/** The reference stored colour names; a row imported from it still resolves to a palette entry. */
const LEGACY_COLORS: Readonly<Record<string, string>> = {
  slate: '#64748b',
  red: '#dc2626',
  orange: '#ea580c',
  amber: '#ca8a04',
  yellow: '#eab308',
  lime: '#84cc16',
  green: '#059669',
  emerald: '#059669',
  teal: '#0d9488',
  cyan: '#0891b2',
  sky: '#0ea5e9',
  blue: '#2563eb',
  indigo: '#4f46e5',
  violet: '#9333ea',
  purple: '#9333ea',
  pink: '#d946ef',
  rose: '#db2777',
}

export function youtubeColor(value: unknown): string {
  if (isYoutubeColor(value)) return value
  if (typeof value === 'string' && LEGACY_COLORS[value]) return LEGACY_COLORS[value]!
  return YOUTUBE_DEFAULT_TAG_COLOR
}

export function normalizeTagIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > YOUTUBE_MAX_TAGS_PER_VIDEO) return null
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !/^[0-9a-hjkmnp-tv-z]{26}$/.test(entry)) return null
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

export function normalizeNotes(value: unknown): string | null {
  if (value === undefined) return ''
  if (typeof value !== 'string') return null
  const notes = value.slice(0, YOUTUBE_MAX_NOTES_LENGTH)
  return notes
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
