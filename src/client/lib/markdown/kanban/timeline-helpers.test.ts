import { describe, expect, it } from 'vitest'
import {
  buildTimelineRange,
  calculateTimelineBarGeometry,
  hasTimelineDates,
  parseDaysDiff,
  shiftTimelineProperties,
  splitTimelineItems,
  timelineAnnouncedDay,
  timelineDragDays,
  TIMELINE_BAR_GAP,
  TIMELINE_BAR_OFFSET,
  TIMELINE_DAY_WIDTH,
  TIMELINE_MAX_DAYS,
  TIMELINE_MIN_BAR_WIDTH,
  TIMELINE_ZOOM_DAY_WIDTH,
} from './timeline-helpers'
import type { KanbanItem } from './types'

const BASE = new Date('2026-06-15T00:00:00')

function card(id: string, properties: Record<string, unknown>): KanbanItem {
  return { id, title: id, properties }
}

function rangeOf(items: KanbanItem[], zoom: Parameters<typeof buildTimelineRange>[0]['zoom'] = 'day') {
  return buildTimelineRange({ items, fields: undefined, zoom, baseDate: BASE, locale: 'en-US' })
}

describe('a bar dragged sideways becomes a number of days', () => {
  it('reads whole days off the scale the grid is drawn at, rounding to the nearest', () => {
    expect(timelineDragDays(0, 48)).toBe(0)
    expect(timelineDragDays(48, 48)).toBe(1)
    expect(timelineDragDays(-96, 48)).toBe(-2)
    expect(timelineDragDays(30, 48)).toBe(1)
    expect(timelineDragDays(14, 48)).toBe(0)
    expect(timelineDragDays(4, 6)).toBe(1)
  })

  it('stands for no days at all when there is no scale to read, or no distance', () => {
    expect(timelineDragDays(120, 0)).toBe(0)
    expect(timelineDragDays(120, -48)).toBe(0)
    expect(timelineDragDays(Number.NaN, 48)).toBe(0)
  })
})

describe('the properties a dragged bar would write', () => {
  it('moves both of the default days the grid reads', () => {
    const moved = shiftTimelineProperties(card('c', { startDate: '2026-06-10', dueDate: '2026-06-14' }), undefined, 3)
    expect(moved).toEqual({ startDate: '2026-06-13', dueDate: '2026-06-17' })
  })

  it('moves a card that carries only one day, and never invents the other', () => {
    expect(shiftTimelineProperties(card('c', { dueDate: '2026-06-14' }), undefined, -2)).toEqual({
      dueDate: '2026-06-12',
    })
    expect(shiftTimelineProperties(card('c', { startDate: '2026-06-10' }), undefined, 1)).toEqual({
      startDate: '2026-06-11',
    })
  })

})

describe('the column each moved day is written back to', () => {
  it('writes the key a card actually stores its deadline under, not the other one', () => {
    // `getKanbanDueDate` reads `dueDate` and falls back to `endDate`, so a card written on `endDate`
    // that was moved through `dueDate` would keep its old day and grow a second field beside it.
    expect(shiftTimelineProperties(card('c', { endDate: '2026-06-14' }), undefined, 2)).toEqual({
      endDate: '2026-06-16',
    })
  })

  it('moves the columns a view named', () => {
    const moved = shiftTimelineProperties(
      card('c', { kickoff: '2026-06-10', ship: '2026-06-14', startDate: '2020-01-01' }),
      { startField: 'kickoff', endField: 'ship' },
      5,
    )
    expect(moved).toEqual({ kickoff: '2026-06-15', ship: '2026-06-19' })
  })

  it('moves the fallback day when the named column is empty, which is the day that was drawn', () => {
    expect(shiftTimelineProperties(card('c', { startDate: '2026-06-10' }), { startField: 'kickoff' }, 1)).toEqual({
      startDate: '2026-06-11',
    })
  })

})

describe('the day a move reports, and the move that reports nothing', () => {
  it('names the day the reader was watching: the deadline when the card has one, else its start', () => {
    const both = card('c', { startDate: '2026-06-10', dueDate: '2026-06-14' })
    expect(timelineAnnouncedDay(both, undefined, shiftTimelineProperties(both, undefined, 2))).toBe('2026-06-16')
    const onlyStart = card('c', { startDate: '2026-06-10' })
    expect(timelineAnnouncedDay(onlyStart, undefined, shiftTimelineProperties(onlyStart, undefined, 2))).toBe('2026-06-12')
    expect(timelineAnnouncedDay(both, undefined, {})).toBe('')
  })

  it('writes nothing for a card with no day, or a drag that stands for no days', () => {
    expect(shiftTimelineProperties(card('c', { status: 'todo' }), undefined, 4)).toEqual({})
    expect(shiftTimelineProperties(card('c', { startDate: '2026-06-10' }), undefined, 0)).toEqual({})
  })
})

describe('timeline-helpers parseDaysDiff', () => {
  it('returns the signed day difference and 0 for anything unreadable', () => {
    expect(parseDaysDiff('2026-06-18', '2026-06-15')).toBe(3)
    expect(parseDaysDiff('2026-06-12', '2026-06-15')).toBe(-3)
    expect(parseDaysDiff('2026-06-15', '2026-06-15')).toBe(0)
    expect(parseDaysDiff('invalid', '2026-06-15')).toBe(0)
  })
})

describe('the window a board asks for', () => {
  it('reaches from the earliest card to the latest, not from a fixed number of days', () => {
    const range = rangeOf([
      card('old', { startDate: '2026-04-01', dueDate: '2026-04-10' }),
      card('late', { startDate: '2026-09-01', dueDate: '2026-09-10' }),
    ])
    // A few days of room on either side, so an edge bar is not flush with the grid.
    expect(range.days[0]!.dateStr < '2026-04-01').toBe(true)
    expect(range.days.at(-1)!.dateStr > '2026-09-10').toBe(true)
    expect(range.clipped).toBe(false)
  })

  it('keeps a card that started before any fixed window inside the grid', () => {
    const range = rangeOf([card('old', { startDate: '2026-04-01', dueDate: '2026-04-10' })])
    const bar = calculateTimelineBarGeometry(card('old', { startDate: '2026-04-01', dueDate: '2026-04-10' }), range)!
    expect(bar.left).toBeGreaterThanOrEqual(0)
    expect(bar.left + bar.width).toBeLessThanOrEqual(range.days.length * range.dayWidth)
    expect(bar.clippedBefore).toBe(false)
  })

  it('always holds today, even for a board that lives in the past', () => {
    const range = rangeOf([card('past', { startDate: '2024-01-05', dueDate: '2024-02-05' })])
    expect(range.todayIndex).toBeGreaterThan(0)
    expect(range.days[range.todayIndex]!.isToday).toBe(true)
  })

  it('shows a month around today when the board holds no dates at all', () => {
    const range = rangeOf([card('none', {}), card('also-none', { title: 'x' })])
    expect(range.days[range.todayIndex]!.dateStr).toBe('2026-06-15')
    expect(range.days.length).toBe(29)
    expect(range.days[0]!.dateStr).toBe('2026-06-08')
  })

  it('caps the span and says it did, rather than building a grid of years', () => {
    const range = rangeOf([card('far', { startDate: '2015-01-01', dueDate: '2035-01-01' })])
    expect(range.clipped).toBe(true)
    expect(range.days.length).toBe(TIMELINE_MAX_DAYS)
    // The window it keeps is the one around today, which is the column people navigate by.
    expect(range.days[range.todayIndex]!.dateStr).toBe('2026-06-15')
  })
})

describe('the edges of the window', () => {
  it('cuts a card that reaches past the window at the edge it left', () => {
    const items = [card('in', { startDate: '2026-06-14', dueDate: '2026-06-16' })]
    const range = buildTimelineRange({ items, fields: undefined, zoom: 'day', baseDate: BASE, locale: 'en-US' })
    const wide = card('wide', { startDate: '2026-01-01', dueDate: '2026-12-31' })
    const bar = calculateTimelineBarGeometry(wide, range)!
    expect(bar.clippedBefore).toBe(true)
    expect(bar.clippedAfter).toBe(true)
    expect(bar.left).toBe(TIMELINE_BAR_OFFSET)
    // The bar ends one gap short of the last column, and never outside the grid.
    expect(bar.left + bar.width).toBe(range.days.length * range.dayWidth - TIMELINE_BAR_GAP + TIMELINE_BAR_OFFSET)
    expect(bar.left + bar.width).toBeLessThanOrEqual(range.days.length * range.dayWidth)
  })

  it('never draws a bar thinner than a day at the coarsest scale', () => {
    const oneDay = card('one', { dueDate: '2026-06-15' })
    const range = buildTimelineRange({ items: [oneDay], fields: undefined, zoom: 'month', baseDate: BASE, locale: 'en-US' })
    const bar = calculateTimelineBarGeometry(oneDay, range)!
    expect(range.dayWidth).toBe(TIMELINE_ZOOM_DAY_WIDTH.month)
    expect(bar.width).toBe(TIMELINE_MIN_BAR_WIDTH)
  })
})

describe('where a bar sits in the window', () => {
  it('draws a multi-day span across its own days', () => {
    const range = rangeOf([card('a', { startDate: '2026-06-12', dueDate: '2026-06-15' })])
    const bar = calculateTimelineBarGeometry(card('a', { startDate: '2026-06-12', dueDate: '2026-06-15' }), range)!
    const startIdx = parseDaysDiff('2026-06-12', range.days[0]!.dateStr)
    expect(bar.left).toBe(startIdx * TIMELINE_DAY_WIDTH + TIMELINE_BAR_OFFSET)
    expect(bar.width).toBe(4 * TIMELINE_DAY_WIDTH - TIMELINE_BAR_GAP)
  })

  it('reads inverted start and due dates as the span between them', () => {
    const range = rangeOf([card('b', { startDate: '2026-06-16', dueDate: '2026-06-14' })])
    const bar = calculateTimelineBarGeometry(card('b', { startDate: '2026-06-16', dueDate: '2026-06-14' }), range)!
    expect(bar.left).toBe(parseDaysDiff('2026-06-14', range.days[0]!.dateStr) * TIMELINE_DAY_WIDTH + TIMELINE_BAR_OFFSET)
    expect(bar.width).toBe(3 * TIMELINE_DAY_WIDTH - TIMELINE_BAR_GAP)
  })

  it('draws the same single-day bar for a due date and for the schema end column', () => {
    const range = rangeOf([card('c', { dueDate: '2026-06-17' }), card('d', { endDate: '2026-06-17' })])
    expect(calculateTimelineBarGeometry(card('d', { endDate: '2026-06-17' }), range)).toEqual(
      calculateTimelineBarGeometry(card('c', { dueDate: '2026-06-17' }), range),
    )
  })

  it('gives a card with no day no bar at all', () => {
    const range = rangeOf([card('none', {})])
    expect(calculateTimelineBarGeometry(card('none', {}), range)).toBeNull()
  })

  it('draws from the view-configured date fields and falls back to the legacy ones', () => {
    const configured = card('cfg', { milestone: '2026-06-13', finish: '2026-06-17' })
    const range = rangeOf([configured])
    const bar = calculateTimelineBarGeometry(configured, range, { startField: 'milestone', endField: 'finish' })!
    expect(bar.width).toBe(5 * TIMELINE_DAY_WIDTH - TIMELINE_BAR_GAP)

    const legacy = card('mix', { startDate: '2026-06-12', dueDate: '2026-06-15' })
    const legacyRange = rangeOf([legacy])
    const legacyBar = calculateTimelineBarGeometry(legacy, legacyRange, { startField: 'kickoff', endField: 'finish' })!
    expect(legacyBar.width).toBe(4 * TIMELINE_DAY_WIDTH - TIMELINE_BAR_GAP)
  })
})

describe('which cards the grid can hold', () => {
  it('separates the cards that have a day from those that have none', () => {
    const dated = card('dated', { dueDate: '2026-06-15' })
    const undated = card('undated', {})
    expect(hasTimelineDates(dated)).toBe(true)
    expect(hasTimelineDates(undated)).toBe(false)
    expect(hasTimelineDates(card('cast', { startDate: '2026-06-15T08:00:00Z' }))).toBe(true)
    expect(splitTimelineItems([dated, undated])).toEqual({ dated: [dated], undated: [undated] })
  })
})

describe('what each scale writes on its columns', () => {
  const twoWeeks = [card('a', { startDate: '2026-06-08', dueDate: '2026-06-21' })]

  it('labels every column at the day scale and only week openings at the week scale', () => {
    const dayRange = buildTimelineRange({ items: twoWeeks, fields: undefined, zoom: 'day', baseDate: BASE, locale: 'en-US' })
    expect(dayRange.days.every((day) => day.label !== '')).toBe(true)
    expect(dayRange.dayWidth).toBe(TIMELINE_ZOOM_DAY_WIDTH.day)

    const weekRange = buildTimelineRange({ items: twoWeeks, fields: undefined, zoom: 'week', baseDate: BASE, locale: 'en-US' })
    const labels = weekRange.days.filter((day) => day.label !== '')
    expect(labels.length, 'the week scale repeats its label on every column').toBeLessThan(weekRange.days.length)
    // en-US opens the week on Sunday, so the labelled columns are Sundays (plus the window's first).
    expect(weekRange.days.filter((day, index) => index > 0 && day.label !== '').every((day) => new Date(day.dateStr + 'T00:00:00').getDay() === 0)).toBe(true)
  })

  it('labels only month openings at the month scale, and names the year in January', () => {
    const year = [card('a', { startDate: '2026-01-01', dueDate: '2026-03-01' })]
    const monthRange = buildTimelineRange({ items: year, fields: undefined, zoom: 'month', baseDate: new Date('2026-02-10T00:00:00'), locale: 'en-US' })
    const january = monthRange.days.find((day) => day.dateStr === '2026-01-01')!
    const february = monthRange.days.find((day) => day.dateStr === '2026-02-01')!
    expect(january.label).toContain('2026')
    expect(february.label).toBe('Feb')
    expect(monthRange.days.find((day) => day.dateStr === '2026-02-02')!.label).toBe('')
  })

  it('takes the week start from the reader’s own locale data', () => {
    const week = [card('a', { startDate: '2026-06-08', dueDate: '2026-06-21' })]
    const zh = buildTimelineRange({ items: week, fields: undefined, zoom: 'week', baseDate: BASE, locale: 'zh-CN' })
    const labelled = zh.days.filter((day, index) => index > 0 && day.label !== '')
    // zh-CN opens the week on Monday, so the labelled columns move by a day rather than by a rule.
    expect(labelled.every((day) => new Date(day.dateStr + 'T00:00:00').getDay() === 1)).toBe(true)
  })

  it('reports today’s offset in the units the scale draws in', () => {
    const range = buildTimelineRange({ items: twoWeeks, fields: undefined, zoom: 'week', baseDate: BASE, locale: 'en-US' })
    expect(range.todayIndex).toBe(parseDaysDiff('2026-06-15', range.days[0]!.dateStr))
    expect(range.todayIndex * range.dayWidth).toBeGreaterThan(0)
  })
})
