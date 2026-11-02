import { Delete } from 'lucide-react'
import { CMD } from '@shared/tools/calculator/contract'
import { calcT } from '../lib/calc-i18n'
import { CalcKey } from './CalcKey'
import { NumberPad } from './NumberPad'

type TrigKey = 'sin' | 'cos' | 'tan' | 'sec' | 'csc' | 'cot'

const TRIG_COMMANDS: Record<TrigKey, readonly [number, number, number, number]> = {
  sin: [CMD.sin, CMD.asin, CMD.sinh, CMD.asinh],
  cos: [CMD.cos, CMD.acos, CMD.cosh, CMD.acosh],
  tan: [CMD.tan, CMD.atan, CMD.tanh, CMD.atanh],
  sec: [CMD.sec, CMD.asec, CMD.sech, CMD.asech],
  csc: [CMD.csc, CMD.acsc, CMD.csch, CMD.acsch],
  cot: [CMD.cot, CMD.acot, CMD.coth, CMD.acoth],
}

function trigLabel(base: TrigKey, shift: boolean, hyp: boolean): string {
  const name = hyp ? `${base}h` : base
  return shift ? `${name}⁻¹` : name
}

export function ScientificPad({
  onCommand,
  shift,
  hyp,
  onToggleShift,
  onToggleHyp,
  fToE,
}: {
  onCommand: (command: number) => void
  shift: boolean
  hyp: boolean
  onToggleShift: () => void
  onToggleHyp: () => void
  fToE: boolean
}) {
  const trig = (base: TrigKey) => {
    const [normal, inverse, hyperbolic, inverseHyperbolic] = TRIG_COMMANDS[base]
    return onCommand(shift ? (hyp ? inverseHyperbolic : inverse) : hyp ? hyperbolic : normal)
  }
  return (
    <div className="space-y-1.5">
      <div role="group" aria-label={calcT('tools.calculator.a11y.keypad')} className="grid grid-cols-6 gap-1.5">
        <CalcKey glyph="2nd" ariaLabel={calcT('tools.calculator.scientific.second')} variant="function" active={shift} onPress={onToggleShift} className="text-[length:var(--text-12)]" />
        <CalcKey glyph="HYP" ariaLabel={calcT('tools.calculator.scientific.hyp')} variant="function" active={hyp} onPress={onToggleHyp} className="text-[length:var(--text-12)]" />
        <CalcKey glyph="FE" ariaLabel={calcT('tools.calculator.scientific.fe')} variant="function" active={fToE} onPress={() => onCommand(CMD.fe)} className="text-[length:var(--text-12)]" />
        <CalcKey glyph="C" ariaLabel={calcT('tools.calculator.common.clear')} variant="function" onPress={() => onCommand(CMD.clear)} />
        <CalcKey glyph="CE" ariaLabel={calcT('tools.calculator.common.clear_entry')} variant="function" onPress={() => onCommand(CMD.clearEntry)} />
        <CalcKey glyph={<Delete size={15} />} ariaLabel={calcT('tools.calculator.common.backspace')} variant="function" onPress={() => onCommand(CMD.back)} />
      </div>
      <div role="group" aria-label={calcT('tools.calculator.a11y.keypad')} className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {(['sin', 'cos', 'tan', 'sec', 'csc', 'cot'] as TrigKey[]).map((key) => (
          <CalcKey key={key} glyph={trigLabel(key, shift, hyp)} ariaLabel={calcT(`tools.calculator.scientific.${key}`)} variant="function" onPress={() => trig(key)} />
        ))}
        <div className="col-span-3 grid grid-cols-3 gap-1.5 sm:col-span-6 sm:grid-cols-7">
          <CalcKey glyph="ln" ariaLabel={calcT('tools.calculator.scientific.ln')} variant="function" onPress={() => onCommand(CMD.ln)} />
          <CalcKey glyph="log" ariaLabel={calcT('tools.calculator.scientific.log')} variant="function" onPress={() => onCommand(CMD.log)} />
          <CalcKey glyph="log_y" ariaLabel={calcT('tools.calculator.scientific.log_base_y')} variant="function" onPress={() => onCommand(CMD.logBaseY)} />
          <CalcKey glyph="eˣ" ariaLabel={calcT('tools.calculator.scientific.e_power')} variant="function" onPress={() => onCommand(CMD.powE)} />
          <CalcKey glyph="10ˣ" ariaLabel={calcT('tools.calculator.scientific.ten_power')} variant="function" onPress={() => onCommand(CMD.tenPower)} />
          <CalcKey glyph="2ˣ" ariaLabel={calcT('tools.calculator.scientific.two_power')} variant="function" onPress={() => onCommand(CMD.twoPower)} />
          <CalcKey glyph="EXP" ariaLabel={calcT('tools.calculator.scientific.exp')} variant="function" onPress={() => onCommand(CMD.exp)} />
        </div>
        <CalcKey glyph="√x" ariaLabel={calcT('tools.calculator.standard.sqrt')} variant="function" onPress={() => onCommand(CMD.sqrt)} />
        <CalcKey glyph="∛x" ariaLabel={calcT('tools.calculator.scientific.cube_root')} variant="function" onPress={() => onCommand(CMD.cubeRoot)} />
        <CalcKey glyph="x²" ariaLabel={calcT('tools.calculator.standard.square')} variant="function" onPress={() => onCommand(CMD.square)} />
        <CalcKey glyph="x³" ariaLabel={calcT('tools.calculator.scientific.cube')} variant="function" onPress={() => onCommand(CMD.cube)} />
        <CalcKey glyph="xʸ" ariaLabel={calcT('tools.calculator.scientific.power')} variant="function" onPress={() => onCommand(CMD.power)} />
        <CalcKey glyph="ʸ√x" ariaLabel={calcT('tools.calculator.scientific.root')} variant="function" onPress={() => onCommand(CMD.root)} />
        <CalcKey glyph="1/x" ariaLabel={calcT('tools.calculator.standard.reciprocal')} variant="function" onPress={() => onCommand(CMD.reciprocal)} />
        <CalcKey glyph="n!" ariaLabel={calcT('tools.calculator.scientific.factorial')} variant="function" onPress={() => onCommand(CMD.factorial)} />
        <CalcKey glyph="DMS" ariaLabel={calcT('tools.calculator.scientific.dms')} variant="function" onPress={() => onCommand(CMD.dms)} />
        <CalcKey glyph="|x|" ariaLabel={calcT('tools.calculator.scientific.abs')} variant="function" onPress={() => onCommand(CMD.abs)} />
        <CalcKey glyph="⌊x⌋" ariaLabel={calcT('tools.calculator.scientific.floor')} variant="function" onPress={() => onCommand(CMD.floor)} />
        <CalcKey glyph="⌈x⌉" ariaLabel={calcT('tools.calculator.scientific.ceil')} variant="function" onPress={() => onCommand(CMD.ceil)} />
        <CalcKey glyph="π" ariaLabel={calcT('tools.calculator.scientific.pi')} variant="function" onPress={() => onCommand(CMD.pi)} />
        <CalcKey glyph="e" ariaLabel={calcT('tools.calculator.scientific.euler')} variant="function" onPress={() => onCommand(CMD.euler)} />
        <CalcKey glyph="rand" ariaLabel={calcT('tools.calculator.scientific.rand')} variant="function" onPress={() => onCommand(CMD.rand)} />
        <CalcKey glyph="mod" ariaLabel={calcT('tools.calculator.scientific.mod')} variant="function" onPress={() => onCommand(CMD.mod)} />
        <CalcKey glyph="(" ariaLabel={calcT('tools.calculator.scientific.open_paren')} variant="function" onPress={() => onCommand(CMD.openParen)} />
        <CalcKey glyph=")" ariaLabel={calcT('tools.calculator.scientific.close_paren')} variant="function" onPress={() => onCommand(CMD.closeParen)} />
      </div>
      <NumberPad onCommand={onCommand} minimal />
    </div>
  )
}
