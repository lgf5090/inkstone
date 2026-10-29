import { describe, expect, it } from 'vitest'
import { paperGridStep, paperLineStep, paperSpacingFactor, paperStyleHasMargin } from './paper'

describe('paperSpacingFactor', () => {
  it('maps the three spacing settings', () => {
    expect(paperSpacingFactor('tight')).toBe(0.85)
    expect(paperSpacingFactor('normal')).toBe(1)
    expect(paperSpacingFactor('wide')).toBe(1.25)
  })
})

describe('paperLineStep', () => {
  it('scales the ordinary 48 px rule when only a spacing is given', () => {
    expect(paperLineStep('tight')).toBeCloseTo(40.8)
    expect(paperLineStep('normal')).toBe(48)
    expect(paperLineStep('wide')).toBe(60)
  })

  it('uses the style-specific pitch', () => {
    expect(paperLineStep('line', 'normal')).toBe(48)
    expect(paperLineStep('cornell', 'tight')).toBeCloseTo(40.8)
    expect(paperLineStep('grid', 'normal')).toBe(38)
    expect(paperLineStep('dot', 'wide')).toBeCloseTo(47.5)
    expect(paperLineStep('planner', 'normal')).toBe(76)
    expect(paperLineStep('music', 'wide')).toBe(92)
    expect(paperLineStep('blank', 'normal')).toBe(0)
    expect(paperLineStep('story', 'normal')).toBe(0)
  })
})

describe('paperGridStep', () => {
  it('scales the 38 px cell', () => {
    expect(paperGridStep('normal')).toBe(38)
    expect(paperGridStep('tight')).toBeCloseTo(32.3)
    expect(paperGridStep('grid', 'wide')).toBeCloseTo(47.5)
  })
})

describe('paperStyleHasMargin', () => {
  it('draws the reference margin only on lined paper', () => {
    expect(paperStyleHasMargin('line')).toBe(true)
    expect(paperStyleHasMargin('grid')).toBe(false)
    expect(paperStyleHasMargin('blank')).toBe(false)
  })
})
