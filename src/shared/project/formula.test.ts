import { describe, expect, it } from 'vitest'
import { evaluateProjectFormula } from './formula'

const values = new Map<string, string>([
  ['price', '10'],
  ['qty', '3'],
  ['name', 'Tea'],
])

describe('the formula language', () => {
  it('resolves references by name and keeps arithmetic precedence', () => {
    expect(evaluateProjectFormula('{Price} * {Qty}', values)).toBe('30')
    expect(evaluateProjectFormula('({Price}+2)*2', values)).toBe('24')
    expect(evaluateProjectFormula('{Price}/4', values)).toBe('2.5')
  })

  it('offers the documented functions', () => {
    expect(evaluateProjectFormula('IF({Qty} > 2, "bulk", "single")', values)).toBe('bulk')
    expect(evaluateProjectFormula('ROUND({Price}/3, 2)', values)).toBe('3.33')
    expect(evaluateProjectFormula('SUM({Price}, {Qty})', values)).toBe('13')
    expect(evaluateProjectFormula('MAX({Price}, {Qty})', values)).toBe('10')
    expect(evaluateProjectFormula('CONCAT({Name}, "!")', values)).toBe('Tea!')
    expect(evaluateProjectFormula('LEN({Name})', values)).toBe('3')
    expect(evaluateProjectFormula('DAYS(0, 86400000)', values)).toBe('1')
  })

  it('degrades an unknown name to zero instead of blanking the column', () => {
    expect(evaluateProjectFormula('{Missing} + 1', values)).toBe('1')
    expect(evaluateProjectFormula('', values)).toBe('')
  })

  it('refuses anything outside the grammar', () => {
    expect(evaluateProjectFormula('1; alert(1)', values)).toBe('')
    expect(evaluateProjectFormula('this.price', values)).toBe('')
    expect(evaluateProjectFormula('{Price} *', values)).toBe('')
    expect(evaluateProjectFormula('EVAL("1+1")', values)).toBe('')
  })
})
