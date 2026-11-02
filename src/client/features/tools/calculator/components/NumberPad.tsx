import { Delete } from 'lucide-react'
import { CMD } from '@shared/tools/calculator/contract'
import { calcT } from '../lib/calc-i18n'
import { CalcKey } from './CalcKey'

export function NumberPad({ onCommand, minimal = false }: { onCommand: (command: number) => void; minimal?: boolean }) {
  if (minimal) {
    return (
      <div role="group" aria-label={calcT('tools.calculator.a11y.keypad')} className="grid grid-cols-4 gap-1.5">
        {['7', '8', '9'].map((digit) => <CalcKey key={digit} glyph={digit} ariaLabel={digit} onPress={() => onCommand(CMD.digit0 + Number(digit))} />)}
        <CalcKey glyph="÷" ariaLabel={calcT('tools.calculator.standard.divide')} variant="operator" onPress={() => onCommand(CMD.divide)} />
        {['4', '5', '6'].map((digit) => <CalcKey key={digit} glyph={digit} ariaLabel={digit} onPress={() => onCommand(CMD.digit0 + Number(digit))} />)}
        <CalcKey glyph="×" ariaLabel={calcT('tools.calculator.standard.multiply')} variant="operator" onPress={() => onCommand(CMD.multiply)} />
        {['1', '2', '3'].map((digit) => <CalcKey key={digit} glyph={digit} ariaLabel={digit} onPress={() => onCommand(CMD.digit0 + Number(digit))} />)}
        <CalcKey glyph="−" ariaLabel={calcT('tools.calculator.standard.subtract')} variant="operator" onPress={() => onCommand(CMD.subtract)} />
        <CalcKey glyph="±" ariaLabel={calcT('tools.calculator.common.negate')} variant="function" onPress={() => onCommand(CMD.sign)} />
        <CalcKey glyph="0" ariaLabel="0" onPress={() => onCommand(CMD.digit0)} />
        <CalcKey glyph="." ariaLabel={calcT('tools.calculator.common.decimal')} onPress={() => onCommand(CMD.decimal)} />
        <CalcKey glyph="+" ariaLabel={calcT('tools.calculator.standard.add')} variant="operator" onPress={() => onCommand(CMD.add)} />
        <CalcKey glyph="=" ariaLabel={calcT('tools.calculator.common.equals')} variant="equals" className="col-span-4" onPress={() => onCommand(CMD.equals)} />
      </div>
    )
  }
  return (
    <div role="group" aria-label={calcT('tools.calculator.a11y.keypad')} className="grid grid-cols-4 gap-1.5">
      <CalcKey glyph="%" ariaLabel={calcT('tools.calculator.standard.percent')} variant="function" onPress={() => onCommand(CMD.percent)} />
      <CalcKey glyph="CE" ariaLabel={calcT('tools.calculator.common.clear_entry')} variant="function" onPress={() => onCommand(CMD.clearEntry)} />
      <CalcKey glyph="C" ariaLabel={calcT('tools.calculator.common.clear')} variant="function" onPress={() => onCommand(CMD.clear)} />
      <CalcKey glyph={<Delete size={16} />} ariaLabel={calcT('tools.calculator.common.backspace')} variant="function" onPress={() => onCommand(CMD.back)} />

      <CalcKey glyph="1/x" ariaLabel={calcT('tools.calculator.standard.reciprocal')} variant="function" onPress={() => onCommand(CMD.reciprocal)} />
      <CalcKey glyph="x²" ariaLabel={calcT('tools.calculator.standard.square')} variant="function" onPress={() => onCommand(CMD.square)} />
      <CalcKey glyph="√x" ariaLabel={calcT('tools.calculator.standard.sqrt')} variant="function" onPress={() => onCommand(CMD.sqrt)} />
      <CalcKey glyph="÷" ariaLabel={calcT('tools.calculator.standard.divide')} variant="operator" onPress={() => onCommand(CMD.divide)} />

      <CalcKey glyph="7" ariaLabel="7" onPress={() => onCommand(CMD.digit7)} />
      <CalcKey glyph="8" ariaLabel="8" onPress={() => onCommand(CMD.digit8)} />
      <CalcKey glyph="9" ariaLabel="9" onPress={() => onCommand(CMD.digit9)} />
      <CalcKey glyph="×" ariaLabel={calcT('tools.calculator.standard.multiply')} variant="operator" onPress={() => onCommand(CMD.multiply)} />

      <CalcKey glyph="4" ariaLabel="4" onPress={() => onCommand(CMD.digit4)} />
      <CalcKey glyph="5" ariaLabel="5" onPress={() => onCommand(CMD.digit5)} />
      <CalcKey glyph="6" ariaLabel="6" onPress={() => onCommand(CMD.digit6)} />
      <CalcKey glyph="−" ariaLabel={calcT('tools.calculator.standard.subtract')} variant="operator" onPress={() => onCommand(CMD.subtract)} />

      <CalcKey glyph="1" ariaLabel="1" onPress={() => onCommand(CMD.digit1)} />
      <CalcKey glyph="2" ariaLabel="2" onPress={() => onCommand(CMD.digit2)} />
      <CalcKey glyph="3" ariaLabel="3" onPress={() => onCommand(CMD.digit3)} />
      <CalcKey glyph="+" ariaLabel={calcT('tools.calculator.standard.add')} variant="operator" onPress={() => onCommand(CMD.add)} />

      <CalcKey glyph="±" ariaLabel={calcT('tools.calculator.common.negate')} variant="function" onPress={() => onCommand(CMD.sign)} />
      <CalcKey glyph="0" ariaLabel="0" onPress={() => onCommand(CMD.digit0)} />
      <CalcKey glyph="." ariaLabel={calcT('tools.calculator.common.decimal')} onPress={() => onCommand(CMD.decimal)} />
      <CalcKey glyph="=" ariaLabel={calcT('tools.calculator.common.equals')} variant="equals" onPress={() => onCommand(CMD.equals)} />
    </div>
  )
}
