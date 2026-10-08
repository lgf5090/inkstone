import { describe, expect, it } from 'vitest'
import { evaluateMathExpression, formatMathValue } from './math'

describe('evaluateMathExpression', () => {
  it('follows precedence, brackets and the sign', () => {
    expect(evaluateMathExpression('1+2*3')).toEqual({ value: 7, error: null })
    expect(evaluateMathExpression('(1+2)*3')).toEqual({ value: 9, error: null })
    expect(evaluateMathExpression('-2+5')).toEqual({ value: 3, error: null })
    expect(evaluateMathExpression('2^3^2')).toEqual({ value: 512, error: null })
    expect(evaluateMathExpression('7%3')).toEqual({ value: 1, error: null })
    expect(evaluateMathExpression(' 10 / 4 ')).toEqual({ value: 2.5, error: null })
  })

  it('knows the functions and constants on the table', () => {
    expect(evaluateMathExpression('round(2.5)').value).toBe(3)
    expect(evaluateMathExpression('max(1, 9, 3)').value).toBe(9)
    expect(evaluateMathExpression('sqrt(16)').value).toBe(4)
    expect(evaluateMathExpression('pi').value).toBeCloseTo(Math.PI)
    expect(evaluateMathExpression('2*pow(3,2)').value).toBe(18)
  })

  it('refuses everything that is not arithmetic', () => {
    expect(evaluateMathExpression('process.exit(1)').error).toContain('"."')
    expect(evaluateMathExpression('process').error).toContain('process')
    expect(evaluateMathExpression('x = 3').error).toContain('=')
    expect(evaluateMathExpression('1;2').error).toContain(';')
    expect(evaluateMathExpression('alert(1)').error).toContain('alert')
    expect(evaluateMathExpression('[1,2]').error).toContain('[')
    expect(evaluateMathExpression('converting 5 km to miles').error).toBeTruthy()
    expect(evaluateMathExpression('').error).toBe('nothing to calculate')
    expect(evaluateMathExpression('1+').error).toBeTruthy()
    expect(evaluateMathExpression('(1+2').error).toContain('parenthesis')
  })

  it('has no answer for a division by zero or an infinite result', () => {
    expect(evaluateMathExpression('1/0').error).toContain('no answer')
    expect(evaluateMathExpression('1%0').error).toContain('no answer')
    expect(evaluateMathExpression('sqrt(-1)').error).toContain('finite')
    expect(evaluateMathExpression('9'.repeat(500) + '+1').error).toContain('too long')
  })

  it('renders the answer without float noise', () => {
    expect(formatMathValue(0.1 + 0.2)).toBe('0.3')
    expect(formatMathValue(4)).toBe('4')
    expect(formatMathValue(-1.25)).toBe('-1.25')
  })
})
