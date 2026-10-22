import { describe, expect, it, vi } from 'vitest'
import { compileMemoFilter } from '@shared/memos/filter'
import type { Memo } from '@shared/memos/types'
import {
  addMemoCalendarDays,
  buildMemoMonthCells,
  groupMemosByDay,
  memoCalendarDateKey,
  memoCalendarPath,
  memoCreatedRangeFilter,
  memoDayKeyInTimeZone,
  memoDayStartSeconds,
  memoMonthGridRows,
  memoMonthHeatLevels,
  memoMonthRangeSeconds,
  resolveMemoCalendarDate,
  resolveMemoTimeZone,
  shiftMemoCalendarMonth,
} from './calendar-model'

function memo(id: string, createdAt: number): Memo {
  return {
    id,
    content: id,
    title: '',
    snippet: '',
    tags: [],
    visibility: 'private',
    state: 'normal',
    pinned: false,
    spaceId: null,
    parentId: null,
    location: null,
    properties: {
      hasLink: false,
      hasCode: false,
      hasTaskList: false,
      hasIncompleteTasks: false,
      hasLocation: false,
    },
    attachments: [],
    reactions: [],
    relations: [],
    commentCount: 0,
    rev: 0,
    createdAt,
    updatedAt: createdAt,
  }
}

describe('memo calendar date resolution', () => {
  const now = new Date(2026, 8, 15, 12, 0, 0)

  it('opens the current month and day when the address names no date', () => {
    expect(resolveMemoCalendarDate(null, now)).toEqual({
      year: 2026,
      month: 9,
      day: 15,
      invalidDay: false,
    })
  })

  it('opens January when only a year is named', () => {
    expect(resolveMemoCalendarDate({ year: 2025 }, now)).toEqual({
      year: 2025,
      month: 1,
      day: 1,
      invalidDay: false,
    })
  })

  it('selects today only when the named month is the current one', () => {
    expect(resolveMemoCalendarDate({ year: 2026, month: 9 }, now).day).toBe(15)
    expect(resolveMemoCalendarDate({ year: 2026, month: 10 }, now).day).toBe(1)
    expect(resolveMemoCalendarDate({ year: 2025, month: 2 }, now).day).toBe(1)
  })

  it('clamps a day the month does not have and reports it', () => {
    expect(resolveMemoCalendarDate({ year: 2025, month: 2, day: 30 }, now)).toEqual({
      year: 2025,
      month: 2,
      day: 28,
      invalidDay: true,
    })
    expect(resolveMemoCalendarDate({ year: 2026, month: 4, day: 31 }, now)).toEqual({
      year: 2026,
      month: 4,
      day: 30,
      invalidDay: true,
    })
    expect(resolveMemoCalendarDate({ year: 2024, month: 2, day: 29 }, now).invalidDay).toBe(false)
  })
})

describe('memo month filters', () => {
  it('writes month bounds as timestamp literals the filter parser accepts', () => {
    const start = Date.UTC(2026, 9, 1) / 1000
    const end = Date.UTC(2026, 10, 1) / 1000
    const expression = memoCreatedRangeFilter(start, end)
    expect(expression).toBe(
      'created_ts >= timestamp("2026-10-01T00:00:00.000Z")'
      + ' && created_ts < timestamp("2026-11-01T00:00:00.000Z")',
    )
    const compiled = compileMemoFilter(expression)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const context = { viewerId: 'viewer', now: end, timeZone: 'UTC' }
    const record = {
      id: 'memo',
      creatorId: 'viewer',
      content: '',
      tags: [],
      visibility: 'private' as const,
      pinned: false,
      spaceId: null,
      size: 0,
      hasLink: false,
      hasCode: false,
      hasTaskList: false,
      hasIncompleteTasks: false,
      hasLocation: false,
      createdAt: Date.UTC(2026, 9, 15) / 1000,
      updatedAt: Date.UTC(2026, 9, 15) / 1000,
    }
    expect(compiled.filter.matches(record, context)).toBe(true)
    expect(compiled.filter.matches(
      { ...record, createdAt: Date.UTC(2026, 10, 1) / 1000 },
      context,
    )).toBe(false)
  })
})

describe('memo month grid', () => {
  it('aligns the grid to a Monday week start', () => {
    const cells = buildMemoMonthCells(2026, 9, 1, '2026-09-15')
    expect(cells).toHaveLength(35)
    expect(cells[0]).toMatchObject({ key: '2026-08-31', day: 31, inMonth: false })
    expect(cells[1]).toMatchObject({ key: '2026-09-01', day: 1, inMonth: true })
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(30)
    expect(cells.filter((cell) => cell.today)).toHaveLength(1)
  })

  it('aligns the grid to a Sunday week start', () => {
    const cells = buildMemoMonthCells(2026, 9, 0, '2026-09-15')
    expect(cells[0]).toMatchObject({ key: '2026-08-30', day: 30, inMonth: false })
    expect(cells[2]).toMatchObject({ key: '2026-09-01', day: 1, inMonth: true })
    expect(cells).toHaveLength(35)
  })

  it('draws a four-row February when Sunday opens the week', () => {
    const sunday = buildMemoMonthCells(2026, 2, 0, '2026-02-10')
    expect(sunday).toHaveLength(28)
    expect(sunday[0]).toMatchObject({ key: '2026-02-01', day: 1, inMonth: true })
    const monday = buildMemoMonthCells(2026, 2, 1, '2026-02-10')
    expect(monday).toHaveLength(35)
    expect(monday[0]).toMatchObject({ key: '2026-01-26', inMonth: false })
  })

  it('splits cells into seven-day rows', () => {
    const rows = memoMonthGridRows(buildMemoMonthCells(2026, 9, 1, '2026-09-15'))
    expect(rows).toHaveLength(5)
    expect(rows.every((row) => row.length === 7)).toBe(true)
    expect(rows[0]?.[0]?.key).toBe('2026-08-31')
  })

  it('reads a selection back as a padded day key', () => {
    expect(memoCalendarDateKey({ year: 2026, month: 3, day: 5 })).toBe('2026-03-05')
  })
})

describe('memo calendar stepping', () => {
  it('steps across month and year boundaries', () => {
    expect(addMemoCalendarDays({ year: 2026, month: 3, day: 1 }, -1))
      .toEqual({ year: 2026, month: 2, day: 28 })
    expect(addMemoCalendarDays({ year: 2026, month: 12, day: 31 }, 1))
      .toEqual({ year: 2027, month: 1, day: 1 })
    expect(addMemoCalendarDays({ year: 2026, month: 3, day: 5 }, 7))
      .toEqual({ year: 2026, month: 3, day: 12 })
  })

  it('clamps the day when the target month is shorter', () => {
    expect(shiftMemoCalendarMonth({ year: 2026, month: 1, day: 31 }, 1))
      .toEqual({ year: 2026, month: 2, day: 28 })
    expect(shiftMemoCalendarMonth({ year: 2026, month: 3, day: 31 }, -1))
      .toEqual({ year: 2026, month: 2, day: 28 })
    expect(shiftMemoCalendarMonth({ year: 2026, month: 12, day: 15 }, 1))
      .toEqual({ year: 2027, month: 1, day: 15 })
    expect(shiftMemoCalendarMonth({ year: 2026, month: 1, day: 15 }, -1))
      .toEqual({ year: 2025, month: 12, day: 15 })
  })
})

describe('memo calendar addresses', () => {
  it('builds a dated global calendar path', () => {
    expect(memoCalendarPath(null, { year: 2026, month: 10, day: 21 }))
      .toBe('/memos/calendar/2026/10/21')
    expect(memoCalendarPath(null, { year: 2026, month: 10 }))
      .toBe('/memos/calendar/2026/10')
  })

  it('keeps a space calendar inside its space', () => {
    expect(memoCalendarPath('team space', { year: 2026, month: 3, day: 5 }))
      .toBe('/memos/spaces/team%20space/calendar/2026/3/5')
  })
})

describe('memo calendar time zones', () => {
  it('falls back to UTC for an unknown zone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveMemoTimeZone('Mars/Olympus')).toBe('UTC')
    expect(resolveMemoTimeZone('')).toBe('UTC')
    expect(resolveMemoTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    warn.mockRestore()
  })

  it('reads the local day of an instant in the chosen zone', () => {
    const instant = Date.UTC(2026, 2, 1, 0, 30) / 1000
    expect(memoDayKeyInTimeZone(instant, 'UTC')).toBe('2026-03-01')
    expect(memoDayKeyInTimeZone(instant, 'Asia/Shanghai')).toBe('2026-03-01')
    expect(memoDayKeyInTimeZone(instant, 'America/New_York')).toBe('2026-02-28')
  })

  it('turns a civil day into its first instant in the chosen zone', () => {
    expect(memoDayStartSeconds(2026, 3, 5, 'Asia/Shanghai'))
      .toBe(Date.UTC(2026, 2, 4, 16) / 1000)
    expect(memoDayStartSeconds(2026, 3, 5, 'America/New_York'))
      .toBe(Date.UTC(2026, 2, 5, 5) / 1000)
    expect(memoDayStartSeconds(2026, 3, 8, 'America/New_York'))
      .toBe(Date.UTC(2026, 2, 8, 5) / 1000)
  })

  it('bounds a month in the chosen zone', () => {
    expect(memoMonthRangeSeconds(2026, 3, 'UTC')).toEqual({
      start: Date.UTC(2026, 2, 1) / 1000,
      end: Date.UTC(2026, 3, 1) / 1000,
      timeZone: 'UTC',
    })
    expect(memoMonthRangeSeconds(2026, 3, 'Asia/Shanghai')).toEqual({
      start: Date.UTC(2026, 1, 28, 16) / 1000,
      end: Date.UTC(2026, 2, 31, 16) / 1000,
      timeZone: 'Asia/Shanghai',
    })
    expect(memoMonthRangeSeconds(2026, 3, 'America/New_York')).toEqual({
      start: Date.UTC(2026, 2, 1, 5) / 1000,
      end: Date.UTC(2026, 3, 1, 4) / 1000,
      timeZone: 'America/New_York',
    })
    expect(memoMonthRangeSeconds(2026, 12, 'UTC')).toEqual({
      start: Date.UTC(2026, 11, 1) / 1000,
      end: Date.UTC(2027, 0, 1) / 1000,
      timeZone: 'UTC',
    })
  })

  it('groups memos by the day the zone is living in and keeps their order', () => {
    const beforeMidnight = Date.UTC(2026, 2, 5, 15, 59) / 1000
    const midnight = Date.UTC(2026, 2, 5, 16, 0) / 1000
    const first = memo('first', beforeMidnight)
    const second = memo('second', midnight)
    const third = memo('third', midnight + 60)
    const groups = groupMemosByDay([first, second, third], 'Asia/Shanghai')
    expect([...groups.keys()]).toEqual(['2026-03-05', '2026-03-06'])
    expect(groups.get('2026-03-05')?.map((entry) => entry.id)).toEqual(['first'])
    expect(groups.get('2026-03-06')?.map((entry) => entry.id)).toEqual(['second', 'third'])
  })
})

describe('memo month heat', () => {
  it('scales a day against the busiest day of the month', () => {
    const levels = memoMonthHeatLevels(
      { '2026-03-01': 1, '2026-03-02': 2, '2026-03-03': 4, '2026-03-04': 8 },
      ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'],
    )
    expect([...levels.entries()]).toEqual([
      ['2026-03-01', 1],
      ['2026-03-02', 1],
      ['2026-03-03', 2],
      ['2026-03-04', 4],
      ['2026-03-05', 0],
    ])
  })

  it('keeps every counted day off level zero and never above four', () => {
    const levels = memoMonthHeatLevels({ '2026-03-01': 100 }, ['2026-03-01'])
    expect(levels.get('2026-03-01')).toBe(4)
    const flat = memoMonthHeatLevels({ '2026-03-01': 2 }, ['2026-03-01', '2026-03-02'])
    expect(flat.get('2026-03-01')).toBe(4)
    expect(flat.get('2026-03-02')).toBe(0)
  })
})
