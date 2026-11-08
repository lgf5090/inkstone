import { describe, expect, it } from 'vitest'
import { WrapLineNumberMarker, wrappedRowCount } from './wrap-line-numbers'

describe('wrappedRowCount', () => {
  it('counts the visual rows a wrapped logical line occupies', () => {
    expect(wrappedRowCount(24.6, 24.6)).toBe(1)
    expect(wrappedRowCount(172.18, 24.6)).toBe(7)
    expect(wrappedRowCount(49.2, 24.6)).toBe(2)
  })

  it('never reports fewer than one row, whatever the browser measured', () => {
    expect(wrappedRowCount(0, 24.6)).toBe(1)
    expect(wrappedRowCount(Number.NaN, 24.6)).toBe(1)
    expect(wrappedRowCount(24.6, 0)).toBe(1)
  })
})

describe('WrapLineNumberMarker', () => {
  it('draws the line number once and one tick per continuation row', () => {
    const dom = new WrapLineNumberMarker('341', 4).toDOM()
    expect(dom.querySelector('.cm-wrap-line-number')?.textContent).toBe('341')
    expect(dom.querySelectorAll('.cm-wrap-line-continuation')).toHaveLength(3)
    for (const tick of dom.querySelectorAll('.cm-wrap-line-continuation'))
      expect(tick.getAttribute('aria-hidden')).toBe('true')
  })

  it('does not draw a continuation tick for a single-row line', () => {
    const dom = new WrapLineNumberMarker('12', 1).toDOM()
    expect(dom.querySelectorAll('.cm-wrap-line-continuation')).toHaveLength(0)
  })

  it('compares by label and row count, so the gutter can skip equal markers', () => {
    expect(new WrapLineNumberMarker('7', 3).eq(new WrapLineNumberMarker('7', 3))).toBe(true)
    expect(new WrapLineNumberMarker('7', 3).eq(new WrapLineNumberMarker('7', 2))).toBe(false)
    expect(new WrapLineNumberMarker('7', 3).eq(new WrapLineNumberMarker('8', 3))).toBe(false)
  })
})
