import { create } from 'zustand'
import { isHexInkColor } from '../../lib/inkpad/hex-color'
import type { InkPaperStyle } from '../../lib/inkpad/types'

export type InkPressureResponse = 'fixed' | 'subtle' | 'natural'
export type InkCanvasBackground = 'theme' | 'dark'

export interface InkSettingsState {
    /** Folder a new file lands in when no explicit folder is named: id or name; empty means the current location. */
    folder: string
    filenamePrefix: string
    filenameDateFormat: string
    useInkExtension: boolean
    autoSaveIntervalMs: number
    /** `auto` follows the theme's text colour; a custom value is always hex. */
    defaultColor: 'auto' | string
    paperStyle: InkPaperStyle
    pressureResponse: InkPressureResponse
    canvasBackground: InkCanvasBackground
    openInAdjacentPane: boolean
    updateSettings: (partial: Partial<Omit<InkSettingsState, 'updateSettings' | 'resetSettings'>>) => void
    resetSettings: () => void
}

const STORAGE_KEY = 'inkstone:inkpad-settings'
const PAPER_STYLES: readonly InkPaperStyle[] = ['grid', 'dots', 'lines', 'cornell', 'music', 'weekly', 'blank']
const PRESSURE_RESPONSES: readonly InkPressureResponse[] = ['fixed', 'subtle', 'natural']
const CANVAS_BACKGROUNDS: readonly InkCanvasBackground[] = ['theme', 'dark']

export const DEFAULT_INK_SETTINGS = {
    folder: '',
    filenamePrefix: 'Ink ',
    filenameDateFormat: 'YYYY-MM-DD HH.mm.ss',
    useInkExtension: true,
    autoSaveIntervalMs: 2000,
    defaultColor: 'auto' as 'auto' | string,
    paperStyle: 'grid' as InkPaperStyle,
    pressureResponse: 'subtle' as InkPressureResponse,
    canvasBackground: 'theme' as InkCanvasBackground,
    openInAdjacentPane: true,
}

/**
 * The delay every ink editor waits before writing its body. The field carries a range, but a
 * restored value or another device's write bypasses the widget; the clamp lives where the delay
 * is read, so a half-typed or stale number can never reach a writer.
 */
export function inkAutoSaveDelayMs(value: unknown): number {
    const numeric = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_INK_SETTINGS.autoSaveIntervalMs
    return Math.min(5000, Math.max(1800, numeric))
}

function sanitize(parsed: Record<string, unknown>, fallback: typeof DEFAULT_INK_SETTINGS): typeof DEFAULT_INK_SETTINGS {
    const next = { ...fallback }
    if (typeof parsed.folder === 'string') next.folder = parsed.folder.trim().slice(0, 120)
    if (typeof parsed.filenamePrefix === 'string') next.filenamePrefix = parsed.filenamePrefix.slice(0, 80)
    if (typeof parsed.filenameDateFormat === 'string') next.filenameDateFormat = parsed.filenameDateFormat.slice(0, 80)
    if (typeof parsed.useInkExtension === 'boolean') next.useInkExtension = parsed.useInkExtension
    if (typeof parsed.autoSaveIntervalMs === 'number' && Number.isFinite(parsed.autoSaveIntervalMs) && parsed.autoSaveIntervalMs > 0) {
        next.autoSaveIntervalMs = parsed.autoSaveIntervalMs
    }
    if (parsed.defaultColor === 'auto' || isHexInkColor(parsed.defaultColor)) next.defaultColor = parsed.defaultColor
    if (PAPER_STYLES.includes(parsed.paperStyle as InkPaperStyle)) next.paperStyle = parsed.paperStyle as InkPaperStyle
    if (PRESSURE_RESPONSES.includes(parsed.pressureResponse as InkPressureResponse)) {
        next.pressureResponse = parsed.pressureResponse as InkPressureResponse
    }
    if (CANVAS_BACKGROUNDS.includes(parsed.canvasBackground as InkCanvasBackground)) {
        next.canvasBackground = parsed.canvasBackground as InkCanvasBackground
    }
    if (typeof parsed.openInAdjacentPane === 'boolean') next.openInAdjacentPane = parsed.openInAdjacentPane
    return next
}

function loadInitialSettings(): typeof DEFAULT_INK_SETTINGS {
    if (typeof window === 'undefined') return DEFAULT_INK_SETTINGS
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return DEFAULT_INK_SETTINGS
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_INK_SETTINGS
        return sanitize(parsed as Record<string, unknown>, DEFAULT_INK_SETTINGS)
    } catch {
        return DEFAULT_INK_SETTINGS
    }
}

function persistSettings(data: unknown): void {
    if (typeof window === 'undefined') return
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
    }
}

export const useInkSettingsStore = create<InkSettingsState>((set) => ({
    ...loadInitialSettings(),

    updateSettings: (partial) => {
        set((state) => {
            const next = sanitize({ ...state, ...partial } as unknown as Record<string, unknown>, state)
            persistSettings(next)
            return next
        })
    },

    resetSettings: () => {
        persistSettings(DEFAULT_INK_SETTINGS)
        set({ ...DEFAULT_INK_SETTINGS })
    },
}))
