import { describe, expect, it } from 'vitest'
import {
  colorContrast,
  FORMAT_COLOR_STORAGE_KEY,
  HIGHLIGHT_COLORS,
  isColorUsable,
  loadRecentColors,
  paletteOf,
  pushRecentColor,
  swatchColor,
  TEXT_COLORS,
} from './format-colors'

describe('colour guard', () => {
  it('refuses a text colour that matches the page', () => {
    expect(isColorUsable('text', '#ffffff', 'rgb(255, 255, 255)')).toBe(false)
    expect(isColorUsable('text', '#e11d48', 'rgb(255, 255, 255)')).toBe(true)
    expect(isColorUsable('text', '#e11d48', 'rgb(24, 24, 27)')).toBe(true)
  })

  it('refuses a wash whose hue sits on the page', () => {
    expect(isColorUsable('highlight', '#f5f5f5', 'rgb(250, 250, 250)')).toBe(false)
    expect(isColorUsable('highlight', '#facc15', 'rgb(250, 250, 250)')).toBe(true)
  })

  it('reads an unresolvable surface as unknown rather than as a failure', () => {
    expect(isColorUsable('text', '#e11d48', '')).toBe(true)
    expect(colorContrast('#e11d48', 'var(--bg-base)')).toBeNull()
  })
})

describe('palettes', () => {
  it('offers every colour in the form the command writes', () => {
    expect(paletteOf('text')).toBe(TEXT_COLORS)
    expect(paletteOf('highlight')).toBe(HIGHLIGHT_COLORS)
    expect(TEXT_COLORS.length).toBeGreaterThanOrEqual(12)
    expect(HIGHLIGHT_COLORS.length).toBeGreaterThanOrEqual(8)
    for (const color of [...TEXT_COLORS, ...HIGHLIGHT_COLORS]) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/)
      expect(swatchColor('text', color)).toBe(color)
      expect(swatchColor('highlight', color)).toMatch(/^#[0-9a-f]{8}$/)
    }
  })
})

function stored(): { text?: unknown[]; highlight?: unknown[] } {
  return JSON.parse(localStorage.getItem(FORMAT_COLOR_STORAGE_KEY) ?? '{}') as { text?: unknown[]; highlight?: unknown[] }
}

function fakeStorage(value: string): Storage {
  return { getItem: () => value } as unknown as Storage
}

describe('recent colours', () => {
  it('keeps the newest pick first and never repeats one', () => {
    pushRecentColor('text', '#e11d48')
    pushRecentColor('text', '#2563eb')
    pushRecentColor('text', '#e11d48')
    expect((stored().text ?? []).slice(0, 2)).toEqual(['#e11d48', '#2563eb'])
    expect((stored().text ?? []).filter(item => item === '#e11d48')).toHaveLength(1)
  })

  it('keeps a custom hex and drops what is neither a preset nor a hex', () => {
    pushRecentColor('text', 'red')
    pushRecentColor('text', 'javascript:alert(1)')
    pushRecentColor('text', '#fff; @import url(x)')
    expect((stored().text ?? []).some(item => String(item).includes('javascript') || String(item).includes('@import'))).toBe(false)
    pushRecentColor('highlight', '#12ab65')
    expect(stored().highlight?.[0]).toBe('#12ab65')
  })

  it('caps the list at eight', () => {
    for (let index = 0; index < 12; index++)
      pushRecentColor('text', `#0a0b${index.toString(16).padStart(2, '0')}`)
    expect(stored().text).toHaveLength(8)
    expect(stored().text?.[0]).toBe('#0a0b0b')
  })

  it('reads a stored list back through the same rules it was written with', () => {
    const parsed = loadRecentColors(fakeStorage('{"text":[3,"#e11d48","#e11d48","#fff;@import(url)"],"highlight":"nope"}'))
    expect(parsed.text).toEqual(['#e11d48'])
    expect(parsed.highlight).toEqual([])
  })

  it('falls back to an empty store when the value is not JSON at all', () => {
    expect(loadRecentColors(fakeStorage('not json'))).toEqual({ text: [], highlight: [] })
    expect(loadRecentColors(null)).toEqual({ text: [], highlight: [] })
  })
})
