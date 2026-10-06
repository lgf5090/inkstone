/**
 * What one turn of the page costs the deck's two list surfaces — the rail beside the projector and
 * the overview grid that roams the whole deck. Every card runs the same three hooks: is it near the
 * viewport, what markup does its slide hold, how is that page sliced. Counting those hooks counts
 * the cards that re-ran, and a turn or a measurement ought to move two of them, not the deck.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { hashContent } from './slide-html'
import type { SlidePlan } from './slide-pagination'
import { usePresentationNav } from './use-presentation-session'

const probe = vi.hoisted(() => ({ runs: null as (() => number) | null, clear: null as (() => void) | null }))

vi.mock('./slide-thumb', async (importOriginal) => {
  const original = await importOriginal<typeof import('./slide-thumb')>()
  const spy = vi.fn((ref: { current: unknown }) => original.useNearViewport(ref as never))
  probe.runs = () => spy.mock.calls.length
  probe.clear = () => spy.mockClear()
  return { ...original, useNearViewport: spy }
})

const { SlideRail } = await import('./slide-rail')
const { SlideOverviewGrid } = await import('./slide-overview-grid')

const ENTRY_COUNT = 24
const plan = (pages: number): SlidePlan => ({ pages: Array.from({ length: pages }, (_, page) => ({ from: page, to: page + 1, top: 0 })), scales: [1], layout: 'cover' })
const deck = Array.from({ length: ENTRY_COUNT }, (_, index) => `# Slide ${index + 1}`)
const cacheKeys = deck.map((_, index) => `key:${index}`)
// One callback for the whole file: the show hands the list a callback that does not move (see the
// last describe), and a fresh arrow per render here would measure that instead of the cards.
const onSelectPage = vi.fn()
const onClose = vi.fn()
const plans: Record<number, SlidePlan> = Object.fromEntries(deck.map((_, index) => [index, plan(1)]))

function railProps(over: Record<string, unknown> = {}) {
  return {
    deck,
    cacheKeys,
    plans,
    index: 0,
    sub: 0,
    designWidth: 1280,
    designHeight: 720,
    title: 'Talk',
    proseFont: 'serif' as const,
    chromeHidden: false,
    occluded: false,
    progress: { measured: ENTRY_COUNT, slides: ENTRY_COUNT, finished: true },
    onSelectPage,
    ...over,
  }
}

function gridProps(over: Record<string, unknown> = {}) {
  const { chromeHidden, occluded, progress, ...shared } = railProps(over)
  void chromeHidden
  void occluded
  void progress
  return { ...shared, onClose }
}

function cardRuns(): number {
  if (!probe.runs) throw new Error('the spy is the point of these cases')
  return probe.runs()
}

function resetRuns(): void {
  probe.clear?.()
}

// The rail scrolls its current card into view and every card watches the viewport, so both are
// stood up here rather than missing — and the observer reports nothing, which keeps the count on the
// cards that re-ran rather than on the markup they would have sliced.
beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('IntersectionObserver', ObserverStub)
  resetRuns()
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the slide list re-runs only the cards that changed', () => {
  it('runs every card once while the list is built', () => {
    const view = renderElement(createElement(SlideRail, railProps()))
    expect(cardRuns()).toBe(ENTRY_COUNT)
    view.unmount()
  })

  it('re-runs the two cards a turn moves the current page between', () => {
    const view: RenderedElement = renderElement(createElement(SlideRail, railProps()))
    resetRuns()
    view.rerender(createElement(SlideRail, railProps({ index: 1 })))
    expect(cardRuns(), `one turn re-ran ${cardRuns()} of ${ENTRY_COUNT} cards`).toBe(2)
    view.unmount()
  })

  it('re-runs the card whose page plan arrived, not the deck', () => {
    const settled: Record<number, SlidePlan> = { ...plans }
    delete settled[5]
    const view = renderElement(createElement(SlideRail, railProps({ plans: settled })))
    resetRuns()
    view.rerender(createElement(SlideRail, railProps({ plans })))
    expect(cardRuns(), `a plan for one slide re-ran ${cardRuns()} cards`).toBe(1)
    view.unmount()
  })
})


// The grid is the surface a presenter roams with the arrow keys, and its focus is its own state: a
// step sideways moves one ring, and that is the only card that has to know.
describe('the overview grid re-runs only the cards its cursor moved between', () => {
  it('runs every card once while the grid is built', () => {
    const view = renderElement(createElement(SlideOverviewGrid, gridProps()))
    expect(cardRuns()).toBe(ENTRY_COUNT)
    view.unmount()
  })

  it('re-runs the two cards a roaming step moves the focus between', async () => {
    const view = renderElement(createElement(SlideOverviewGrid, gridProps()))
    resetRuns()
    const first = view.container.querySelector<HTMLElement>('[data-overview-index="0"]')
    first?.focus()
    await act(async () => {
      first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    expect(view.container.querySelector('[data-overview-index="1"]')?.getAttribute('tabindex'), 'the cursor did not move').toBe('0')
    expect(cardRuns(), `a step re-ran ${cardRuns()} of ${ENTRY_COUNT} cards`).toBe(2)
    view.unmount()
  })
})

// What the show hands the list matters as much as what the list does with it: a callback that changes
// identity when the position moves would re-run every card of a memoized list on every turn.
describe('the show hands its list callbacks that do not move', () => {
  const NAV_DECK = ['# One', '# Two', '# Three']
  const NAV_HASHES = NAV_DECK.map((slide) => hashContent(slide))

  it('keeps one goNext and one jumpToPage across a turn', () => {
    const seen: Array<{ index: number; goNext: () => void; jumpToPage: (slide: number, page: number) => void }> = []

    function Host() {
      const nav = usePresentationNav(NAV_DECK, NAV_HASHES)
      seen.push({ index: nav.index, goNext: nav.goNext, jumpToPage: nav.jumpToPage })
      return createElement('span')
    }

    const view = renderElement(createElement(Host))
    expect(seen.at(-1)?.index).toBe(0)

    act(() => { seen.at(-1)?.goNext() })
    expect(seen.at(-1)?.index, 'the turn did not move the show').toBe(1)
    const before = seen[seen.length - 2]
    const after = seen.at(-1)
    expect(after?.goNext).toBe(before?.goNext)
    expect(after?.jumpToPage).toBe(before?.jumpToPage)
    view.unmount()
  })
})

// The memo only holds while what the cards are handed holds. The show's own position lives inside the
// callback that moves it, so reading that position when the callback runs — rather than freezing it
// into the closure — is what keeps one callback for the whole talk.
describe('the show hands its list a callback that does not move', () => {
  const NAV_DECK = ['# One', '# Two', '# Three']
  const NAV_HASHES = NAV_DECK.map((slide) => hashContent(slide))

  it('keeps one jumpToPage across a turn that actually turned', () => {
    // What each render handed the show, in order: reading the last entry is reading the current one,
    // and a variable assigned inside the component would be narrowed to its initial value here.
    const frames: Array<{ index: number; goNext: () => void; jumpToPage: (slide: number, page: number) => void }> = []

    function Host() {
      const seen = usePresentationNav(NAV_DECK, NAV_HASHES)
      frames.push({ index: seen.index, goNext: seen.goNext, jumpToPage: seen.jumpToPage })
      return createElement('span', { 'data-index': String(seen.index) })
    }

    const view = renderElement(createElement(Host))
    expect(frames.at(-1)?.index).toBe(0)

    act(() => { frames.at(-1)?.goNext() })
    expect(frames.at(-1)?.index, 'the turn did not move the show').toBe(1)
    expect(frames.length, 'the show never re-rendered, so nothing was being measured').toBeGreaterThan(1)
    expect(frames[0]?.jumpToPage).toBe(frames.at(-1)?.jumpToPage)
    view.unmount()
  })
})
