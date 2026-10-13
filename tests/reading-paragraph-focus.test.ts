// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { blockHolding, blockSpans, paintFocus } from '../src/client/features/reading/engine/paragraph-focus'

const span = (start: number, size: number) => ({ start, end: start + size })

describe('which paragraph is lit', () => {
  it('picks the last block that has already begun', () => {
    const spans = [span(0, 100), span(100, 100), span(200, 100)]
    expect(blockHolding(spans, 0)).toBe(0)
    expect(blockHolding(spans, 140)).toBe(1)
    expect(blockHolding(spans, 260)).toBe(2)
  })

  it('holds the first block above the top of the page', () => {
    expect(blockHolding([span(50, 100), span(200, 100)], 0)).toBe(0)
  })

  it('keeps the last block lit past the end of the chapter', () => {
    const spans = [span(0, 100), span(100, 100)]
    expect(blockHolding(spans, 5_000)).toBe(1)
  })

  it('tolerates a boundary landing a hair short of the block that starts there', () => {
    expect(blockHolding([span(0, 100), span(100, 100)], 99)).toBe(1)
  })

  it('has one block lit whatever the page', () => {
    const spans = [span(0, 40), span(40, 40), span(80, 40)]
    for (const at of [-10, 0, 20, 39, 40, 79, 80, 120]) {
      expect(blockHolding(spans, at)).toBeGreaterThanOrEqual(0)
      expect(blockHolding(spans, at)).toBeLessThan(spans.length)
    }
  })
})

describe('the blocks themselves', () => {
  it('reads the axis it is asked for and skips the empty gaps', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>一</p><p>二</p><div></div><span>三</span>'
    const spans = blockSpans(root, 'x')
    // jsdom has no layout, so every box is zero: the rule that survives is that a child with no words
    // is not a paragraph to dim, and one with words is.
    expect(spans.length).toBe(3)
  })

  it('lights exactly one child', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>a</p><p>b</p><p>c</p>'
    paintFocus(root, 1)
    expect([...root.children].map((one) => one.classList.contains('reader-now'))).toEqual([false, true, false])
    paintFocus(root, -1)
    expect(root.querySelectorAll('.reader-now').length).toBe(0)
  })
})
