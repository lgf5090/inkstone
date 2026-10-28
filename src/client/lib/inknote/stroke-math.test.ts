import { describe, expect, it } from 'vitest'
import {
  HIGHLIGHTER_ALPHA,
  penTaper,
  pressureFilter,
  strokeAlpha,
  strokeBaseWidth,
  strokeWidthAt,
  traceHighlighterPath,
  traceSmoothPath,
  type StrokePathSink,
} from './stroke-math'

function recorder(): { sink: StrokePathSink; calls: string[] } {
  const calls: string[] = []
  const round = (value: number): number => Math.round(value * 1000) / 1000
  return {
    calls,
    sink: {
      beginPath: () => calls.push('begin'),
      moveTo: (x, y) => calls.push(`move ${round(x)} ${round(y)}`),
      lineTo: (x, y) => calls.push(`line ${round(x)} ${round(y)}`),
      quadraticCurveTo: (cx, cy, x, y) => calls.push(`quad ${round(cx)} ${round(cy)} ${round(x)} ${round(y)}`),
    },
  }
}

describe('pressureFilter', () => {
  it('weights the new sample at 0.55 and the previous one at 0.45', () => {
    expect(pressureFilter(1, 0)).toBeCloseTo(0.55)
    expect(pressureFilter(0.2, 1)).toBeCloseTo(0.56)
    expect(pressureFilter(0.6, 0.6)).toBeCloseTo(0.6)
  })
})

describe('strokeBaseWidth', () => {
  it('uses the reference pressure curve with its 0.3 floor and 1.6 minimum', () => {
    expect(strokeBaseWidth(10, 1)).toBeCloseTo(10)
    expect(strokeBaseWidth(10, 0.5)).toBeCloseTo(7.25)
    expect(strokeBaseWidth(10, 0)).toBeCloseTo(6.15)
    expect(strokeBaseWidth(1, 1)).toBe(1.6)
    expect(strokeBaseWidth(0, 0)).toBe(1.6)
  })
})

describe('penTaper', () => {
  it('tapers both ends and stays flat in the middle', () => {
    expect(penTaper(0)).toBeCloseTo(0.35)
    expect(penTaper(0.06)).toBeCloseTo(0.675)
    expect(penTaper(0.12)).toBe(1)
    expect(penTaper(0.5)).toBe(1)
    expect(penTaper(0.88)).toBe(1)
    expect(penTaper(1)).toBeCloseTo(0.35)
  })
})

describe('strokeWidthAt', () => {
  it('applies taper and local pressure with the 0.8 floor', () => {
    expect(strokeWidthAt(10, 0.5, 1)).toBeCloseTo(10)
    expect(strokeWidthAt(10, 0, 1)).toBeCloseTo(3.5)
    expect(strokeWidthAt(10, 0.5, 0)).toBeCloseTo(8)
    expect(strokeWidthAt(0.1, 0.5, 1)).toBe(0.8)
  })
})

describe('strokeAlpha', () => {
  it('keeps the highlighter at 0.45 and gives pencil and brush their base passes', () => {
    expect(strokeAlpha('highlighter', 'normal')).toBe(HIGHLIGHTER_ALPHA)
    expect(strokeAlpha('pen', 'pencil')).toBe(0.5)
    expect(strokeAlpha('pen', 'brush')).toBe(0.92)
    expect(strokeAlpha('ballpen', 'normal')).toBe(1)
  })
})

describe('traceSmoothPath', () => {
  it('emits nothing for fewer than two points', () => {
    const { sink, calls } = recorder()
    traceSmoothPath(sink, [])
    traceSmoothPath(sink, [{ x: 1, y: 2 }])
    expect(calls).toEqual([])
  })

  it('draws a straight segment for two points', () => {
    const { sink, calls } = recorder()
    traceSmoothPath(sink, [{ x: 0, y: 0 }, { x: 10, y: 10 }])
    expect(calls).toEqual(['begin', 'move 0 0', 'line 10 10'])
  })

  it('uses midpoint quadratics between interior points', () => {
    const { sink, calls } = recorder()
    traceSmoothPath(sink, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }])
    expect(calls).toEqual([
      'begin',
      'move 0 0',
      'quad 10 0 10 5',
      'quad 10 10 15 10',
      'line 20 10',
    ])
  })
})

describe('traceHighlighterPath', () => {
  it('joins successive midpoints and ends on the final sample', () => {
    const { sink, calls } = recorder()
    traceHighlighterPath(sink, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
    expect(calls).toEqual([
      'begin',
      'move 0 0',
      'line 5 0',
      'line 10 5',
      'line 10 10',
    ])
  })

  it('emits nothing for fewer than two points', () => {
    const { sink, calls } = recorder()
    traceHighlighterPath(sink, [{ x: 1, y: 1 }])
    expect(calls).toEqual([])
  })
})
