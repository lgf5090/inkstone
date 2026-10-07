import { describe, expect, it } from 'vitest'
import { resolveProperties } from './property-style'
import type { PropertyResolveContext, PropertyStyleSettings } from './property-style'

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime()

const CONTEXT = { locale: 'en-US', now: NOW }

function settings(patch: Partial<PropertyStyleSettings> = {}): PropertyStyleSettings {
  return {
    enabled: true,
    colors: {},
    hidden: [],
    hiddenWhenEmpty: [],
    hideAllEmpty: false,
    customDateFormats: false,
    dateFormat: '',
    dateTimeFormat: '',
    relativeDateColors: false,
    dateColors: {},
    progress: {},
    formats: {},
    selectOptions: {},
    ...patch,
  }
}

function one(data: Record<string, unknown>, patch: Partial<PropertyStyleSettings> = {}, extra: PropertyResolveContext = CONTEXT) {
  return resolveProperties(data, settings(patch), extra)[0]!
}

describe('resolveProperties colours', () => {
  it('paints the value the reader gave a colour to', () => {
    const row = one({ status: 'done' }, { colors: { status: { done: { pill: '#059669', text: '#059669' } } } })
    expect(row.items[0]?.pill).toBe('#059669')
    expect(row.items[0]?.pillSlot).toBe('color')
    expect(row.items[0]?.textColor).toBe('#059669')
    expect(row.pill).toBe('#059669')
  })

  it('reads the property name without caring about its case', () => {
    const row = one({ Status: 'done' }, { colors: { status: { done: { pill: '#2563eb' } } } })
    expect(row.items[0]?.pill).toBe('#2563eb')
  })

  it('keeps none and default as the two different answers they are', () => {
    expect(one({ s: 'a' }, { colors: { s: { a: { pill: 'none' } } } }).items[0]).toMatchObject({ pill: null, pillSlot: 'transparent' })
    expect(one({ s: 'a' }, { colors: { s: { a: { pill: 'default' } } } }).items[0]).toMatchObject({ pill: null, pillSlot: 'theme' })
  })

  it('colours every pill of a list and each tag by its own value', () => {
    const row = one({ people: ['Ada', 'Linus'] }, { colors: { people: { Ada: { pill: '#dc2626' }, Linus: { pill: '#2563eb' } } } })
    expect(row.items.map((item) => item.pill)).toEqual(['#dc2626', '#2563eb'])
    expect(row.pill).toBe(null)
    const tags = one({ tags: ['red', 'blue'] }, { colors: { tags: { red: { pill: '#dc2626' } } } })
    expect(tags.items.map((item) => item.pill)).toEqual(['#dc2626', null])
  })

  it('falls back to the tag registry when the note set no colour', () => {
    const row = one({ tags: ['urgent'] }, {}, { ...CONTEXT, tagColorOf: (name: string) => (name === 'urgent' ? '#ea580c' : null) })
    expect(row.items[0]?.textColor).toBe('#ea580c')
    expect(row.items[0]?.textSlot).toBe('color')
  })

  it('lets an explicit rule win over the registry', () => {
    const row = one(
      { tags: ['urgent'] },
      { colors: { tags: { urgent: { text: '#059669' } } } },
      { ...CONTEXT, tagColorOf: () => '#ea580c' },
    )
    expect(row.items[0]?.textColor).toBe('#059669')
  })
})

describe('resolveProperties hiding', () => {
  it('hides a named property whatever its value', () => {
    expect(one({ secret: 'x' }, { hidden: ['Secret'] })).toMatchObject({ hidden: true, hiddenReason: 'property' })
    expect(one({ secret: 'x' })).toMatchObject({ hidden: false, hiddenReason: null })
  })

  it('hides only the empty ones when the author asked for that', () => {
    expect(one({ draft: '' }, { hiddenWhenEmpty: ['draft'] })).toMatchObject({ hidden: true, hiddenReason: 'empty', empty: true })
    expect(one({ draft: 'text' }, { hiddenWhenEmpty: ['draft'] })).toMatchObject({ hidden: false })
    expect(one({ draft: [] }, { hideAllEmpty: true })).toMatchObject({ hidden: true, hiddenReason: 'empty' })
    expect(one({ draft: 0 }, { hideAllEmpty: true })).toMatchObject({ hidden: false })
  })

  it('shows everything again when the whole feature is off', () => {
    const row = one({ secret: 'x', status: 'done' }, {
      enabled: false,
      hidden: ['secret'],
      colors: { status: { done: { pill: '#dc2626' } } },
    })
    expect(row).toMatchObject({ hidden: false, pill: null })
    expect(row.items[0]?.pill).toBe(null)
  })
})

describe('resolveProperties progress', () => {
  it('uses the fixed maximum, then the named property, then a hundred', () => {
    expect(one({ pages: 30 }, { progress: { pages: { max: 120 } } })?.progress).toEqual({ value: 30, max: 120, percent: 25, variant: 'bar' })
    expect(one({ pages: 30, total: 60 }, { progress: { pages: { maxProperty: 'total' } } })?.progress?.percent).toBe(50)
    expect(one({ pages: 25 }, { progress: { pages: {} } })?.progress).toMatchObject({ max: 100, percent: 25 })
    expect(one({ pages: 25 }, { progress: { pages: { variant: 'circle' } } })?.progress?.variant).toBe('circle')
  })

  it('refuses a maximum it cannot divide by', () => {
    expect(one({ pages: 25 }, { progress: { pages: { max: 0 } } })?.progress?.max).toBe(100)
    expect(one({ pages: 25 }, { progress: { pages: { maxProperty: 'missing' } } })?.progress?.max).toBe(100)
    expect(one({ pages: 'lots' }, { progress: { pages: { max: 10 } } })?.progress).toBe(null)
  })

  it('clamps a value that runs past its maximum', () => {
    expect(one({ pages: 240 }, { progress: { pages: { max: 120 } } })?.progress?.percent).toBe(100)
  })
})

describe('resolveProperties formats and dates', () => {
  it('replaces the value with what the template says', () => {
    const row = one({ length: 829 }, { formats: { length: { template: '{{durationFormatted propertyValue "seconds" "HH:mm:ss"}}' } } })
    expect(row.display).toBe('00:13:49')
    expect(row.formatted).toBe(true)
  })

  it('keeps the raw text when the template cannot be read', () => {
    const row = one({ length: 'x' }, { formats: { length: { template: '{{nonsense propertyValue}}' } } })
    expect(row.display).toBe('x')
    expect(row.formatted).toBe(false)
  })

  it('marks the properties the reader wants rendered as markdown', () => {
    expect(one({ bio: 'a' }, { formats: { bio: { markdown: true } } })).toMatchObject({ markdown: true })
    expect(one({ bio: 'a' })).toMatchObject({ markdown: false })
  })

  it('formats a date only when the reader turned that on', () => {
    const data = { due: '2026-10-08' }
    expect(one(data).display).toBe('2026-10-08')
    expect(one(data, { customDateFormats: true, dateFormat: 'MMM D, YYYY' }).display).toBe('Oct 8, 2026')
    expect(one(data, { customDateFormats: true, dateFormat: '' }).display).toBe('2026-10-08')
  })

  it('leaves a value that only looks like a date alone', () => {
    expect(one({ code: '2026-13-08' }, { customDateFormats: true, dateFormat: 'YYYY' }).display).toBe('2026-13-08')
  })

  it('tints past, present and future dates with the colours the reader chose', () => {
    const patch = { relativeDateColors: true, dateColors: { past: '#dc2626', present: '#059669', future: '#2563eb' } }
    expect(one({ due: '2026-10-01' }, patch).items[0]?.textColor).toBe('#dc2626')
    expect(one({ due: '2026-10-08' }, patch).items[0]?.textColor).toBe('#059669')
    expect(one({ due: '2026-10-11' }, patch).items[0]?.textColor).toBe('#2563eb')
    expect(one({ due: '2026-10-08' }, patch).relative).toBe('present')
  })

  it('lets an explicit text colour outrank the date tint', () => {
    const row = one(
      { due: '2026-10-01' },
      { relativeDateColors: true, dateColors: { past: '#dc2626' }, colors: { due: { '2026-10-01': { text: '#9333ea' } } } },
    )
    expect(row.items[0]?.textColor).toBe('#9333ea')
  })
})

describe('resolveProperties shapes', () => {
  it('offers the option list the reader wrote for a text property', () => {
    expect(one({ status: 'a' }, { selectOptions: { status: ['a', 'b'] } }).options).toEqual(['a', 'b'])
    expect(one({ status: 'a' }).options).toEqual([])
  })

  it('renders an object value as the JSON it holds', () => {
    const row = one({ pair: { a: 1 } })
    expect(row.kind).toBe('object')
    expect(row.display).toBe('{"a":1}')
  })

  it('keeps a boolean and a number as scalars, not as pills', () => {
    expect(one({ done: true })).toMatchObject({ kind: 'boolean', display: 'true' })
    expect(one({ n: 4 })).toMatchObject({ kind: 'number', display: '4' })
  })
})
