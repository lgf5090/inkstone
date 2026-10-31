import { create } from 'zustand'
import { PRINT_SHEET_PRESETS } from '@shared/tools/id-photo/presets'
import { BUILTIN_ID_PHOTO_SPECS } from '@shared/tools/id-photo/specs'
import type {
  IdPhotoAdjustOptions,
  IdPhotoExportFormat,
  IdPhotoSpec,
  IdPhotoUserSettings,
  PrintSheetOptions,
} from '@shared/tools/id-photo/types'
import { getIdPhotoSettings, listCustomSpecs } from './api'
import {
  panCrop,
  panPercent,
  percentToCrop,
  rotatedBounds,
  zoomPercentOf,
  type CropRect,
  type Size,
} from './engine/framing'

export type IdPhotoOptionsTab = 'spec' | 'color' | 'framing' | 'retouch' | 'attire'

export interface HeadBoxRatios {
  x: number
  y: number
  width: number
  height: number
}

const MAX_WORKING_EDGE = 2048

export function planSourceResize(width: number, height: number): { width: number; height: number } | null {
  const longest = Math.max(width, height)
  if (!(longest > MAX_WORKING_EDGE) || !(width > 0) || !(height > 0)) return null
  const ratio = MAX_WORKING_EDGE / longest
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  }
}

function clampCropFn(rect: CropRect, layer: Size): CropRect {
  return {
    cropX: Math.min(layer.width - rect.cropWidth, Math.max(0, rect.cropX)),
    cropY: Math.min(layer.height - rect.cropHeight, Math.max(0, rect.cropY)),
    cropWidth: rect.cropWidth,
    cropHeight: rect.cropHeight,
  }
}

function cropRectOf(adjustOptions: IdPhotoAdjustOptions, layer: Size): CropRect | null {
  const { cropX, cropY, cropWidth, cropHeight } = adjustOptions
  if (cropX === undefined || cropY === undefined || !cropWidth || !cropHeight) return null
  return clampCropFn({ cropX, cropY, cropWidth, cropHeight }, layer)
}

function downscale(image: HTMLImageElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable while preparing the working image')
  }
  ctx.drawImage(image, 0, 0, width, height)
  return canvas
}

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

const PAPER_SIZES = PRINT_SHEET_PRESETS.map((preset) => preset.id)

const EXPORT_FORMATS: readonly IdPhotoExportFormat[] = ['jpg', 'jpeg', 'png', 'webp']
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export const DEFAULT_PRINT_OPTIONS: PrintSheetOptions = {
  paperSize: '6inch',
  orientation: 'portrait',
  gapMm: 2,
  marginMm: 4,
  showCropMarks: true,
  dpi: 300,
}

export interface IdPhotoExportResult {
  bytes: number
  format: IdPhotoExportFormat
  targetKb?: number
  exceededTarget: boolean
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
  imageElement: HTMLImageElement | HTMLCanvasElement | null
  sourceSize: { width: number; height: number } | null
  workingSize: Size | null
  framingLayer: () => Size | null
  cropRect: () => CropRect | null
  headBox: HeadBoxRatios | null
  setHeadBox: (box: HeadBoxRatios | null) => void
  cropPercents: () => { zoom: number; x: number; y: number } | null
  setCropPercents: (zoom: number, x: number, y: number) => void
  panByRatio: (dx: number, dy: number) => void
  resetCrop: () => void
  setImageSrc: (src: string | null) => Promise<boolean>

  // Spec Selection
  selectedSpecId: string
  customSpecs: IdPhotoSpec[]
  setSelectedSpecId: (specId: string) => void
  getActiveSpec: () => IdPhotoSpec
  loadCustomSpecs: () => Promise<void>
  loadPreferences: () => Promise<void>
  applyUserSettings: (settings: IdPhotoUserSettings) => void

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

  lastExport: IdPhotoExportResult | null
  setLastExport: (result: IdPhotoExportResult | null) => void

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
  sourceSize: null,
  setImageSrc: (src) => {
    const uncrop = (options: IdPhotoAdjustOptions): IdPhotoAdjustOptions => ({
      ...options,
      cropX: undefined,
      cropY: undefined,
      cropWidth: undefined,
      cropHeight: undefined,
    })
    if (!src) {
      set((s) => ({
        imageSrc: null,
        originalImageSrc: null,
        imageElement: null,
        sourceSize: null,
        workingSize: null,
        lastExport: null,
        headBox: null,
        adjustOptions: uncrop(s.adjustOptions),
      }))
      return Promise.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      const img = new Image()
      img.onload = () => {
        const plan = planSourceResize(img.naturalWidth, img.naturalHeight)
        const working = plan ? downscale(img, plan.width, plan.height) : img
        set((s) => ({
          imageSrc: src,
          originalImageSrc: src,
          imageElement: working,
          sourceSize: { width: img.naturalWidth, height: img.naturalHeight },
          workingSize: { width: working.width, height: working.height },
          lastExport: null,
          adjustOptions: uncrop(s.adjustOptions),
        }))
        resolve(true)
      }
      img.onerror = () => resolve(false)
      img.src = src
    })
  },

  selectedSpecId: 'cn_one_inch',
  customSpecs: [],
  setSelectedSpecId: (selectedSpecId) => {
    const spec =
      get().customSpecs.find((s) => s.id === selectedSpecId) ??
      BUILTIN_ID_PHOTO_SPECS.find((s) => s.id === selectedSpecId)

    set((s) => ({
      selectedSpecId,
      ...(spec?.fileSizeMaxKb ? { targetMaxKb: spec.fileSizeMaxKb } : {}),
      adjustOptions: {
        ...s.adjustOptions,
        specId: selectedSpecId,
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

  workingSize: null,

  headBox: null,
  setHeadBox: (headBox) => set({ headBox }),

  framingLayer: () => {
    const { workingSize, adjustOptions } = get()
    if (!workingSize) return null
    return rotatedBounds(workingSize.width, workingSize.height, adjustOptions.rotation ?? 0)
  },

  cropRect: () => {
    const layer = get().framingLayer()
    if (!layer) return null
    const manual = cropRectOf(get().adjustOptions, layer)
    if (manual) return manual
    const spec = get().getActiveSpec()
    return percentToCrop(layer, spec.widthPx / spec.heightPx, 0, 50, 50)
  },

  cropPercents: () => {
    const layer = get().framingLayer()
    if (!layer) return null
    const rect = cropRectOf(get().adjustOptions, layer)
    if (!rect) return { zoom: 0, x: 50, y: 50 }
    return { zoom: zoomPercentOf(rect, layer, rect.cropWidth / rect.cropHeight), ...panPercent(rect, layer) }
  },

  panByRatio: (dx, dy) => {
    const layer = get().framingLayer()
    const rect = get().cropRect()
    if (!layer || !rect) return
    set((s) => ({ adjustOptions: { ...s.adjustOptions, ...panCrop(rect, layer, dx * rect.cropWidth, dy * rect.cropHeight) } }))
  },

  setCropPercents: (zoom, x, y) =>
    set((s) => {
      const layer = s.framingLayer()
      if (!layer) return s
      const rect = percentToCrop(layer, s.getActiveSpec().widthPx / s.getActiveSpec().heightPx, zoom, x, y)
      return { adjustOptions: { ...s.adjustOptions, ...rect } }
    }),

  resetCrop: () =>
    set((s) => ({
      adjustOptions: {
        ...s.adjustOptions,
        cropX: undefined,
        cropY: undefined,
        cropWidth: undefined,
        cropHeight: undefined,
      },
    })),

  loadCustomSpecs: async () => {
    set({ customSpecs: await listCustomSpecs() })
  },

  loadPreferences: async () => {
    get().applyUserSettings(await getIdPhotoSettings())
  },

  applyUserSettings: (settings) =>
    set((s) => {
      if (s.imageSrc) return {}
      const knownSpec = [
        ...s.customSpecs,
        ...BUILTIN_ID_PHOTO_SPECS,
      ].some((spec) => spec.id === settings.defaultSpecId)
      const selectedSpecId = knownSpec ? settings.defaultSpecId : s.selectedSpecId
      const bgColor = HEX_COLOR.test(settings.defaultBgColor)
        ? settings.defaultBgColor
        : s.adjustOptions.bgColor
      const defaultFormat = settings.defaultExportFormat as IdPhotoExportFormat
      const exportFormat = EXPORT_FORMATS.includes(defaultFormat) ? defaultFormat : s.exportFormat
      const paperSize = PAPER_SIZES.includes(settings.printPaperSize)
        ? settings.printPaperSize
        : s.printOptions.paperSize

      return {
        selectedSpecId,
        adjustOptions: { ...s.adjustOptions, specId: selectedSpecId, bgColor },
        exportFormat,
        printOptions: { ...s.printOptions, paperSize },
      }
    }),

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

  lastExport: null,
  setLastExport: (lastExport) => set({ lastExport }),

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
