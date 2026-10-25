/**
 * The one settings guard shared by the settings routes, backup restore and persistence.
 *
 * A stored document can be older than the current shape or edited by hand; every field is rebuilt
 * from `DEFAULT_MUSIC_SETTINGS` so no consumer ever sees a missing or wrongly typed property.
 */
import { DEFAULT_MUSIC_SETTINGS, type MusicSettings } from '@shared/music/model'
import { ApiError } from '../lib/errors'

const URL_MAX = 2_048
const NAME_FORMAT_MAX = 200
const RESPONSE_PATH_MAX = 500
const PARAMS_MAX = 32
const PARAM_KEY_MAX = 64
const PARAM_VALUE_MAX = 512

const QUALITIES = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'jymaster',
] as const
const DOWNLOAD_FORMATS = ['auto', 'mp3', 'flac', 'm4a'] as const
const SOURCE_KINDS = ['official', 'custom'] as const

export function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function qualityOf(value: unknown, fallback: MusicSettings['quality']): MusicSettings['quality'] {
  return typeof value === 'string' && (QUALITIES as readonly string[]).includes(value)
    ? value as MusicSettings['quality']
    : fallback
}

function formatOf(value: unknown, fallback: MusicSettings['downloadFormat']): MusicSettings['downloadFormat'] {
  return typeof value === 'string' && (DOWNLOAD_FORMATS as readonly string[]).includes(value)
    ? value as MusicSettings['downloadFormat']
    : fallback
}

function booleanOf(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${field} must be true or false`)
  return value
}

function stringOf(value: unknown, fallback: string, max: number, field: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be text`)
  if (value.length > max) throw ApiError.badRequest(`${field} is longer than ${max} characters`)
  return value
}

/** Text that later becomes a filename or a path expression: no control characters. */
function singleLineOf(value: unknown, fallback: string, max: number, field: string): string {
  const parsed = stringOf(value, fallback, max, field)
  if (/[\r\n\0]/.test(parsed)) throw ApiError.badRequest(`${field} contains invalid characters`)
  return parsed
}

/** A flat string map: query parameters and the quality map share this shape. */
function stringMapOf(value: unknown, fallback: Record<string, string>, label: string): Record<string, string> {
  if (value === undefined) return fallback
  const input = recordOf(value, label)
  const entries = Object.entries(input)
  if (entries.length > PARAMS_MAX) throw ApiError.badRequest(`${label} holds at most ${PARAMS_MAX} entries`)
  const output: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (typeof entry !== 'string') throw ApiError.badRequest(`${label} values must be text`)
    const name = key.trim()
    if (!name) throw ApiError.badRequest(`${label} names may not be empty`)
    if (name.length > PARAM_KEY_MAX) throw ApiError.badRequest(`${label} names are too long`)
    if (entry.length > PARAM_VALUE_MAX) throw ApiError.badRequest(`${label} values are too long`)
    output[name] = entry
  }
  return output
}

function resolverUrlOf(value: unknown): string {
  const raw = stringOf(value, '', URL_MAX, 'Resolver URL').trim()
  if (!raw) return ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw ApiError.badRequest('The resolver URL is not a valid address')
  }
  if (url.protocol !== 'https:') throw ApiError.badRequest('The resolver URL must use HTTPS')
  if (url.username || url.password) throw ApiError.badRequest('The resolver URL may not carry credentials')
  return raw
}

function cloudTargetOf(value: unknown): string {
  if (value === undefined) return DEFAULT_MUSIC_SETTINGS.cloudWebdavTargetId
  if (typeof value !== 'string') throw ApiError.badRequest('The WebDAV target id must be text')
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) throw ApiError.badRequest('That WebDAV target id is not valid')
  return trimmed
}

function cloudDirOf(value: unknown): string {
  const raw = singleLineOf(value, DEFAULT_MUSIC_SETTINGS.cloudWebdavDir, 512, 'Cloud folder')
    .trim().replace(/^\/+|\/+$/g, '')
  if (!raw) return DEFAULT_MUSIC_SETTINGS.cloudWebdavDir
  const segments = raw.split('/').filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw ApiError.badRequest('The cloud folder may not leave the WebDAV target')
  }
  return segments.join('/')
}

function sourcePriorityOf(value: unknown): Array<'official' | 'custom'> {
  if (value === undefined) return [...DEFAULT_MUSIC_SETTINGS.sourcePriority]
  if (!Array.isArray(value)) throw ApiError.badRequest('Source priority must be a list')
  const seen = new Set<'official' | 'custom'>()
  for (const entry of value) {
    if (typeof entry === 'string' && (SOURCE_KINDS as readonly string[]).includes(entry)) {
      seen.add(entry as 'official' | 'custom')
    }
  }
  return seen.size ? [...seen] : [...DEFAULT_MUSIC_SETTINGS.sourcePriority]
}

/** Rebuild a complete settings document from anything that was stored or sent. */
export function normalizeMusicSettings(value: unknown): MusicSettings {
  const raw = value === undefined || value === null ? {} : recordOf(value, 'Settings')
  return {
    quality: qualityOf(raw.quality, DEFAULT_MUSIC_SETTINGS.quality),
    downloadQuality: qualityOf(raw.downloadQuality, DEFAULT_MUSIC_SETTINGS.downloadQuality),
    downloadFormat: formatOf(raw.downloadFormat, DEFAULT_MUSIC_SETTINGS.downloadFormat),
    downloadConcurrency: Math.min(5, Math.max(1, Number.isFinite(Number(raw.downloadConcurrency))
      ? Math.trunc(Number(raw.downloadConcurrency))
      : DEFAULT_MUSIC_SETTINGS.downloadConcurrency)),
    downloadNameFormat: singleLineOf(
      raw.downloadNameFormat,
      DEFAULT_MUSIC_SETTINGS.downloadNameFormat,
      NAME_FORMAT_MAX,
      'Download name format',
    ),
    autoPlay: booleanOf(raw.autoPlay, DEFAULT_MUSIC_SETTINGS.autoPlay, 'Autoplay'),
    singleTrackMode: raw.singleTrackMode === 'append' ? 'append' : 'replace',
    pureMode: booleanOf(raw.pureMode, DEFAULT_MUSIC_SETTINGS.pureMode, 'Pure mode'),
    sourcePriority: sourcePriorityOf(raw.sourcePriority),
    cacheLyrics: booleanOf(raw.cacheLyrics, DEFAULT_MUSIC_SETTINGS.cacheLyrics, 'Cache lyrics'),
    customResolverEnabled: booleanOf(
      raw.customResolverEnabled,
      DEFAULT_MUSIC_SETTINGS.customResolverEnabled,
      'Resolver enabled',
    ),
    customResolverUrl: resolverUrlOf(raw.customResolverUrl),
    customResolverMethod: raw.customResolverMethod === 'POST' ? 'POST' : 'GET',
    customResolverParams: stringMapOf(
      raw.customResolverParams,
      DEFAULT_MUSIC_SETTINGS.customResolverParams,
      'Resolver parameters',
    ),
    customResolverResponsePath: singleLineOf(
      raw.customResolverResponsePath,
      DEFAULT_MUSIC_SETTINGS.customResolverResponsePath,
      RESPONSE_PATH_MAX,
      'Resolver response path',
    ),
    customResolverQualityMap: stringMapOf(
      raw.customResolverQualityMap,
      DEFAULT_MUSIC_SETTINGS.customResolverQualityMap,
      'Resolver quality map',
    ),
    cloudWebdavTargetId: cloudTargetOf(raw.cloudWebdavTargetId),
    cloudWebdavDir: cloudDirOf(raw.cloudWebdavDir),
    // Display-only; the settings route overwrites it with this deployment's constant.
    storageQuotaBytes: DEFAULT_MUSIC_SETTINGS.storageQuotaBytes,
  }
}
