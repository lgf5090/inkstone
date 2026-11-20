import { describe, expect, it } from 'vitest'
import type { ProjectProperty, ProjectRollupAggregation } from './model'
import { evaluateProjectRollup, projectRollupCycleIds, projectRollupOrder } from './rollup'

const property = (id: string, targetPropertyId?: string): ProjectProperty => ({
  id,
  name: id,
  type: 'rollup',
  options: [],
  ...(targetPropertyId ? { config: { rollup: { relationPropertyId: 'r', targetPropertyId, aggregation: 'sum' as ProjectRollupAggregation } } } : {}),
})

describe('rollup evaluation', () => {
  it('counts related cards regardless of their values', () => {
    expect(evaluateProjectRollup(['5', '', '7'], 'count')).toBe('3')
    expect(evaluateProjectRollup([], 'count')).toBe('0')
  })

  it('sums, averages and finds extremes while ignoring non-numeric values', () => {
    const values = ['2', '4', 'n/a', '']
    expect(evaluateProjectRollup(values, 'sum')).toBe('6')
    expect(evaluateProjectRollup(values, 'avg')).toBe('3')
    expect(evaluateProjectRollup(values, 'min')).toBe('2')
    expect(evaluateProjectRollup(values, 'max')).toBe('4')
    expect(evaluateProjectRollup(['n/a'], 'sum')).toBe('')
  })
})

describe('rollup dependency graph', () => {
  it('detects a self reference and a two-property cycle', () => {
    expect([...projectRollupCycleIds([property('a', 'a')])]).toEqual(['a'])
    expect([...projectRollupCycleIds([property('a', 'b'), property('b', 'a')])].sort()).toEqual(['a', 'b'])
  })

  it('orders a dependency chain before its dependent and drops the cyclic ones', () => {
    expect(projectRollupOrder([property('derived', 'base'), property('base', 'num')])).toEqual(['base', 'derived'])
    expect(projectRollupOrder([property('c', 'c')])).toEqual([])
  })
})
