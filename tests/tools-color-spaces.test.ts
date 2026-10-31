import { describe, expect, it } from 'vitest'
import {
  getColorSpaceValues,
  hexToRgb,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  rgbToHsv,
  hsvToRgb,
  rgbToCmyk,
  cmykToRgb,
  rgbToLab,
  labToRgb,
  rgbToOklab,
  oklabToRgb,
  deltaE76,
  normalizeHex,
} from '../src/shared/tools/color/spaces'
import { getHarmonies } from '../src/shared/tools/color/harmonies'
import { generateAlgorithmicPalettes } from '../src/shared/tools/color/colorspace-algorithms'
import { interpolateOklab, generateOklabGradientStops, buildCssGradient } from '../src/shared/tools/color/oklab'
import { generateTokenScale, formatAsCssVariables, formatAsTailwindConfig } from '../src/shared/tools/color/token-scale'
import { getContrastRatio, evaluateWcagContrast, simulateColorBlindness } from '../src/shared/tools/color/a11y'
import { extractPaletteFromPixels } from '../src/shared/tools/color/quantize'
import {
  CreateColorFavoriteSchema,
  CreateColorPaletteSchema,
  UpdateColorSettingsSchema,
} from '../src/shared/tools/color/schemas'

describe('Color Assistant: Spaces Math & Conversions', () => {
  it('normalizes hex values properly', () => {
    expect(normalizeHex('#fff')).toBe('#ffffff')
    expect(normalizeHex('abc', false)).toBe('aabbcc')
    expect(normalizeHex('#627486')).toBe('#627486')
    expect(normalizeHex('invalid')).toBe('#000000')
  })

  it('converts HEX <-> RGB reversibly', () => {
    const hex = '#627486'
    const rgb = hexToRgb(hex)
    expect(rgb).toEqual({ r: 98, g: 116, b: 134 })
    expect(rgbToHex(rgb)).toBe(hex)
  })

  it('converts RGB <-> HSL reversibly', () => {
    const rgb = { r: 98, g: 116, b: 134 }
    const hsl = rgbToHsl(rgb)
    const convertedBack = hslToRgb(hsl)
    expect(Math.abs(convertedBack.r - rgb.r)).toBeLessThanOrEqual(2)
    expect(Math.abs(convertedBack.g - rgb.g)).toBeLessThanOrEqual(2)
    expect(Math.abs(convertedBack.b - rgb.b)).toBeLessThanOrEqual(2)
  })

  it('converts RGB <-> HSV reversibly', () => {
    const rgb = { r: 98, g: 116, b: 134 }
    const hsv = rgbToHsv(rgb)
    const convertedBack = hsvToRgb(hsv)
    expect(Math.abs(convertedBack.r - rgb.r)).toBeLessThanOrEqual(1)
    expect(Math.abs(convertedBack.g - rgb.g)).toBeLessThanOrEqual(1)
    expect(Math.abs(convertedBack.b - rgb.b)).toBeLessThanOrEqual(1)
  })

  it('converts RGB <-> CMYK reversibly', () => {
    const rgb = { r: 98, g: 116, b: 134 }
    const cmyk = rgbToCmyk(rgb)
    const convertedBack = cmykToRgb(cmyk)
    expect(Math.abs(convertedBack.r - rgb.r)).toBeLessThanOrEqual(2)
    expect(Math.abs(convertedBack.g - rgb.g)).toBeLessThanOrEqual(2)
    expect(Math.abs(convertedBack.b - rgb.b)).toBeLessThanOrEqual(2)
  })

  it('converts RGB <-> CIE-LAB and OKLab reversibly', () => {
    const rgb = { r: 98, g: 116, b: 134 }
    const lab = rgbToLab(rgb)
    const rgbFromLab = labToRgb(lab)
    expect(Math.abs(rgbFromLab.r - rgb.r)).toBeLessThanOrEqual(2)
    expect(Math.abs(rgbFromLab.g - rgb.g)).toBeLessThanOrEqual(2)
    expect(Math.abs(rgbFromLab.b - rgb.b)).toBeLessThanOrEqual(2)

    const oklab = rgbToOklab(rgb)
    const rgbFromOklab = oklabToRgb(oklab)
    expect(Math.abs(rgbFromOklab.r - rgb.r)).toBeLessThanOrEqual(2)
    expect(Math.abs(rgbFromOklab.g - rgb.g)).toBeLessThanOrEqual(2)
    expect(Math.abs(rgbFromOklab.b - rgb.b)).toBeLessThanOrEqual(2)
  })

  it('calculates Delta E 76 distance', () => {
    const c1 = { r: 255, g: 0, b: 0 }
    const c2 = { r: 255, g: 10, b: 10 }
    const dist = deltaE76(c1, c2)
    expect(dist).toBeGreaterThan(0)
    expect(dist).toBeLessThan(10)
  })

  it('returns the color spaces the interface reads', () => {
    const values = getColorSpaceValues('#627486')
    expect(values.hex).toBe('#627486')
    expect(values.rgb).toEqual({ r: 98, g: 116, b: 134 })
    expect(values.hsl.h).toBe(210)
    expect(values.hsl.s).toBe(16)
    expect(values.hsl.l).toBe(45)
    expect(Number.isInteger(values.hsv.h)).toBe(true)
    expect(values.cmyk).toBeDefined()
    expect(values.lab).toBeDefined()
    expect(values.oklab).toBeDefined()
    // The pre-formatted strings and the HSI triple used to be computed on every color change and read by
    // nobody; the panel builds its own CSS text. Deleting them is only safe while nothing asks for them.
    expect(values).not.toHaveProperty('hexClean')
    expect(values).not.toHaveProperty('hslString')
    expect(values).not.toHaveProperty('hsi')
  })
})

describe('Color Assistant: Harmonies & Algorithmic Generation', () => {
  it('computes 6 harmony groups with expected colors', () => {
    const harmonies = getHarmonies('#627486')
    expect(harmonies).toHaveLength(6)
    const types = harmonies.map((h) => h.type)
    expect(types).toContain('complementary')
    expect(types).toContain('triadic')
    expect(types).toContain('analogous')
    expect(types).toContain('tetradic')
    expect(types).toContain('split_complementary')
    expect(types).toContain('intermediate')
  })

  it('generates 8 MyColorSpace algorithmic palettes with valid hexes', () => {
    const palettes = generateAlgorithmicPalettes('#627486')
    expect(palettes).toHaveLength(8)
    for (const pal of palettes) {
      expect(pal.colors.length).toBeGreaterThanOrEqual(4)
      for (const hex of pal.colors) {
        expect(hex).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })
})

describe('Color Assistant: OKLab Interpolation & Gradients', () => {
  it('interpolates colors smoothly in OKLab space', () => {
    const start = '#0000ff' // Blue
    const end = '#ffff00' // Yellow
    const mid = interpolateOklab(start, end, 0.5)
    expect(mid).toMatch(/^#[0-9a-f]{6}$/)
    // Midpoint in OKLab between blue and yellow is not dead gray
    const rgb = hexToRgb(mid)
    expect(rgb.g).toBeGreaterThan(100)
  })

  it('generates gradient color stops and CSS string', () => {
    const stops = generateOklabGradientStops('#627486', '#ffffff', 4)
    expect(stops).toHaveLength(5)
    expect(stops[0].offset).toBe(0)
    expect(stops[4].offset).toBe(100)

    const css = buildCssGradient({
      type: 'linear',
      angle: 90,
      stops: [
        { id: '1', color: '#627486', offset: 0 },
        { id: '2', color: '#ffffff', offset: 100 },
      ],
      useOklabInterpolation: true,
    })
    expect(css).toContain('linear-gradient(90deg,')
    expect(css).toContain('#627486')
    expect(css).toContain('#ffffff')
  })
})

describe('Color Assistant: Token Scale & A11y Suite', () => {
  it('generates 11 token scale steps from 50 to 950', () => {
    const scale = generateTokenScale('#627486')
    expect(scale).toHaveLength(11)
    expect(scale[0].step).toBe(50)
    expect(scale[10].step).toBe(950)

    // Check luminance decrease from 50 to 950
    const lightStep = scale[0]
    const darkStep = scale[10]
    expect(lightStep.contrastBlack).toBeGreaterThan(darkStep.contrastBlack)
    expect(darkStep.contrastWhite).toBeGreaterThan(lightStep.contrastWhite)

    const tailwind = formatAsTailwindConfig('slate', scale)
    expect(tailwind).toContain('colors')
    expect(tailwind).toContain("'50':")

    const cssVars = formatAsCssVariables('slate', scale)
    expect(cssVars).toContain('--color-slate-50:')
  })

  it('evaluates WCAG 2.1 contrast correctly', () => {
    const contrast = getContrastRatio('#000000', '#ffffff')
    expect(contrast).toBe(21)

    const evalResult = evaluateWcagContrast('#000000', '#ffffff')
    expect(evalResult.score).toBe('AAA')
    expect(evalResult.normalAa).toBe(true)
    expect(evalResult.normalAaa).toBe(true)

    const poorContrast = evaluateWcagContrast('#888888', '#999999')
    expect(poorContrast.score).toBe('Fail')
  })

  it('simulates color blindness', () => {
    const hex = '#ff0000'
    const protan = simulateColorBlindness(hex, 'protanopia')
    const deutan = simulateColorBlindness(hex, 'deuteranopia')
    const tritan = simulateColorBlindness(hex, 'tritanopia')
    const achroma = simulateColorBlindness(hex, 'achromatopsia')

    expect(protan).toMatch(/^#[0-9a-f]{6}$/)
    expect(deutan).toMatch(/^#[0-9a-f]{6}$/)
    expect(tritan).toMatch(/^#[0-9a-f]{6}$/)
    expect(achroma).toMatch(/^#[0-9a-f]{6}$/)
    // Achromatopsia should have equal R, G, B
    const achromaRgb = hexToRgb(achroma)
    expect(achromaRgb.r).toBe(achromaRgb.g)
    expect(achromaRgb.g).toBe(achromaRgb.b)
  })
})

describe('Color Assistant: Quantize (MMCQ) & Schemas', () => {
  it('extracts dominant color and palette from synthetic pixel array', () => {
    // 100 pixels of red and 50 pixels of green
    const pixels: number[] = []
    for (let i = 0; i < 100; i++) {
      pixels.push(220, 40, 40, 255)
    }
    for (let i = 0; i < 50; i++) {
      pixels.push(40, 180, 50, 255)
    }

    const result = extractPaletteFromPixels(pixels, 4)
    expect(result.dominant).toMatch(/^#[0-9a-f]{6}$/)
    expect(result.palette.length).toBeGreaterThanOrEqual(1)
  })

  it('validates API schemas', () => {
    const validFav = CreateColorFavoriteSchema.safeParse({
      name: 'Forest Green',
      hex: '#2d8659',
      tags: ['green', 'nature'],
    })
    expect(validFav.success).toBe(true)

    const invalidFav = CreateColorFavoriteSchema.safeParse({
      hex: 'not-a-color',
    })
    expect(invalidFav.success).toBe(false)

    const validPal = CreateColorPaletteSchema.safeParse({
      title: 'Summer Breeze',
      colors: [{ hex: '#ffbe0b' }, { hex: '#fb5607' }],
      sourceType: 'colorhunt',
    })
    expect(validPal.success).toBe(true)

    const validSettings = UpdateColorSettingsSchema.safeParse({
      stripHash: true,
      defaultFormat: 'hex',
    })
    expect(validSettings.success).toBe(true)
  })
})

describe('HSL round trip (studio sliders)', () => {
  it('keeps a zero-degree hue rotation lossless', () => {
    // The studio rebuilds the hex from the slider triple on every step. With the rounded triple this
    // round trip moved 89.5% of colors by up to 3 units in a channel the reader never touched.
    let drift = 0
    for (let i = 0; i < 5000; i++) {
      const hex = rgbToHex(
        { r: (i * 7919) % 256, g: (i * 104729) % 256, b: (i * 15485863) % 256 },
        true,
      )
      const { h, s, l } = getColorSpaceValues(hex).hslExact
      if (rgbToHex(hslToRgb({ h, s, l }), true) !== hex) drift++
    }
    expect(drift).toBe(0)
  })

  it('preserves saturation and lightness when the hue moves', () => {
    const before = getColorSpaceValues('#c2703d').hslExact
    const rotated = rgbToHex(hslToRgb({ ...before, h: (before.h + 30) % 360 }), true)
    const after = getColorSpaceValues(rotated).hslExact
    expect(after.s).toBeCloseTo(before.s, 6)
    expect(after.l).toBeCloseTo(before.l, 6)
  })

  it('reports the rounded triple for display and the exact one for math', () => {
    const values = getColorSpaceValues('#c2703d')
    expect(Number.isInteger(values.hsl.h)).toBe(true)
    expect(Number.isInteger(values.hsl.s)).toBe(true)
    expect(values.hslExact.h).not.toBe(values.hsl.h)
  })
})
