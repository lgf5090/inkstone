/**
 * The overview grid read the way a presenter uses it: every page of the deck is a card, the arrows
 * walk the matrix without moving the show, and a card hands the projector to the page it shows.
 * The grid is laid out by the browser, so the row geometry it walks is handed to it by the test.
 */
import { act, createElement, StrictMode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement } from '../../lib/test-render'
import { initI18n } from '../../lib/i18n'
import { createFenceBodies } from '../../lib/markdown/fence-bodies'
import { rememberSlideHtml } from './slide-html'
import type { SlidePlan } from './slide-pagination'
import { SlideOverviewGrid, type SlideOverviewGridProps } from './slide-overview-grid'
import { SLIDE_PAD_X, SLIDE_PAD_Y } from './slide-stage'

const DECK = ['# First', '# Second', '# Third']

function seed(cacheKey: string, html: string) {
  rememberSlideHtml(cacheKey, { html, fences: createFenceBodies() })
}

// The report is the same geometry every surface reads from, so seeding it once per key is what
// lets a card be asserted on the markup the projector prepared rather than on a placeholder.
function seedDeck() {
  seed('k1', '<h1>First</h1>')
  seed('k2', '<h1>Second</h1>')
  seed('k3', '<h1>Third</h1>')
}

function gridProps(overrides: Partial<SlideOverviewGridProps> = {}): SlideOverviewGridProps {
  return {
    deck: DECK,
    cacheKeys: ['k1', 'k2', 'k3'],
    plans: {},
    index: 1,
    sub: 0,
    designWidth: 1280,
    designHeight: 720,
    proseFont: 'sans',
    onSelectPage: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

// jsdom reports zero for every offset, so a grid that measured the page would walk one endless row.
// The offsets are written onto the cards the test is about to roam.
function paintRows(cards: HTMLElement[], perRow: number) {
  cards.forEach((card, item) => {
    Object.defineProperty(card, 'offsetTop', { value: Math.floor(item / perRow) * 240, configurable: true })
  })
}

function cards(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[data-overview-index]')]
}

function keyOn(element: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    element.dispatchEvent(event)
  })
  return event
}

// A control that stops taking the keyboard once it is masked, the way the projector's chrome is
// `inert` while the matrix is up: jsdom lets `focus()` land on an inert element and the browser
// silently drops it, and that difference is what the grid has to survive.
function maskedOpener(): HTMLButtonElement & { masked: boolean } {
  const opener = document.createElement('button') as HTMLButtonElement & { masked: boolean }
  const take = HTMLButtonElement.prototype.focus.bind(opener)
  opener.masked = false
  opener.focus = () => { if (!opener.masked) take() }
  return opener
}

// The cards are named by their page label, so the assertions read the messages a presenter reads.
beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  // jsdom has no layout, so it has no scrolling either; the grid keeps the focused card in view.
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  class IntersectingObserver {
    private readonly report: (entries: Partial<IntersectionObserverEntry>[]) => void
    constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
      this.report = callback
    }
    observe(target: Element) {
      this.report([{ target, isIntersecting: true }])
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('IntersectionObserver', IntersectingObserver)
  seedDeck()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('SlideOverviewGrid — the matrix', () => {
  it('gives every page of the deck its own card', () => {
    const { container } = renderElement(createElement(SlideOverviewGrid, gridProps()))
    const items = cards(container)
    expect(items.length).toBe(3)
    expect(items.map((item) => item.dataset.slideIndex)).toEqual(['0', '1', '2'])
    expect(items[1]?.getAttribute('aria-current')).toBe('true')
    expect(items[0]?.getAttribute('aria-current')).toBeNull()
    container.remove()
  })

  it('lists the pages a measured slide has, so the grid and the arrow keys agree', () => {
    const plan: SlidePlan = { pages: [{ from: 0, to: 2, top: 0 }, { from: 2, to: 3, top: 400 }], scales: [1, 1, 1] }
    const { container } = renderElement(createElement(SlideOverviewGrid, gridProps({ index: 0, plans: { 1: plan } })))
    const items = cards(container)
    expect(items.length).toBe(4)
    expect(items.map((item) => item.dataset.slidePage)).toEqual(['0', '0', '1', '0'])
    expect(items.map((item) => item.dataset.overviewIndex)).toEqual(['0', '1', '2', '3'])
    container.remove()
  })

  it('numbers the cards and labels them with the heading they carry', () => {
    const { container } = renderElement(createElement(SlideOverviewGrid, gridProps()))
    const items = cards(container)
    expect(items[2]?.textContent).toContain('3')
    expect(items[2]?.textContent).toContain('Third')
    expect(items[2]?.getAttribute('aria-label')).toContain('3')
    container.remove()
  })

  it('paints the card from the markup the projector prepared', () => {
    const { container } = renderElement(createElement(SlideOverviewGrid, gridProps()))
    expect(container.querySelector('[data-overview-index="1"] .ink-slide-thumb .ink-prose h1')?.textContent).toBe('Second')
    container.remove()
  })

  // A page the projector had to shrink to fit is handed to the card at the card's own content box,
  // which is the design canvas minus the same padding the slide page gets — a card that sliced at
  // the un-padded width would show a page that does not match what was measured for it.
  it('slices a shrunk page of the card at the content box the projector measured it in', () => {
    const plan: SlidePlan = { pages: [{ from: 0, to: 2, top: 0 }], scales: [0.5, 0.5] }
    const deck = ['# First\n\nBody of the first slide', '# Second', '# Third']
    const { container } = renderElement(createElement(SlideOverviewGrid, gridProps({ deck, cacheKeys: ['kx', 'k2', 'k3'], index: 0, plans: { 0: plan } })))
    const block = container.querySelector<HTMLElement>('[data-overview-index="0"] .ink-slide-thumb .ink-prose p')
    expect(block?.style.transform).toBe('scale(0.5)')
    expect(block?.style.width).toBe(`${(1280 - SLIDE_PAD_X * 2) / 0.5}px`)
    expect(block?.style.height).toBe(`${(720 - SLIDE_PAD_Y * 2) / 0.5}px`)
    container.remove()
  })
})

describe('SlideOverviewGrid — roaming the grid', () => {
  it('moves the focus a card to the right without turning the page', () => {
    const props = gridProps()
    const { container } = renderElement(createElement(SlideOverviewGrid, props))
    const items = cards(container)
    items[0]?.focus()
    const event = keyOn(items[0]!, 'ArrowRight')
    expect(document.activeElement).toBe(items[1])
    expect(event.defaultPrevented).toBe(true)
    expect(props.onSelectPage).not.toHaveBeenCalled()
    container.remove()
  })

  it('steps a whole row when the grid painted more than one card per row', () => {
    const props = gridProps()
    const { container } = renderElement(createElement(SlideOverviewGrid, props))
    const items = cards(container)
    paintRows(items, 2)
    items[0]?.focus()
    keyOn(items[0]!, 'ArrowDown')
    expect(document.activeElement).toBe(items[2])
    expect(props.onSelectPage).not.toHaveBeenCalled()
    container.remove()
  })

  it('holds the last card instead of walking out of the grid', () => {
    const props = gridProps()
    const { container } = renderElement(createElement(SlideOverviewGrid, props))
    const items = cards(container)
    paintRows(items, 2)
    items[2]?.focus()
    keyOn(items[2]!, 'ArrowDown')
    expect(document.activeElement).toBe(items[2])
    keyOn(items[2]!, 'End')
    expect(document.activeElement).toBe(items[2])
    keyOn(items[2]!, 'Home')
    expect(document.activeElement).toBe(items[0])
    container.remove()
  })

  it('leaves a key the grid does not roam with to the show', () => {
    const props = gridProps()
    const { container } = renderElement(createElement(SlideOverviewGrid, props))
    const items = cards(container)
    items[0]?.focus()
    expect(keyOn(items[0]!, 'PageDown').defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(items[0])
    container.remove()
  })

  it('closes the matrix on the key that opened it, from wherever the keyboard is inside it', () => {
    const props = gridProps()
    const { container } = renderElement(createElement(SlideOverviewGrid, props))
    const items = cards(container)
    items[1]?.focus()
    const event = keyOn(items[1]!, 'g')
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onSelectPage).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
    container.remove()
  })

  it('keeps only the card the presenter is on in the tab order', () => {
    const { container } = renderElement(createElement(SlideOverviewGrid, gridProps()))
    const items = cards(container)
    expect(items.filter((item) => item.tabIndex === 0).length).toBe(1)
    items[0]?.focus()
    keyOn(items[0]!, 'ArrowRight')
    expect(items.findIndex((item) => item.tabIndex === 0)).toBe(1)
    container.remove()
  })
})

describe('SlideOverviewGrid — taking a page', () => {
  it('jumps to the card it was given and puts the grid away', () => {
    const props = gridProps()
    const { container } = renderElement(createElement(SlideOverviewGrid, props))
    const items = cards(container)
    act(() => {
      items[2]?.click()
    })
    expect(props.onSelectPage).toHaveBeenCalledWith(2, 0)
    expect(props.onClose).toHaveBeenCalledTimes(1)
    container.remove()
  })

  it('takes the focus when it opens and hands it back when it closes', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const view = renderElement(createElement(SlideOverviewGrid, gridProps()))
    const items = cards(view.container)
    expect(document.activeElement).toBe(items[1])
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('hands the keyboard back to the control that opened it even when its own mount moved the keyboard', () => {
    const opener = maskedOpener()
    document.body.append(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)
    opener.masked = true
    const view = renderElement(createElement(StrictMode, null, createElement(SlideOverviewGrid, gridProps())))
    expect(document.activeElement).toBe(cards(view.container)[1])
    opener.masked = false
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('starts on the page the show is presenting', () => {
    const props = gridProps({ index: 2 })
    const view = renderElement(createElement(SlideOverviewGrid, props))
    expect(document.activeElement).toBe(cards(view.container)[2])
    view.unmount()
  })
})
