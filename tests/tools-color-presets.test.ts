import { describe, expect, it } from 'vitest'
import {
  FLAT_UI_PALETTES,
  FLUENT_UI_PALETTES,
  OPEN_COLOR_PALETTES,
  ANTD_PALETTES,
  MATERIAL_UI_PALETTES,
  TAILWIND_PALETTES,
  TRADITIONAL_CHINESE_COLORS,
  TRADITIONAL_NIPPON_COLORS,
  COLOR_HUNT_PALETTES,
  GRADIENT_PRESETS,
} from '../src/shared/tools/color/presets'

const HEX_REGEX = /^#[0-9a-fA-F]{6}$/

describe('Color Assistant: UI Palettes Presets (WP-2)', () => {
  it('loads Flat UI palettes with valid hex values', () => {
    expect(FLAT_UI_PALETTES.length).toBeGreaterThanOrEqual(4)
    for (const group of FLAT_UI_PALETTES) {
      expect(group.colors.length).toBeGreaterThan(0)
      for (const col of group.colors) {
        expect(col.hex).toMatch(HEX_REGEX)
      }
    }
  })

  it('loads Fluent UI palettes with theme, neutral, accent, status', () => {
    expect(FLUENT_UI_PALETTES.length).toBe(4)
    const ids = FLUENT_UI_PALETTES.map((p) => p.id)
    expect(ids).toContain('fluent-theme')
    expect(ids).toContain('fluent-neutral')
    expect(ids).toContain('fluent-accent')
    expect(ids).toContain('fluent-status')
  })

  it('loads Open Color with 13 color families', () => {
    expect(OPEN_COLOR_PALETTES.length).toBe(13)
    for (const fam of OPEN_COLOR_PALETTES) {
      expect(fam.colors.length).toBe(10)
    }
  })

  it('loads Ant Design palettes with 12 families', () => {
    expect(ANTD_PALETTES.length).toBe(12)
    for (const fam of ANTD_PALETTES) {
      expect(fam.colors.length).toBeGreaterThanOrEqual(10)
    }
  })

  it('loads Material Design palettes', () => {
    expect(MATERIAL_UI_PALETTES.length).toBeGreaterThanOrEqual(8)
  })

  it('loads Tailwind CSS palettes', () => {
    expect(TAILWIND_PALETTES.length).toBeGreaterThanOrEqual(6)
    for (const p of TAILWIND_PALETTES) {
      expect(p.colors.length).toBe(11) // 50 to 950
    }
  })
})

describe('Color Assistant: Cultural & Hunt Presets (WP-2)', () => {
  it('loads Traditional Chinese colors with pinyin, hex, and solarTerm', () => {
    expect(TRADITIONAL_CHINESE_COLORS.length).toBeGreaterThan(30)
    for (const col of TRADITIONAL_CHINESE_COLORS) {
      expect(col.name).toBeTruthy()
      expect(col.hex).toMatch(HEX_REGEX)
      expect(col.cmyk.length).toBe(4)
      expect(col.solarTerm).toBeTruthy()
    }
  })

  it('loads Traditional Japanese colors with kana, romaji, and hex', () => {
    expect(TRADITIONAL_NIPPON_COLORS.length).toBeGreaterThan(30)
    for (const col of TRADITIONAL_NIPPON_COLORS) {
      expect(col.name).toBeTruthy()
      expect(col.hex).toMatch(HEX_REGEX)
      expect(col.cmyk.length).toBe(4)
      expect(col.romaji).toBeTruthy()
      expect(col.kana).toBeTruthy()
    }
  })

  it('loads Color Hunt 4-color palettes with tags and likes', () => {
    expect(COLOR_HUNT_PALETTES.length).toBeGreaterThan(15)
    for (const pal of COLOR_HUNT_PALETTES) {
      expect(pal.colors.length).toBe(4)
      expect(pal.tags.length).toBeGreaterThan(0)
      expect(pal.likes).toBeGreaterThan(0)
      for (const hex of pal.colors) {
        expect(hex).toMatch(HEX_REGEX)
      }
    }
  })

  it('loads Gradient presets with valid stop offsets', () => {
    expect(GRADIENT_PRESETS.length).toBeGreaterThan(5)
    for (const g of GRADIENT_PRESETS) {
      expect(g.config.stops.length).toBeGreaterThanOrEqual(2)
      for (const s of g.config.stops) {
        expect(s.color).toMatch(HEX_REGEX)
        expect(s.offset).toBeGreaterThanOrEqual(0)
        expect(s.offset).toBeLessThanOrEqual(100)
      }
    }
  })
})
