import { describe, expect, it } from 'vitest'
import { CMD } from '@shared/tools/calculator/contract'
import { CalculatorEngine } from '@shared/tools/calculator/engine/calc-engine'
import { parsePasteCommands } from '@shared/tools/calculator/engine/paste'
import { convertUnitValue, getUnitsForCategory } from '@shared/tools/calculator/converters/unit-converter'
import { addDuration, difference, subtractDuration } from '@shared/tools/calculator/converters/date-calculator'

function press(engine: CalculatorEngine, commands: number[]): void {
  for (const command of commands) engine.send(command)
}

function digits(text: string): number[] {
  return [...text].map((char) => CMD.digit0 + Number(char))
}

describe('calculator engine', () => {
  it('evaluates standard arithmetic immediately', () => {
    const engine = new CalculatorEngine()
    press(engine, [...digits('12'), CMD.add, ...digits('30'), CMD.equals])
    expect(engine.getState().primary).toBe('42')
  })

  it('repeats the last operation on repeated equals', () => {
    const engine = new CalculatorEngine()
    press(engine, [...digits('2'), CMD.add, ...digits('3'), CMD.equals, CMD.equals])
    expect(engine.getState().primary).toBe('8')
  })

  it('applies percent relative to the left operand', () => {
    const engine = new CalculatorEngine()
    press(engine, [...digits('50'), CMD.add, ...digits('10'), CMD.percent, CMD.equals])
    expect(engine.getState().primary).toBe('55')
  })

  it('respects operator precedence in scientific mode', () => {
    const engine = new CalculatorEngine()
    engine.setMode('scientific')
    press(engine, [...digits('2'), CMD.add, ...digits('3'), CMD.multiply, ...digits('4'), CMD.equals])
    expect(engine.getState().primary).toBe('14')
  })

  it('evaluates parentheses in scientific mode', () => {
    const engine = new CalculatorEngine()
    engine.setMode('scientific')
    press(engine, [CMD.openParen, ...digits('2'), CMD.add, ...digits('3'), CMD.closeParen, CMD.multiply, ...digits('4'), CMD.equals])
    expect(engine.getState().primary).toBe('20')
  })

  it('evaluates sine in degrees', () => {
    const engine = new CalculatorEngine()
    engine.setMode('scientific')
    press(engine, [...digits('30'), CMD.sin, CMD.equals])
    expect(engine.getState().primary).toMatch(/^0\.5/)
  })

  it('enters exponent notation in scientific mode', () => {
    const engine = new CalculatorEngine()
    engine.setMode('scientific')
    press(engine, [CMD.digit1, CMD.exp, CMD.digit3, CMD.equals])
    expect(engine.getState().primary).toBe('1,000')
  })

  it('evaluates e to the power of x', () => {
    const engine = new CalculatorEngine()
    engine.setMode('scientific')
    press(engine, [CMD.digit2, CMD.powE, CMD.equals])
    expect(Number(engine.getState().primary.replace(/,/g, ''))).toBeCloseTo(Math.exp(2), 6)
  })

  it('evaluates powers', () => {
    const engine = new CalculatorEngine()
    engine.setMode('scientific')
    press(engine, [...digits('2'), CMD.power, ...digits('10'), CMD.equals])
    expect(engine.getState().primary).toBe('1,024')
  })

  it('keeps the carry bit across rotate-carry commands', () => {
    const engine = new CalculatorEngine()
    engine.setMode('programmer')
    press(engine, [CMD.byte, CMD.hex, ...digits('80'), CMD.rotateLeftCarry, CMD.rotateLeftCarry])
    expect(engine.getState().programmer.hex).toBe('1')
    const reverse = new CalculatorEngine()
    reverse.setMode('programmer')
    press(reverse, [CMD.byte, CMD.hex, CMD.digit1, CMD.rotateRightCarry, CMD.rotateRightCarry])
    expect(reverse.getState().programmer.hex).toBe('80')
  })

  it('shows rotate commands as reference expression groups', () => {
    const engine = new CalculatorEngine()
    engine.setMode('programmer')
    press(engine, [CMD.byte, CMD.hex, ...digits('80'), CMD.rotateLeftCarry])
    expect(engine.getState().expressionTokens.map((token) => token.text)).toEqual(['RoL(', '80', ')', '='])
    expect(engine.getState().primary).toBe('0')
  })

  it('formats FE mode while an input is being typed', () => {
    const engine = new CalculatorEngine()
    engine.setMode('scientific')
    press(engine, [...digits('5'), CMD.fe])
    expect(engine.getState().primary).toBe('5.e+0')
  })

  it('keeps an error until clear or clear-entry', () => {
    const engine = new CalculatorEngine()
    engine.setMode('scientific')
    press(engine, [...digits('5'), CMD.sign, CMD.sqrt, CMD.equals])
    expect(engine.getState().isError).toBe(true)
    expect(engine.getState().primary).toBe('invalid_input')
    press(engine, [CMD.digit2])
    expect(engine.getState().isError).toBe(true)
    press(engine, [CMD.clearEntry])
    expect(engine.getState().isError).toBe(false)
    expect(engine.getState().primary).toBe('0')
  })

  it('distinguishes undefined division and modulo by zero', () => {
    const undefinedDivision = new CalculatorEngine()
    press(undefinedDivision, [CMD.digit0, CMD.divide, CMD.digit0, CMD.equals])
    expect(undefinedDivision.getState().primary).toBe('undefined')
    const division = new CalculatorEngine()
    press(division, [CMD.digit1, CMD.divide, CMD.digit0, CMD.equals])
    expect(division.getState().primary).toBe('divide_by_zero')
    const modulo = new CalculatorEngine()
    modulo.setMode('scientific')
    press(modulo, [...digits('10'), CMD.mod, CMD.digit0, CMD.equals])
    expect(modulo.getState().primary).toBe('10')
  })

  it('supports hexadecimal programmer arithmetic', () => {
    const engine = new CalculatorEngine()
    engine.setMode('programmer')
    press(engine, [CMD.hex, CMD.a, CMD.add, CMD.digit1, CMD.equals])
    expect(engine.getState().programmer.hex).toBe('B')
    expect(engine.getState().primary).toBe('B')
  })

  it('masks programmer values to the selected word size', () => {
    const engine = new CalculatorEngine()
    engine.setMode('programmer')
    press(engine, [CMD.byte, CMD.dec, ...digits('127'), CMD.add, CMD.digit1, CMD.equals])
    expect(engine.getState().programmer.hex).toBe('80')
    expect(engine.getState().primary).toBe('-128')
  })

  it('toggles a bit in the bit flip panel', () => {
    const engine = new CalculatorEngine()
    engine.setMode('programmer')
    press(engine, [CMD.hex, CMD.bitFlipStart, CMD.hex])
    expect(engine.getState().programmer.hex).toBe('1')
  })

  it('stores and recalls memory', () => {
    const engine = new CalculatorEngine()
    press(engine, [...digits('7'), CMD.equals])
    engine.rememberMemory()
    press(engine, [CMD.clear])
    engine.recallMemory(0)
    expect(engine.getState().primary).toBe('7')
  })

  it('records standard history with an expression', () => {
    const engine = new CalculatorEngine()
    press(engine, [...digits('1'), CMD.add, ...digits('2'), CMD.equals])
    const entry = engine.getHistory()[0]
    expect(entry?.expression).toBe('1   +   2 =')
    expect(entry?.result).toBe('3')
  })

  it('parses pasted standard expressions with immediate evaluation', () => {
    const result = parsePasteCommands('1+2*3', 'standard', 10)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const engine = new CalculatorEngine()
    press(engine, result.commands)
    press(engine, [CMD.equals])
    expect(engine.getState().primary).toBe('9')
  })

  it('parses pasted scientific expressions with precedence', () => {
    const result = parsePasteCommands('1+2*3', 'scientific', 10)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const engine = new CalculatorEngine()
    engine.setMode('scientific')
    press(engine, result.commands)
    press(engine, [CMD.equals])
    expect(engine.getState().primary).toBe('7')
  })

  it('converts length units', () => {
    const units = getUnitsForCategory('length')
    const meter = units.find((unit) => unit.nameKey.endsWith('.name') && unit.factor === 1)
    const foot = units.find((unit) => unit.factor !== undefined && Math.abs((unit.factor ?? 0) - 0.3048) < 1e-12)
    expect(meter).toBeDefined()
    expect(foot).toBeDefined()
    expect(convertUnitValue(1, meter!.id, foot!.id)).toBeCloseTo(3.280839895, 6)
  })

  it('converts temperatures with offsets', () => {
    const units = getUnitsForCategory('temperature')
    expect(units).toHaveLength(3)
    expect(convertUnitValue(0, units[0]!.id, units[1]!.id)).toBeCloseTo(32, 10)
    expect(convertUnitValue(32, units[1]!.id, units[0]!.id)).toBeCloseTo(0, 10)
  })

  it('calculates date differences and durations', () => {
    expect(difference('2024-01-01', '2024-01-31')?.totalDays).toBe(30)
    expect(difference('2024-01-31', '2024-01-01')?.totalDays).toBe(30)
    expect(addDuration('2024-01-31', 0, 1, 0)).toBe('2024-02-29')
    expect(subtractDuration('2024-03-31', 0, 1, 0)).toBe('2024-02-29')
  })
})
