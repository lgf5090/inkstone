/**
 * Music preferences, plus the owner's custom resolver coordinates.
 *
 * Settings are one JSON document per account because they are only ever read as a whole. Every field
 * is rebuilt from `DEFAULT_MUSIC_SETTINGS` on the way in, so a stored document written by an older
 * build (or edited by hand) cannot leave the client with a missing property. `storageQuotaBytes` is
 * display-only and is always the server constant, never a client value.
 *
 * The resolver is configuration, not code: it stores a URL, HTTP method, parameters, a response path
 * and a quality map. Nothing here executes a script, and only the owner may change it because the
 * worker will later make outbound requests on those coordinates.
 */
import { Hono } from 'hono'
import { MUSIC_LIMITS } from '@shared/music/constants'
import { DEFAULT_MUSIC_SETTINGS, type MusicSettings } from '@shared/music/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { requireOwner } from '../middleware/auth'
import { MusicStore } from '../music/store'

const SETTINGS_BODY_LIMIT = MUSIC_LIMITS.settingsMaxBytes
const SOURCES_BODY_LIMIT = MUSIC_LIMITS.settingsMaxBytes
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

function recordOf(value: unknown, label: string): Record<string, unknown> {
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
    exportLyrics: booleanOf(raw.exportLyrics, DEFAULT_MUSIC_SETTINGS.exportLyrics, 'Export lyrics'),
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
    // Server-owned: a client cannot grant itself more storage by writing a number here.
    storageQuotaBytes: MUSIC_LIMITS.quotaBytes,
  }
}

interface MusicSources {
  enabled: boolean
  url: string
  method: 'GET' | 'POST'
  params: Record<string, string>
  responsePath: string
  qualityMap: Record<string, string>
}

function sourcesOf(settings: MusicSettings): MusicSources {
  return {
    enabled: settings.customResolverEnabled,
    url: settings.customResolverUrl,
    method: settings.customResolverMethod,
    params: settings.customResolverParams,
    responsePath: settings.customResolverResponsePath,
    qualityMap: settings.customResolverQualityMap,
  }
}

async function loadSettings(store: MusicStore): Promise<MusicSettings> {
  return normalizeMusicSettings(await store.getSettings())
}

/**
 * Merge the resolver patch onto the stored document, then run the whole thing through the normal
 * settings guard. Patching the subset instead of writing it as its own row keeps one source of truth
 * for the resolver coordinates: `settings` and `sources` can never disagree.
 */
function mergeSources(current: MusicSettings, patchValue: unknown): MusicSettings {
  const patch = recordOf(patchValue, 'Sources')
  return normalizeMusicSettings({
    ...current,
    customResolverEnabled: patch.enabled ?? current.customResolverEnabled,
    customResolverUrl: patch.url ?? current.customResolverUrl,
    customResolverMethod: patch.method ?? current.customResolverMethod,
    customResolverParams: patch.params ?? current.customResolverParams,
    customResolverResponsePath: patch.responsePath ?? current.customResolverResponsePath,
    customResolverQualityMap: patch.qualityMap ?? current.customResolverQualityMap,
  })
}

export const musicSettingsRoutes = new Hono<AppBindings>()

musicSettingsRoutes.get('/settings', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json({ settings: await loadSettings(store) })
})

musicSettingsRoutes.put('/settings', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SETTINGS_BODY_LIMIT)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const settings = normalizeMusicSettings(body.settings ?? body)
  return c.json({ settings: await store.saveSettings(settings) })
})

musicSettingsRoutes.get('/sources', requireOwner, async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json({ sources: sourcesOf(await loadSettings(store)) })
})

musicSettingsRoutes.put('/sources', requireOwner, async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SOURCES_BODY_LIMIT)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const current = await loadSettings(store)
  const settings = mergeSources(current, body.sources ?? body)
  return c.json({ sources: sourcesOf(await store.saveSettings(settings)) })
})
