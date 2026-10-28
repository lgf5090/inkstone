import { describe, expect, it } from 'vitest'
import type { InknotePageContent, InknoteStroke, InknoteTextBox } from '@shared/inknote/types'
import {
  boundsOf,
  boxIntersects,
  computeSelectionBox,
  fromContentPoint,
  mergeBounds,
  pointInPolygon,
  segmentDistance,
  selectionBounds,
  toContentPoint,
} from './geometry'

const METRICS = { width: 816, height: 1056, contentWidth: 612, contentHeight: 792 }

function stroke(id: string, points: Array<[number, number]>, extra: Partial<InknoteStroke> = {}): InknoteStroke {
  return {
    id,
    tool: 'pen',
    style: 'normal',
    shape: null,
    color: '#123456',
    width: 4,
    points: points.map(([x, y]) => ({ x, y, p: 1 })),
    ...extra,
  }
}

function text(id: string): InknoteTextBox {
  return {
    id,
    x: 0.5,
    y: 0.25,
    w: 0.25,
    h: 0.1,
    text: 'hello',
    fontSize: 20,
    color: '#111111',
    align: 'left',
    bold: false,
    italic: false,
    underline: false,
    hl: null,
    lh: 1.3,
    list: null,
  }
}

function page(): InknotePageContent {
  return {
    format: 'inknote-page',
    version: 1,
    strokes: [stroke('s1', [[0, 0], [100, 50]])],
    texts: [text('t1')],
    images: [{ id: 'i1', x: 0.1, y: 0.1, w: 0.2, h: 0.2, assetId: 'a', url: '/api/inknote/assets/a', rot: 0 }],
    bg: null,
  }
}

describe('boundsOf', () => {
  it('returns null for an empty list', () => {
    expect(boundsOf([])).toBeNull()
  })

  it('handles a single point, negative values and large coordinates', () => {
    expect(boundsOf([{ x: 7, y: -9 }])).toEqual({ x: 7, y: -9, w: 0, h: 0 })
    expect(boundsOf([{ x: -1e6, y: -1e6 }, { x: 1e6, y: 1e6 }])).toEqual({ x: -1e6, y: -1e6, w: 2e6, h: 2e6 })
  })
})

describe('mergeBounds', () => {
  it('unions boxes and passes through null', () => {
    expect(mergeBounds(null, null)).toBeNull()
    expect(mergeBounds({ x: 0, y: 0, w: 10, h: 10 }, null)).toEqual({ x: 0, y: 0, w: 10, h: 10 })
    expect(mergeBounds(null, { x: 5, y: 5, w: 2, h: 2 })).toEqual({ x: 5, y: 5, w: 2, h: 2 })
    expect(mergeBounds({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({ x: 0, y: 0, w: 15, h: 15 })
  })

  it('does not mutate its inputs', () => {
    const a = { x: 0, y: 0, w: 1, h: 1 }
    const b = { x: 2, y: 2, w: 1, h: 1 }
    mergeBounds(a, b)
    expect(a).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(b).toEqual({ x: 2, y: 2, w: 1, h: 1 })
  })
})

describe('boxIntersects', () => {
  it('accepts overlap, containment and touching edges', () => {
    const box = { x: 0, y: 0, w: 10, h: 10 }
    expect(boxIntersects(box, { x: 5, y: 5, w: 10, h: 10 })).toBe(true)
    expect(boxIntersects(box, { x: 2, y: 2, w: 1, h: 1 })).toBe(true)
    expect(boxIntersects(box, { x: 10, y: 10, w: 5, h: 5 })).toBe(true)
    expect(boxIntersects(box, { x: 11, y: 0, w: 5, h: 5 })).toBe(false)
  })
})

describe('pointInPolygon', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]

  it('detects inside, outside and boundary points', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true)
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false)
    expect(pointInPolygon({ x: 0, y: 5 }, square)).toBe(true)
    expect(pointInPolygon({ x: 10, y: 10 }, square)).toBe(true)
  })

  it('handles concave polygons and degenerate input', () => {
    const concave = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
      { x: 6, y: 4 }, { x: 2, y: 10 },
    ]
    expect(pointInPolygon({ x: 6, y: 8 }, concave)).toBe(false)
    expect(pointInPolygon({ x: 6, y: 2 }, concave)).toBe(true)
    expect(pointInPolygon({ x: 1, y: 1 }, concave)).toBe(true)
    expect(pointInPolygon({ x: 1, y: 1 }, [{ x: 0, y: 0 }, { x: 2, y: 2 }])).toBe(false)
  })
})

describe('segmentDistance', () => {
  it('measures projection, endpoints and a degenerate segment', () => {
    expect(segmentDistance(5, 3, 0, 0, 10, 0)).toBe(3)
    expect(segmentDistance(-3, 0, 0, 0, 10, 0)).toBe(3)
    expect(segmentDistance(4, 3, 2, 2, 2, 2)).toBe(Math.hypot(2, 1))
  })
})

describe('content and display coordinates', () => {
  it('round-trips and preserves extra fields', () => {
    const content = { x: 306, y: 396, p: 0.5 }
    const display = fromContentPoint(content, METRICS)
    expect(display).toEqual({ x: 408, y: 528, p: 0.5 })
    expect(toContentPoint(display, METRICS)).toEqual(content)
  })

  it('is the identity when an axis has no usable content size', () => {
    const point = { x: 12, y: 34 }
    expect(fromContentPoint(point, { width: 816, height: 1056, contentWidth: 0, contentHeight: -1 })).toEqual(point)
  })
})

describe('selectionBounds', () => {
  function expectBounds(
    actual: { x: number; y: number; w: number; h: number } | null,
    expected: { x: number; y: number; w: number; h: number },
  ): void {
    expect(actual).not.toBeNull()
    expect(actual!.x).toBeCloseTo(expected.x)
    expect(actual!.y).toBeCloseTo(expected.y)
    expect(actual!.w).toBeCloseTo(expected.w)
    expect(actual!.h).toBeCloseTo(expected.h)
  }

  it('unions strokes in display space and prefixed text/image boxes', () => {
    expectBounds(selectionBounds(page(), ['s1'], METRICS), { x: 0, y: 0, w: 133.33333333333334, h: 66.66666666666667 })
    expectBounds(selectionBounds(page(), ['t:t1'], METRICS), { x: 408, y: 264, w: 204, h: 105.6 })
    expectBounds(selectionBounds(page(), ['i:i1', 's1'], METRICS), { x: 0, y: 0, w: 244.8, h: 316.8 })
  })

  it('matches plain ids against strokes then text, ignores unknown ids and duplicates', () => {
    expectBounds(selectionBounds(page(), ['t1'], METRICS), { x: 408, y: 264, w: 204, h: 105.6 })
    expect(selectionBounds(page(), ['missing'], METRICS)).toBeNull()
    expect(selectionBounds(page(), [], METRICS)).toBeNull()
    const once = selectionBounds(page(), ['s1', 's1'], METRICS)
    expect(once).toEqual(selectionBounds(page(), ['s1'], METRICS))
  })

  it('pads the computed selection box and returns null without bounds', () => {
    expect(computeSelectionBox(null)).toBeNull()
    expect(computeSelectionBox({ x: 10, y: 20, w: 30, h: 40 })).toEqual({ x: 2, y: 12, w: 46, h: 56 })
    expect(computeSelectionBox({ x: 10, y: 20, w: 30, h: 40 }, 0)).toEqual({ x: 10, y: 20, w: 30, h: 40 })
  })
})
