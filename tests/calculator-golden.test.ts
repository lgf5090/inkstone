import { describe, expect, it } from 'vitest'
import fixtures from './fixtures/calculator/golden.json'
import { CalculatorEngine } from '@shared/tools/calculator/engine/calc-engine'
import type { CalculatorMode } from '@shared/tools/calculator/contract'
import { EN_US_CALCULATOR_UI } from '@shared/locales/en-US-calculator-ui'

const errorDisplay = (key: string): string | undefined => (EN_US_CALCULATOR_UI as Record<string, string>)[`tools.calculator.error.${key}`]

interface GoldenFixture {
  name: string
  mode: CalculatorMode
  commands: number[]
  expect: {
    primary: string
    isError: boolean
    expression: string[]
    expressionText: string
    history: Array<{ expression: string; result: string }>
  }
}

describe('calculator golden corpus (reference C++ engine)', () => {
  it.each((fixtures as GoldenFixture[]).map((fixture) => [fixture.name, fixture] as const))('%s', (_name, fixture) => {
    const engine = new CalculatorEngine()
    engine.setMode(fixture.mode)
    for (const command of fixture.commands) engine.send(command)
    const state = engine.getState()
    expect(state.isError).toBe(fixture.expect.isError)
    expect(fixture.expect.isError ? errorDisplay(state.primary) : state.primary).toBe(fixture.expect.primary)
    expect(state.expressionTokens.map((token) => token.text)).toEqual(fixture.expect.expression)
    const history = engine.getHistory().slice().reverse()
    expect(history.length).toBe(fixture.expect.history.length)
    for (let index = 0; index < history.length; index++) {
      expect(history[index].expression).toBe(fixture.expect.history[index].expression)
      expect(history[index].result).toBe(fixture.expect.history[index].result)
    }
  })
})
