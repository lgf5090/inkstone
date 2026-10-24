/**
 * What the music shell is showing, as opposed to what the player is playing.
 *
 * The page is mirrored here from the address so a pane can read it with one selector; the address
 * remains the source of truth and `MusicApp` writes the parse result after every navigation. The two
 * overlays are transient by design — a queue drawer reopened after a reload would be a surprise.
 *
 * Search history is the only persisted value: it is per device, and it is what makes the search box
 * useful on the second visit. It is capped at the shared limit so the record cannot grow forever.
 */
import { create } from 'zustand'
import { MUSIC_LIMITS } from '@shared/music/constants'
import { DEFAULT_MUSIC_SETTINGS, type MusicQuality } from '@shared/music/model'
import { IS_DEMO_MODE } from '../../../lib/runtime'
import type { MusicPage } from '../music-address'

const STORAGE_KEY = IS_DEMO_MODE ? 'inkstone.demo.music.searchHistory' : 'inkstone.music.searchHistory'
const MAX_TERM_LENGTH = 200

export const MUSIC_UI_DEFAULTS = {
  queueOpen: false,
  lyricsOpen: false,
  quality: DEFAULT_MUSIC_SETTINGS.quality as MusicQuality,
} as const

export interface MusicUiState {
  page: MusicPage
  /** The right-hand queue drawer. Closing it leaves the player untouched. */
  queueOpen: boolean
  /** The full-screen lyrics layer. */
  lyricsOpen: boolean
  searchHistory: string[]
  /** The quality the next play request asks for; the account setting remains the fallback. */
  quality: MusicQuality
  setPage: (page: MusicPage) => void
  setQueueOpen: (open: boolean) => void
  toggleQueue: () => void
  setLyricsOpen: (open: boolean) => void
  toggleLyrics: () => void
  pushSearchHistory: (term: string) => void
  removeSearchHistory: (term: string) => void
  clearSearchHistory: () => void
  setQuality: (quality: MusicQuality) => void
}

function normaliseHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const term = entry.trim().slice(0, MAX_TERM_LENGTH)
    if (!term || seen.has(term.toLocaleLowerCase())) continue
    seen.add(term.toLocaleLowerCase())
    out.push(term)
    if (out.length >= MUSIC_LIMITS.searchHistory) break
  }
  return out
}

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? normaliseHistory(JSON.parse(raw)) : []
  } catch {
    // A corrupt record or a storage-denied browser: an empty list is still a working search box.
    return []
  }
}

function writeHistory(history: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
  } catch {
    // Private mode and a full quota both land here; the in-memory list still works this session.
  }
}

export const useMusicUi = create<MusicUiState>((set, get) => ({
  page: { kind: 'home' },
  queueOpen: MUSIC_UI_DEFAULTS.queueOpen,
  lyricsOpen: MUSIC_UI_DEFAULTS.lyricsOpen,
  searchHistory: readHistory(),
  quality: MUSIC_UI_DEFAULTS.quality,

  setPage(page) {
    set({ page })
  },

  setQueueOpen(open) {
    set({ queueOpen: open, ...(open ? { lyricsOpen: false } : {}) })
  },

  toggleQueue() {
    get().setQueueOpen(!get().queueOpen)
  },

  setLyricsOpen(open) {
    set({ lyricsOpen: open, ...(open ? { queueOpen: false } : {}) })
  },

  toggleLyrics() {
    get().setLyricsOpen(!get().lyricsOpen)
  },

  pushSearchHistory(term) {
    const value = term.trim().slice(0, MAX_TERM_LENGTH)
    if (!value) return
    const lower = value.toLocaleLowerCase()
    const next = [value, ...get().searchHistory.filter((entry) => entry.toLocaleLowerCase() !== lower)]
      .slice(0, MUSIC_LIMITS.searchHistory)
    set({ searchHistory: next })
    writeHistory(next)
  },

  removeSearchHistory(term) {
    const next = get().searchHistory.filter((entry) => entry !== term)
    if (next.length === get().searchHistory.length) return
    set({ searchHistory: next })
    writeHistory(next)
  },

  clearSearchHistory() {
    if (get().searchHistory.length === 0) return
    set({ searchHistory: [] })
    writeHistory([])
  },

  setQuality(quality) {
    set({ quality })
  },
}))
