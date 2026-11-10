import { describe, expect, it } from 'vitest'
import type { ProjectCard } from './model'
import { projectDayToStamp } from './date'
import {
  PROJECT_TIMELINE_DAY_MS,
  projectCardDays,
  projectTimelineBar,
  projectTimelineDays,
  projectTimelineRows,
  projectTimelineWindow,
} from './timeline-layout'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const day = (d: number) => new Date(2026, 10, d).getTime()

function card(id: string, values: Record<string, string> = {}, parentId = ''): ProjectCard {
  return { id, boardId: 'b1', parentId, title: id, icon: '', isTemplate: false, contentOrder: [], values, ...stamps }
}

describe('reading a card onto the axis', () => {
  it('reads the picked local day, not the stored UTC instant', () => {
    const dated = card('c1', { pd: JSON.stringify({ from: projectDayToStamp(new Date(2026, 10, 10)) }) })
    expect(projectCardDays(dated, 'pd')).toEqual({ start: day(10), end: day(10) })
  })

  it('keeps both ends of a range and never runs backwards', () => {
    const ranged = card('c1', { pd: JSON.stringify({ from: projectDayToStamp(new Date(2026, 10, 10)), to: projectDayToStamp(new Date(2026, 10, 13)) }) })
    expect(projectCardDays(ranged, 'pd')).toEqual({ start: day(10), end: day(13) })
    const reversed = card('c2', { pd: JSON.stringify({ from: projectDayToStamp(new Date(2026, 10, 13)), to: projectDayToStamp(new Date(2026, 10, 10)) }) })
    expect(projectCardDays(reversed, 'pd')).toEqual({ start: day(13), end: day(13) })
  })

  it('names no days for an undated card or a missing property', () => {
    expect(projectCardDays(card('c1'), 'pd')).toBeNull()
    expect(projectCardDays(card('c1', { pd: 'not a date' }), 'pd')).toBeNull()
    expect(projectCardDays(card('c1', { pd: JSON.stringify({ from: projectDayToStamp(new Date(2026, 10, 10)) }) }), undefined)).toBeNull()
  })
})

describe('the window and its columns', () => {
  it('pads the dated span by whole days on both sides', () => {
    const window = projectTimelineWindow([{ from: day(10), to: day(13) }], day(20))
    expect(window).toEqual({ start: day(7), end: day(16) })
  })

  it('still names a fortnight when nothing is dated', () => {
    const window = projectTimelineWindow([], day(10))
    expect(window).toEqual({ start: day(3), end: day(17) })
  })

  it('marks weekends, today and the first of a month', () => {
    // 2026-11-01 is a Sunday; the 7th is Saturday and the 10th is Tuesday.
    const days = projectTimelineDays({ start: day(1), end: day(10) }, day(10))
    expect(days).toHaveLength(10)
    expect(days[0]).toMatchObject({ weekend: true, monthStart: true, today: false })
    expect(days[6]!.weekend).toBe(true)
    expect(days[9]).toMatchObject({ weekend: false, today: true })
    expect(days.filter((entry) => entry.monthStart)).toHaveLength(1)
  })

  it('places a bar on its first day and covers its last day inclusively', () => {
    const window = { start: day(7), end: day(16) }
    expect(projectTimelineBar({ from: day(10), to: day(13) }, window)).toEqual({ left: 3, width: 4 })
    expect(projectTimelineBar({ from: day(10), to: day(10) }, window)).toEqual({ left: 3, width: 1 })
  })

  it('counts columns in whole days across a month boundary', () => {
    const start = new Date(2026, 9, 30).getTime()
    const end = new Date(2026, 10, 2).getTime()
    expect((end - start) / PROJECT_TIMELINE_DAY_MS).toBe(3)
  })
})

describe('the task tree', () => {
  it('indents children under their parent instead of listing them alongside', () => {
    const rows = projectTimelineRows([card('p'), card('c1', {}, 'p'), card('c2', {}, 'p'), card('other')])
    expect(rows.map((row) => [row.card.id, row.depth, row.childCount])).toEqual([
      ['p', 0, 2], ['c1', 1, 0], ['c2', 1, 0], ['other', 0, 0],
    ])
  })

  it('promotes a child whose parent the view filtered out', () => {
    const rows = projectTimelineRows([card('c1', {}, 'absent')])
    expect(rows).toEqual([{ card: expect.objectContaining({ id: 'c1' }), depth: 0, childCount: 0 }])
  })

  it('hides the subtree of a collapsed parent but keeps its count', () => {
    const rows = projectTimelineRows([card('p'), card('c1', {}, 'p')], new Set(['p']))
    expect(rows.map((row) => [row.card.id, row.childCount])).toEqual([['p', 1]])
  })

  it('stops at a cycle rather than recursing forever', () => {
    const rows = projectTimelineRows([card('a', {}, 'b'), card('b', {}, 'a')])
    expect(rows.map((row) => row.card.id).sort()).toEqual(['a', 'b'])
  })
})