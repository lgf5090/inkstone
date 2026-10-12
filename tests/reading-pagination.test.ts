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
    expect(two.step).toBe(412)
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
