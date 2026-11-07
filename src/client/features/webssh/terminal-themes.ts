/**
 * Two terminal palettes, both built from the Inkstone surface values. "Follow" picks the palette that
 * matches the app's light/dark theme; the explicit presets let a reader keep a dark terminal inside a
 * light shell. ANSI colours are fixed per palette so syntax and command output stay legible either way.
 */
import type { ITheme } from '@xterm/xterm'
import type { TerminalThemeId } from './prefs'
import { mergeTerminalTheme, type TerminalColorOverrides } from './appearance'

const DARK: ITheme = {
  background: '#1e1b19',
  foreground: '#dfdcd6',
  cursor: '#e0664a',
  cursorAccent: '#1e1b19',
  selectionBackground: 'rgba(224, 102, 74, 0.30)',
  selectionInactiveBackground: 'rgba(224, 102, 74, 0.18)',
  black: '#3a3531',
  red: '#e06c5a',
  green: '#8bbf7a',
  yellow: '#d9b45a',
  blue: '#6ba8d6',
  magenta: '#c98bc9',
  cyan: '#6fc3c0',
  white: '#d9d6d0',
  brightBlack: '#7a736c',
  brightRed: '#f08a78',
  brightGreen: '#a8d49a',
  brightYellow: '#eed07a',
  brightBlue: '#8fc4ea',
  brightMagenta: '#e0a8e0',
  brightCyan: '#95dedb',
  brightWhite: '#f5f3ef',
}

const LIGHT: ITheme = {
  background: '#fdfcfa',
  foreground: '#2a2523',
  cursor: '#bb4430',
  cursorAccent: '#fdfcfa',
  selectionBackground: 'rgba(187, 68, 48, 0.22)',
  selectionInactiveBackground: 'rgba(187, 68, 48, 0.12)',
  black: '#3a3531',
  red: '#a33327',
  green: '#356f2b',
  yellow: '#7c5f0f',
  blue: '#24578f',
  magenta: '#7d357d',
  cyan: '#1b6666',
  white: '#e9e5de',
  brightBlack: '#6b645d',
  brightRed: '#c24534',
  brightGreen: '#4a8a3d',
  brightYellow: '#97751c',
  brightBlue: '#336fb0',
  brightMagenta: '#9a4a9a',
  brightCyan: '#2b8080',
  brightWhite: '#f7f5f1',
}

export function resolveTerminalTheme(
  id: TerminalThemeId,
  appIsDark: boolean,
  overrides: TerminalColorOverrides = {},
  surfaceOpacity = 1,
): ITheme {
  const base = id === 'dark' ? DARK : id === 'light' ? LIGHT : appIsDark ? DARK : LIGHT
  return mergeTerminalTheme(base, overrides, surfaceOpacity)
}

export const TERMINAL_THEME_PALETTES = { dark: DARK, light: LIGHT } as const
