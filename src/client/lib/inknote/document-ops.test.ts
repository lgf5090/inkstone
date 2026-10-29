import { describe, expect, it } from 'vitest'
import type { InknotePageContent, InknoteStroke } from '@shared/inknote/types'
import { moveSelection, pixelErase, scaleSelection } from './document-ops'

function stroke(overrides: Partial<InknoteStroke> = {}): InknoteStroke {
  return {
    id: 's1',
    tool: 'ballpen',
    style: 'dashed',
    shape: null,
    color: '#334455',
    width: 6,
    points: [
      { x: 0, y: 0, p: 1 },
      { x: 20, y: 0, p: 0.5 },
      { x: 40, y: 0, p: 1 },
      { x: 60, y: 0, p: 0.75 },
      { x: 80, y: 0, p: 1 },
    ],
    ...overrides,
  }
}

function page(strokes: InknoteStroke[]): InknotePageContent {
  return {
    format: 'inknote-page',
    version: 1,
    strokes,
    texts: [{
      id: 't1', x: 0.1, y: 0.2, w: 0.3, h: 0.2, text: 'hello', fontSize: 20, color: '#111111',
      align: 'left', bold: false, italic: false, underline: false, hl: null, lh: 1.3, list: null,
    }],
    images: [{ id: 'i1', x: 0.2, y: 0.3, w: 0.4, h: 0.2, assetId: 'a', url: '/api/inknote/assets/a', rot: 0 }],
    bg: null,
  }
}

const METRICS = { width: 100, height: 100, contentWidth: 100, contentHeight: 100 }

describe('pixelErase', () => {
  it('returns null without a path or when nothing is hit', () => {
    expect(pixelErase({ strokes: [stroke()] }, [], 5, () => 'n1')).toBeNull()
    expect(pixelErase({ strokes: [stroke()] }, [{ x: 0, y: 50 }, { x: 80, y: 50 }], 5, () => 'n1')).toBeNull()
  })

  it('splits a stroke and keeps tool, style, colour, width and pressure', () => {
    let next = 0
    const original = stroke()
    const result = pixelErase({ strokes: [original] }, [{ x: 40, y: -10 }, { x: 40, y: 10 }], 1, () => `n${++next}`)
    expect(result).not.toBeNull()
    expect(result).toHaveLength(2)
    expect(result![0]).toMatchObject({
      id: 'n1', tool: 'ballpen', style: 'dashed', shape: null, color: '#334455', width: 6,
    })
    expect(result![0]!.points).toEqual([{ x: 0, y: 0, p: 1 }, { x: 20, y: 0, p: 0.5 }])
    expect(result![1]!.id).toBe('n2')
    expect(result![1]!.points).toEqual([{ x: 60, y: 0, p: 0.75 }, { x: 80, y: 0, p: 1 }])
    expect(original.points).toHaveLength(5)
  })

  it('drops fragments shorter than two points', () => {
    const result = pixelErase({ strokes: [stroke()] }, [{ x: 20, y: -10 }, { x: 20, y: 10 }], 1, () => 'n')
    expect(result!.map((item) => item.points.map((point) => point.x))).toEqual([[40, 60, 80]])
  })

  it('erases a whole stroke and can return an empty page', () => {
    const result = pixelErase({ strokes: [stroke()] }, [{ x: -10, y: 0 }, { x: 100, y: 0 }], 10, () => 'n')
    expect(result).toEqual([])
  })

  it('removes a shape whose box the eraser crosses, even away from a corner', () => {
    const shape = stroke({
      id: 'shape',
      shape: 'rect',
      points: [{ x: 0, y: 0, p: 1 }, { x: 100, y: 100, p: 1 }],
    })
    const kept = stroke({ id: 'keep' })
    const result = pixelErase({ strokes: [shape, kept] }, [{ x: 50, y: -20 }, { x: 50, y: 120 }], 2, () => 'n')
    expect(result!.map((item) => item.id)).toEqual(['keep'])
    expect(result![0]).toBe(kept)
  })

  it('handles a single-point eraser and a single-point stroke', () => {
    const dot = stroke({ id: 'dot', points: [{ x: 10, y: 10, p: 1 }] })
    const result = pixelErase({ strokes: [dot] }, [{ x: 10, y: 10 }], 3, () => 'n')
    expect(result).toEqual([])
  })
})

describe('moveSelection', () => {
  it('moves strokes in content units and text/images in normalized units', () => {
    const content = page([stroke()])
    moveSelection(content, ['s1', 't:t1', 'i1'], 10, 20, METRICS)
    expect(content.strokes[0]!.points[0]).toMatchObject({ x: 10, y: 20 })
    expect(content.texts[0]!.x).toBeCloseTo(0.2)
    expect(content.texts[0]!.y).toBeCloseTo(0.4)
    expect(content.images[0]!.x).toBeCloseTo(0.3)
    expect(content.images[0]!.y).toBeCloseTo(0.5)
  })

  it('converts display deltas through non-identity metrics', () => {
    const content = page([stroke()])
    moveSelection(content, ['s1'], 816, 1056, { width: 816, height: 1056, contentWidth: 612, contentHeight: 792 })
    expect(content.strokes[0]!.points[0]).toMatchObject({ x: 612, y: 792 })
  })

  it('ignores duplicate, unknown ids and unusable input', () => {
    const content = page([stroke()])
    moveSelection(content, ['s1', 's1', 'missing'], 5, 5, METRICS)
    expect(content.strokes[0]!.points[0]).toMatchObject({ x: 5, y: 5 })
    const after = content.strokes[0]!.points[0]!.x
    moveSelection(content, ['s1'], Number.NaN, 1, METRICS)
    moveSelection(content, ['s1'], 1, 1, { width: 0, height: 0, contentWidth: 100, contentHeight: 100 })
    expect(content.strokes[0]!.points[0]!.x).toBe(after)
  })
})

describe('scaleSelection', () => {
  it('scales strokes, text and images around the opposite corner', () => {
    const content = page([stroke({ points: [{ x: 10, y: 10, p: 1 }] })])
    const box = { x: 0, y: 0, w: 100, h: 100 }
    const next = scaleSelection(content, ['s1', 't:t1', 'i1'], box, 'se', { x: 200, y: 200 }, METRICS)
    expect(next).toEqual({ x: 0, y: 0, w: 200, h: 200 })
    expect(content.strokes[0]!.points[0]).toMatchObject({ x: 20, y: 20, p: 1 })
    expect(content.texts[0]).toMatchObject({ x: 0.2, y: 0.4, w: 0.6, h: 0.4 })
    expect(content.images[0]).toMatchObject({ x: 0.4, y: 0.6, w: 0.8, h: 0.4 })
  })

  it('anchors the north-west handle at the south-east corner', () => {
    const content = page([stroke({ points: [{ x: 20, y: 20, p: 1 }, { x: 100, y: 100, p: 1 }] })])
    const next = scaleSelection(content, ['s1'], { x: 0, y: 0, w: 100, h: 100 }, 'nw', { x: 50, y: 50 }, METRICS)
    expect(next).toEqual({ x: 50, y: 50, w: 50, h: 50 })
    expect(content.strokes[0]!.points[0]).toMatchObject({ x: 60, y: 60 })
    expect(content.strokes[0]!.points[1]).toMatchObject({ x: 100, y: 100 })
  })

  it('enforces the minimum box and converts the anchor through the metrics', () => {
    const content = page([stroke({ points: [{ x: 306, y: 396, p: 1 }, { x: 612, y: 792, p: 1 }] })])
    const metrics = { width: 816, height: 1056, contentWidth: 612, contentHeight: 792 }
    const next = scaleSelection(content, ['s1'], { x: 0, y: 0, w: 408, h: 528 }, 'se', { x: 5, y: 5 }, metrics)
    expect(next.w).toBe(16)
    expect(next.h).toBe(16)
    expect(content.strokes[0]!.points[0]!.x).toBeCloseTo(12)
    expect(content.strokes[0]!.points[0]!.y).toBeCloseTo(12)
    expect(content.strokes[0]!.points[1]!.x).toBeCloseTo(24)
    expect(content.strokes[0]!.points[1]!.y).toBeCloseTo(24)
  })

  it('does nothing for a non-finite pointer or a zero-sized box scale factor', () => {
    const content = page([stroke({ points: [{ x: 10, y: 10, p: 1 }] })])
    const box = { x: 0, y: 0, w: 0, h: 0 }
    const unchanged = scaleSelection(content, ['s1'], box, 'se', { x: Number.NaN, y: 10 }, METRICS)
    expect(unchanged).toEqual(box)
    expect(content.strokes[0]!.points[0]).toMatchObject({ x: 10, y: 10 })
    const next = scaleSelection(content, ['s1'], box, 'se', { x: 50, y: 50 }, METRICS)
    expect(next).toEqual({ x: 0, y: 0, w: 50, h: 50 })
    expect(content.strokes[0]!.points[0]).toMatchObject({ x: 10, y: 10 })
  })
})
