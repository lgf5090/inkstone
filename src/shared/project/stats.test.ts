import { describe, expect, it } from 'vitest'
import type { ProjectCard, ProjectProperty } from './model'
import { projectEffortStats, projectPriorityBuckets, projectPriorityProperty, projectWeeklyCompletions } from './stats'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, deleteAt: 0 }
const status: ProjectProperty = { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'open', value: 'Open', color: '' }, { id: 'done', value: 'Done', color: '' }] }
const priority: ProjectProperty = {
  id: 'pp', name: 'Priority', type: 'select',
  options: [{ id: 'lo', value: 'Low', color: 'propColorGreen' }, { id: 'hi', value: 'High', color: 'propColorRed' }, { id: 'mid', value: 'Medium', color: 'propColorOrange' }],
}
const hours: ProjectProperty = { id: 'pn', name: 'Hours', type: 'number', options: [] }

function card(id: string, values: Record<string, string>, updateAt = 1): ProjectCard {
  return { id, boardId: 'b1', parentId: '', title: id, icon: '', isTemplate: false, contentOrder: [], values, updateAt, ...stamps }
}

describe('finding the priority property', () => {
  it('recognises a select whose options read as levels, in either language', () => {
    expect(projectPriorityProperty([status, priority])?.id).toBe('pp')
    const zh: ProjectProperty = { id: 'pz', name: 'P', type: 'select', options: [{ id: 'a', value: '\u9ad8', color: '' }, { id: 'b', value: '\u4f4e', color: '' }] }
    expect(projectPriorityProperty([status, zh])?.id).toBe('pz')
  })

  it('says nothing when no property names levels', () => {
    expect(projectPriorityProperty([status, hours])).toBeNull()
  })

  it('orders the buckets high to low regardless of the option order', () => {
    const buckets = projectPriorityBuckets([card('a', { pp: 'hi' }), card('b', { pp: 'hi' }), card('c', { pp: 'lo' })], priority, () => null)
    expect(buckets.map((bucket) => [bucket.label, bucket.count])).toEqual([['High', 2], ['Medium', 0], ['Low', 1]])
  })
})

describe('weekly completions', () => {
  // 2026-11-11 is a Wednesday; its week starts Monday the 9th.
  const today = new Date(2026, 10, 11, 15).getTime()
  const day = (d: number) => new Date(2026, 10, d, 10).getTime()

  it('counts only done cards, into the week of their last edit', () => {
    const cards = [
      card('this', { ps: 'done' }, day(10)),
      card('last', { ps: 'done' }, day(4)),
      card('open', { ps: 'open' }, day(10)),
      card('old', { ps: 'done' }, day(1)),
    ]
    const weeks = projectWeeklyCompletions(cards, [status], today, 4)
    expect(weeks).toHaveLength(4)
    // Nov 1 is a Sunday, so it lands in the week that started Monday Oct 26.
    expect(weeks.map((week) => week.count)).toEqual([0, 1, 1, 1])
    expect(new Date(weeks[3]!.start).getDate()).toBe(9)
  })

  it('returns empty weeks rather than dropping them when nothing was finished', () => {
    expect(projectWeeklyCompletions([card('open', { ps: 'open' }, day(10))], [status], today, 3).map((week) => week.count)).toEqual([0, 0, 0])
  })
})

describe('effort stats', () => {
  it('sums, averages and names the peak, ignoring blanks and non-numbers', () => {
    const cards = [card('a', { pn: '8' }), card('b', { pn: '4' }), card('c', { pn: '' }), card('d', { pn: 'abc' })]
    const stats = projectEffortStats(cards, hours)
    expect(stats.total).toBe(12)
    expect(stats.average).toBe(6)
    expect(stats.max).toBe(8)
    expect(stats.maxCard?.id).toBe('a')
  })

  it('reports zeroes when the board measures nothing', () => {
    expect(projectEffortStats([card('a', {})], undefined)).toEqual({ total: 0, average: 0, max: 0, maxCard: null })
  })
})