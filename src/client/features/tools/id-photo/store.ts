import { create } from 'zustand'
import { BUILTIN_ID_PHOTO_SPECS } from '@shared/tools/id-photo/specs'
import type {
  IdPhotoAdjustOptions,
  IdPhotoExportFormat,
  IdPhotoSpec,
  PrintSheetOptions,
} from '@shared/tools/id-photo/types'
import { listCustomSpecs } from './api'

export type IdPhotoOptionsTab = 'spec' | 'color' | 'retouch' | 'attire' | 'print'

export const DEFAULT_ADJUST_OPTIONS: IdPhotoAdjustOptions = {
  specId: 'cn_one_inch',
  bgColor: '#ffffff',
  bgType: 'solid',
  feathering: 10,
  brightness: 0,
  contrast: 0,
  smoothness: 0,
  whitening: 0,
  sharpness: 0,
  attireId: undefined,
  attireScale: 1.0,
  attireOffsetX: 0,
  attireOffsetY: 0,
  cropX: undefined,
  cropY: undefined,
  cropWidth: undefined,
  cropHeight: undefined,
  rotation: 0,
}

export const DEFAULT_PRINT_OPTIONS: PrintSheetOptions = {
  paperSize: '6inch',
  orientation: 'portrait',
  gapMm: 2,
  marginMm: 4,
  showCropMarks: true,
  dpi: 300,
}

export interface IdPhotoState {
  // Navigation & Tabs
  activeOptionsTab: IdPhotoOptionsTab
  setActiveOptionsTab: (tab: IdPhotoOptionsTab) => void
  optionsAccordionOpen: boolean
  toggleOptionsAccordion: () => void

  // Image Source
  imageSrc: string | null
  originalImageSrc: string | null
  imageElement: HTMLImageElement | null
  setImageSrc: (src: string | null) => void

  // Spec Selection
  selectedSpecId: string
  customSpecs: IdPhotoSpec[]
  setSelectedSpecId: (specId: string) => void
  getActiveSpec: () => IdPhotoSpec
  loadCustomSpecs: () => Promise<void>

  // Adjust Options
  adjustOptions: IdPhotoAdjustOptions
  setAdjustOptions: (patch: Partial<IdPhotoAdjustOptions>) => void
  setBgColor: (color: string, isGradient?: boolean, endColor?: string) => void
  resetAdjustOptions: () => void
  rotateImage: (deltaDegrees: number) => void

  // Print Sheet Options
  printOptions: PrintSheetOptions
  setPrintOptions: (patch: Partial<PrintSheetOptions>) => void

  // Export Settings
  exportFormat: IdPhotoExportFormat
  setExportFormat: (format: IdPhotoExportFormat) => void
  targetMaxKb: number | undefined
  setTargetMaxKb: (kb: number | undefined) => void

  // View toggles
  guidesVisible: boolean
  toggleGuides: () => void
  fullscreenModalOpen: boolean
  setFullscreenModalOpen: (open: boolean) => void
  customSpecModalOpen: boolean
  setCustomSpecModalOpen: (open: boolean) => void
}

export const useIdPhotoStore = create<IdPhotoState>((set, get) => ({
  activeOptionsTab: 'spec',
  setActiveOptionsTab: (activeOptionsTab) => set({ activeOptionsTab }),
  optionsAccordionOpen: true,
  toggleOptionsAccordion: () => set((s) => ({ optionsAccordionOpen: !s.optionsAccordionOpen })),

  imageSrc: null,
  originalImageSrc: null,
  imageElement: null,
  setImageSrc: (src) => {
    if (!src) {
      set({ imageSrc: null, originalImageSrc: null, imageElement: null })
      return
    }
    const img = new Image()
    img.onload = () => {
      set({
        imageSrc: src,
        originalImageSrc: get().originalImageSrc ?? src,
        imageElement: img,
      })
    }
    img.src = src
  },

  selectedSpecId: 'cn_one_inch',
  customSpecs: [],
  setSelectedSpecId: (selectedSpecId) => {
    const spec =
      get().customSpecs.find((s) => s.id === selectedSpecId) ??
      BUILTIN_ID_PHOTO_SPECS.find((s) => s.id === selectedSpecId)

    const defaultBg = spec?.recommendedBgColors?.[0] ?? '#ffffff'
    set((s) => ({
      selectedSpecId,
      adjustOptions: {
        ...s.adjustOptions,
        specId: selectedSpecId,
        bgColor: defaultBg,
        cropX: undefined,
        cropY: undefined,
        cropWidth: undefined,
        cropHeight: undefined,
      },
    }))
  },

  getActiveSpec: () => {
    const { selectedSpecId, customSpecs } = get()
    const custom = customSpecs.find((s) => s.id === selectedSpecId)
    if (custom) return custom
    const builtin = BUILTIN_ID_PHOTO_SPECS.find((s) => s.id === selectedSpecId)
    return builtin ?? BUILTIN_ID_PHOTO_SPECS[0]
  },

  loadCustomSpecs: async () => {
    try {
      const specs = await listCustomSpecs()
      set({ customSpecs: specs })
    } catch {
      // Best effort load
    }
  },

  adjustOptions: { ...DEFAULT_ADJUST_OPTIONS },
  setAdjustOptions: (patch) =>
    set((s) => ({
      adjustOptions: { ...s.adjustOptions, ...patch },
    })),

  setBgColor: (bgColor, isGradient = false, endColor) =>
    set((s) => ({
      adjustOptions: {
        ...s.adjustOptions,
        bgColor,
        bgType: isGradient ? 'gradient' : 'solid',
        bgGradientEndColor: endColor,
      },
    })),

  resetAdjustOptions: () =>
    set((s) => ({
      adjustOptions: {
        ...DEFAULT_ADJUST_OPTIONS,
        specId: s.selectedSpecId,
      },
    })),

  rotateImage: (delta) =>
    set((s) => {
      const current = s.adjustOptions.rotation ?? 0
      const next = (current + delta + 360) % 360
      return {
        adjustOptions: {
          ...s.adjustOptions,
          rotation: next,
        },
      }
    }),

  printOptions: { ...DEFAULT_PRINT_OPTIONS },
  setPrintOptions: (patch) =>
    set((s) => ({
      printOptions: { ...s.printOptions, ...patch },
    })),

  exportFormat: 'jpg',
  setExportFormat: (exportFormat) => set({ exportFormat }),
  targetMaxKb: undefined,
  setTargetMaxKb: (targetMaxKb) => set({ targetMaxKb }),

  guidesVisible: true,
  toggleGuides: () => set((s) => ({ guidesVisible: !s.guidesVisible })),
  fullscreenModalOpen: false,
  setFullscreenModalOpen: (fullscreenModalOpen) => set({ fullscreenModalOpen }),
  customSpecModalOpen: false,
  setCustomSpecModalOpen: (customSpecModalOpen) => set({ customSpecModalOpen }),
}))
