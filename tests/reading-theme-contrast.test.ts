/**
 * The page palettes have to stay readable.
 *
 * A theme that quietly drops to 3.1:1 is the kind of regression nobody notices until they have read a
 * whole chapter with a headache, so the whole table is measured here rather than eyeballed once.
 */
import { describe, expect, it } from 'vitest'
import { READER_THEMES, READER_THEME_ORDER } from '../src/client/features/reading/themes'

function channel(value: number): number {
  const scaled = value / 255
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const digits = hex.replace('#', '')
  const [red, green, blue] = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16))
  return 0.2126 * channel(red!) + 0.7152 * channel(green!) + 0.0722 * channel(blue!)
}

function contrast(a: string, b: string): number {
  const high = Math.max(luminance(a), luminance(b))
  const low = Math.min(luminance(a), luminance(b))
  return (high + 0.05) / (low + 0.05)
}

describe('the contrast maths', () => {
  // Two pairs with published answers, so a mistake in the formula cannot pass the rest of the file.
  it('scores black on white at the ceiling', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1)
  })

  it('sits on the WCAG body-text boundary at #767676', () => {
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
  })
})

describe('the reading palettes', () => {
  for (const name of READER_THEME_ORDER) {
    const theme = READER_THEMES[name]
    it(`keeps ${name} legible`, () => {
      expect(contrast(theme.foreground, theme.background), `${name} body text`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(theme.muted, theme.background), `${name} quiet text`).toBeGreaterThanOrEqual(3)
      expect(contrast(theme.accent, theme.background), `${name} accent`).toBeGreaterThanOrEqual(3)
    })
  }

  it('lists every palette the picker can offer', () => {
    expect([...READER_THEME_ORDER].sort()).toEqual(Object.keys(READER_THEMES).sort())
  })

  it('paints e-ink with no grey at all', () => {
    expect(READER_THEMES.eink.background).toBe('#ffffff')
    expect(READER_THEMES.eink.foreground).toBe('#000000')
    expect(READER_THEMES.eink.dark).toBe(false)
  })
})
