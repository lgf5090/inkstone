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
import type { ReaderThemeName } from '../themes'

const STORAGE_KEY = IS_DEMO_MODE ? 'inkstone.demo.reader.settings' : 'inkstone.reader.settings'
const fontStore = createStore(CLIENT_DATABASE_NAME, 'kv')

export type ReaderFontFamily = 'serif' | 'sans' | 'mono' | 'custom'
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
  /** Whether a book's reading note is created on the first highlight or on request. */
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
  autoBookNote: true,
  quoteBacklinks: true,
  notesFolder: '',
}

/** Bounds the sliders share with the keyboard shortcuts that nudge the same values. */
export const FONT_SIZE_RANGE = { min: 13, max: 34, step: 0.5 }
export const LINE_HEIGHT_RANGE = { min: 1.2, max: 2.8, step: 0.05 }
export const MARGIN_RANGE = { min: 0, max: 96, step: 2 }
export const MAX_FONT_BYTES = 8 * 1024 * 1024

function readStored(): ReaderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_READER_SETTINGS
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>
    return { ...DEFAULT_READER_SETTINGS, ...sanitise(parsed) }
  } catch {
    return DEFAULT_READER_SETTINGS
  }
}

/**
 * A hand-edited or half-written record must not reach the page as CSS.
 *
 * Every numeric setting is clamped rather than validated-and-dropped, because the reader who typed
 * `lineHeight: 40` wants a looser page, and the closest legal value is what they meant.
 */
function sanitise(parsed: Partial<ReaderSettings>): Partial<ReaderSettings> {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => (
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  )
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
  )
  return {
    fontSize: clamp(parsed.fontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max, DEFAULT_READER_SETTINGS.fontSize),
    lineHeight: clamp(parsed.lineHeight, LINE_HEIGHT_RANGE.min, LINE_HEIGHT_RANGE.max, DEFAULT_READER_SETTINGS.lineHeight),
    letterSpacing: clamp(parsed.letterSpacing, 0, 0.2, 0),
    paragraphSpacing: clamp(parsed.paragraphSpacing, 0, 3, 0.8),
    margin: clamp(parsed.margin, MARGIN_RANGE.min, MARGIN_RANGE.max, 24),
    dailyGoalMinutes: clamp(parsed.dailyGoalMinutes, 0, 600, 15),
    columns: parsed.columns === 2 ? 2 : 1,
    theme: oneOf(parsed.theme, ['auto', 'paper', 'warm', 'celadon', 'moon', 'xuan', 'fog', 'night', 'ink'] as const, 'auto'),
    fontFamily: oneOf(parsed.fontFamily, ['serif', 'sans', 'mono', 'custom'] as const, 'serif'),
    readMode: oneOf(parsed.readMode, ['paged', 'scroll'] as const, 'paged'),
    textAlign: oneOf(parsed.textAlign, ['left', 'justify'] as const, 'left'),
    pageButtons: oneOf(parsed.pageButtons, ['always', 'hover'] as const, 'always'),
    translateEngine: oneOf(parsed.translateEngine, ['google', 'ai'] as const, 'google'),
    defaultHighlightColor: oneOf(parsed.defaultHighlightColor, ['yellow', 'green', 'blue', 'pink', 'red', 'purple'] as const, 'yellow'),
    importedFonts: Array.isArray(parsed.importedFonts)
      ? parsed.importedFonts.filter((one): one is ImportedFont => Boolean(one && typeof one.family === 'string' && typeof one.id === 'string'))
      : [],
  }
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
      set({ ...DEFAULT_READER_SETTINGS })
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
