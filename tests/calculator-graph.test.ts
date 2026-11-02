import { describe, expect, it } from 'vitest'
import { parseGraphExpression } from '@shared/tools/calculator/graphing/parser'
import { evaluateNode } from '@shared/tools/calculator/graphing/evaluate'
import { plotEquation } from '@shared/tools/calculator/graphing/plot'
import { analyzeFunction } from '@shared/tools/calculator/graphing/analyze'

describe('graph expressions', () => {
  it('parses and evaluates y = x^2', () => {
    const parsed = parseGraphExpression('y = x^2')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(evaluateNode(parsed.relation?.right ?? parsed.node, { x: 3, trigMode: 'rad' })).toBe(9)
  })

  it('parses implicit multiplication', () => {
    const parsed = parseGraphExpression('2x + 1')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(evaluateNode(parsed.node, { x: 4, trigMode: 'rad' })).toBe(9)
  })

  it('honours comparison operators', () => {
    const parsed = parseGraphExpression('y > x')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(evaluateNode(parsed.node, { x: 1, y: 2, trigMode: 'rad' })).toBe(1)
  })

  it('plots a parabola', () => {
    const parsed = parseGraphExpression('y = x^2 - 4')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const geometry = plotEquation(parsed.node, { xMin: -5, xMax: 5, yMin: -5, yMax: 10 }, {
      width: 400,
      height: 300,
      variables: {},
      trigMode: 'rad',
    })
    expect(geometry.curves.length).toBeGreaterThan(0)
    expect(geometry.curves[0].length).toBeGreaterThan(100)
  })

  it('does not invent asymptotes for a parabola', () => {
    const parsed = parseGraphExpression('y = x^2 - 4')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const result = analyzeFunction(parsed.relation?.right ?? parsed.node, { xMin: -10, xMax: 10, yMin: -10, yMax: 100 }, {}, 'rad')
    const horizontal = result.features.find((feature) => feature.titleKey === 'horizontal_asymptote')
    const oblique = result.features.find((feature) => feature.titleKey === 'oblique_asymptote')
    expect(horizontal?.values ?? []).toHaveLength(0)
    expect(oblique?.values ?? []).toHaveLength(0)
  })

  it('finds the period of a sine wave', () => {
    const parsed = parseGraphExpression('y = sin(x)')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const result = analyzeFunction(parsed.relation?.right ?? parsed.node, { xMin: -10, xMax: 10, yMin: -10, yMax: 10 }, {}, 'rad')
    const periodicity = result.features.find((feature) => feature.titleKey === 'periodicity')
    expect(periodicity?.values.length).toBe(1)
    expect(Number(periodicity?.values[0])).toBeCloseTo(Math.PI * 2, 5)
  })

  it('finds the horizontal asymptote of 1/x', () => {
    const parsed = parseGraphExpression('y = 1/x')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const result = analyzeFunction(parsed.relation?.right ?? parsed.node, { xMin: -10, xMax: 10, yMin: -10, yMax: 10 }, {}, 'rad')
    const horizontal = result.features.find((feature) => feature.titleKey === 'horizontal_asymptote')
    expect(horizontal?.values.join(' ')).toContain('0')
  })

  it('finds zeros of x^2 - 4', () => {
    const parsed = parseGraphExpression('y = x^2 - 4')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const result = analyzeFunction(parsed.relation?.right ?? parsed.node, { xMin: -5, xMax: 5, yMin: -5, yMax: 10 }, {}, 'rad')
    expect(result.error).toBe('none')
    const zeros = result.features.find((feature) => feature.titleKey === 'zeros')
    expect(zeros?.values.join(' ')).toContain('2')
    expect(zeros?.values.join(' ')).toContain('-2')
  })
})
