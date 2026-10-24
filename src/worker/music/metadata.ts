/**
 * What the server is willing to believe about an uploaded file.
 *
 * The browser parses tags before uploading, but none of that is trusted: titles, artists, album and
 * duration are trimmed to display-sized values, and the format is decided from the bytes. The first
 * four kilobytes are enough for every container this app accepts, which is what makes the check
 * affordable on a 300 MB upload.
 */
import {
  MUSIC_FORMAT_EXTENSIONS,
  formatFromFilename,
  isMusicFormat,
  type MusicFormat,
} from '@shared/music/constants'
import { truncateText } from '@shared/text-utils'
import { ApiError } from '../lib/errors'
import {
  hasExpectedImageSignature,
  hasReasonableImageDimensions,
  readImageSize,
} from '../lib/image'

/** The prefix read back from R2 for magic detection; no full-file read enters the isolate. */
export const MUSIC_MAGIC_HEADER_BYTES = 4096

const MAX_TITLE_CHARS = 300
const MAX_ARTIST_CHARS = 120
const MAX_ARTISTS = 20
const MAX_ALBUM_CHARS = 300
const MAX_DURATION_MS = 24 * 60 * 60 * 1000
const MAX_BITRATE = 2_000_000
const MAX_FILENAME_CHARS = 180

const COVER_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

export interface MusicUploadMetadata {
  title: string
  artists: string[]
  album: string
  durationMs: number
  bitrate: number | null
}

export interface MusicCoverInfo {
  mime: string
  extension: string
  width: number | null
  height: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** The filename kept for display: no path separators, no control characters, bounded length. */
export function sanitizeMusicFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  return truncateText(cleaned || 'audio', MAX_FILENAME_CHARS)
}

/** The extensionless part of a filename, used as the fallback title. */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').trim()
  return truncateText(base || filename, MAX_TITLE_CHARS)
}

/**
 * The format the upload claims, from the explicit field or the filename. This only decides where
 * the multipart object is written; the recorded format comes from the bytes at completion.
 */
export function declaredUploadFormat(filename: string, hint: unknown): MusicFormat | null {
  if (typeof hint === 'string' && isMusicFormat(hint)) return hint
  return formatFromFilename(filename)
}

/** Trim client-reported tags into the values a music row stores. Bad shapes fall back, never throw. */
export function sanitizeUploadMetadata(raw: unknown, fallbackTitle: string): MusicUploadMetadata {
  const record = isRecord(raw) ? raw : {}
  const rawTitle = typeof record.title === 'string' ? record.title.trim() : ''
  const rawAlbum = typeof record.album === 'string' ? record.album.trim() : ''

  const artists: string[] = []
  for (const entry of Array.isArray(record.artists) ? record.artists : []) {
    const name = typeof entry === 'string'
      ? entry.trim()
      : isRecord(entry) && typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!name) continue
    const cleaned = truncateText(name, MAX_ARTIST_CHARS)
    if (!artists.includes(cleaned)) artists.push(cleaned)
    if (artists.length >= MAX_ARTISTS) break
  }

  const duration = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)
    ? Math.trunc(record.durationMs)
    : 0
  const bitrate = typeof record.bitrate === 'number' && Number.isFinite(record.bitrate)
    ? Math.trunc(record.bitrate)
    : null

  return {
    title: truncateText(rawTitle || fallbackTitle, MAX_TITLE_CHARS) || 'Untitled',
    artists,
    album: truncateText(rawAlbum, MAX_ALBUM_CHARS),
    durationMs: Math.min(MAX_DURATION_MS, Math.max(0, duration)),
    bitrate: bitrate !== null && bitrate >= 0 && bitrate <= MAX_BITRATE ? bitrate : null,
  }
}

/** Parse the metadata JSON this worker wrote. A broken row is a warning, not a failed request. */
export function parseStoredUploadMetadata(raw: string, fallbackTitle: string): MusicUploadMetadata {
  if (!raw) return sanitizeUploadMetadata(null, fallbackTitle)
  try {
    return sanitizeUploadMetadata(JSON.parse(raw) as unknown, fallbackTitle)
  } catch (error) {
    console.warn('[inkstone] Music upload metadata is not valid JSON:', error)
    return sanitizeUploadMetadata(null, fallbackTitle)
  }
}

/**
 * Decide the container from its leading bytes.
 *
 * ISO BMFF cannot tell an audio-only m4a from an mp4 without walking the boxes, so the declared
 * extension breaks that one tie; everything else is identified by its own signature. `null` means
 * the upload is not one of the accepted containers and must be refused.
 */
export function sniffMusicFormat(bytes: Uint8Array, declared: MusicFormat | null): MusicFormat | null {
  if (bytes.length < 4) return null
  if (ascii(bytes, 0, 4) === 'fLaC') return 'flac'
  if (ascii(bytes, 0, 4) === 'RIFF' && bytes.length >= 12 && ascii(bytes, 8, 12) === 'WAVE') return 'wav'
  if (ascii(bytes, 0, 4) === 'OggS') return containsAscii(bytes, 'OpusHead') ? 'opus' : 'ogg'
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12)
    if (brand.startsWith('M4A') || brand.startsWith('M4B') || brand.startsWith('M4P')) return 'm4a'
    if (brand === 'qt  ') return 'mp4'
    // `isom`/`mp42`/`avc1` cover both audio-only and video files.
    return declared === 'm4a' || declared === 'mp4' ? declared : 'mp4'
  }
  if (ascii(bytes, 0, 3) === 'ID3') return 'mp3'
  if (isAdts(bytes)) return 'aac'
  if (isMp3Frame(bytes)) return 'mp3'
  return null
}

/** Formats that share one container may disagree about the label without lying about the bytes. */
export function formatCompatibleWithContainer(declared: MusicFormat, sniffed: MusicFormat): boolean {
  if (declared === sniffed) return true
  const shared: readonly (readonly MusicFormat[])[] = [
    ['m4a', 'mp4'],
    ['ogg', 'opus'],
  ]
  return shared.some((family) => family.includes(declared) && family.includes(sniffed))
}

/**
 * Validate a cover through the same image sniffing the attachment pipeline uses. SVG is absent on
 * purpose: it is executable markup, not a picture this app renders from user input.
 */
export function inspectMusicCover(bytes: Uint8Array, reportedMime: string): MusicCoverInfo {
  const mime = normalizeCoverMime(reportedMime)
  if (!mime) throw invalidCover('The cover must be a PNG, JPEG, GIF, WebP or AVIF image')
  if (!hasExpectedImageSignature(bytes, mime)) {
    throw invalidCover('The cover bytes do not match the declared image type')
  }
  const dimensions = readImageSize(bytes, mime)
  if (!hasReasonableImageDimensions(dimensions)) {
    throw invalidCover('The cover dimensions are not supported')
  }
  return {
    mime,
    extension: COVER_EXTENSIONS[mime]!,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  }
}

/** The canonical extension for a format, used only when a filename must be synthesised. */
export function extensionForMusicFormat(format: MusicFormat): string {
  return MUSIC_FORMAT_EXTENSIONS[format][0] ?? format
}

function normalizeCoverMime(reported: string): string | null {
  const raw = reported.trim().toLowerCase().split(';', 1)[0] ?? ''
  const mime = raw === 'image/jpg' || raw === 'image/pjpeg' ? 'image/jpeg' : raw
  return COVER_EXTENSIONS[mime] ? mime : null
}

function invalidCover(message: string): ApiError {
  return new ApiError(415, 'music_upload_invalid', message)
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  if (end > bytes.length) return ''
  return String.fromCharCode(...bytes.subarray(start, end))
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  const needle = text.split('').map((character) => character.charCodeAt(0))
  outer: for (let offset = 0; offset + needle.length <= bytes.length; offset++) {
    for (let index = 0; index < needle.length; index++) {
      if (bytes[offset + index] !== needle[index]) continue outer
    }
    return true
  }
  return false
}

function isAdts(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0
}

function isMp3Frame(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0
}
