// @vitest-environment node
/**
 * The formats the exporter can hand over.
 *
 * The palette was exportable as CSS, SCSS, a Tailwind v3 config, JSON and .ase. What readers actually
 * paste today is a Tailwind v4 `@theme` block, an `oklch()` sheet (the accent stack of this very app is
 * oklch), a Design Tokens JSON for Figma, and a palette file for GIMP, Android or Xcode — none of which
 * existed, so the colour tool could not hand its work to the next tool.
 */
import { describe, expect, it } from 'vitest'
import { rgbToOklch, rgbToOklchString } from '@shared/tools/color/spaces'
import {
  EXPORT_FORMATS,
  exportToFigmaTokens,
  exportToGpl,
  exportToOklchCssVariables,
  exportToTailwindV4Theme,
  slugFromTitle,
} from '../src/client/features/tools/color/lib/export-engine'

const palette = { title: 'Sunset Dusk', colors: ['#0f172a', '#f59e0b', '#22c55e'] }

describe('tailwind v4 theme', () => {
  it('emits @theme custom properties instead of a v3 module export', () => {
    const out = exportToTailwindV4Theme(palette)

    expect(out).toContain('@theme {')
    expect(out).toContain('  --color-sunset-dusk-1: #0f172a;')
    expect(out).toContain('  --color-sunset-dusk-3: #22c55e;')
    expect(out).not.toContain('module.exports')
  })

  it('declares one property per colour, in order', () => {
    const out = exportToTailwindV4Theme({ title: 'Three', colors: ['#000000', '#808080', '#ffffff'] })
    expect(out.match(/--color-three-\d+:/g)).toHaveLength(3)
  })
})

describe('oklch sheet', () => {
  it('prints CSS custom properties in oklch() notation', () => {
    const out = exportToOklchCssVariables({ title: 'Grey Step', colors: ['#000000', '#808080', '#ffffff'] })

    expect(out).toContain('--color-grey-step-1: oklch(0.0% 0.0000 0.0);')
    // A neutral has no chroma by definition, whatever hue angle the polar conversion lands on.
    expect(out).toContain('--color-grey-step-2: oklch(60.0% 0.0000 ')
    expect(out).toContain('--color-grey-step-3: oklch(100.0% 0.0000 ')
  })

  it('keeps red at the hue CSS documents and white at full lightness', () => {
    // Independently known answers, so a wrong matrix cannot pass: oklch red is `oklch(62.8% 0.2577 29.23)`.
    const red = rgbToOklch({ r: 255, g: 0, b: 0 })
    expect(red.l).toBeCloseTo(0.628, 2)
    expect(red.c).toBeCloseTo(0.2577, 3)
    expect(red.h).toBeCloseTo(29.2, 1)
    expect(rgbToOklchString({ r: 255, g: 0, b: 0 })).toBe('oklch(62.8% 0.2577 29.2)')
    expect(rgbToOklchString({ r: 255, g: 255, b: 255 })).toMatch(/^oklch\(100\.0% 0\.0000 [\d.]+\)$/)
    // The other two browser-documented primaries, so a wrong matrix cannot clear all three.
    expect(rgbToOklchString({ r: 0, g: 255, b: 0 })).toBe('oklch(86.6% 0.2948 142.5)')
    expect(rgbToOklchString({ r: 0, g: 0, b: 255 })).toBe('oklch(45.2% 0.3132 264.1)')
  })
})

describe('design tokens for Figma', () => {
  it('writes a DTCG document the importer reads', () => {
    const doc = JSON.parse(exportToFigmaTokens(palette)) as Record<string, unknown>

    expect(doc['$type']).toBe('color')
    const group = doc['sunset-dusk'] as Record<string, { $value: string }>
    expect(Object.keys(group)).toEqual(['1', '2', '3'])
    expect(group['1']!.$value).toBe('#0f172a')
    expect(group['3']!.$value).toBe('#22c55e')
  })
})

describe('palette files', () => {
  it('writes a GIMP palette with decimal channels', () => {
    const out = exportToGpl(palette)
    const lines = out.split('\n')

    expect(lines[0]).toBe('GIMP Palette')
    expect(lines[1]).toBe('Name: Sunset Dusk')
    expect(lines[2]).toMatch(/^Columns: \d+$/)
    // 0f/17/2a is 15, 23, 42 — GIMP stores channels as decimal, not hex.
    expect(lines[4]).toContain('15')
    expect(lines[4]).toContain('23')
    expect(lines[4]).toContain('42')
  })
})

describe('platform colour files', () => {
  it('writes Android colours with the alpha channel the parser expects', () => {
    const out = EXPORT_FORMATS.android.build({ title: 'Dusk', colors: ['#0f172a'] })

    expect(out).toContain('<?xml version="1.0"')
    // Android reads #RRGGBB as transparent, so an omitted alpha is a silent wrong colour.
    expect(out).toContain('<color name="dusk_1">#FF0f172a</color>')
  })

  it('writes an Xcode colour set with components in 0..1', () => {
    const doc = JSON.parse(EXPORT_FORMATS.ios.build({ title: 'Dusk', colors: ['#0f172a', '#ffffff'] })) as {
      colorSetName: string
      colors: Array<{ name: string; hex: string; components: { red: number; green: number; blue: number; alpha: number } }>
    }

    expect(doc.colorSetName).toBe('dusk')
    expect(doc.colors).toHaveLength(2)
    expect(doc.colors[0]!.name).toBe('dusk-1')
    expect(doc.colors[0]!.components.red).toBeCloseTo(15 / 255, 6)
    expect(doc.colors[1]!.components).toEqual({ red: 1, green: 1, blue: 1, alpha: 1 })
  })
})

describe('the format table', () => {
  it('names every format it can build, and builds every one it names', () => {
    const ids = Object.keys(EXPORT_FORMATS)
    expect(ids.length).toBeGreaterThanOrEqual(10)
    for (const id of ids) {
      const format = EXPORT_FORMATS[id as keyof typeof EXPORT_FORMATS]
      expect(format.suffix, id).toMatch(/^[a-z][a-z0-9.-]*$/)
      expect(format.labelKey, id).toMatch(/^tools\.color\.export\.format_/)
      if (format.binary) {
        // A binary format has no text to preview; the dialog says what the file is instead.
        expect(format.build(palette), id).toBe('')
        continue
      }
      const built = format.build(palette)
      expect(built.trim().length, `${id} builds nothing`).toBeGreaterThan(0)
      // However a format writes a colour — hex, decimal channels, oklch — it has to account for every one.
      // Android writes `#FF0f172a`, GIMP prints 15/23/42 and 245/158/11, OKLCH writes neither — so the
      // probe accepts any of the forms a faithful build has to contain.
      const marks = built.match(/0f172a|f59e0b|22c55e|\b15\b|\b245\b|\b34\b|oklch\(/gi) ?? []
      expect(marks.length >= palette.colors.length, `${id} lost colours`).toBe(true)
    }
  })

  it('gives each format a distinct file name, so two exports cannot overwrite each other', () => {
    const suffixes = Object.values(EXPORT_FORMATS).map((format) => format.suffix)
    expect(new Set(suffixes).size).toBe(suffixes.length)
  })

  it('covers the formats the picker offers', () => {
    expect(Object.keys(EXPORT_FORMATS).sort()).toEqual([
      'android',
      'ase',
      'css',
      'figma',
      'gpl',
      'ios',
      'json',
      'oklch',
      'scss',
      'tailwind',
      'tailwind_v4',
    ].sort())
  })

  it('keeps the slug rule shared by every format', () => {
    expect(slugFromTitle('暮山紫')).toBe('palette')
    expect(slugFromTitle('Sunset Dusk')).toBe('sunset-dusk')
    expect(slugFromTitle('  --  ')).toBe('palette')
  })
})
