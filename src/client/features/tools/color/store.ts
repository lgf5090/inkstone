/**
 * Reactive state machine for Color Assistant (`tools/color`).
 */

import { create } from 'zustand'
import { getColorSpaceValues, normalizeHex } from '@shared/tools/color/spaces'
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
  activeUiTab: string
  traditionalTab: 'chinese' | 'nippon'
  colorHuntTagFilter: string

  favorites: UserColorFavorite[]
  palettes: UserColorPalette[]
  history: ColorHistoryItem[]
  isLoadingFavorites: boolean
  isLoadingPalettes: boolean

  // Modals visibility
  isContrastModalOpen: boolean
  isTokenScaleModalOpen: boolean
  isRealtimeColorsModalOpen: boolean
  isColorBlindnessModalOpen: boolean
  isCreatePaletteModalOpen: boolean
  isExportPaletteModalOpen: boolean
  exportTargetPalette: { title: string; colors: string[] } | null

  // Actions
  setCurrentHex: (hex: string, source?: string) => void
  setCurrentColor: (hex: string, source?: string) => void
  copyColor: (value: string, label?: string) => Promise<void>
  setActiveUiTab: (tab: string) => void
  setTraditionalTab: (tab: 'chinese' | 'nippon') => void
  setColorHuntTagFilter: (tag: string) => void

  fetchSettings: () => Promise<void>
  updateSettings: (partial: Partial<ColorSettings>) => Promise<void>

  fetchFavorites: () => Promise<void>
  addFavorite: (hex: string, name?: string, tags?: string[]) => Promise<void>
  removeFavorite: (id: string) => Promise<void>

  fetchPalettes: () => Promise<void>
  savePalette: (
    title: string,
    colors: PaletteColorItem[],
    sourceType?: UserColorPalette['sourceType'],
    tags?: string[],
    description?: string,
  ) => Promise<void>
  togglePaletteFavorite: (id: string) => Promise<void>
  removePalette: (id: string) => Promise<void>

  fetchHistory: () => Promise<void>
  clearHistory: () => Promise<void>

  // Modal controls
  openContrastModal: () => void
  closeContrastModal: () => void
  openTokenScaleModal: () => void
  closeTokenScaleModal: () => void
  openRealtimeColorsModal: () => void
  closeRealtimeColorsModal: () => void
  openColorBlindnessModal: () => void
  closeColorBlindnessModal: () => void
  openCreatePaletteModal: () => void
  closeCreatePaletteModal: () => void
  openExportPaletteModal: (palette: { title: string; colors: string[] }) => void
  closeExportPaletteModal: () => void
}

const DEFAULT_HEX = '#627486'

export const useColorStudioStore = create<ColorStudioState>((set, get) => ({
  currentHex: DEFAULT_HEX,
  colorSpaceValues: getColorSpaceValues(DEFAULT_HEX),
  settings: {
    stripHash: false,
    defaultFormat: 'hex',
    defaultUiTab: 'flat_ui',
    autoSaveHistory: true,
    updatedAt: Date.now(),
  },
  activeUiTab: 'flat',
  traditionalTab: 'chinese',
  colorHuntTagFilter: 'all',

  favorites: [],
  palettes: [],
  history: [],
  isLoadingFavorites: false,
  isLoadingPalettes: false,

  isContrastModalOpen: false,
  isTokenScaleModalOpen: false,
  isRealtimeColorsModalOpen: false,
  isColorBlindnessModalOpen: false,
  isCreatePaletteModalOpen: false,
  isExportPaletteModalOpen: false,
  exportTargetPalette: null,

  setCurrentHex: (hex: string, source = 'studio') => {
    const norm = normalizeHex(hex, true)
    set({
      currentHex: norm,
      colorSpaceValues: getColorSpaceValues(norm),
    })

    if (get().settings.autoSaveHistory) {
      colorApi.addHistory(norm, source).then(() => {
        get().fetchHistory()
      }).catch(() => {
        // Best effort
      })
    }
  },

  setCurrentColor: (hex: string, source?: string) => {
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

  setActiveUiTab: (tab: string) => set({ activeUiTab: tab }),
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
      set({ favorites, isLoadingFavorites: false })
    } catch {
      set({ isLoadingFavorites: false })
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
      set({ palettes, isLoadingPalettes: false })
    } catch {
      set({ isLoadingPalettes: false })
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
    } catch (e: unknown) {
      const err = e as Error
      useUi.getState().toast({
        title: err.message || t('tools.color.toast.palette_save_failed'),
        tone: 'danger',
      })
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
      const history = await colorApi.listHistory()
      set({ history })
    } catch {
      // Best effort
    }
  },

  clearHistory: async () => {
    try {
      await colorApi.clearHistory()
      set({ history: [] })
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
  openRealtimeColorsModal: () => set({ isRealtimeColorsModalOpen: true }),
  closeRealtimeColorsModal: () => set({ isRealtimeColorsModalOpen: false }),
  openColorBlindnessModal: () => set({ isColorBlindnessModalOpen: true }),
  closeColorBlindnessModal: () => set({ isColorBlindnessModalOpen: false }),
  openCreatePaletteModal: () => set({ isCreatePaletteModalOpen: true }),
  closeCreatePaletteModal: () => set({ isCreatePaletteModalOpen: false }),
  openExportPaletteModal: (palette) =>
    set({ isExportPaletteModalOpen: true, exportTargetPalette: palette }),
  closeExportPaletteModal: () =>
    set({ isExportPaletteModalOpen: false, exportTargetPalette: null }),
}))
