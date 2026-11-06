import { describe, expect, it } from 'vitest'
import { nextRetryDecision, MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAYS_MS } from '../src/client/features/webssh/session-retry'
import {
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_SETTINGS_STORAGE_KEY,
  loadTerminalSettings,
  parseTerminalSettings,
  saveTerminalSettings,
} from '../src/client/features/webssh/prefs'
import { applyControlModifier } from '../src/client/features/webssh/MobileKeyBar'
import { resolveTerminalTheme, TERMINAL_THEME_PALETTES } from '../src/client/features/webssh/terminal-themes'

describe('the reconnect ladder', () => {
  it('waits 1s, 2s and 4s, then gives up', () => {
    expect(nextRetryDecision(1)).toEqual({ action: 'retry', attempt: 1, delayMs: 1000 })
    expect(nextRetryDecision(2)).toEqual({ action: 'retry', attempt: 2, delayMs: 2000 })
    expect(nextRetryDecision(3)).toEqual({ action: 'retry', attempt: 3, delayMs: 4000 })
    expect(nextRetryDecision(4)).toEqual({ action: 'exhausted', attempt: MAX_RECONNECT_ATTEMPTS })
    expect(RECONNECT_DELAYS_MS).toHaveLength(MAX_RECONNECT_ATTEMPTS)
  })
})

describe('terminal preferences', () => {
  it('falls back field by field on missing or broken values', () => {
    expect(parseTerminalSettings(null)).toEqual(DEFAULT_TERMINAL_SETTINGS)
    expect(parseTerminalSettings('not json')).toEqual(DEFAULT_TERMINAL_SETTINGS)
    expect(parseTerminalSettings(JSON.stringify({ theme: 'purple', fontSize: 'large' }))).toEqual(DEFAULT_TERMINAL_SETTINGS)
    expect(parseTerminalSettings(JSON.stringify({ theme: 'dark' }))).toEqual({ theme: 'dark', fontSize: DEFAULT_TERMINAL_SETTINGS.fontSize })
  })

  it('clamps a font size to the slider range and rounds fractions', () => {
    expect(parseTerminalSettings(JSON.stringify({ fontSize: 8 })).fontSize).toBe(TERMINAL_FONT_SIZE_MIN)
    expect(parseTerminalSettings(JSON.stringify({ fontSize: 30 })).fontSize).toBe(TERMINAL_FONT_SIZE_MAX)
    expect(parseTerminalSettings(JSON.stringify({ fontSize: 14.6 })).fontSize).toBe(15)
  })

  it('round-trips through localStorage', () => {
    localStorage.removeItem(TERMINAL_SETTINGS_STORAGE_KEY)
    saveTerminalSettings({ theme: 'light', fontSize: 18 })
    expect(loadTerminalSettings()).toEqual({ theme: 'light', fontSize: 18 })
    localStorage.removeItem(TERMINAL_SETTINGS_STORAGE_KEY)
  })
})

describe('terminal themes', () => {
  it('follows the app theme unless an explicit palette is chosen', () => {
    expect(resolveTerminalTheme('follow', true)).toBe(TERMINAL_THEME_PALETTES.dark)
    expect(resolveTerminalTheme('follow', false)).toBe(TERMINAL_THEME_PALETTES.light)
    expect(resolveTerminalTheme('dark', false)).toBe(TERMINAL_THEME_PALETTES.dark)
    expect(resolveTerminalTheme('light', true)).toBe(TERMINAL_THEME_PALETTES.light)
  })

  it('keeps the two palettes visually distinct', () => {
    expect(TERMINAL_THEME_PALETTES.dark.background).not.toBe(TERMINAL_THEME_PALETTES.light.background)
    expect(TERMINAL_THEME_PALETTES.dark.foreground).not.toBe(TERMINAL_THEME_PALETTES.light.foreground)
    expect(TERMINAL_THEME_PALETTES.dark.background).toBe('#1e1b19')
    expect(TERMINAL_THEME_PALETTES.light.background).toBe('#fdfcfa')
  })
})

describe('the mobile Ctrl modifier', () => {
  it('turns a letter into its control byte and leaves other keys alone', () => {
    expect(applyControlModifier('c')).toBe('\x03')
    expect(applyControlModifier('d')).toBe('\x04')
    expect(applyControlModifier('z')).toBe('\x1a')
    expect(applyControlModifier('|')).toBe('|')
    expect(applyControlModifier('\x1b[A')).toBe('\x1b[A')
  })
})
