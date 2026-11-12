import { describe, expect, it } from 'vitest'
import type { ProjectCard, ProjectProperty } from './model'
import { emptyProjectFilterGroup } from './model'
import { calculationOptionsFor, computeProjectCalculation } from './calculations'
import { matchProjectFilterGroup } from './view-eval'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
function card(id: string, values: Record<string, string>): ProjectCard {
  return { id, boardId: 'b1', parentId: '', title: id, icon: '', isTemplate: false, contentOrder: [], values, ...stamps }
}
const numberProp: ProjectProperty = { id: 'pn', name: 'Hours', type: 'number', options: [] }
const checkboxProp: ProjectProperty = { id: 'pc', name: 'Done', type: 'checkbox', options: [] }

describe('column calculations', () => {
  const cards = [card('a', { pn: '1', pc: 'true' }), card('b', { pn: '3', pc: 'false' }), card('c', { pn: '', pc: 'true' })]
  it('computes the numeric summaries', () => {
    expect(computeProjectCalculation(cards, numberProp, 'count')).toBe('3')
    expect(computeProjectCalculation(cards, numberProp, 'countEmpty')).toBe('1')
    expect(computeProjectCalculation(cards, numberProp, 'sum')).toBe('4')
    expect(computeProjectCalculation(cards, numberProp, 'average')).toBe('2')
    expect(computeProjectCalculation(cards, numberProp, 'median')).toBe('2')
    expect(computeProjectCalculation(cards, numberProp, 'min')).toBe('1')
    expect(computeProjectCalculation(cards, numberProp, 'max')).toBe('3')
    expect(computeProjectCalculation(cards, numberProp, 'range')).toBe('2')
  })
  it('computes the checked summaries (X-9)', () => {
    expect(computeProjectCalculation(cards, checkboxProp, 'countChecked')).toBe('2')
    expect(computeProjectCalculation(cards, checkboxProp, 'countUnchecked')).toBe('1')
    expect(computeProjectCalculation(cards, checkboxProp, 'percentChecked')).toBe('66.67%')
  })
  it('offers checked options for checkbox and numeric options for number', () => {
    expect(calculationOptionsFor(checkboxProp)).toContain('countChecked')
    expect(calculationOptionsFor(numberProp)).toContain('sum')
  })
})

describe('number filtering (X-8)', () => {
  const cards = [card('a', { pn: '5' }), card('b', { pn: '10' })]
  it('greaterThan / lessThan compare numerically', () => {
    const gt = { operation: 'and' as const, filters: [{ propertyId: 'pn', condition: 'greaterThan' as const, values: ['7'] }] }
    const lt = { operation: 'and' as const, filters: [{ propertyId: 'pn', condition: 'lessThan' as const, values: ['7'] }] }
    expect(cards.filter((c) => matchProjectFilterGroup(c, gt, [numberProp])).map((c) => c.id)).toEqual(['b'])
    expect(cards.filter((c) => matchProjectFilterGroup(c, lt, [numberProp])).map((c) => c.id)).toEqual(['a'])
    expect(matchProjectFilterGroup(cards[0]!, emptyProjectFilterGroup(), [numberProp])).toBe(true)
  })
})