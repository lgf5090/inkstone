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
import { applyControlModifier, applyModifiers } from '../src/client/features/webssh/MobileKeyBar'
import { resolveTerminalTheme, TERMINAL_THEME_PALETTES } from '../src/client/features/webssh/terminal-themes'
import {
  DEFAULT_APPEARANCE,
  mergeTerminalTheme,
  parseAppearance,
  parseTerminalColorsFile,
  exportTerminalColors,
} from '../src/client/features/webssh/appearance'
import {
  DEFAULT_QUICK_COMMANDS,
  currentLineAt,
  parseQuickCommands,
} from '../src/client/features/webssh/quick-commands'

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

  it('sends Alt as the ESC prefix and gives Ctrl+Alt its arrow form', () => {
    expect(applyModifiers('a', false, true)).toBe('\x1ba')
    expect(applyModifiers('r', true, false)).toBe('\x12')
    expect(applyModifiers('\x1b[A', true, true)).toBe('\x1b[1;7A')
    expect(applyModifiers('\x1b[B', false, true)).toBe('\x1b\x1b[B')
    expect(applyModifiers('x', false, false)).toBe('x')
  })
})

describe('appearance', () => {
  it('falls back on a broken record and clamps the two sliders', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE)
    expect(parseAppearance('not json')).toEqual(DEFAULT_APPEARANCE)
    const parsed = parseAppearance(JSON.stringify({ siteName: '  Lab  ', background: 'data:text/html;base64,AAAA', surfaceOpacity: 0.1, spacing: 99, terminalColors: { background: '#ABCDEF', cursor: 'red' } }))
    expect(parsed.siteName).toBe('Lab')
    expect(parsed.background).toBeNull()
    expect(parsed.surfaceOpacity).toBe(0.35)
    expect(parsed.spacing).toBe(16)
    expect(parsed.terminalColors).toEqual({ background: '#abcdef' })
  })

  it('merges a colour overlay and leaves the base palette untouched without one', () => {
    expect(mergeTerminalTheme(TERMINAL_THEME_PALETTES.dark, {}, 1)).toBe(TERMINAL_THEME_PALETTES.dark)
    const translucent = mergeTerminalTheme(TERMINAL_THEME_PALETTES.dark, {}, 0.8)
    expect(translucent.background).toBe('rgba(30, 27, 25, 0.8)')
    const custom = mergeTerminalTheme(TERMINAL_THEME_PALETTES.dark, { foreground: '#ffffff', cursor: '#ff0000' }, 1)
    expect(custom.foreground).toBe('#ffffff')
    expect(custom.cursor).toBe('#ff0000')
  })

  it('round-trips a colour file and rejects an empty one', () => {
    expect(parseTerminalColorsFile(exportTerminalColors({ background: '#112233' }))).toEqual({ background: '#112233' })
    expect(parseTerminalColorsFile(exportTerminalColors({}))).toBeNull()
    expect(parseTerminalColorsFile('not json')).toBeNull()
  })
})

describe('quick commands', () => {
  it('seeds the shipped presets only when nothing is stored', () => {
    expect(parseQuickCommands(null)).toEqual([...DEFAULT_QUICK_COMMANDS])
    expect(parseQuickCommands('[]')).toEqual([])
    expect(parseQuickCommands(JSON.stringify([{ id: 'x', title: 'Run', command: 'echo ok', category: 'custom', favorite: true }]))).toHaveLength(1)
    expect(parseQuickCommands(JSON.stringify([{ id: 'x', command: '', category: 'custom' }]))).toEqual([])
  })

  it('returns the line under the caret', () => {
    expect(currentLineAt('one\ntwo\nthree', 5)).toBe('two')
    expect(currentLineAt('one\ntwo', 0)).toBe('one')
    expect(currentLineAt('one\ntwo', 7)).toBe('two')
  })
})
