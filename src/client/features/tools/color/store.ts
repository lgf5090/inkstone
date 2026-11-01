/**
 * Reactive state machine for Color Assistant (`tools/color`).
 */

import { create } from 'zustand'
import { getColorSpaceValues, normalizeHex } from '@shared/tools/color/spaces'
import { COLOR_HISTORY_WINDOW, DEFAULT_SEED_HEX, DEFAULT_UI_TAB, type ColorHistorySource } from '@shared/tools/color/contract'
import type {
  ColorHistoryItem,
  ColorSettings,
  ColorSpaceValues,
  PaletteColorItem,
  UserColorFavorite,
  UserColorPalette,
} from '@shared/tools/color/types'
import { useUi } from '../../../store/ui'
import { t } from '../../../lib/i18n'
import { colorApi } from './api'

/**
 * Family helper for dynamic translation key resolution.
 */
export const colorT = (sub: string) => t(('tools.color.' + sub) as Parameters<typeof t>[0])

export interface ColorStudioState {
  currentHex: string
  colorSpaceValues: ColorSpaceValues
  settings: ColorSettings
  traditionalTab: 'chinese' | 'nippon'
  colorHuntTagFilter: string

  favorites: UserColorFavorite[]
  palettes: UserColorPalette[]
  history: ColorHistoryItem[]
  isLoadingFavorites: boolean
  isLoadingPalettes: boolean
  /** Which collection panel could not be read — an empty list and a failed one look the same otherwise. */
  favoritesLoadFailed: boolean
  palettesLoadFailed: boolean

  // Modals visibility
  isContrastModalOpen: boolean
  isTokenScaleModalOpen: boolean
  isColorBlindnessModalOpen: boolean
  isCreatePaletteModalOpen: boolean
  isExportPaletteModalOpen: boolean
  exportTargetPalette: { title: string; colors: string[] } | null

  /** The row whose editor is open, by id: the list stays the single source of what it says. */
  editingFavoriteId: string | null
  editingPaletteId: string | null

  // Actions
  setCurrentHex: (hex: string, source?: ColorHistorySource) => void
  setCurrentColor: (hex: string, source?: ColorHistorySource) => void
  copyColor: (value: string, label?: string) => Promise<void>
  setTraditionalTab: (tab: 'chinese' | 'nippon') => void
  setColorHuntTagFilter: (tag: string) => void

  fetchSettings: () => Promise<void>
  updateSettings: (partial: Partial<ColorSettings>) => Promise<void>

  fetchFavorites: () => Promise<void>
  addFavorite: (hex: string, name?: string, tags?: string[]) => Promise<void>
  removeFavorite: (id: string) => Promise<void>
  updateFavorite: (id: string, patch: { name?: string; tags?: string[]; note?: string }) => Promise<boolean>
  moveFavorite: (id: string, delta: number) => Promise<void>

  fetchPalettes: () => Promise<void>
  savePalette: (
    title: string,
    colors: PaletteColorItem[],
    sourceType?: UserColorPalette['sourceType'],
    tags?: string[],
    description?: string,
  ) => Promise<boolean>
  togglePaletteFavorite: (id: string) => Promise<void>
  removePalette: (id: string) => Promise<void>
  updatePalette: (
    id: string,
    patch: { title?: string; description?: string; tags?: string[] },
  ) => Promise<boolean>
  movePalette: (id: string, delta: number) => Promise<void>

  fetchHistory: () => Promise<void>
  clearHistory: () => Promise<void>

  // Modals controls
  openContrastModal: () => void
  closeContrastModal: () => void
  openTokenScaleModal: () => void
  closeTokenScaleModal: () => void
  openColorBlindnessModal: () => void
  closeColorBlindnessModal: () => void
  openCreatePaletteModal: () => void
  closeCreatePaletteModal: () => void
  openExportPaletteModal: (palette: { title: string; colors: string[] }) => void
  closeExportPaletteModal: () => void
  openEditFavorite: (id: string) => void
  closeEditFavorite: () => void
  openEditPalette: (id: string) => void
  closeEditPalette: () => void
}

const DEFAULT_HEX = DEFAULT_SEED_HEX

/** How long the pointer has to rest before the color lands in the history. */
const HISTORY_IDLE_MS = 600

/**
 * The pending history write, held outside the store on purpose.
 *
 * A drag of the hue slider calls `setCurrentHex` once per step, and each of those used to POST a row and
 * then GET the whole list back — thirty-one steps measured twenty writes and twenty reads. Nothing in the
 * interface shows a timer, so the schedule lives in module scope rather than in render-visible state, and
 * only the last color of a burst is kept: the intermediate ones were never what the reader meant to pick.
 */
let pendingHistory: { hex: string, source: ColorHistorySource } | null = null
let historyTimer: ReturnType<typeof setTimeout> | null = null
let lastLoggedHex: string | null = null

function queueHistoryWrite(hex: string, source: ColorHistorySource): void {
  pendingHistory = { hex, source }
  if (historyTimer) return

  historyTimer = setTimeout(() => {
    historyTimer = null
    const entry = pendingHistory
    pendingHistory = null
    if (!entry || entry.hex === lastLoggedHex) return

    lastLoggedHex = entry.hex
    colorApi.addHistory(entry.hex, entry.source).then(() => {
      useColorStudioStore.getState().fetchHistory()
    }).catch((error: unknown) => {
      // A history row is a convenience trail, not reader data: losing one must not interrupt picking
      // colors. The hex is released so the next change over that color retries rather than being
      // silently remembered as already saved.
      lastLoggedHex = null
      console.debug('[tools/color] history write failed', entry.hex, error)
    })
  }, HISTORY_IDLE_MS)
}

/** The list with `id` moved `delta` places, or null when it is already at that end. */
function movedBefore<T extends { id: string }>(list: T[], id: string, delta: number): T[] | null {
  const index = list.findIndex((item) => item.id === id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= list.length) return null
  const next = [...list]
  const row = next[index]!
  next.splice(index, 1)
  next.splice(target, 0, row)
  return next
}

export const useColorStudioStore = create<ColorStudioState>((set, get) => ({
  currentHex: DEFAULT_HEX,
  colorSpaceValues: getColorSpaceValues(DEFAULT_HEX),
  settings: {
    stripHash: false,
    defaultFormat: 'hex',
    defaultUiTab: DEFAULT_UI_TAB,
    autoSaveHistory: true,
    updatedAt: Date.now(),
  },
  traditionalTab: 'chinese',
  colorHuntTagFilter: 'all',

  favorites: [],
  palettes: [],
  history: [],
  isLoadingFavorites: false,
  isLoadingPalettes: false,
  favoritesLoadFailed: false,
  palettesLoadFailed: false,

  isContrastModalOpen: false,
  isTokenScaleModalOpen: false,
  isColorBlindnessModalOpen: false,

  isCreatePaletteModalOpen: false,
  isExportPaletteModalOpen: false,
  exportTargetPalette: null,
  editingFavoriteId: null,
  editingPaletteId: null,

  setCurrentHex: (hex: string, source: ColorHistorySource = 'studio') => {
    const norm = normalizeHex(hex, true)
    set({
      currentHex: norm,
      colorSpaceValues: getColorSpaceValues(norm),
    })

    if (get().settings.autoSaveHistory) queueHistoryWrite(norm, source)
  },

  setCurrentColor: (hex: string, source?: ColorHistorySource) => {
    get().setCurrentHex(hex, source)
  },

  copyColor: async (value: string, label?: string) => {
    const { settings } = get()
    let textToCopy = value

    // If copying hex and stripHash is enabled, remove leading #
    if (value.startsWith('#') && settings.stripHash) {
      textToCopy = value.slice(1)
    }

    const displayLabel = label || t('tools.color.studio.seed_color')
    try {
      await navigator.clipboard.writeText(textToCopy)
      useUi.getState().toast({
        title: t('tools.color.toast.copied', { label: displayLabel, value: textToCopy }),
        tone: 'success',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.color.toast.copy_failed'),
        tone: 'danger',
      })
    }
  },

  setTraditionalTab: (tab: 'chinese' | 'nippon') => set({ traditionalTab: tab }),
  setColorHuntTagFilter: (tag: string) => set({ colorHuntTagFilter: tag }),

  fetchSettings: async () => {
    try {
      const settings = await colorApi.getSettings()
      set({ settings })
    } catch {
      // Best effort
    }
  },

  updateSettings: async (partial: Partial<ColorSettings>) => {
    try {
      const updated = await colorApi.updateSettings(partial)
      set({ settings: updated })
      useUi.getState().toast({
        title: t('tools.color.toast.settings_updated'),
        tone: 'success',
      })
    } catch (e: unknown) {
      const err = e as Error
      useUi.getState().toast({
        title: err.message || t('tools.color.toast.settings_update_failed'),
        tone: 'danger',
      })
    }
  },

  fetchFavorites: async () => {
    set({ isLoadingFavorites: true })
    try {
      const favorites = await colorApi.listFavorites()
      set({ favorites, isLoadingFavorites: false, favoritesLoadFailed: false })
    } catch {
      // Swallowing the reason silently showed "nothing saved yet" over a failed request, which reads as
      // the collection being gone. The panel names the failure and offers the same fetch again.
      set({ isLoadingFavorites: false, favoritesLoadFailed: true })
    }
  },

  addFavorite: async (hex: string, name = '', tags: string[] = []) => {
    try {
      const created = await colorApi.createFavorite({ hex, name, tags })
      set((state) => ({ favorites: [created, ...state.favorites] }))
      useUi.getState().toast({
        title: t('tools.color.toast.favorite_added', { hex: created.hex }),
        tone: 'success',
      })
    } catch (e: unknown) {
      const err = e as Error
      useUi.getState().toast({
        title: err.message || t('tools.color.toast.favorite_add_failed'),
        tone: 'danger',
      })
    }
  },

  updateFavorite: async (id: string, patch) => {
    try {
      const updated = await colorApi.updateFavorite(id, patch)
      set((state) => ({ favorites: state.favorites.map((f) => (f.id === id ? updated : f)) }))
      useUi.getState().toast({ title: t('tools.color.toast.favorite_updated'), tone: 'success' })
      return true
    } catch (e: unknown) {
      const err = e as Error
      useUi.getState().toast({
        title: err.message || t('tools.color.toast.favorite_update_failed'),
        tone: 'danger',
      })
      return false
    }
  },

  moveFavorite: async (id: string, delta: number) => {
    const current = get().favorites
    const next = movedBefore(current, id, delta)
    if (!next) return
    // Optimistic: a reorder that waits for the server before it paints looks like the click did nothing.
    set({ favorites: next })
    try {
      set({ favorites: await colorApi.reorderFavorites(next.map((item) => item.id)) })
    } catch {
      set({ favorites: current })
      useUi.getState().toast({ title: t('tools.color.toast.order_save_failed'), tone: 'danger' })
    }
  },

  removeFavorite: async (id: string) => {
    try {
      await colorApi.deleteFavorite(id)
      set((state) => ({ favorites: state.favorites.filter((f) => f.id !== id) }))
      useUi.getState().toast({
        title: t('tools.color.toast.favorite_removed'),
        tone: 'default',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.color.toast.favorite_remove_failed'),
        tone: 'danger',
      })
    }
  },

  fetchPalettes: async () => {
    set({ isLoadingPalettes: true })
    try {
      const palettes = await colorApi.listPalettes()
      set({ palettes, isLoadingPalettes: false, palettesLoadFailed: false })
    } catch {
      set({ isLoadingPalettes: false, palettesLoadFailed: true })
    }
  },

  savePalette: async (
    title: string,
    colors: PaletteColorItem[],
    sourceType: UserColorPalette['sourceType'] = 'custom',
    tags: string[] = [],
    description = '',
  ) => {
    try {
      const created = await colorApi.createPalette({
        title,
        colors,
        sourceType,
        tags,
        description,
        isFavorite: true,
      })
      set((state) => ({ palettes: [created, ...state.palettes] }))
      useUi.getState().toast({
        title: t('tools.color.toast.palette_saved', { title }),
        tone: 'success',
      })
      return true
    } catch (e: unknown) {
      const err = e as Error
      useUi.getState().toast({
        title: err.message || t('tools.color.toast.palette_save_failed'),
        tone: 'danger',
      })
      return false
    }
  },

  updatePalette: async (id, patch) => {
    try {
      const updated = await colorApi.updatePalette(id, patch)
      set((state) => ({ palettes: state.palettes.map((pal) => (pal.id === id ? updated : pal)) }))
      useUi.getState().toast({ title: t('tools.color.toast.palette_updated'), tone: 'success' })
      return true
    } catch (e: unknown) {
      const err = e as Error
      useUi.getState().toast({
        title: err.message || t('tools.color.toast.palette_update_failed'),
        tone: 'danger',
      })
      return false
    }
  },

  movePalette: async (id: string, delta: number) => {
    const current = get().palettes
    const next = movedBefore(current, id, delta)
    if (!next) return
    set({ palettes: next })
    try {
      set({ palettes: await colorApi.reorderPalettes(next.map((item) => item.id)) })
    } catch {
      set({ palettes: current })
      useUi.getState().toast({ title: t('tools.color.toast.order_save_failed'), tone: 'danger' })
    }
  },

  togglePaletteFavorite: async (id: string) => {
    try {
      const updated = await colorApi.togglePaletteFavorite(id)
      set((state) => ({
        palettes: state.palettes.map((p) => (p.id === id ? updated : p)),
      }))
      useUi.getState().toast({
        title: updated.isFavorite
          ? t('tools.color.toast.palette_favorite_added')
          : t('tools.color.toast.palette_favorite_removed'),
        tone: 'default',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.color.toast.palette_favorite_toggle_failed'),
        tone: 'danger',
      })
    }
  },

  removePalette: async (id: string) => {
    try {
      await colorApi.deletePalette(id)
      set((state) => ({ palettes: state.palettes.filter((p) => p.id !== id) }))
      useUi.getState().toast({
        title: t('tools.color.toast.palette_deleted'),
        tone: 'default',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.color.toast.palette_delete_failed'),
        tone: 'danger',
      })
    }
  },

  fetchHistory: async () => {
    try {
      const history = await colorApi.listHistory(COLOR_HISTORY_WINDOW)
      set({ history })
    } catch {
      // Best effort
    }
  },

  clearHistory: async () => {
    try {
      await colorApi.clearHistory()
      set({ history: [] })
      // The trail is empty now, so the next color is worth recording even if it was the last one logged.
      lastLoggedHex = null
      useUi.getState().toast({
        title: t('tools.color.toast.history_cleared'),
        tone: 'default',
      })
    } catch {
      // Best effort
    }
  },

  openContrastModal: () => set({ isContrastModalOpen: true }),
  closeContrastModal: () => set({ isContrastModalOpen: false }),
  openTokenScaleModal: () => set({ isTokenScaleModalOpen: true }),
  closeTokenScaleModal: () => set({ isTokenScaleModalOpen: false }),
  openColorBlindnessModal: () => set({ isColorBlindnessModalOpen: true }),
  closeColorBlindnessModal: () => set({ isColorBlindnessModalOpen: false }),
  openCreatePaletteModal: () => set({ isCreatePaletteModalOpen: true }),
  closeCreatePaletteModal: () => set({ isCreatePaletteModalOpen: false }),
  openExportPaletteModal: (palette) =>
    set({ isExportPaletteModalOpen: true, exportTargetPalette: palette }),
  closeExportPaletteModal: () =>
    set({ isExportPaletteModalOpen: false, exportTargetPalette: null }),

  openEditFavorite: (id: string) => set({ editingFavoriteId: id }),
  closeEditFavorite: () => set({ editingFavoriteId: null }),
  openEditPalette: (id: string) => set({ editingPaletteId: id }),
  closeEditPalette: () => set({ editingPaletteId: null }),
}))
