/**
 * The rules that decide what a label looks like, and the split that decides what a label is.
 *
 * Both are pure and both are load-bearing in ways a route test cannot see: the split is what the rail,
 * the aggregate and the registry must agree on, and the tier order is what makes a reader's own choice
 * outrank a default without the default having to be written down first.
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ORGANIZER_COLORS } from '../src/shared/organizer-colors'
import {
  hashColorOf,
  normalizeColor,
  normalizeIcon,
  resolveIdentity,
} from '../src/shared/subscriptions/identity'
import { labelNamesOf, LABEL_MAX } from '../src/shared/subscriptions/model'

/** A catalog stand-in that answers in one language, so the tier order is what is under test. */
const EN = (key: string): string => ({
  'subscriptions.type.streaming': 'Streaming',
  'subscriptions.category.family': 'Family',
} as Record<string, string>)[key] ?? key

describe('labelNamesOf', () => {
  it('splits a category on every separator the app has ever accepted', () => {
    expect(labelNamesOf('视频/音乐，工具, 学习 news', 'category')).toEqual(['视频', '音乐', '工具', '学习', 'news'])
  })

  it('never splits a type', () => {
    expect(labelNamesOf('视频/音乐', 'type')).toEqual(['视频/音乐'])
  })

  it('drops repeats and empty parts', () => {
    expect(labelNamesOf('a // a /  ', 'category')).toEqual(['a'])
    expect(labelNamesOf('', 'category')).toEqual([])
    expect(labelNamesOf(null, 'category')).toEqual([])
  })
})

describe('normalizeIcon', () => {
  it('keeps an offered icon in its stored spelling', () => {
    expect(normalizeIcon('lucide:Tv')).toBe('lucide:Tv')
    expect(normalizeIcon('  lucide:Cloud  ')).toBe('lucide:Cloud')
  })

  it('drops a bare name, an invented name and anything that is not text', () => {
    expect(normalizeIcon('Tv')).toBeNull()
    expect(normalizeIcon('lucide:Netflix')).toBeNull()
    expect(normalizeIcon('')).toBeNull()
    expect(normalizeIcon(42)).toBeNull()
    expect(normalizeIcon(undefined)).toBeNull()
  })
})

describe('normalizeColor', () => {
  it('accepts a palette hex in either case', () => {
    expect(normalizeColor('#DC2626')).toBe('#dc2626')
    expect(normalizeColor('#059669')).toBe('#059669')
  })

  it('refuses anything the contrast maths cannot read', () => {
    expect(normalizeColor('#fff')).toBeNull()
    expect(normalizeColor('red')).toBeNull()
    expect(normalizeColor('var(--accent)')).toBeNull()
    expect(normalizeColor('')).toBeNull()
  })
})

describe('hashColorOf', () => {
  it('answers the same colour for the same name, always', () => {
    expect(hashColorOf('Figma')).toBe(hashColorOf('Figma'))
    expect(hashColorOf('  Figma  ')).toBe(hashColorOf('Figma'))
  })

  it('only ever answers a palette colour', () => {
    for (const name of ['', 'Netflix', '阿里云', 'a'.repeat(LABEL_MAX), '🎬']) {
      expect(ORGANIZER_COLORS).toContain(hashColorOf(name))
    }
  })
})

describe('resolveIdentity', () => {
  it('lets the reader\'s own choice win', () => {
    const resolved = resolveIdentity({
      label: 'Streaming',
      kind: 'type',
      storedIcon: 'lucide:Coffee',
      storedColor: '#059669',
      resolve: EN,
    })
    expect(resolved).toEqual({ icon: 'lucide:Coffee', color: '#059669' })
  })

  it('falls back to the preset per axis, so a half-finished choice does not lose the other half', () => {
    expect(resolveIdentity({ label: 'Streaming', kind: 'type', storedIcon: null, storedColor: '#059669', resolve: EN }))
      .toEqual({ icon: 'lucide:Tv', color: '#059669' })
    expect(resolveIdentity({ label: 'Streaming', kind: 'type', storedIcon: 'lucide:Gem', storedColor: '', resolve: EN }))
      .toEqual({ icon: 'lucide:Gem', color: '#e11d48' })
  })

  it('hashes a colour for a name no preset knows, and leaves its icon unset', () => {
    const resolved = resolveIdentity({ label: 'Figma', kind: 'type', resolve: EN })
    expect(resolved.icon).toBeNull()
    expect(resolved.color).toBe(hashColorOf('Figma'))
  })

  it('does not treat a label as a preset in the wrong list', () => {
    // `Family` is a category preset, not a type one, so as a type it must fall through to the hash.
    expect(resolveIdentity({ label: 'Family', kind: 'type', resolve: EN }).icon).toBeNull()
    expect(resolveIdentity({ label: 'Family', kind: 'category', resolve: EN }).icon).toBe('lucide:Home')
  })
})
