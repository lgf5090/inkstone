import { describe, expect, it } from 'vitest'
import {
  chapterProgress,
  computeGeometry,
  pageCount,
  pageForOffset,
  pageForScroll,
  scrollForPage,
} from '../src/client/features/reading/engine/paginate'

describe('computeGeometry', () => {
  it('splits the viewport into columns and a gutter each', () => {
    const one = computeGeometry(800, 1, 24)
    expect(one.columnWidth).toBe(800)
    // A single column still advances by width + gap: that is where the browser puts the next column,
    // and a page turn that assumed 800 would drift a gutter behind the text on every page.
    expect(one.step).toBe(824)

    const two = computeGeometry(800, 2, 24)
    expect(two.columnWidth).toBe(388)
    // A spread of two columns is 388 + 24 + 388 of text, and the gutter after it belongs to the page:
    // turning by one column would show the reader the second column twice.
    expect(two.step).toBe(824)
    expect(two.viewport).toBe(800)
  })

  it('shows the page margin on every page, not only the first', () => {
    const one = computeGeometry(800, 1, 0, 24)
    expect(one.step).toBe(800)
    // The margin is the scroll container's padding, so the window is wider than the column it shows.
    expect(one.viewport).toBe(848)
    // n columns of text occupy the margin once, then a column each: three pages of prose measure 2448.
    expect(pageCount(24 + 800 * 3, one)).toBe(3)
    expect(pageCount(24 + 800, one)).toBe(1)
  })

  it('counts spreads, not columns', () => {
    const two = computeGeometry(800, 2, 24)
    // Four columns of a spread of two: 388 each with three gutters, and no margin.
    expect(pageCount(388 * 4 + 24 * 3, two)).toBe(2)
    expect(pageCount(388 * 6 + 24 * 5, two)).toBe(3)
  })

  it('keeps a usable column in a window too narrow for two', () => {
    const geometry = computeGeometry(300, 2, 40)
    expect(geometry.columns).toBe(2)
    // 120px is the floor a column may not go under, so a cramped window paginates rather than vanishing.
    expect(geometry.columnWidth).toBeGreaterThanOrEqual(120)
    expect(computeGeometry(120, 2, 40).columnWidth).toBe(120)
  })

  it('refuses a zero or negative width', () => {
    expect(computeGeometry(0, 1, 0).columnWidth).toBe(120)
    expect(computeGeometry(-40, 1, 0).step).toBeGreaterThan(0)
  })
})

describe('pageCount', () => {
  it('counts one page for content that fits', () => {
    expect(pageCount(800, computeGeometry(800, 1, 24))).toBe(1)
  })

  it('counts the pages a chapter of several columns needs', () => {
    const geometry = computeGeometry(800, 1, 24)
    expect(pageCount(800 + 800, geometry)).toBe(2)
    expect(pageCount(800 * 4, geometry)).toBe(4)
  })

  it('does not charge a reader for a pixel of overflow', () => {
    const geometry = computeGeometry(800, 1, 24)
    expect(pageCount(801, geometry)).toBe(1)
    expect(pageCount(1599, geometry)).toBe(2)
  })

  it('survives a chapter that has not laid out yet', () => {
    expect(pageCount(0, computeGeometry(800, 1, 24))).toBe(1)
  })
})

describe('page and scroll correspondence', () => {
  it('maps an element’s offset to the page it landed on', () => {
    const geometry = computeGeometry(800, 2, 24)
    expect(pageForOffset(0, geometry)).toBe(0)
    expect(pageForOffset(geometry.step, geometry)).toBe(1)
    expect(pageForOffset(geometry.step * 2 + 10, geometry)).toBe(2)
  })

  it('round-trips a page through the scroll position', () => {
    const geometry = computeGeometry(800, 1, 24)
    for (const page of [0, 1, 7, 40]) {
      expect(pageForScroll(scrollForPage(page, geometry), geometry)).toBe(page)
    }
  })

  it('clamps a nonsense page to the first one', () => {
    expect(scrollForPage(-3, computeGeometry(800, 1, 24))).toBe(0)
  })
})

describe('chapterProgress', () => {
  it('reports a one-page chapter as finished rather than as a divide by zero', () => {
    expect(chapterProgress(0, 1)).toEqual({ page: 1, pages: 1, fraction: 1 })
  })

  it('spreads the pages between 0 and 1', () => {
    expect(chapterProgress(0, 5).fraction).toBe(0)
    expect(chapterProgress(2, 5).fraction).toBe(0.5)
    expect(chapterProgress(4, 5).fraction).toBe(1)
  })

  it('clamps a page number that ran past the end', () => {
    expect(chapterProgress(9, 5)).toEqual({ page: 5, pages: 5, fraction: 1 })
  })
})
