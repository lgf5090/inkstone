import { describe, expect, it } from 'vitest'
import type { ProjectCard, ProjectProperty } from './model'
import { projectDayToStamp } from './date'
import { projectCalendarDayChips, projectCalendarOverdue, projectCalendarRibbons } from './calendar-layout'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const properties: ProjectProperty[] = [
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: 'propColorBlue' }, { id: 'o2', value: 'Done', color: '' }] },
  { id: 'pd', name: 'Due', type: 'date', options: [] },
]
// Stored stamps go through the module's own writer; keys are the local days a reader resolves.
const day = (d: number) => projectDayToStamp(new Date(2026, 10, d))
const keyOf = (stamp: number) => { const x = new Date(stamp); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` }
const keys = Array.from({ length: 10 }, (_, index) => keyOf(day(index + 8)))

function card(id: string, from?: number, to?: number, status = 'o1'): ProjectCard {
  const values: Record<string, string> = { ps: status }
  if (from !== undefined) values.pd = JSON.stringify(to === undefined ? { from } : { from, to })
  return { id, boardId: 'b1', parentId: '', title: id, icon: '', isTemplate: false, contentOrder: [], values, ...stamps }
}

describe('spanning ribbons', () => {
  it('draws one ribbon across every covered day with caps only at the ends', () => {
    const ribbons = projectCalendarRibbons([card('sprint', day(10), day(12))], 'pd', properties, keys, keyOf)
    expect([...ribbons.keys()]).toEqual([keyOf(day(10)), keyOf(day(11)), keyOf(day(12))])
    expect(ribbons.get(keyOf(day(10)))![0]).toMatchObject({ lane: 0, start: true, end: false })
    expect(ribbons.get(keyOf(day(11)))![0]).toMatchObject({ lane: 0, start: false, end: false })
    expect(ribbons.get(keyOf(day(12)))![0]).toMatchObject({ lane: 0, start: false, end: true })
  })

  it('keeps a card on the same lane across a week boundary', () => {
    const ribbons = projectCalendarRibbons([card('long', day(8), day(17))], 'pd', properties, keys, keyOf)
    const lanes = [...ribbons.values()].map((list) => list[0]!.lane)
    expect(new Set(lanes).size).toBe(1)
    expect(lanes).toHaveLength(10)
  })

  it('stacks overlapping ranges on separate lanes and reuses a freed lane', () => {
    const ribbons = projectCalendarRibbons([card('a', day(8), day(10)), card('b', day(9), day(11)), card('c', day(12), day(14))], 'pd', properties, keys, keyOf)
    expect(ribbons.get(keyOf(day(9)))!.map((r) => [r.card.id, r.lane])).toEqual([['a', 0], ['b', 1]])
    expect(ribbons.get(keyOf(day(12)))![0]).toMatchObject({ card: expect.objectContaining({ id: 'c' }), lane: 0 })
  })

  it('gives a single-day card no ribbon at all', () => {
    expect(projectCalendarRibbons([card('one', day(10))], 'pd', properties, keys, keyOf).size).toBe(0)
  })

  it('ignores ranges entirely outside the visible grid', () => {
    expect(projectCalendarRibbons([card('away', day(1), day(3))], 'pd', properties, keys, keyOf).size).toBe(0)
  })

  it('paints the ribbon with the card status colour', () => {
    const ribbons = projectCalendarRibbons([card('sprint', day(10), day(12))], 'pd', properties, keys, keyOf)
    expect(ribbons.get(keyOf(day(10)))![0]!.color).toBe('var(--kanban-tag-blue-fg)')
  })
})

describe('day chips', () => {
  it('names a single-day card on its day and marks it as starting', () => {
    expect(projectCalendarDayChips([card('one', day(10))], 'pd', keyOf(day(10)), keyOf)).toEqual([{ card: expect.objectContaining({ id: 'one' }), starting: true }])
  })

  it('shows a spanning card only on its start day, leaving the rest to the ribbon', () => {
    const spanning = card('sprint', day(10), day(12))
    expect(projectCalendarDayChips([spanning], 'pd', keyOf(day(10)), keyOf)).toHaveLength(1)
    expect(projectCalendarDayChips([spanning], 'pd', keyOf(day(11)), keyOf)).toHaveLength(0)
    expect(projectCalendarDayChips([spanning], 'pd', keyOf(day(12)), keyOf)).toHaveLength(0)
  })

  it('says nothing for an undated card', () => {
    expect(projectCalendarDayChips([card('none')], 'pd', keyOf(day(10)), keyOf)).toHaveLength(0)
  })
})

describe('overdue chips', () => {
  it('flags a past range that is not done and spares a completed one', () => {
    expect(projectCalendarOverdue(card('late', day(9)), properties, day(9), day(12))).toBe(true)
    expect(projectCalendarOverdue(card('done', day(9), undefined, 'o2'), properties, day(9), day(12))).toBe(false)
    expect(projectCalendarOverdue(card('future', day(14)), properties, day(14), day(12))).toBe(false)
  })
})