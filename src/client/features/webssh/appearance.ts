/**
 * The WebSSH surface a reader styles for themselves: the site label, the paper behind the terminal,
 * how far the terminal pane is inset, and a small terminal palette overlay. Everything lives in
 * localStorage because none of it belongs to an account or to a host, and nothing here is secret.
 *
 * Terminal colours are an overlay, not a replacement: the built-in dark/light/follow palettes stay the
 * base, and a reader's choices are merged on top of whichever one is active. Import and export carry
 * only that overlay, so a palette file can never smuggle a background image or a site name into
 * another browser.
 */
import type { ITheme } from '@xterm/xterm'
import type { CSSProperties } from 'react'

export const APPEARANCE_STORAGE_KEY = 'inkstone.webssh.appearance'
export const MAX_BACKGROUND_BYTES = 2 * 1024 * 1024
export const SURFACE_OPACITY_MIN = 0.35
export const LAYOUT_SPACING_MAX = 16
export const SITE_NAME_MAX_LENGTH = 40

export type TerminalColorKey = 'background' | 'foreground' | 'cursor' | 'selectionBackground'

export interface TerminalColorOverrides {
  background?: string
  foreground?: string
  cursor?: string
  selectionBackground?: string
}

export interface WebsshAppearance {
  /** An empty value means the translated app title; a site name never replaces the control labels. */
  siteName: string
  /** A data URL, validated to an image type and a two-megabyte ceiling before it is stored. */
  background: string | null
  /** The terminal's own background alpha, so the paper behind it stays visible without dimming text. */
  surfaceOpacity: number
  /** Padding inside the terminal surface, in pixels. */
  spacing: number
  terminalColors: TerminalColorOverrides
}

export const TERMINAL_COLOR_KEYS: readonly TerminalColorKey[] = [
  'background',
  'foreground',
  'cursor',
  'selectionBackground',
]

export const DEFAULT_APPEARANCE: WebsshAppearance = {
  siteName: '',
  background: null,
  surfaceOpacity: 1,
  spacing: 0,
  terminalColors: {},
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const BACKGROUND_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,/i

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value)
}

/** A stored or imported colour is accepted only in the one shape the colour wheel writes. */
export function normalizeColor(value: unknown): string | undefined {
  return typeof value === 'string' && isHexColor(value) ? value.toLowerCase() : undefined
}

export function parseTerminalColors(value: unknown): TerminalColorOverrides {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>
  const next: TerminalColorOverrides = {}
  for (const key of TERMINAL_COLOR_KEYS) {
    const color = normalizeColor(source[key])
    if (color) next[key] = color
  }
  return next
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value * 100) / 100))
}

/** The approximate decoded size of a base64 data URL, so the cap counts pixels rather than characters. */
function dataUrlBytes(url: string): number {
  const comma = url.indexOf(',')
  if (comma < 0) return 0
  const payload = url.slice(comma + 1).replace(/\s+/g, '')
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

export function isValidBackground(value: unknown): value is string {
  return typeof value === 'string'
    && BACKGROUND_DATA_URL.test(value)
    && dataUrlBytes(value) <= MAX_BACKGROUND_BYTES
}

export function parseAppearance(raw: string | null | undefined): WebsshAppearance {
  if (!raw) return { ...DEFAULT_APPEARANCE }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const siteName = typeof parsed.siteName === 'string'
      ? parsed.siteName.trim().slice(0, SITE_NAME_MAX_LENGTH)
      : DEFAULT_APPEARANCE.siteName
    return {
      siteName,
      background: isValidBackground(parsed.background) ? parsed.background : DEFAULT_APPEARANCE.background,
      surfaceOpacity: clampNumber(parsed.surfaceOpacity, SURFACE_OPACITY_MIN, 1, DEFAULT_APPEARANCE.surfaceOpacity),
      spacing: clampNumber(parsed.spacing, 0, LAYOUT_SPACING_MAX, DEFAULT_APPEARANCE.spacing),
      terminalColors: parseTerminalColors(parsed.terminalColors),
    }
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

export function loadAppearance(): WebsshAppearance {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_APPEARANCE }
  return parseAppearance(localStorage.getItem(APPEARANCE_STORAGE_KEY))
}

export function saveAppearance(appearance: WebsshAppearance): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance))
}

/** The CSS variables the workspace and the terminal surface read. */
export function appearanceStyle(appearance: WebsshAppearance): CSSProperties {
  return {
    '--webssh-bg': appearance.background ? `url("${appearance.background}")` : 'none',
    '--webssh-space': `${appearance.spacing}px`,
  } as CSSProperties
}

export function siteTitle(appearance: WebsshAppearance, fallback: string): string {
  return appearance.siteName.trim() || fallback
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const red = Number.parseInt(value.slice(0, 2), 16)
  const green = Number.parseInt(value.slice(2, 4), 16)
  const blue = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

/**
 * Merge the reader's overlay onto a built-in palette. With no overlay and an opaque surface the base
 * palette is returned unchanged, which keeps the default terminal byte-for-byte what it was.
 */
export function mergeTerminalTheme(base: ITheme, overrides: TerminalColorOverrides, surfaceOpacity: number): ITheme {
  const hasOverrides = TERMINAL_COLOR_KEYS.some((key) => overrides[key])
  if (!hasOverrides && surfaceOpacity >= 1) return base
  const next: ITheme = { ...base }
  next.background = overrides.background ?? hexToRgba(base.background ?? '#000000', Math.max(SURFACE_OPACITY_MIN, surfaceOpacity))
  if (overrides.foreground) next.foreground = overrides.foreground
  if (overrides.cursor) next.cursor = overrides.cursor
  if (overrides.selectionBackground) next.selectionBackground = overrides.selectionBackground
  return next
}

/** The palette file carries the overlay alone, so it cannot carry a site name or a background image. */
export function exportTerminalColors(overrides: TerminalColorOverrides): string {
  return JSON.stringify({ version: 1, terminalColors: overrides }, null, 2)
}

export function parseTerminalColorsFile(text: string): TerminalColorOverrides | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const colors = parseTerminalColors(parsed.terminalColors)
    if (!TERMINAL_COLOR_KEYS.some((key) => colors[key])) return null
    return colors
  } catch {
    return null
  }
}
