// @vitest-environment jsdom
/**
 * What a list icon may be, and what the screens draw for one.
 *
 * The picker writes `lucide:<Name>` or a single emoji. A bare word — which only the API can let in —
 * is neither: drawing its first letters beside a list named Work reads as a typo, so nothing is drawn.
 */
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderElement } from '../../lib/test-render'
import { LIST_ICONS, ListIcon, listIconOption } from './list-icons'

describe('list icons', () => {
  it('resolves the identifier the picker writes', () => {
    expect(listIconOption('lucide:Briefcase')?.name).toBe('Briefcase')
  })

  it('treats an emoji, a bare word and no icon as no lucide option', () => {
    expect(listIconOption('📅')).toBeNull()
    expect(listIconOption('Briefcase')).toBeNull()
    expect(listIconOption(null)).toBeNull()
  })

  it('offers a grouped set wide enough to name a list by what it is about', () => {
    expect(LIST_ICONS.length).toBeGreaterThanOrEqual(48)
    expect(new Set(LIST_ICONS.map((option) => option.name)).size).toBe(LIST_ICONS.length)
  })

  it('draws the glyph for a known icon and the emoji for an emoji', () => {
    const glyph = renderElement(createElement(ListIcon, { icon: 'lucide:Briefcase' }))
    expect(glyph.container.querySelector('svg')).not.toBeNull()
    glyph.unmount()

    const emoji = renderElement(createElement(ListIcon, { icon: '📅' }))
    expect(emoji.container.textContent).toBe('📅')
    emoji.unmount()
  })

  it('draws nothing for a bare word', () => {
    const view = renderElement(createElement(ListIcon, { icon: 'Briefcase' }))
    expect(view.container.innerHTML).toBe('')
    view.unmount()
  })
})
