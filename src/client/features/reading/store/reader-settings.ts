/**
 * How the reader wants its page to look and behave.
 *
 * These are device settings rather than account settings: type size and column count belong to the
 * screen a reader is holding, not to the person, and a phone should not inherit a desktop's 2-column
 * spread. The one thing that does travel is what the reader writes — highlights and the reading note —
 * and that lives in the library store.
 *
 * Imported font files are the exception to the localStorage rule. A face is megabytes of binary, so
 * it goes to IndexedDB and comes back as a `data:` URL, which is what this app's content policy lets a
 * page load a font from (`blob:` is not in `font-src`).
 */
import { create } from 'zustand'
import { createStore, del as idbRemove, get as idbGet, set as idbSet } from 'idb-keyval'
import { CLIENT_DATABASE_NAME, IS_DEMO_MODE } from '../../../lib/runtime'
import type { HighlightColor } from '../types'
import { isShelfViewMode, type ShelfViewMode } from '../shelf-view'
import { READER_THEMES, type ReaderThemeName } from '../themes'

const STORAGE_KEY = IS_DEMO_MODE ? 'inkstone.demo.reader.settings' : 'inkstone.reader.settings'
const fontStore = createStore(CLIENT_DATABASE_NAME, 'kv')

export type ReaderFontFamily = 'serif' | 'sans' | 'mono' | 'custom'
export type CoverFit = 'cover' | 'contain'
export type ReadMode = 'paged' | 'scroll'

export interface ImportedFont {
  id: string
  /** The name the font asked to be registered under. */
  family: string
  label: string
  bytes: number
}

export interface ReaderSettings {
  theme: ReaderThemeName
  fontSize: number
  lineHeight: number
  letterSpacing: number
  paragraphSpacing: number
  fontFamily: ReaderFontFamily
  customFamily: string
  importedFonts: ImportedFont[]
  columns: 1 | 2
  /** Half-gutter around the text block, in CSS pixels. */
  margin: number
  textAlign: 'left' | 'justify'
  hyphenate: boolean
  /** Indent the opening line of a paragraph, which unsegmented prose expects and English does not. */
  firstLineIndent: boolean
  readMode: ReadMode
  /** Dim every paragraph but the one the reader is on. */
  focusParagraph: boolean
  /** How the shelf lays its books out; see `shelf-view.ts` for what each mode means. */
  shelfView: ShelfViewMode
  pageTurnAnimation: boolean
  showFigures: boolean
  /** Controls float over the page and retract on idle, instead of reserving a row. */
  immersive: boolean
  pageButtons: 'always' | 'hover'
  defaultHighlightColor: HighlightColor
  selectionLabels: boolean
  timerEnabled: boolean
  dailyGoalMinutes: number
  translateEnabled: boolean
  translateTo: string
  translateEngine: 'google' | 'ai'
  /** Where a tap turns the page: two edges, three zones, or never. */
  tapZones: 'thirds' | 'edges' | 'off'
  swipeTurns: boolean
  showScrubber: boolean
  estimateTimeLeft: boolean
  /** A dark veil drawn over the page, for reading in the dark without lighting the whole screen. */
  dimming: number
  /** Pixels per second of automatic scrolling; 0 leaves the page still. */
  autoScrollSpeed: number
  /** Whether a book's reading note is created on the first highlight or on request. */
  /** Write a mark's colour into the reading note, so the note reads like the page. */
  exportColors: boolean
  /** Per-book cover display: a scanned jacket wants to be seen whole, not cropped. */
  coverFits: Record<string, CoverFit>
  autoBookNote: boolean
  quoteBacklinks: boolean
  /** Folder the reading notes are created in, by name. Empty means "wherever the app would". */
  notesFolder: string
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  theme: 'auto',
  fontSize: 19,
  lineHeight: 1.8,
  letterSpacing: 0,
  paragraphSpacing: 0.8,
  fontFamily: 'serif',
  customFamily: '',
  importedFonts: [],
  columns: 1,
  margin: 24,
  textAlign: 'left',
  hyphenate: false,
  firstLineIndent: true,
  readMode: 'paged',
  focusParagraph: false,
  shelfView: 'adaptive',
  pageTurnAnimation: true,
  showFigures: true,
  immersive: true,
  pageButtons: 'always',
  defaultHighlightColor: 'yellow',
  selectionLabels: false,
  timerEnabled: true,
  dailyGoalMinutes: 15,
  translateEnabled: false,
  translateTo: 'zh-CN',
  translateEngine: 'google',
  exportColors: true,
  coverFits: {},
  autoBookNote: true,
  quoteBacklinks: true,
  notesFolder: '',
  tapZones: 'thirds',
  swipeTurns: true,
  showScrubber: true,
  estimateTimeLeft: true,
  dimming: 0,
  autoScrollSpeed: 0,
}

/** Bounds the sliders share with the keyboard shortcuts that nudge the same values. */
export const FONT_SIZE_RANGE = { min: 13, max: 34, step: 0.5 }
export const LINE_HEIGHT_RANGE = { min: 1.2, max: 2.8, step: 0.05 }
export const MARGIN_RANGE = { min: 0, max: 96, step: 2 }
export const MAX_FONT_BYTES = 8 * 1024 * 1024

/**
 * The page a device can carry before its reader changes anything.
 *
 * Type is set by the arm holding the device, not by the setting: 19px prose with a 24px margin leaves
 * twelve characters to a line on the smallest phone this app supports, which is a column rather than a
 * page. These are seeds only — the first slider moves and the device keeps its own answer, and a phone
 * never inherits a desktop's spread because the record lives in that browser, not in the account.
 */
export function readerProfile(width: number): Pick<ReaderSettings, 'fontSize' | 'lineHeight' | 'margin'> {
  if (width < 380) return { fontSize: 17, lineHeight: 1.62, margin: 14 }
  if (width < 640) return { fontSize: 18, lineHeight: 1.7, margin: 18 }
  if (width < 1024) return { fontSize: 19, lineHeight: 1.8, margin: 24 }
  return { fontSize: 19, lineHeight: 1.8, margin: 32 }
}

function deviceProfile(): Pick<ReaderSettings, 'fontSize' | 'lineHeight' | 'margin'> {
  return readerProfile(typeof window === 'undefined' ? 1024 : window.innerWidth)
}

function readStored(): ReaderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_READER_SETTINGS, ...deviceProfile() }
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>
    return { ...DEFAULT_READER_SETTINGS, ...deviceProfile(), ...sanitise(parsed) }
  } catch {
    return { ...DEFAULT_READER_SETTINGS, ...deviceProfile() }
  }
}

/**
 * A hand-edited or half-written record must not reach the page as CSS.
 *
 * Every numeric setting is clamped rather than validated-and-dropped, because the reader who typed
 * `lineHeight: 40` wants a looser page, and the closest legal value is what they meant.
 *
 * The flags are not listed here on purpose: they are coerced by `FLAG_KEYS`, which is derived from the
 * defaults, so a new setting persists the moment it gets a default instead of needing a rule nobody
 * remembers to write.
 */
function sanitise(parsed: Partial<ReaderSettings>): Partial<ReaderSettings> {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => (
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  )
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
  )
  const text = (value: unknown, max: number, fallback: string): string => (
    typeof value === 'string' ? value.slice(0, max) : fallback
  )
  return {
    fontSize: clamp(parsed.fontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max, DEFAULT_READER_SETTINGS.fontSize),
    lineHeight: clamp(parsed.lineHeight, LINE_HEIGHT_RANGE.min, LINE_HEIGHT_RANGE.max, DEFAULT_READER_SETTINGS.lineHeight),
    letterSpacing: clamp(parsed.letterSpacing, 0, 0.2, 0),
    paragraphSpacing: clamp(parsed.paragraphSpacing, 0, 3, 0.8),
    margin: clamp(parsed.margin, MARGIN_RANGE.min, MARGIN_RANGE.max, 24),
    dailyGoalMinutes: clamp(parsed.dailyGoalMinutes, 0, 600, 15),
    dimming: clamp(parsed.dimming, 0, 0.7, 0),
    autoScrollSpeed: clamp(parsed.autoScrollSpeed, 0, 160, 0),
    columns: parsed.columns === 2 ? 2 : 1,
    theme: oneOf<ReaderThemeName>(parsed.theme, ['auto', ...Object.keys(READER_THEMES)] as ReaderThemeName[], 'auto'),
    fontFamily: oneOf(parsed.fontFamily, ['serif', 'sans', 'mono', 'custom'] as const, 'serif'),
    readMode: oneOf(parsed.readMode, ['paged', 'scroll'] as const, 'paged'),
    shelfView: isShelfViewMode(parsed.shelfView) ? parsed.shelfView : DEFAULT_READER_SETTINGS.shelfView,
    textAlign: oneOf(parsed.textAlign, ['left', 'justify'] as const, 'left'),
    pageButtons: oneOf(parsed.pageButtons, ['always', 'hover'] as const, 'always'),
    translateEngine: oneOf(parsed.translateEngine, ['google', 'ai'] as const, 'google'),
    defaultHighlightColor: oneOf(parsed.defaultHighlightColor, ['yellow', 'green', 'blue', 'pink', 'red', 'purple'] as const, 'yellow'),
    tapZones: oneOf(parsed.tapZones, ['thirds', 'edges', 'off'] as const, 'thirds'),
    customFamily: text(parsed.customFamily, 64, ''),
    translateTo: text(parsed.translateTo, 16, 'zh-CN'),
    notesFolder: text(parsed.notesFolder, 128, ''),
    coverFits: parsed.coverFits && typeof parsed.coverFits === 'object'
      ? Object.fromEntries(Object.entries(parsed.coverFits as Record<string, unknown>)
        .filter(([id, value]) => typeof id === 'string' && id.length <= 200 && (value === 'cover' || value === 'contain'))
        .slice(0, 2000)) as Record<string, CoverFit>
      : {},
    importedFonts: Array.isArray(parsed.importedFonts)
      ? parsed.importedFonts.filter((one): one is ImportedFont => Boolean(one && typeof one.family === 'string' && typeof one.id === 'string'))
      : [],
    ...flagValues(parsed),
  }
}

/** The settings whose default is a boolean, so one pass can cover all of them. */
const FLAG_KEYS = (Object.keys(DEFAULT_READER_SETTINGS) as (keyof ReaderSettings)[])
  .filter((key) => typeof DEFAULT_READER_SETTINGS[key] === 'boolean')

function flagValues(parsed: Partial<ReaderSettings>): Partial<ReaderSettings> {
  const out: Record<string, boolean> = {}
  for (const key of FLAG_KEYS) {
    const value: unknown = parsed[key]
    out[key] = typeof value === 'boolean' ? value : DEFAULT_READER_SETTINGS[key] === true
  }
  return out as Partial<ReaderSettings>
}

/** The persisted half of the store, which is everything the reader can change but no action. */
const SETTING_KEYS = Object.keys(DEFAULT_READER_SETTINGS) as (keyof ReaderSettings)[]

function snapshot(state: ReaderSettingsState): ReaderSettings {
  const out: Record<string, unknown> = {}
  for (const key of SETTING_KEYS) out[key] = state[key]
  return out as unknown as ReaderSettings
}

function writeStored(state: ReaderSettingsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot(state)))
  } catch {
    // Private mode and a full device both land here; the page still reads, it just forgets.
  }
}

export function fontStorageKey(id: string): string {
  return `reading:font:${id}`
}

interface ReaderSettingsState extends ReaderSettings {
  /** `data:` URLs for the imported faces, resolved once per session. */
  fontUrls: Record<string, string>
  update: <Key extends keyof ReaderSettings>(key: Key, value: ReaderSettings[Key]) => void
  patch: (values: Partial<ReaderSettings>) => void
  reset: () => void
  loadFonts: () => Promise<void>
  /** Register a font file the reader picked; returns the face so the settings row can name it. */
  importFont: (file: File) => Promise<ImportedFont>
  removeFont: (id: string) => Promise<void>
}

export const useReaderSettings = create<ReaderSettingsState>((set, get) => {
  const commit = (): void => writeStored(get())
  return {
    ...readStored(),
    fontUrls: {},
    update(key, value) {
      set({ [key]: value } as Partial<ReaderSettingsState>)
      commit()
    },
    patch(values) {
      set(values)
      commit()
    },
    reset() {
      set({ ...DEFAULT_READER_SETTINGS, ...deviceProfile() })
      commit()
    },
    async loadFonts() {
      const urls: Record<string, string> = {}
      await Promise.all(get().importedFonts.map(async (font) => {
        const dataUrl = await idbGet<string>(fontStorageKey(font.id), fontStore)
        if (dataUrl) urls[font.id] = dataUrl
      }))
      set({ fontUrls: urls })
    },
    async importFont(file) {
      if (!file.size || file.size > MAX_FONT_BYTES) {
        throw new Error('A font file must be between 1 KB and 8 MB')
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      const id = `font-${Date.now().toString(36)}`
      const family = `Inkstone ${file.name.replace(/\.[^.]+$/, '').replace(/[^\w -]/g, '').trim() || 'Imported'}`
      const dataUrl = await bytesToDataUrl(bytes, file.type || 'font/ttf')
      await idbSet(fontStorageKey(id), dataUrl, fontStore)
      const font: ImportedFont = { id, family, label: file.name, bytes: file.size }
      set((state) => ({
        importedFonts: [...state.importedFonts, font],
        fontUrls: { ...state.fontUrls, [id]: dataUrl },
      }))
      commit()
      return font
    },
    async removeFont(id) {
      // Evicting the imported bytes. The font is taken out of state below and the settings persisted with
      // it, so the reader's choice is applied whatever this write answers; a failure leaves bytes in the
      // cache under a key the font list no longer names.
      await idbRemove(fontStorageKey(id), fontStore).catch(() => {})
      set((state) => {
        const fontUrls = { ...state.fontUrls }
        delete fontUrls[id]
        const importedFonts = state.importedFonts.filter((one) => one.id !== id)
        const wasCustom = state.fontFamily === 'custom' && state.customFamily === state.importedFonts.find((one) => one.id === id)?.family
        return {
          importedFonts,
          fontUrls,
          ...(wasCustom ? { fontFamily: 'serif' as const, customFamily: '' } : {}),
        }
      })
      commit()
    },
  }
})

async function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  // A FileReader is used rather than a base64 loop because the platform's is the one that does not
  // build a second copy of an 8 MB face in JavaScript.
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime })
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The font could not be read'))
    reader.readAsDataURL(blob)
  })
}

/** The stack a page should ask for, with the imported faces named first when one is chosen. */
export function fontStackFor(settings: Pick<ReaderSettings, 'fontFamily' | 'customFamily'>): string {
  const serif = 'var(--font-serif)'
  const sans = 'var(--font-ui)'
  const mono = 'var(--font-mono)'
  if (settings.fontFamily === 'custom') {
    const family = settings.customFamily.trim()
    return family ? `"${family.replace(/"/g, '')}", ${serif}` : serif
  }
  return settings.fontFamily === 'sans' ? sans : settings.fontFamily === 'mono' ? mono : serif
}
