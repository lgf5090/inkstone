import { describe, expect, it } from 'vitest'
import { evaluateWcagContrast, getContrastRatio, simulateColorBlindness } from '@shared/tools/color/a11y'
import { buildCssGradient, generateOklabGradientStops, interpolateOklab } from '@shared/tools/color/oklab'
import { extractPaletteFromPixels } from '@shared/tools/color/quantize'
import { formatAsCssVariables, formatAsTailwindConfig, generateTokenScale } from '@shared/tools/color/token-scale'
import {
  exportToAseBlob,
  exportToCssVariables,
  exportToJson,
  exportToScssVariables,
  exportToTailwindConfig,
} from '../src/client/features/tools/color/lib/export-engine'

describe('OKLab Gradient Engine', () => {
  it('smoothly interpolates between two colors in OKLab space', () => {
    const mid = interpolateOklab('#ff0000', '#0000ff', 0.5)
    expect(mid).toMatch(/^#[0-9a-f]{6}$/)
    // Intermediate in OKLab should not be dull black or invalid
    expect(mid).not.toBe('#000000')
    expect(mid).not.toBe('#ffffff')
  })

  it('generates intermediate stops without dead zones', () => {
    const stops = generateOklabGradientStops('#3b82f6', '#ec4899', 4)
    expect(stops).toHaveLength(5)
    expect(stops[0].offset).toBe(0)
    expect(stops[stops.length - 1].offset).toBe(100)
  })

  it('builds CSS gradients for linear, radial, and conic types', () => {
    const config = {
      type: 'linear' as const,
      angle: 90,
      stops: [
        { id: '1', color: '#ff0000', offset: 0 },
        { id: '2', color: '#00ff00', offset: 100 },
      ],
      useOklabInterpolation: false,
    }

    const linear = buildCssGradient(config)
    expect(linear).toContain('linear-gradient(90deg, #ff0000 0%, #00ff00 100%)')

    const radial = buildCssGradient({ ...config, type: 'radial' })
    expect(radial).toContain('radial-gradient(circle at center')

    const conic = buildCssGradient({ ...config, type: 'conic' })
    expect(conic).toContain('conic-gradient(from 90deg at center')

    const oklabLinear = buildCssGradient({ ...config, useOklabInterpolation: true })
    expect(oklabLinear).toContain('linear-gradient(90deg,')
    // Should have generated intermediate stops
    expect(oklabLinear.split(',').length).toBeGreaterThan(3)
  })
})

describe('MMCQ Quantization Engine', () => {
  it('handles blank/transparent pixels gracefully with fallbacks', () => {
    const transparentPixels = new Uint8ClampedArray(400).fill(0)
    const result = extractPaletteFromPixels(transparentPixels, 5)
    expect(result.dominant).toBe('#627486')
    expect(result.palette.length).toBeGreaterThanOrEqual(1)
  })

  it('extracts dominant color and harmonic palette from simulated pixel data', () => {
    // Generate synthetic image data: 70% blue (#0000ff), 30% red (#ff0000)
    const pixelCount = 1000
    const pixels = new Uint8ClampedArray(pixelCount * 4)

    for (let i = 0; i < pixelCount; i++) {
      const idx = i * 4
      if (i < 700) {
        pixels[idx] = 0 // R
        pixels[idx + 1] = 0 // G
        pixels[idx + 2] = 255 // B
        pixels[idx + 3] = 255 // A
      } else {
        pixels[idx] = 255 // R
        pixels[idx + 1] = 0 // G
        pixels[idx + 2] = 0 // B
        pixels[idx + 3] = 255 // A
      }
    }

    const result = extractPaletteFromPixels(pixels, 4)
    expect(result.dominant).toMatch(/^#[0-9a-f]{6}$/)
    expect(result.dominantRgb).toBeDefined()
    expect(result.palette.length).toBeGreaterThanOrEqual(1)
  })
})

describe('Accessibility & CVD Simulation', () => {
  it('calculates WCAG contrast ratio accurately for black and white', () => {
    const ratio = getContrastRatio('#000000', '#ffffff')
    expect(ratio).toBe(21)
  })

  it('evaluates compliance for normal, large text and UI components', () => {
    const highContrast = evaluateWcagContrast('#000000', '#ffffff')
    expect(highContrast.score).toBe('AAA')
    expect(highContrast.normalAa).toBe(true)
    expect(highContrast.normalAaa).toBe(true)
    expect(highContrast.largeAa).toBe(true)
    expect(highContrast.largeAaa).toBe(true)
    expect(highContrast.uiComponents).toBe(true)

    const lowContrast = evaluateWcagContrast('#888888', '#999999')
    expect(lowContrast.score).toBe('Fail')
    expect(lowContrast.normalAa).toBe(false)
  })

  it('simulates color blindness across all supported conditions', () => {
    const color = '#3b82f6'
    expect(simulateColorBlindness(color, 'normal')).toBe(color)
    expect(simulateColorBlindness(color, 'protanopia')).toMatch(/^#[0-9a-f]{6}$/)
    expect(simulateColorBlindness(color, 'deuteranopia')).toMatch(/^#[0-9a-f]{6}$/)
    expect(simulateColorBlindness(color, 'tritanopia')).toMatch(/^#[0-9a-f]{6}$/)

    const achroma = simulateColorBlindness('#ff0000', 'achromatopsia')
    expect(achroma).toMatch(/^#[0-9a-f]{6}$/)
    // Achromatopsia should produce gray tones (R = G = B approximately)
    const r = parseInt(achroma.slice(1, 3), 16)
    const g = parseInt(achroma.slice(3, 5), 16)
    const b = parseInt(achroma.slice(5, 7), 16)
    expect(Math.abs(r - g)).toBeLessThanOrEqual(2)
    expect(Math.abs(g - b)).toBeLessThanOrEqual(2)
  })
})

describe('Token Scale Generator', () => {
  it('generates 11-step scale from 50 to 950', () => {
    const scale = generateTokenScale('#3b82f6')
    expect(scale).toHaveLength(11)
    expect(scale.map((s) => s.step)).toEqual([
      50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
    ])

    // Step 50 should have high lightness and pass contrast with dark text
    expect(scale[0].textRecommended).toBe('#000000')
    // Step 950 should have low lightness and pass contrast with white text
    expect(scale[10].textRecommended).toBe('#ffffff')
  })

  it('formats token scale as Tailwind config and CSS variables', () => {
    const scale = generateTokenScale('#3b82f6')
    const tailwind = formatAsTailwindConfig('brand', scale)
    expect(tailwind).toContain("'brand': {")
    expect(tailwind).toContain("'50':")
    expect(tailwind).toContain("'950':")

    const cssVars = formatAsCssVariables('brand', scale)
    expect(cssVars).toContain('--color-brand-50:')
    expect(cssVars).toContain('--color-brand-950:')
  })
})

describe('Universal Palette Exporter', () => {
  const palette = {
    title: 'Brand Modern',
    colors: ['#3b82f6', '#ec4899', '#10b981', '#f59e0b'],
  }

  it('generates valid binary Adobe Swatch Exchange (.ase) file', async () => {
    const blob = exportToAseBlob(palette)
    expect(blob.type).toBe('application/octet-stream')
    expect(blob.size).toBeGreaterThan(12)

    const buffer = await blob.arrayBuffer()
    const view = new DataView(buffer)

    // Check Magic: "ASEF" (0x41 0x53 0x45 0x46)
    expect(view.getUint8(0)).toBe(0x41)
    expect(view.getUint8(1)).toBe(0x53)
    expect(view.getUint8(2)).toBe(0x45)
    expect(view.getUint8(3)).toBe(0x46)

    // Version: 1.0
    expect(view.getUint16(4, false)).toBe(1)
    expect(view.getUint16(6, false)).toBe(0)

    // Number of blocks: 4
    expect(view.getUint32(8, false)).toBe(4)
  })

  it('exports to CSS, SCSS, Tailwind, and JSON', () => {
    const css = exportToCssVariables(palette)
    expect(css).toContain(':root {')
    expect(css).toContain('--color-brand-modern-1: #3b82f6;')

    const scss = exportToScssVariables(palette)
    expect(scss).toContain('$color-brand-modern-1: #3b82f6;')

    const tailwind = exportToTailwindConfig(palette)
    expect(tailwind).toContain("'brand-modern': {")
    expect(tailwind).toContain("'100': '#3b82f6'")

    const json = exportToJson(palette)
    const parsed = JSON.parse(json)
    expect(parsed.title).toBe('Brand Modern')
    expect(parsed.colors).toHaveLength(4)
    expect(parsed.colors[0].hex).toBe('#3b82f6')
  })
})
