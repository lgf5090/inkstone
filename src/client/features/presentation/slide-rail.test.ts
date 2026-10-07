import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement } from '../../lib/test-render'
import { extractSlideHeading } from './slide-thumb'
import { SlideRail } from './slide-rail'

describe('extractSlideHeading', () => {
  it('extracts H1 heading as the slide title', () => {
    const source = '# Welcome to Inkstone\n\nThis is a presentation slide.'
    expect(extractSlideHeading(source)).toBe('Welcome to Inkstone')
  })

  it('extracts lower-level headings (H2-H6)', () => {
    expect(extractSlideHeading('## Section Two\nSome content')).toBe('Section Two')
    expect(extractSlideHeading('### Deep Topic\nDetails')).toBe('Deep Topic')
    expect(extractSlideHeading('#### Level 4\nDetails')).toBe('Level 4')
  })

  it('falls back to the first non-empty prose line if no heading exists', () => {
    const source = 'Just plain text describing the architecture.\nSecond line.'
    expect(extractSlideHeading(source)).toBe('Just plain text describing the')
  })

  it('ignores HTML comments and code block markers when falling back', () => {
    const source = '<!-- note: private notes -->\n```ts\nconst x = 1\n```\nReal text content here'
    expect(extractSlideHeading(source)).toBe('Real text content here')
  })

  it('returns empty string for empty or comment-only slides', () => {
    expect(extractSlideHeading('')).toBe('')
    expect(extractSlideHeading('   \n\n  ')).toBe('')
    expect(extractSlideHeading('<!-- note: speaker notes only -->')).toBe('')
  })
})

const defaultRailProps = {
  deck: ['# Slide 1', '# Slide 2', '# Slide 3'],
  cacheKeys: ['k1', 'k2', 'k3'],
  plans: {},
  index: 1,
  sub: 0,
  designWidth: 1280,
  designHeight: 720,
  title: 'Test Deck',
  proseFont: 'sans' as const,
  chromeHidden: false,
  occluded: false,
  progress: { finished: true, measured: 3, slides: 3 },
  onSelectPage: vi.fn(),
}

// The rail scrolls its active page into view and each thumbnail watches the viewport, so every case
// in this file runs with those two browser objects stood up rather than missing.
beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('IntersectionObserver', ObserverStub)
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('SlideRail ARIA semantics', () => {
  it('declares tablist and tab roles with accurate setsize and posinset', () => {
    const { container } = renderElement(createElement(SlideRail, defaultRailProps))
    const tablist = container.querySelector('[role="tablist"]')
    expect(tablist?.getAttribute('aria-orientation')).toBe('vertical')

    const tabs = container.querySelectorAll('[role="tab"]')
    expect(tabs.length).toBe(3)
    expect(tabs[0]?.getAttribute('aria-posinset')).toBe('1')
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[1]?.getAttribute('aria-posinset')).toBe('2')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
  })

  // The list is under the grid, and its active page is in the tab order; leaving it reachable
  // would let Tab walk into a layer the presenter cannot see.
  it('takes the list out of reach while the overview grid is up', () => {
    const { container } = renderElement(createElement(SlideRail, { ...defaultRailProps, occluded: true }))
    expect(container.querySelector('[data-presentation-rail]')?.hasAttribute('inert')).toBe(true)
  })

  it('takes the list out of reach once the chrome has faded', () => {
    const { container } = renderElement(createElement(SlideRail, { ...defaultRailProps, chromeHidden: true }))
    expect(container.querySelector('[data-presentation-rail]')?.hasAttribute('inert')).toBe(true)
  })
})

// N-21: a tab says which one it is once. `aria-current` next to `aria-selected` was that same fact
// spelled twice, and this list has no tabpanel either of them could point at.
describe('SlideRail current page', () => {
  it('names the current page in the one attribute the tablist owns', () => {
    const { container } = renderElement(createElement(SlideRail, defaultRailProps))
    const tabs = [...container.querySelectorAll('[role="tab"]')]
    const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0]?.getAttribute('aria-current')).toBeNull()
    expect(tabs.some((tab) => tab.hasAttribute('aria-current'))).toBe(false)
  })
})
