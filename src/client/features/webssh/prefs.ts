/**
 * Terminal preferences live in localStorage beside the reader, like the editor's own font size: they
 * are a property of this browser, not of an account, and nothing here is secret.
 */
export type TerminalThemeId = 'follow' | 'dark' | 'light'

export interface TerminalSettings {
  theme: TerminalThemeId
  fontSize: number
}

export const TERMINAL_SETTINGS_STORAGE_KEY = 'inkstone.webssh.terminal'
export const TERMINAL_FONT_SIZE_MIN = 11
export const TERMINAL_FONT_SIZE_MAX = 22
export const TERMINAL_FONT_SIZE_DEFAULT = 14

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  theme: 'follow',
  fontSize: TERMINAL_FONT_SIZE_DEFAULT,
}

const THEME_IDS: readonly TerminalThemeId[] = ['follow', 'dark', 'light']

function clampFontSize(value: number): number {
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)))
}

/** Tolerates a missing, truncated or hand-edited value; every rejected field falls back on its own. */
export function parseTerminalSettings(raw: string | null | undefined): TerminalSettings {
  if (!raw) return { ...DEFAULT_TERMINAL_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as { theme?: unknown; fontSize?: unknown }
    const theme = THEME_IDS.includes(parsed.theme as TerminalThemeId)
      ? (parsed.theme as TerminalThemeId)
      : DEFAULT_TERMINAL_SETTINGS.theme
    const fontSize = typeof parsed.fontSize === 'number' && Number.isFinite(parsed.fontSize)
      ? clampFontSize(parsed.fontSize)
      : DEFAULT_TERMINAL_SETTINGS.fontSize
    return { theme, fontSize }
  } catch {
    return { ...DEFAULT_TERMINAL_SETTINGS }
  }
}

export function loadTerminalSettings(): TerminalSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_TERMINAL_SETTINGS }
  return parseTerminalSettings(localStorage.getItem(TERMINAL_SETTINGS_STORAGE_KEY))
}

export function saveTerminalSettings(settings: TerminalSettings): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(TERMINAL_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
}
