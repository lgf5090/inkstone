import { describe, expect, it } from 'vitest'
import { shapeStats, trendDays } from '../src/worker/tools/compare/stats'
import type { CompareStatsRows } from '../src/shared/tools/compare/types'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

const raw = (patch: Partial<CompareStatsRows> = {}): CompareStatsRows => ({
  total: 0,
  identical: 0,
  byKind: {},
  changedLinesTotal: 0,
  changedRuns: 0,
  extensions: [],
  trend: [],
  ...patch,
})

describe('trendDays', () => {
  it('ends with the day the reader is in and starts seven days back', () => {
    expect(trendDays('7d', NOW)).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ])
    expect(trendDays('30d', NOW)).toHaveLength(30)
  })
})

describe('shapeStats', () => {
  it('fills the quiet days with a real zero', () => {
    const stats = shapeStats('7d', raw({ total: 3, trend: [{ day: '2026-11-02', count: 3 }] }), NOW)
    expect(stats.trend.map((bucket) => bucket.count)).toEqual([0, 0, 0, 0, 3, 0, 0])
    expect(stats.trend[3]!.day).toBe('2026-11-01')
  })

  it('maps the kind rows onto every known kind', () => {
    const stats = shapeStats('7d', raw({ byKind: { text: 4, image: 1, nonsense: 9 } }), NOW)
    expect(stats.byKind).toEqual({ text: 4, file: 0, dir: 0, image: 1, binary: 0 })
  })

  it('rounds the average changed lines to one decimal', () => {
    const stats = shapeStats('7d', raw({ changedLinesTotal: 100, changedRuns: 3 }), NOW)
    expect(stats.averageChangedLines).toBe(33.3)
    expect(shapeStats('7d', raw(), NOW).averageChangedLines).toBe(0)
  })

  it('keeps at most eight extensions, in the order the query returned them', () => {
    const extensions = Array.from({ length: 10 }, (_, index) => ({ ext: `e${index}`, count: index }))
    const stats = shapeStats('7d', raw({ extensions }), NOW)
    expect(stats.topExtensions).toHaveLength(8)
    expect(stats.topExtensions[0]).toEqual({ ext: 'e0', count: 0 })
  })

  it('carries the totals through unchanged', () => {
    const stats = shapeStats('30d', raw({ total: 12, identical: 5 }), NOW)
    expect(stats.total).toBe(12)
    expect(stats.identical).toBe(5)
    expect(stats.range).toBe('30d')
  })
})
