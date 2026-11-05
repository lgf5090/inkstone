import { describe, expect, it } from 'vitest'
import { ORGANIZER_COLORS, organizerColorContrast } from '../src/shared/organizer-colors'
import { TAG_COLOR_PALETTE, tagColorFor, tagPillStyle } from '../src/client/features/scriptshub/tag-color'

describe('a tag keeps the same colour without storing one', () => {
  it('maps the same name to the same project token every time', () => {
    const first = tagColorFor('linux', null)
    expect(tagColorFor('linux', null)).toBe(first)
    expect(tagColorFor('Linux', null)).toBe(first)
    expect(tagColorFor('linux', undefined)).toBe(first)
  })

  it('spreads different names across the palette rather than painting them all one colour', () => {
    const used = new Set(['linux', 'ops', 'git', 'backup', 'deploy', 'network', 'docker', 'python'].map((name) => tagColorFor(name, null)))
    expect(used.size).toBeGreaterThanOrEqual(4)
  })

  it('uses a stored colour as-is and only tints the pill frame', () => {
    expect(tagColorFor('linux', '#123456')).toBe('#123456')
    const style = tagPillStyle('linux', null)
    expect(style.backgroundColor).toContain('color-mix')
    expect(style.backgroundColor).toContain('var(--bg-raised)')
    expect(style.borderColor).toContain('var(--border-subtle)')
  })

  it('draws from the tokens the app already declares', () => {
    expect(TAG_COLOR_PALETTE.every((token) => token.startsWith('var(--'))).toBe(true)
    expect(TAG_COLOR_PALETTE).toContain('var(--success)')
    expect(TAG_COLOR_PALETTE).toContain('var(--danger)')
  })

  it('offers the notebook\u2019s own colour ramp as the built-in presets', () => {
    expect(ORGANIZER_COLORS).toHaveLength(24)
    expect(new Set(ORGANIZER_COLORS).size).toBe(24)
    expect(ORGANIZER_COLORS.every((color) => /^#[0-9a-f]{6}$/i.test(color))).toBe(true)
  })

  it('keeps a preset readable on the light surface the panel paints', () => {
    const ratio = organizerColorContrast(ORGANIZER_COLORS[0]!, '#ffffff')
    expect(ratio).not.toBeNull()
    expect(ratio!).toBeGreaterThanOrEqual(3)
  })
})
