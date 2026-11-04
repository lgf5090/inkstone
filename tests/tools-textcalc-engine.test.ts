import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEXTCALC_SETTINGS,
  TEXTCALC_MAX_CHARS,
  TEXTCALC_MAX_LINES,
  evaluateDocument,
} from '../src/client/features/tools/calculator/textcalc/engine'

const evaluate = (text: string, overrides = {}) =>
  evaluateDocument(text, { ...DEFAULT_TEXTCALC_SETTINGS, ...overrides })

describe('text calculator engine', () => {
  it('evaluates arithmetic with the usual precedence', () => {
    const result = evaluate('1 + 2 * 3\n(4 + 6) / 2\n2^10\n17 % 5')
    expect(result.lines.map((line) => line.value)).toEqual(['7', '5', '1,024', '2'])
  })

  it('carries variables down the page in order', () => {
    const result = evaluate('a = 2\nb = a * 3\nc = (a + b) / 2\nc')
    expect(result.lines[0]?.value).toBe('2')
    expect(result.lines[1]?.value).toBe('6')
    expect(result.lines[2]?.value).toBe('4')
    expect(result.lastValue?.text).toBe('4')
  })

  it('defines and calls functions across lines', () => {
    const result = evaluate('f(x) = x^2 + 1\ng(x) = sin(x)\nf(3)\ng(pi / 2)')
    expect(result.lines[0]?.kind).toBe('function')
    expect(result.lines[0]?.value).toBe('f(x)')
    expect(result.lines[1]?.kind).toBe('function')
    expect(result.lines[2]?.value).toBe('10')
    expect(result.lines[3]?.value).toBe('1')
  })

  it('reports a variable cycle without evaluating either line', () => {
    const result = evaluate('a = b\nb = a')
    expect(result.lines[0]?.error?.code).toBe('cycle')
    expect(result.lines[1]?.error?.code).toBe('cycle')
  })

  it('lets a later assignment update a variable instead of calling it a cycle', () => {
    const result = evaluate('a = 2\na = a + 1\na')
    expect(result.lines[0]?.error).toBeUndefined()
    expect(result.lines[1]?.value).toBe('3')
    expect(result.lines[2]?.value).toBe('3')
  })

  it('keeps one bad line from blocking the rest', () => {
    const result = evaluate('a = 2\nb = unknown + 1\nc = a * 4')
    expect(result.lines[0]?.value).toBe('2')
    expect(result.lines[1]?.error?.code).toBe('undefined_symbol')
    expect(result.lines[1]?.error?.detail).toBe('unknown')
    expect(result.lines[2]?.value).toBe('8')
  })

  it('reports a syntax error on its own line', () => {
    const result = evaluate('1 +\n2 + 2')
    expect(result.lines[0]?.error?.code).toBe('syntax')
    expect(result.lines[1]?.value).toBe('4')
  })

  it('supports binary, octal, hexadecimal and scientific literals', () => {
    const result = evaluate('0b1010\n0o17\n0xFF\n1e3')
    expect(result.lines.map((line) => line.value)).toEqual(['10', '15', '255', '1,000'])
  })

  it('supports percentage and unit conversion', () => {
    const result = evaluate('100 + 10%\n100 * 20%\n5 cm to inch')
    expect(result.lines[0]?.value).toBe('110')
    expect(result.lines[1]?.value).toBe('20')
    expect(result.lines[2]?.value).toBe('1.968503937 inch')
  })

  it('adds different units of the same dimension', () => {
    const result = evaluate('2 kg + 500 g')
    expect(result.lines[0]?.value).toBe('2.5 kg')
  })

  it('converts percent and bases into display detail', () => {
    const result = evaluate('255', { bases: true, thousands: true })
    expect(result.lines[0]?.value).toBe('255')
    expect(result.lines[0]?.detail).toContain('0xFF')
    expect(result.lines[0]?.detail).toContain('0b11111111')
    expect(result.lines[0]?.detail).toContain('0o377')
  })

  it('hides grouping and base detail when the settings ask for it', () => {
    const result = evaluate('1234567', { thousands: false, bases: false })
    expect(result.lines[0]?.value).toBe('1234567')
    expect(result.lines[0]?.detail).toBeUndefined()
  })

  it('switches trigonometric functions to degrees', () => {
    expect(evaluate('sin(30)').lines[0]?.value).toBe('-0.9880316241')
    expect(evaluate('sin(30 deg)').lines[0]?.value).toBe('0.5')
    expect(evaluate('sin(30)', { angleMode: 'deg' }).lines[0]?.value).toBe('0.5')
    expect(evaluate('asin(0.5)', { angleMode: 'deg' }).lines[0]?.value).toBe('30')
  })

  it('treats hash and slash-slash lines as comments', () => {
    const result = evaluate('# heading\n// note\n1 + 1')
    expect(result.lines[0]?.kind).toBe('comment')
    expect(result.lines[1]?.kind).toBe('comment')
    expect(result.lines[2]?.value).toBe('2')
  })

  it('refuses a document over the line limit and never truncates it', () => {
    const text = Array.from({ length: TEXTCALC_MAX_LINES + 1 }, () => '1').join('\n')
    const result = evaluate(text)
    expect(result.limit).toEqual({ kind: 'lines', actual: TEXTCALC_MAX_LINES + 1, max: TEXTCALC_MAX_LINES })
    expect(result.lines).toHaveLength(0)
  })

  it('refuses a document over the character limit', () => {
    const text = '1'.repeat(TEXTCALC_MAX_CHARS + 1)
    const result = evaluate(text)
    expect(result.limit).toEqual({ kind: 'chars', actual: TEXTCALC_MAX_CHARS + 1, max: TEXTCALC_MAX_CHARS })
    expect(result.lines).toHaveLength(0)
  })

  it('formats with the requested precision', () => {
    const result = evaluate('1 / 3', { precision: 6 })
    expect(result.lines[0]?.value).toBe('0.333333')
  })
})
