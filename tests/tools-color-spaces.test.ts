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

  it('returns all color space values', () => {
    const values = getColorSpaceValues('#627486')
    expect(values.hex).toBe('#627486')
    expect(values.hexClean).toBe('627486')
    expect(values.rgbString).toBe('rgb(98, 116, 134)')
    expect(values.hsvString).toContain('hsv(')
    expect(values.hslString).toContain('hsl(')
    expect(values.cmykString).toContain('cmyk(')
    expect(values.hsiString).toContain('hsi(')
    expect(values.labString).toContain('lab(')
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
