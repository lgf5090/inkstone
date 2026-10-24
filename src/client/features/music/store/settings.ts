/**
 * The music app's preferences, split by who owns them.
 *
 * `local` is this device: volume, mute, playback mode and rate, the equalizer curve and how lyrics
 * look. It is written to localStorage on every change, because losing a volume setting after a
 * reload is a worse trade than an occasional write.
 *
 * `server` is the account's music settings row, read and written through `/api/music/settings` with
 * the same shapes the worker stores. Edits are optimistic and debounced; a failed PUT is rolled back
 * so the panel never shows a setting the account does not have.
 *
 * The endpoints are the planned ones from the port; this module does not implement routes.
 */
import { create } from 'zustand'
import { CLIENT_HEADER } from '@shared/constants'
import {
  DEFAULT_MUSIC_SETTINGS,
  MUSIC_PLAY_MODES,
  type MusicPlayMode,
  type MusicSettings,
} from '@shared/music/model'
import { isDownloadableQuality } from '@shared/music/format'
import { IS_DEMO_MODE } from '../../../lib/runtime'
import {
  DEFAULT_EQ_GAINS,
  DEFAULT_EQ_SETTINGS,
  musicEqualizer,
  sanitizeEqSettings,
  type EqSettings,
} from '../player/eq'

const STORAGE_KEY = IS_DEMO_MODE ? 'inkstone.demo.music.settings' : 'inkstone.music.settings'
const SAVE_DELAY_MS = 600

/** The rate ladder the player and the settings panel share. */
export const MUSIC_RATE_RANGE = { min: 0.5, max: 3, step: 0.25 } as const
export const MUSIC_VOLUME_RANGE = { min: 0, max: 1 } as const

export const LYRIC_FONT_SIZE_RANGE = { min: 14, max: 40 } as const
export const LYRIC_LINE_HEIGHT_RANGE = { min: 1.2, max: 2.6 } as const

export interface MusicLyricPreferences {
  fontSize: number
  lineHeight: number
  showTranslation: boolean
  wordByWord: boolean
  align: 'left' | 'center'
  blurBackground: boolean
}

export const DEFAULT_LYRIC_PREFERENCES: MusicLyricPreferences = {
  fontSize: 20,
  lineHeight: 1.7,
  showTranslation: true,
  wordByWord: true,
  align: 'center',
  blurBackground: true,
}

export interface MusicLocalPreferences {
  volume: number
  muted: boolean
  mode: MusicPlayMode
  rate: number
  eq: EqSettings
  lyrics: MusicLyricPreferences
}

export function defaultLocalPreferences(): MusicLocalPreferences {
  return {
    volume: 1,
    muted: false,
    mode: 'order',
    rate: 1,
    eq: { ...DEFAULT_EQ_SETTINGS, gains: [...DEFAULT_EQ_GAINS] },
    lyrics: { ...DEFAULT_LYRIC_PREFERENCES },
  }
}

export const DEFAULT_MUSIC_LOCAL_PREFERENCES: MusicLocalPreferences = defaultLocalPreferences()

export const MUSIC_SETTINGS_ERROR_KEYS = {
  load: 'music.settings.error.load',
  save: 'music.settings.error.save',
} as const

export interface MusicSettingsState {
  local: MusicLocalPreferences
  server: MusicSettings
  serverStatus: 'idle' | 'loading' | 'saving' | 'error'
  serverError: string | null
  serverErrorDetail: string | null
  setLocal: (patch: Partial<MusicLocalPreferences>) => void
  setVolume: (volume: number) => void
  setMuted: (muted: boolean) => void
  setMode: (mode: MusicPlayMode) => void
  setRate: (rate: number) => void
  setEq: (patch: Partial<EqSettings>) => void
  setLyrics: (patch: Partial<MusicLyricPreferences>) => void
  resetLocal: () => void
  loadServer: () => Promise<void>
  saveServer: (patch: Partial<MusicSettings>) => void
  flushServer: () => Promise<void>
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function isPlayMode(value: unknown): value is MusicPlayMode {
  return typeof value === 'string' && (MUSIC_PLAY_MODES as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneDefaults(): MusicLocalPreferences {
  const defaults = defaultLocalPreferences()
  return { ...defaults, eq: { ...defaults.eq, gains: [...defaults.eq.gains] }, lyrics: { ...defaults.lyrics } }
}

function readLyrics(value: unknown): MusicLyricPreferences {
  if (!isRecord(value)) return { ...DEFAULT_LYRIC_PREFERENCES }
  return {
    fontSize: clamp(
      typeof value.fontSize === 'number' ? value.fontSize : DEFAULT_LYRIC_PREFERENCES.fontSize,
      LYRIC_FONT_SIZE_RANGE.min,
      LYRIC_FONT_SIZE_RANGE.max,
    ),
    lineHeight: clamp(
      typeof value.lineHeight === 'number' ? value.lineHeight : DEFAULT_LYRIC_PREFERENCES.lineHeight,
      LYRIC_LINE_HEIGHT_RANGE.min,
      LYRIC_LINE_HEIGHT_RANGE.max,
    ),
    showTranslation: typeof value.showTranslation === 'boolean' ? value.showTranslation : DEFAULT_LYRIC_PREFERENCES.showTranslation,
    wordByWord: typeof value.wordByWord === 'boolean' ? value.wordByWord : DEFAULT_LYRIC_PREFERENCES.wordByWord,
    align: value.align === 'left' ? 'left' : 'center',
    blurBackground: typeof value.blurBackground === 'boolean' ? value.blurBackground : DEFAULT_LYRIC_PREFERENCES.blurBackground,
  }
}

function readLocal(value: unknown): MusicLocalPreferences {
  const defaults = cloneDefaults()
  if (!isRecord(value)) return defaults
  return {
    volume: clamp(
      typeof value.volume === 'number' ? value.volume : defaults.volume,
      MUSIC_VOLUME_RANGE.min,
      MUSIC_VOLUME_RANGE.max,
    ),
    muted: typeof value.muted === 'boolean' ? value.muted : defaults.muted,
    mode: isPlayMode(value.mode) ? value.mode : defaults.mode,
    rate: clamp(
      typeof value.rate === 'number' ? value.rate : defaults.rate,
      MUSIC_RATE_RANGE.min,
      MUSIC_RATE_RANGE.max,
    ),
    eq: sanitizeEqSettings(value.eq),
    lyrics: readLyrics(value.lyrics),
  }
}

function loadLocal(): MusicLocalPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? readLocal(JSON.parse(raw)) : cloneDefaults()
  } catch {
    // A corrupt record or a browser that forbids storage: the defaults are a usable player.
    return cloneDefaults()
  }
}

function writeLocal(local: MusicLocalPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(local))
  } catch {
    // Private mode and a full quota both land here. The setting still applies for this session;
    // only the next launch forgets it.
  }
}

function applyEq(eq: EqSettings): void {
  musicEqualizer.setEnabled(eq.enabled)
  musicEqualizer.setGains(eq.gains)
}

function mergeLocal(current: MusicLocalPreferences, patch: Partial<MusicLocalPreferences>): MusicLocalPreferences {
  const next: MusicLocalPreferences = {
    ...current,
    ...patch,
    eq: patch.eq ? sanitizeEqSettings({ ...current.eq, ...patch.eq }) : current.eq,
    lyrics: patch.lyrics ? readLyrics({ ...current.lyrics, ...patch.lyrics }) : current.lyrics,
  }
  next.volume = clamp(next.volume, MUSIC_VOLUME_RANGE.min, MUSIC_VOLUME_RANGE.max)
  next.rate = clamp(next.rate, MUSIC_RATE_RANGE.min, MUSIC_RATE_RANGE.max)
  if (!isPlayMode(next.mode)) next.mode = current.mode
  return next
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function textOr(value: unknown, fallback: string, max = 2048): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback
}

function stringMap(value: unknown, maxEntries: number): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value).slice(0, maxEntries)) {
    if (typeof entry === 'string') out[key.slice(0, 120)] = entry.slice(0, 2048)
  }
  return out
}

/**
 * Merge an account row over the defaults, keeping only values the shape allows.
 *
 * The Worker is the only writer of this row, but a backup restored from another version can hold
 * settings this build does not know. Valid values survive; everything else falls back.
 */
export function normalizeMusicSettings(value: unknown): MusicSettings {
  const input = isRecord(value) ? value : {}
  const defaults = DEFAULT_MUSIC_SETTINGS
  const quality = isDownloadableQuality(input.quality as string) ? input.quality as MusicSettings['quality'] : defaults.quality
  const sourcePriority = Array.isArray(input.sourcePriority)
    ? input.sourcePriority.filter((entry): entry is 'official' | 'custom' => entry === 'official' || entry === 'custom')
    : []
  return {
    quality,
    downloadQuality: isDownloadableQuality(input.downloadQuality as string)
      ? input.downloadQuality as MusicSettings['downloadQuality']
      : defaults.downloadQuality,
    downloadFormat: oneOf(input.downloadFormat, ['auto', 'mp3', 'flac', 'm4a'] as const, defaults.downloadFormat),
    downloadConcurrency: Math.trunc(clamp(
      typeof input.downloadConcurrency === 'number' ? input.downloadConcurrency : defaults.downloadConcurrency,
      1,
      5,
    )),
    downloadNameFormat: textOr(input.downloadNameFormat, defaults.downloadNameFormat, 200),
    exportLyrics: booleanOr(input.exportLyrics, defaults.exportLyrics),
    autoPlay: booleanOr(input.autoPlay, defaults.autoPlay),
    singleTrackMode: oneOf(input.singleTrackMode, ['replace', 'append'] as const, defaults.singleTrackMode),
    pureMode: booleanOr(input.pureMode, defaults.pureMode),
    sourcePriority: sourcePriority.length > 0 ? [...new Set(sourcePriority)] : [...defaults.sourcePriority],
    cacheLyrics: booleanOr(input.cacheLyrics, defaults.cacheLyrics),
    customResolverEnabled: booleanOr(input.customResolverEnabled, defaults.customResolverEnabled),
    customResolverUrl: textOr(input.customResolverUrl, defaults.customResolverUrl),
    customResolverMethod: oneOf(input.customResolverMethod, ['GET', 'POST'] as const, defaults.customResolverMethod),
    customResolverResponsePath: textOr(input.customResolverResponsePath, defaults.customResolverResponsePath, 512),
    customResolverParams: stringMap(input.customResolverParams, 50),
    customResolverQualityMap: stringMap(input.customResolverQualityMap, 100),
    cloudWebdavTargetId: textOr(input.cloudWebdavTargetId, defaults.cloudWebdavTargetId, 64),
    cloudWebdavDir: textOr(input.cloudWebdavDir, defaults.cloudWebdavDir, 512),
    storageQuotaBytes: Math.max(0, Math.trunc(
      typeof input.storageQuotaBytes === 'number' && Number.isFinite(input.storageQuotaBytes)
        ? input.storageQuotaBytes
        : defaults.storageQuotaBytes,
    )),
  }
}

function defaultServerSettings(): MusicSettings {
  return {
    ...DEFAULT_MUSIC_SETTINGS,
    sourcePriority: [...DEFAULT_MUSIC_SETTINGS.sourcePriority],
    customResolverParams: {},
    customResolverQualityMap: {},
  }
}

interface SettingsAnswer {
  settings?: unknown
}

async function settingsRequest(init?: RequestInit): Promise<SettingsAnswer> {
  const headers: Record<string, string> = {
    [CLIENT_HEADER]: '1',
    Accept: 'application/json',
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
  }
  const response = await fetch('/api/music/settings', {
    credentials: 'same-origin',
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`The music settings request failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
  if (response.status === 204) return {}
  try {
    return await response.json() as SettingsAnswer
  } catch (error) {
    throw new Error('The music settings answer could not be read', { cause: error })
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useMusicSettings = create<MusicSettingsState>((set, get) => {
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  let revision = 0
  let inFlight: Promise<void> | null = null
  let serverBefore: MusicSettings | null = null

  const commit = (): Promise<void> => {
    if (inFlight) {
      return inFlight.then(() => commit())
    }
    if (!dirty) return Promise.resolve()
    dirty = false
    const savingRevision = revision
    const settings = get().server
    inFlight = (async () => {
      try {
        const answer = await settingsRequest({ method: 'PUT', body: JSON.stringify({ settings }) })
        if (savingRevision === revision) {
          set({
            server: normalizeMusicSettings(answer.settings ?? get().server),
            serverStatus: 'idle',
            serverError: null,
            serverErrorDetail: null,
          })
          serverBefore = null
        }
      } catch (error) {
        if (savingRevision === revision) {
          set({
            server: serverBefore ?? settings,
            serverStatus: 'error',
            serverError: MUSIC_SETTINGS_ERROR_KEYS.save,
            serverErrorDetail: describe(error),
          })
          serverBefore = null
        }
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  const local = loadLocal()
  applyEq(local.eq)

  return {
    local,
    server: defaultServerSettings(),
    serverStatus: 'idle',
    serverError: null,
    serverErrorDetail: null,

    setLocal(patch) {
      const previous = get().local
      const next = mergeLocal(previous, patch)
      set({ local: next })
      if (next.eq !== previous.eq) applyEq(next.eq)
      writeLocal(next)
    },

    setVolume(volume) {
      get().setLocal({
        volume: clamp(volume, MUSIC_VOLUME_RANGE.min, MUSIC_VOLUME_RANGE.max),
        muted: volume > 0 ? false : get().local.muted,
      })
    },

    setMuted(muted) {
      get().setLocal({ muted })
    },

    setMode(mode) {
      get().setLocal({ mode })
    },

    setRate(rate) {
      get().setLocal({ rate: clamp(rate, MUSIC_RATE_RANGE.min, MUSIC_RATE_RANGE.max) })
    },

    setEq(patch) {
      const eq = sanitizeEqSettings({ ...get().local.eq, ...patch })
      set({ local: { ...get().local, eq } })
      applyEq(eq)
      writeLocal(get().local)
    },

    setLyrics(patch) {
      const lyrics = readLyrics({ ...get().local.lyrics, ...patch })
      set({ local: { ...get().local, lyrics } })
      writeLocal(get().local)
    },

    resetLocal() {
      const next = cloneDefaults()
      set({ local: next })
      applyEq(next.eq)
      writeLocal(next)
    },

    async loadServer() {
      set({ serverStatus: 'loading', serverError: null, serverErrorDetail: null })
      try {
        const answer = await settingsRequest()
        set({
          server: normalizeMusicSettings(answer.settings),
          serverStatus: 'idle',
          serverError: null,
          serverErrorDetail: null,
        })
      } catch (error) {
        set({
          serverStatus: 'error',
          serverError: MUSIC_SETTINGS_ERROR_KEYS.load,
          serverErrorDetail: describe(error),
        })
      }
    },

    saveServer(patch) {
      const before = get().server
      if (!serverBefore) serverBefore = before
      revision++
      dirty = true
      set({
        server: normalizeMusicSettings({ ...before, ...patch }),
        serverStatus: 'saving',
        serverError: null,
        serverErrorDetail: null,
      })
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = null
        void commit()
      }, SAVE_DELAY_MS)
    },

    flushServer() {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      return commit()
    },
  }
})
