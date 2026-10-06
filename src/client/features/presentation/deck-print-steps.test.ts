import { beforeEach, describe, expect, it } from 'vitest'
import { createFenceBodies, takeFenceIndex, type FenceBodies } from '../../lib/markdown/fence-bodies'
import { buildDeckPages, groupDeckHandout } from './deck-print'
import { formatDeckPosition } from './deck-position'
import { rememberSlideHtml, slideCacheKey, slideSettingFlags } from './slide-html'
import { planSlidePages, type SlideBlock, type SlidePlan } from './slide-pagination'
import type { StageMetrics } from './slide-stage'

// N-31's other half: a page the room watched arrive block by block has to arrive block by block on
// paper too. The export reads the same measured plan the projector walked, so the states it prints are
// the states the presenter passed through — and the handout still shows each page once, as its author
// finished it.
const FLAGS = slideSettingFlags({ math: true, mermaid: true, chart: true })
const METRICS: StageMetrics = { scale: 1, designWidth: 1280, designHeight: 720, contentWidth: 1168, contentHeight: 632 }
const FIRST = '<p>one</p><p>two</p><h2>three</h2><p>four</p>'
const SECOND = '<p>second slide</p>'
const BLOCKS: SlideBlock[] = [
  { top: 0, height: 100, heading: true },
  { top: 100, height: 100, heading: false },
  { top: 200, height: 100, heading: false },
  { top: 300, height: 100, heading: false },
]
const STEPPED: SlidePlan = planSlidePages(BLOCKS, 632, undefined, true)

function fences(body: string): FenceBodies {
  const set = createFenceBodies()
  takeFenceIndex(set, 'kanban', body)
  return set
}

const deck = [FIRST, SECOND]
const cacheKeys = deck.map((_, index) => slideCacheKey({ fingerprint: 'fingerprint', dark: false, index, contentWidth: METRICS.contentWidth, contentHeight: METRICS.contentHeight }))
const hidden = (html: string) => (html.match(/visibility: ?hidden/g) ?? []).length

beforeEach(() => {
  rememberSlideHtml(cacheKeys[0], { html: FIRST, fences: fences('board of the first slide') })
  rememberSlideHtml(cacheKeys[1], { html: SECOND, fences: fences('board of the second slide') })
})

describe('buildDeckPages — a stepped slide prints one page per step', () => {
  it('walks the steps before the page is over', () => {
    const pages = buildDeckPages(deck, cacheKeys, { 0: STEPPED }, METRICS, FLAGS)
    expect(STEPPED.pages).toHaveLength(1)
    expect(pages).toHaveLength(5)
    expect(pages.slice(0, 4).map((page) => page.position.step)).toEqual([0, 1, 2, 3])
    expect(pages.slice(0, 4).map((page) => page.position.steps)).toEqual([3, 3, 3, 3])
    expect(pages[4]!.position.step, 'an unstepped slide has no step of its own').toBeUndefined()
  })

  it('reveals one more block on each printed state, and none on the last', () => {
    const pages = buildDeckPages(deck, cacheKeys, { 0: STEPPED }, METRICS, FLAGS)
    expect(pages.slice(0, 4).map((page) => hidden(page.html))).toEqual([3, 2, 1, 0])
  })

  // The four states of one page used to carry one number, which asked whoever held the printout to work
  // out which of them the room had actually ended on. Each sheet now says how far it had arrived.
  it('numbers every state of a page by itself, inside the number the room read', () => {
    const pages = buildDeckPages(deck, cacheKeys, { 0: STEPPED }, METRICS, FLAGS)
    expect(pages.slice(0, 4).map((page) => formatDeckPosition(page.position))).toEqual(['1 / 2 · 1/4', '1 / 2 · 2/4', '1 / 2 · 3/4', '1 / 2 · 4/4'])
  })

  it('hands the handout the page as its author finished it, once per page', () => {
    const slides = groupDeckHandout(buildDeckPages(deck, cacheKeys, { 0: STEPPED }, METRICS, FLAGS), ['say this', ''])
    expect(slides).toHaveLength(2)
    expect(slides[0]!.pages).toHaveLength(1)
    expect(hidden(slides[0]!.pages[0]!.html)).toBe(0)
  })

  it('leaves a slide without the switch exactly one page per page', () => {
    const pages = buildDeckPages(deck, cacheKeys, { 0: planSlidePages(BLOCKS, 632) }, METRICS, FLAGS)
    expect(pages.filter((page) => page.position.index === 0)).toHaveLength(1)
    expect(pages.every((page) => page.position.step === undefined)).toBe(true)
  })
})
