import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { describeDeckPosition, formatDeckPosition } from './deck-position'
import { pageLabel } from './slide-thumb'

// The wording comes from the resources, so the spoken form is asserted by the numbers it carries and in
// which order — a claim that holds in either language the app runs in.
beforeAll(async () => {
  await initI18n()
})

const digits = (text: string) => text.match(/\d+/g) ?? []

describe('formatDeckPosition', () => {
  it('writes the deck position without padding the numbers', () => {
    expect(formatDeckPosition({ index: 3, count: 28, subPage: 0, pageCount: 1 })).toBe('4 / 28')
    expect(formatDeckPosition({ index: 0, count: 5, subPage: 0, pageCount: 1 })).toBe('1 / 5')
  })

  it('keeps the sub-page inside the same number group as its slide', () => {
    expect(formatDeckPosition({ index: 3, count: 28, subPage: 1, pageCount: 3 })).toBe('4 / 28 · 2/3')
  })

  it('writes nothing when there is no deck', () => {
    expect(formatDeckPosition({ index: 0, count: 0, subPage: 0, pageCount: 1 })).toBe('')
  })

  // A page the room watches arrive block by block is one position with one more number inside it, so the
  // step joins the same string rather than standing beside it (N-31).
  it('adds the reveal to a stepped page of a single-page slide', () => {
    expect(formatDeckPosition({ index: 0, count: 5, subPage: 0, pageCount: 1, step: 1, steps: 3 })).toBe('1 / 5 · 2/4')
  })

  it('reads the groups outward: the slide, then its page, then that page\'s reveal', () => {
    expect(formatDeckPosition({ index: 3, count: 28, subPage: 1, pageCount: 3, step: 0, steps: 2 })).toBe('4 / 28 · 2/3 · 1/3')
  })

  it('leaves an unstepped page at the numbers it already had', () => {
    expect(formatDeckPosition({ index: 3, count: 28, subPage: 1, pageCount: 3, step: 0, steps: 0 })).toBe('4 / 28 · 2/3')
  })
})

describe('describeDeckPosition', () => {
  it('names the slide and the deck it belongs to', () => {
    expect(digits(describeDeckPosition({ index: 3, count: 28, subPage: 0, pageCount: 1 }))).toEqual(['4', '28'])
  })

  it('names the page and its total after them, in the order the sentence reads', () => {
    const spoken = describeDeckPosition({ index: 2, count: 14, subPage: 1, pageCount: 4 })
    expect(digits(spoken)).toEqual(['3', '14', '2', '4'])
  })

  it('is a sentence rather than the digits on screen', () => {
    const position = { index: 2, count: 14, subPage: 1, pageCount: 4 }
    expect(describeDeckPosition(position)).not.toBe(formatDeckPosition(position))
  })

  it('says nothing when there is no deck', () => {
    expect(describeDeckPosition({ index: 0, count: 0, subPage: 0, pageCount: 1 })).toBe('')
  })

  // The one live region is what a listener learns the reveal from, so the step has to reach the sentence
  // rather than only the digits (N-31).
  it('names the reveal of a stepped page after the page it belongs to', () => {
    const spoken = describeDeckPosition({ index: 2, count: 14, subPage: 1, pageCount: 4, step: 1, steps: 2 })
    expect(digits(spoken)).toEqual(['3', '14', '2', '4', '2', '3'])
  })

  it('names the reveal of a slide that never paginated, from its first state to its last', () => {
    expect(digits(describeDeckPosition({ index: 1, count: 6, subPage: 0, pageCount: 1, step: 0, steps: 3 }))).toEqual(['2', '6', '1', '4'])
    expect(digits(describeDeckPosition({ index: 1, count: 6, subPage: 0, pageCount: 1, step: 2, steps: 3 }))).toEqual(['2', '6', '3', '4'])
  })
})

// The slide list names its entries with this sentence too, which is what keeps four surfaces from
// writing one state four ways.
describe('the surfaces share one derivation', () => {
  it('names a rail entry exactly as the show announces the same position', () => {
    const entry = { slide: 2, sub: 1, pageCount: 4 }
    expect(pageLabel(entry, 14)).toBe(describeDeckPosition({ index: entry.slide, count: 14, subPage: entry.sub, pageCount: entry.pageCount }))
  })
})
