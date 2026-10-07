import { describe, expect, it } from 'vitest'
import {
  PROPERTY_COLOR_RULES_MAX,
  PROPERTY_COVER_NAMES_MAX,
  PROPERTY_LIST_MAX,
  PROPERTY_TEMPLATE_MAX,
  mergeSettings,
  mergeSettingsPatch,
} from './constants'
import type { UserSettings } from './types'

function merged(properties: Record<string, unknown>): UserSettings {
  return mergeSettings({ properties })
}

describe('property settings defaults', () => {
  it('answers the shipped defaults for an account that never set any', () => {
    const settings = mergeSettings({})
    expect(settings.properties.enabled).toBe(true)
    expect(settings.properties.bannerProperty).toBe('banner')
    expect(settings.properties.coverProperties).toEqual(['cover'])
    expect(settings.properties.coverPosition).toBe('left')
    expect(settings.properties.quickSearchKey).toBe('ctrl')
    expect(settings.properties.colors).toEqual({})
    expect(settings.properties.hidden).toEqual([])
  })

  it('does not let one account\'s list leak into the next clone', () => {
    const first = mergeSettings({ properties: { hidden: ['draft'] } })
    first.properties.coverProperties.push('mutated')
    expect(mergeSettings({}).properties.coverProperties).toEqual(['cover'])
    expect(mergeSettings({}).properties.hidden).toEqual([])
  })
})

describe('property name lists', () => {
  it('trims, folds case and drops the repeats', () => {
    const list = merged({ hidden: [' Draft ', 'draft', 'Status', '', 7, 'rating'] }).properties.hidden
    expect(list).toEqual(['Draft', 'Status', 'rating'])
  })

  it('caps how many names the account may hide', () => {
    const many = Array.from({ length: PROPERTY_LIST_MAX + 40 }, (_, index) => `p${index}`)
    expect(merged({ hidden: many }).properties.hidden).toHaveLength(PROPERTY_LIST_MAX)
  })

  it('caps the cover property list', () => {
    const many = Array.from({ length: 20 }, (_, index) => `cover${index}`)
    expect(merged({ coverProperties: many }).properties.coverProperties).toHaveLength(PROPERTY_COVER_NAMES_MAX)
  })

  it('keeps a blank name out of the decoration properties', () => {
    expect(merged({ bannerProperty: '   ' }).properties.bannerProperty).toBe('banner')
    expect(merged({ iconProperty: 'picture' }).properties.iconProperty).toBe('picture')
  })
})

describe('property colour rules', () => {
  it('lowercases a hex and keeps the two sentinels the menu offers', () => {
    const colors = merged({
      colors: {
        status: { done: { pill: '#059669', text: 'none' }, todo: { pill: 'default' } },
      },
    }).properties.colors
    expect(colors.status?.done).toEqual({ pill: '#059669', text: 'none' })
    expect(colors.status?.todo).toEqual({ pill: 'default' })
  })

  it('drops a colour it cannot paint and a property that ends up with none', () => {
    const colors = merged({
      colors: {
        status: { done: { pill: 'red', text: '#059669' }, other: { pill: 'javascript:alert(1)' } },
        empty: { x: { nonsense: '#059669' } },
      },
    }).properties.colors
    expect(colors.status?.done).toEqual({ text: '#059669' })
    expect(colors.status?.other).toBeUndefined()
    expect(colors.empty).toBeUndefined()
  })

  it('folds the property name so the lookup has one spelling', () => {
    const colors = merged({ colors: { Status: { Done: { pill: '#2563eb' } } } }).properties.colors
    expect(Object.keys(colors)).toEqual(['status'])
    expect(Object.keys(colors.status ?? {})).toEqual(['Done'])
  })

  it('refuses to keep a value key longer than the panel can show', () => {
    const colors = merged({ colors: { s: { ['x'.repeat(121)]: { pill: '#2563eb' } } } }).properties.colors
    expect(colors.s).toBeUndefined()
  })

  it('caps the number of properties it will carry', () => {
    const wide: Record<string, Record<string, { pill: string }>> = {}
    for (let index = 0; index < PROPERTY_COLOR_RULES_MAX + 20; index++)
      wide[`p${index}`] = { v: { pill: '#2563eb' } }
    expect(Object.keys(merged({ colors: wide }).properties.colors)).toHaveLength(PROPERTY_COLOR_RULES_MAX)
  })
})

describe('property format and progress rules', () => {
  it('keeps a template up to the documented length and drops a blank one', () => {
    const long = `{{upper propertyValue}}${' '.repeat(PROPERTY_TEMPLATE_MAX)}`
    const formats = merged({ formats: { a: { template: long }, b: { template: '   ' }, c: { markdown: true } } }).properties.formats
    expect(formats.a?.template).toHaveLength(PROPERTY_TEMPLATE_MAX)
    expect(formats.b).toBeUndefined()
    expect(formats.c).toEqual({ markdown: true })
  })

  it('replaces a maximum of zero with the percent reading', () => {
    expect(merged({ progress: { pages: { max: 0 } } }).properties.progress.pages).toEqual({ max: 100 })
    expect(merged({ progress: { pages: { max: 250, variant: 'circle' } } }).properties.progress.pages)
      .toEqual({ max: 250, variant: 'circle' })
    expect(merged({ progress: { pages: { maxProperty: 'total' } } }).properties.progress.pages)
      .toEqual({ maxProperty: 'total' })
    expect(merged({ progress: { pages: {} } }).properties.progress.pages).toEqual({ max: 100 })
  })

  it('clamps the geometry into the ranges the panel can draw', () => {
    const properties = merged({
      coverWidth: 10,
      coverWidth2: 5000,
      bannerHeight: 4,
      iconSize: 9999,
      bannerPosition: -20,
      coverMaxHeight: -1,
    }).properties
    expect(properties.coverWidth).toBe(60)
    expect(properties.coverWidth2).toBe(900)
    expect(properties.bannerHeight).toBe(40)
    expect(properties.iconSize).toBe(240)
    expect(properties.bannerPosition).toBe(0)
    expect(properties.coverMaxHeight).toBe(60)
  })

  it('reads only the shapes and positions that exist', () => {
    expect(merged({ coverShape: 'square' }).properties.coverShape).toBe('square')
    expect(merged({ coverShape: 'triangle' }).properties.coverShape).toBe('initial')
    expect(merged({ coverPosition: 'bottom' }).properties.coverPosition).toBe('bottom')
    expect(merged({ coverPosition: 'middle' }).properties.coverPosition).toBe('left')
    expect(merged({ quickSearchKey: 'off' }).properties.quickSearchKey).toBe('off')
    expect(merged({ quickSearchKey: 'shift' }).properties.quickSearchKey).toBe('ctrl')
  })

  it('takes only a plain hex for the relative date colours', () => {
    const properties = merged({
      datePastColor: '#DC2626',
      datePresentColor: 'red',
      dateFutureColor: 'oklch(0.5 0.1 20)',
    }).properties
    expect(properties.datePastColor).toBe('#dc2626')
    expect(properties.datePresentColor).toBe(null)
    expect(properties.dateFutureColor).toBe(null)
  })

  it('drops a date pattern longer than the formatter reads', () => {
    expect(merged({ dateFormat: 'Y'.repeat(200) }).properties.dateFormat).toHaveLength(120)
    expect(merged({ dateFormat: '  ' }).properties.dateFormat).toBe('')
  })
})

describe('property settings ceiling', () => {
  function maximal(): Record<string, unknown> {
    const colors: Record<string, Record<string, { pill: string, text: string }>> = {}
    for (let property = 0; property < PROPERTY_COLOR_RULES_MAX; property++) {
      const rules: Record<string, { pill: string, text: string }> = {}
      for (let value = 0; value < 200; value++)
        rules[`a-long-ish-value-${value}`] = { pill: '#059669', text: '#dc2626' }
      colors[`property-${property}`] = rules
    }
    const formats: Record<string, { template: string }> = {}
    for (let index = 0; index < PROPERTY_COLOR_RULES_MAX; index++)
      formats[`format-${index}`] = { template: `{{durationHumanized propertyValue "s" true}} ${index}` }
    const selectOptions: Record<string, string[]> = {}
    for (let index = 0; index < PROPERTY_COLOR_RULES_MAX; index++)
      selectOptions[`select-${index}`] = Array.from({ length: 24 }, (_, item) => `option-${index}-${item}`)
    const progress: Record<string, { max: number }> = {}
    for (let index = 0; index < PROPERTY_COLOR_RULES_MAX; index++)
      progress[`progress-${index}`] = { max: 100 + index }
    return {
      hidden: Array.from({ length: PROPERTY_LIST_MAX }, (_, index) => `hidden-name-${index}`),
      hiddenWhenEmpty: Array.from({ length: PROPERTY_LIST_MAX }, (_, index) => `empty-name-${index}`),
      colors,
      formats,
      selectOptions,
      progress,
    }
  }

  it('stays inside the body the settings route accepts', () => {
    const settings = merged(maximal())
    const bytes = JSON.stringify(settings).length
    expect(bytes).toBeLessThan(16_384)
    expect(Object.keys(settings.properties.colors).length).toBeGreaterThan(0)
  })

  it('trims in order instead of dropping the whole map', () => {
    const first = merged(maximal()).properties.colors
    const keys = Object.keys(first)
    expect(keys[0]).toBe('property-0')
    expect(keys.length).toBeLessThan(PROPERTY_COLOR_RULES_MAX)
    for (const key of keys.slice(0, -1))
      expect(Object.keys(first[key]!).length).toBeGreaterThan(1)
  })

  it('leaves the section untouched when a patch speaks about another one', () => {
    const stored = merged({ colors: { status: { done: { pill: '#059669' } } }, hidden: ['draft'] })
    const patched = mergeSettingsPatch(stored, { editor: { fontSize: 17 } })
    expect(patched.properties).toEqual(stored.properties)
    expect(patched.editor.fontSize).toBe(17)
    const recolored = mergeSettingsPatch(stored, { properties: { hideAllEmpty: true } })
    expect(recolored.properties.hideAllEmpty).toBe(true)
    expect(recolored.properties.colors).toEqual(stored.properties.colors)
  })
})
