import { describe, expect, it } from 'vitest'
import type { Point } from './geometry'
import { detectShape, fitLine, polyFitOk, rdp, rectFitOk, snapToGrid } from './shape-recognition'

function linePoints(count = 9): Point[] {
  const points: Point[] = []
  for (let i = 0; i < count; i++) points.push({ x: (i / (count - 1)) * 200, y: 0 })
  return points
}

function rectPoints(width: number, height: number): Point[] {
  const points: Point[] = []
  const sides: Array<[Point, Point]> = [
    [{ x: 0, y: 0 }, { x: width, y: 0 }],
    [{ x: width, y: 0 }, { x: width, y: height }],
    [{ x: width, y: height }, { x: 0, y: height }],
    [{ x: 0, y: height }, { x: 0, y: 0 }],
  ]
  for (const [from, to] of sides) {
    for (let i = 0; i < 4; i++) {
      const t = i / 4
      points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
  }
  points.push({ x: 0, y: 0 })
  return points
}

function ellipsePoints(rx: number, ry: number): Point[] {
  const points: Point[] = []
  for (let i = 0; i <= 64; i++) {
    const angle = (i / 64) * Math.PI * 2
    points.push({ x: rx + Math.cos(angle) * rx, y: ry + Math.sin(angle) * ry })
  }
  return points
}

describe('detectShape', () => {
  it('returns null below five samples', () => {
    expect(detectShape([])).toBeNull()
    expect(detectShape([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }])).toBeNull()
  })

  it('recognises a straight line and keeps only its endpoints', () => {
    const result = detectShape(linePoints())
    expect(result).toEqual({ kind: 'line', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] })
  })

  it('recognises a square and a rectangle', () => {
    expect(detectShape(rectPoints(100, 100))?.kind).toBe('square')
    expect(detectShape(rectPoints(200, 100))?.kind).toBe('rect')
  })

  it('recognises a circle and an ellipse', () => {
    expect(detectShape(ellipsePoints(50, 50))?.kind).toBe('circle')
    expect(detectShape(ellipsePoints(100, 50))?.kind).toBe('ellipse')
  })

  it('recognises a triangle as a polygon', () => {
    const triangle: Point[] = [
      { x: 0, y: 100 }, { x: 25, y: 50 }, { x: 50, y: 0 }, { x: 75, y: 50 }, { x: 100, y: 100 },
      { x: 75, y: 100 }, { x: 50, y: 100 }, { x: 25, y: 100 }, { x: 0, y: 100 },
    ]
    expect(detectShape(triangle)?.kind).toBe('polygon')
  })

  it('recognises an open arc as a curve', () => {
    const curve: Point[] = []
    for (let i = 0; i <= 20; i++) {
      const x = (i / 20) * 200
      curve.push({ x, y: Math.sin((i / 20) * Math.PI) * 60 })
    }
    const result = detectShape(curve)
    expect(result?.kind).toBe('curve')
    expect(result?.points).toHaveLength(curve.length)
  })

  it('returns null for a closed scribble that fits no primitive', () => {
    const star: Point[] = []
    const corners = 5
    for (let i = 0; i < corners * 2; i++) {
      const radius = i % 2 === 0 ? 100 : 8
      const angle = (i / (corners * 2)) * Math.PI * 2
      star.push({ x: 100 + Math.cos(angle) * radius, y: 100 + Math.sin(angle) * radius })
    }
    star.push(star[0]!)
    expect(detectShape(star)).toBeNull()
  })
})

describe('fitLine', () => {
  it('reports zero deviation for an empty or perfect line', () => {
    expect(fitLine([])).toEqual({ maxDev: 0 })
    expect(fitLine([{ x: 0, y: 0 }, { x: 10, y: 10 }]).maxDev).toBeCloseTo(0)
  })

  it('measures a vertical line as horizontal distance', () => {
    expect(fitLine([{ x: 5, y: 0 }, { x: 5, y: 10 }, { x: 5, y: 20 }]).maxDev).toBeCloseTo(0)
  })
})

describe('rdp', () => {
  it('keeps the endpoints of a collinear run and honours epsilon', () => {
    expect(rdp(linePoints(50), 0.5)).toEqual([{ x: 0, y: 0 }, { x: 200, y: 0 }])
    const path: Point[] = [{ x: 0, y: 0 }, { x: 50, y: 20 }, { x: 100, y: 0 }]
    expect(rdp(path, 10)).toEqual([{ x: 0, y: 0 }, { x: 50, y: 20 }, { x: 100, y: 0 }])
    expect(rdp(path, 30)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }])
  })

  it('handles 30k points without recursion', () => {
    const many: Point[] = []
    for (let i = 0; i < 30_000; i++) many.push({ x: i, y: i % 100 })
    const simplified = rdp(many, 0.1)
    expect(simplified.length).toBeGreaterThan(1)
    expect(simplified[0]).toEqual({ x: 0, y: 0 })
    expect(simplified[simplified.length - 1]).toEqual({ x: 29_999, y: 99 })
  })
})

describe('rectFitOk and polyFitOk', () => {
  it('requires every corner and a small edge deviation', () => {
    const points = rectPoints(100, 100)
    expect(rectFitOk(points, 0, 0, 100, 100, Math.hypot(100, 100))).toBe(true)
    expect(rectFitOk(points.slice(0, 8), 0, 0, 100, 100, Math.hypot(100, 100))).toBe(false)
    expect(rectFitOk([...points, { x: 50, y: 50 }], 0, 0, 100, 100, Math.hypot(100, 100))).toBe(false)
  })

  it('accepts samples near the polygon and rejects a distant point', () => {
    const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]
    expect(polyFitOk(rectPoints(100, 100), square, Math.hypot(100, 100))).toBe(true)
    expect(polyFitOk([{ x: 50, y: 50 }], square, Math.hypot(100, 100))).toBe(false)
    expect(polyFitOk([], [], 100)).toBe(false)
  })
})

describe('snapToGrid', () => {
  it('rounds to the 38 px recognition grid and does not mutate input', () => {
    const input: Point[] = [{ x: 18, y: 20 }, { x: -20, y: 55 }]
    expect(snapToGrid(input)).toEqual([{ x: 0, y: 38 }, { x: -38, y: 38 }])
    expect(input).toEqual([{ x: 18, y: 20 }, { x: -20, y: 55 }])
    expect(snapToGrid([{ x: 5, y: 5 }], 10)).toEqual([{ x: 10, y: 10 }])
    expect(snapToGrid([{ x: 5, y: 5 }], 0)).toEqual([{ x: 5, y: 5 }])
  })
})
