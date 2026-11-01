// @vitest-environment jsdom
/**
 * The swatch overlay contract.
 *
 * jsdom has no layout and no pointer-event resolution, so it cannot show that a click lands; what it can
 * pin is the class contract that decides it, which is exactly what the four copies of this markup used to
 * get wrong in four different ways. The contrast half runs on the real preset corpus.
 */
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  getContrastRatio,
  recommendedTextColor,
  TEXT_ON_DARK_SWATCH,
  TEXT_ON_LIGHT_SWATCH,
} from '@shared/tools/color/a11y'
import { COLOR_HUNT_PALETTES } from '@shared/tools/color/presets/color-hunt-curated'
import { FLAT_UI_PALETTES, TAILWIND_PALETTES } from '@shared/tools/color/presets'
import { installTestGlobals, renderElement } from '../src/client/lib/test-render'
import { initI18n, t } from '../src/client/lib/i18n'
import { HarmoniesPanel } from '../src/client/features/tools/color/components/HarmoniesPanel'
import { ColorHuntCard } from '../src/client/features/tools/color/components/ColorHuntCard'

vi.mock('../src/client/features/tools/color/api', () => ({
  colorApi: {
    getSettings: vi.fn().mockResolvedValue({
      stripHash: false,
      defaultFormat: 'hex',
      defaultUiTab: 'flat_ui',
      autoSaveHistory: false,
      updatedAt: 1,
    }),
    addHistory: vi.fn().mockResolvedValue({}),
    listHistory: vi.fn().mockResolvedValue([]),
    listFavorites: vi.fn().mockResolvedValue([]),
    listPalettes: vi.fn().mockResolvedValue([]),
    createFavorite: vi.fn().mockResolvedValue({ id: 'f', hex: '#000000' }),
    createPalette: vi.fn().mockResolvedValue({ id: 'p' }),
  },
}))

installTestGlobals()
await initI18n()

describe('Swatch overlay structure', () => {
  it('leaves the swatch itself clickable and opts only the buttons in', () => {
    const rendered = renderElement(createElement(HarmoniesPanel, { currentHex: '#3b82f6' }))

    const wrappers = [...rendered.container.querySelectorAll<HTMLDivElement>('div[class*="pointer-events"]')]
    expect(wrappers.length).toBeGreaterThan(0)
    for (const wrapper of wrappers) {
      const cls = wrapper.className
      expect(cls, 'the wrapper must not answer pointers').toContain('pointer-events-none')
      expect(cls, 'the wrapper must not opt itself back in').not.toContain('pointer-events-auto')
      expect(cls, 'a keyboard must reveal the controls too').toContain('group-focus-within:opacity-100')
      expect(cls, 'a touch reader has no hover to wait for').toContain('pointer-coarse:opacity-100')
    }

    const buttons = [...rendered.container.querySelectorAll<HTMLButtonElement>('div[class*="pointer-events-none"] button')]
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(button.className).toContain('pointer-events-auto')
    }

    rendered.unmount()
  })

  it('names the primary swatch action in the reader language', () => {
    const rendered = renderElement(createElement(HarmoniesPanel, { currentHex: '#3b82f6' }))
    const primary = rendered.container.querySelector<HTMLButtonElement>('div.group > button[aria-label]')
    expect(primary?.getAttribute('aria-label')).toBe(t('tools.color.swatch.use', { hex: '#3b82f6' }))
    expect(primary?.getAttribute('aria-label')).not.toMatch(/^Select /)
    rendered.unmount()
  })

  it('scopes the hover reveal to one row, not the whole card', () => {
    const rendered = renderElement(createElement(ColorHuntCard, { palette: COLOR_HUNT_PALETTES[0] }))
    const rows = [...rendered.container.querySelectorAll('div.group')]
    expect(rows).toHaveLength(COLOR_HUNT_PALETTES[0].colors.length)
    expect((rendered.container.firstElementChild as HTMLElement).classList.contains('group')).toBe(false)
    rendered.unmount()
  })
})

describe('recommendedTextColor', () => {
  it('always picks the ink with the better contrast', () => {
    for (let i = 0; i < 4096; i++) {
      const hex = `#${(i * 4099 + 7).toString(16).padStart(6, '0').slice(-6)}`
      const picked = recommendedTextColor(hex)
      const other = picked === TEXT_ON_LIGHT_SWATCH ? TEXT_ON_DARK_SWATCH : TEXT_ON_LIGHT_SWATCH
      expect(getContrastRatio(picked, hex)).toBeGreaterThanOrEqual(getContrastRatio(other, hex))
    }
  })

  it('keeps every preset swatch label at AA', () => {
    const corpus = [
      ...COLOR_HUNT_PALETTES.flatMap((p) => p.colors),
      ...TAILWIND_PALETTES.flatMap((g) => g.colors.map((c) => c.hex)),
      ...FLAT_UI_PALETTES.flatMap((g) => g.colors.map((c) => c.hex)),
    ]
    expect(corpus.length).toBeGreaterThan(200)
    const worst = Math.min(...corpus.map((hex) => getContrastRatio(recommendedTextColor(hex), hex)))
    console.log(`CORPUS n=${corpus.length} worstRatio=${worst.toFixed(2)}`)
    expect(worst).toBeGreaterThanOrEqual(4.5)
  })
})
