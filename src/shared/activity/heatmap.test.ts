import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_KINDS,
  HEATMAP_MAX_DAYS,
  heatLevel,
  heatmapWindow,
  isHeatmapDay,
  parseHeatmapKinds,
  yearGrid,
} from './heatmap'

describe('yearGrid', () => {
  it('opens on the Monday on or before 1 January and keeps every column a full ISO week', () => {
    // 1 January 2024 is a Monday, so the year needs no leading padding and 53 columns total.
    const columns = yearGrid(2024)
    expect(columns).toHaveLength(53)
    expect(columns[0]!.map(cell => cell.date)).toEqual([
      '2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-06', '2024-01-07',
    ])
    for (const column of columns) expect(column).toHaveLength(7)
  })

  it('pads the first week when the year opens mid-week', () => {
    // 1 January 2026 is a Thursday: Monday–Wednesday belong to the previous year and are null.
    const first = yearGrid(2026)[0]!
    expect(first.slice(0, 3).map(cell => cell.date)).toEqual([null, null, null])
    expect(first[3]!.date).toBe('2026-01-01')
  })

  it('pads the last week rather than leaking the next year', () => {
    // 31 December 2026 is a Thursday; the column still closes on the Sunday.
    const last = yearGrid(2026).at(-1)!
    expect(last[3]!.date).toBe('2026-12-31')
    expect(last.slice(4).map(cell => cell.date)).toEqual([null, null, null])
  })

  it('keeps 29 February in a leap year', () => {
    const dates = yearGrid(2024).flat().map(cell => cell.date)
    expect(dates).toContain('2024-02-29')
  })

  it('drops 29 February in an ordinary year', () => {
    const dates = yearGrid(2025).flat().map(cell => cell.date)
    expect(dates).not.toContain('2025-02-29')
  })
})

describe('heatmapWindow', () => {
  it('accepts a single year and refuses anything longer', () => {
    expect(heatmapWindow('2026-01-01', '2026-12-31')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    expect(dayCount('2026-01-01', '2026-12-31')).toBe(365)
    expect(HEATMAP_MAX_DAYS).toBe(366)
    expect(heatmapWindow('2025-01-01', '2026-12-31')).toBeNull()
  })

  it('refuses a reversed range and a day that does not exist', () => {
    expect(heatmapWindow('2026-03-01', '2026-02-01')).toBeNull()
    expect(heatmapWindow('2026-02-30', '2026-03-01')).toBeNull()
    expect(heatmapWindow('2024-02-29', '2024-02-29')).toEqual({ from: '2024-02-29', to: '2024-02-29' })
  })
})

function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
}

describe('parseHeatmapKinds', () => {
  it('defaults to every kind', () => {
    expect(parseHeatmapKinds(null)).toEqual([...ACTIVITY_KINDS])
    expect(parseHeatmapKinds('')).toEqual([...ACTIVITY_KINDS])
  })

  it('keeps the requested order and drops duplicates', () => {
    expect(parseHeatmapKinds('todos,notes,todos')).toEqual(['todos', 'notes'])
  })

  it('refuses an unknown kind rather than silently omitting it', () => {
    expect(parseHeatmapKinds('todos,email')).toBeNull()
    expect(parseHeatmapKinds('nope')).toBeNull()
  })
})

describe('isHeatmapDay', () => {
  it('checks the calendar, not only the shape', () => {
    expect(isHeatmapDay('2026-11-04')).toBe(true)
    expect(isHeatmapDay('2026-2-3')).toBe(false)
    expect(isHeatmapDay('2026-02-30')).toBe(false)
  })
})

describe('heatLevel', () => {
  it('leaves zero empty and never exceeds the palette', () => {
    expect(heatLevel(0, 10)).toBe(0)
    expect(heatLevel(1, 10)).toBe(1)
    expect(heatLevel(10, 10)).toBe(5)
    expect(heatLevel(100, 10)).toBe(5)
  })
})
