import { CMD, HISTORY_LIMIT, MEMORY_LIMIT, isReplayableCommand } from '../contract'
import type { AngleMode, CalculatorCommand, CalculatorMode, Radix, WordSize } from '../contract'
import type {
  CalculatorDisplayState,
  EngineSnapshot,
  ExpressionToken,
  HistoryEntry,
  MemoryEntry,
} from '../types'
import {
  FIXED_E,
  FIXED_PI,
  fixedToRational,
  acosValue,
  acoshValue,
  asinValue,
  asinhValue,
  atanValue,
  atanhValue,
  cosValue,
  coshValue,
  cbrtValue,
  dmsValue,
  expValue,
  factorialValue,
  lnValue,
  log10Value,
  logBaseValue,
  powerValue,
  rootValue,
  secValue,
  cscValue,
  cotValue,
  sinValue,
  sinhValue,
  sqrtValue,
  tanValue,
  tanhValue,
} from './bigmath'
import { Rational } from './rational'

type SciToken =
  | { kind: 'number'; value: Rational; text: string; commandIndex: number }
  | { kind: 'operator'; value: string; commandIndex: number }
  | { kind: 'lparen'; commandIndex: number }
  | { kind: 'rparen'; commandIndex: number }
  | { kind: 'function'; value: string; commandIndex: number }

type AstNode =
  | { kind: 'number'; value: Rational }
  | { kind: 'unary'; op: string; value: AstNode }
  | { kind: 'binary'; op: string; left: AstNode; right: AstNode }
  | { kind: 'call'; name: string; arg: AstNode }

export type EngineErrorKey =
  | 'divide_by_zero'
  | 'overflow'
  | 'undefined'
  | 'invalid_input'
  | 'max_digits'

const OP_TEXT: Record<number, string> = {
  [CMD.add]: '+',
  [CMD.subtract]: '-',
  [CMD.multiply]: '×',
  [CMD.divide]: '÷',
  [CMD.mod]: 'Mod',
  [CMD.power]: '^',
  [CMD.root]: 'yroot',
  [CMD.and]: 'AND',
  [CMD.or]: 'OR',
  [CMD.xor]: 'XOR',
  [CMD.nand]: 'NAND',
  [CMD.nor]: 'NOR',
  [CMD.leftShift]: 'Lsh',
  [CMD.rightShift]: 'Rsh',
  [CMD.leftShiftLogical]: 'Lsh',
  [CMD.rotateLeft]: 'RoL',
  [CMD.rotateRight]: 'RoR',
  [CMD.rotateLeftCarry]: 'RoLC',
  [CMD.rotateRightCarry]: 'RoRC',
  [CMD.logBaseY]: 'LogBaseY',
}

function isDigitCommand(command: number): boolean {
  return command >= CMD.digit0 && command <= CMD.digit9
}

function digitFromCommand(command: number): string {
  return String(command - CMD.digit0)
}

function hexDigitFromCommand(command: number): string {
  return String.fromCharCode(65 + command - CMD.a)
}

function opText(command: number): string | null {
  return OP_TEXT[command] ?? null
}

function scientificNumberText(value: Rational): string {
  return value.toDecimalString({ maxSignificant: 32 })
}

function groupProgrammerDigits(text: string, radix: Radix): string {
  if (radix === 10 || !text) return text
  const size = radix === 16 || radix === 2 ? 4 : 3
  const negative = text.startsWith('-')
  const digits = negative ? text.slice(1) : text
  let grouped = ''
  for (let index = 0; index < digits.length; index++) {
    if (index > 0 && (digits.length - index) % size === 0) grouped += ' '
    grouped += digits[index]
  }
  return `${negative ? '-' : ''}${grouped}`
}

export class CalculatorEngine {
  private mode: CalculatorMode = 'standard'
  private input = ''
  private value = Rational.zero()
  private errorKey: EngineErrorKey | null = null
  private tokens: SciToken[] = []
  private lastDisplayTokens: ExpressionToken[] = []
  private displayEquals = false
  private pendingOperator: string | null = null
  private accumulator = Rational.zero()
  private hasAccumulator = false
  private lastOperator: string | null = null
  private lastOperand: Rational | null = null
  private justEvaluated = false
  private angleMode: AngleMode = 'deg'
  private radix: Radix = 10
  private wordSize: WordSize = 64
  private bitFlip = false
  private carryBit = 0
  private binaryDigits: boolean[] = new Array(64).fill(false)
  private fToE = false
  private shift = false
  private hyp = false
  private parenCount = 0
  private history: HistoryEntry[] = []
  private memory: MemoryEntry[] = []
  private commandLog: number[] = []
  private suppressHistory = false
  private randomSeed = 0

  constructor() {
    this.emitInitialHistory()
  }

  private emitInitialHistory(): void {
    this.lastDisplayTokens = []
  }

  setMode(mode: CalculatorMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.resetExpression()
    this.errorKey = null
    if (mode === 'programmer') {
      this.radix = 10
      this.wordSize = 64
      this.bitFlip = false
      this.updateBinaryDigits()
    }
  }

  getMode(): CalculatorMode {
    return this.mode
  }

  getState(): CalculatorDisplayState {
    const primary = this.primaryText()
    return {
      primary,
      isError: this.errorKey !== null,
      isBinaryOperatorPending: this.pendingOperator !== null,
      expressionTokens: this.expressionTokens(),
      parenthesisCount: this.parenCount,
      memory: this.memory.map((entry) => this.formatMemory(Rational.fromRationalValue(entry.value))),
      history: this.history.slice(),
      mode: this.mode,
      radix: this.radix,
      wordSize: this.wordSize,
      programmer: this.programmerDisplays(),
      bitFlip: this.bitFlip,
      binaryDigits: this.binaryDigits.slice(),
      isFToEEnabled: this.fToE,
      angleMode: this.angleMode,
      shift: this.shift,
      hyp: this.hyp,
    }
  }

  private primaryText(): string {
    if (this.errorKey) return this.errorKey
    if (this.mode === 'programmer') return this.programmerPrimary()
    if (this.input) {
      if (this.fToE) {
        try {
          return this.formatValue(Rational.fromDecimalString(this.input))
        } catch {
          return this.formatInput(this.input)
        }
      }
      return this.formatInput(this.input)
    }
    return this.formatValue(this.value)
  }

  private formatInput(input: string): string {
    const [whole, fraction] = input.split('.')
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return fraction === undefined ? grouped : `${grouped}.${fraction}`
  }

  private formatValue(value: Rational): string {
    return value.toDecimalString({
      maxSignificant: this.mode === 'standard' ? 16 : 32,
      forceScientific: this.fToE,
      group: true,
      groupSeparator: ',',
      decimalSeparator: '.',
    })
  }

  private formatMemory(value: Rational): string {
    return value.toDecimalString({
      maxSignificant: this.mode === 'standard' ? 16 : 32,
      group: true,
      groupSeparator: ',',
      decimalSeparator: '.',
    })
  }

  private expressionTokens(): ExpressionToken[] {
    if (this.tokens.length === 0) return this.lastDisplayTokens
    return this.renderExpressionTokens(this.tokens, this.displayEquals)
  }

  private expressionNumberText(value: Rational): string {
    return value.toDecimalString({
      maxSignificant: this.mode === 'standard' ? 16 : 32,
      forceScientific: this.fToE,
      group: false,
      decimalSeparator: '.',
    })
  }

  private functionLabel(name: string): string {
    const angle = this.angleMode === 'rad' ? 'ᵣ' : this.angleMode === 'grad' ? '₉' : '₀'
    const angleName = this.angleMode === 'rad' ? 'Rad' : this.angleMode === 'grad' ? 'Grad' : 'Deg'
    const inverseAngle = '⁻¹'
    switch (name) {
      case 'sin': return `sin${angle}(`
      case 'cos': return `cos${angle}(`
      case 'tan': return `tan${angle}(`
      case 'asin': return `sin${angle}${inverseAngle}(`
      case 'acos': return `cos${angle}${inverseAngle}(`
      case 'atan': return `tan${angle}${inverseAngle}(`
      case 'sec': return `Sec${angleName}(`
      case 'csc': return `Csc${angleName}(`
      case 'cot': return `Cot${angleName}(`
      case 'asec': return `InverseSec${angleName}(`
      case 'acsc': return `InverseCsc${angleName}(`
      case 'acot': return `InverseCot${angleName}(`
      case 'sinh': return 'sinh('
      case 'cosh': return 'cosh('
      case 'tanh': return 'tanh('
      case 'asinh': return 'sinh⁻¹('
      case 'acosh': return 'cosh⁻¹('
      case 'atanh': return 'tanh⁻¹('
      case 'sech': return 'Sech('
      case 'csch': return 'Csch('
      case 'coth': return 'Coth('
      case 'asech': return 'InverseSech('
      case 'acsch': return 'InverseCsch('
      case 'acoth': return 'InverseCoth('
      case 'not': return 'NOT('
      case 'rol':
      case 'rolc': return 'RoL('
      case 'ror':
      case 'rorc': return 'RoR('
      case 'ln': return 'ln('
      case 'log': return 'log('
      case 'sqrt': return '√('
      case 'square': return 'sqr('
      case 'cube': return 'cube('
      case 'cbrt': return 'CubeRoot('
      case 'reciprocal': return '1/('
      case 'fact': return 'fact('
      case 'dms': return 'dms('
      case 'degrees': return 'degrees('
      case 'tenPower': return '10^('
      case 'twoPower': return 'TwoPowX('
      case 'exp': return 'e^('
      case 'abs': return 'Abs('
      case 'floor': return 'Floor('
      case 'ceil': return 'Ceil('
      default: return `${name}(`
    }
  }

  private renderExpressionTokens(tokens: SciToken[], withEquals: boolean): ExpressionToken[] {
    const result: ExpressionToken[] = []
    for (const token of tokens) {
      switch (token.kind) {
        case 'number':
          result.push({ text: token.text, commandIndex: token.commandIndex, type: 'operand', editable: true })
          break
        case 'operator':
          result.push({ text: ' ', commandIndex: -1, type: 'separator', editable: false })
          result.push({ text: token.value, commandIndex: token.commandIndex, type: 'operator', editable: false })
          result.push({ text: ' ', commandIndex: -1, type: 'separator', editable: false })
          break
        case 'lparen':
        case 'rparen':
          result.push({ text: token.kind === 'lparen' ? '(' : ')', commandIndex: token.commandIndex, type: 'separator', editable: false })
          break
        case 'function':
          result.push({ text: this.functionLabel(token.value), commandIndex: token.commandIndex, type: 'operator', editable: false })
          break
      }
    }
    if (withEquals && result.length > 0) {
      result.push({ text: '=', commandIndex: -1, type: 'operator', editable: false })
    }
    return result
  }

  private expressionText(tokens: SciToken[], withEquals: boolean): string {
    return this.renderExpressionTokens(tokens, withEquals).map((token) => token.text).join(' ')
  }

  private programmerPrimary(): string {
    const value = this.programmerValue()
    if (this.radix === 10) return this.formatValue(new Rational(this.signedProgrammerValue(this.maskValue(value))))
    return groupProgrammerDigits(this.maskValue(value).toString(this.radix).toUpperCase(), this.radix)
  }

  private programmerDisplays(): { hex: string; dec: string; oct: string; bin: string } {
    const value = this.maskValue(this.programmerValue())
    const signed = this.signedProgrammerValue(value)
    return {
      hex: groupProgrammerDigits(value.toString(16).toUpperCase(), 16),
      dec: signed.toString(),
      oct: groupProgrammerDigits(value.toString(8), 8),
      bin: groupProgrammerDigits(value.toString(2), 2),
    }
  }

  private programmerValue(): bigint {
    if (this.input) {
      try {
        return this.parseProgrammerInput(this.input)
      } catch {
        return 0n
      }
    }
    return this.accumulator.n / this.accumulator.d
  }

  private parseProgrammerInput(input: string): bigint {
    if (!input) return 0n
    const negative = input.startsWith('-')
    const digits = negative ? input.slice(1) : input
    let value = 0n
    const base = BigInt(this.radix)
    for (const char of digits) {
      const digit = parseInt(char, this.radix)
      if (!Number.isInteger(digit) || digit < 0 || digit >= this.radix) throw new RangeError('Invalid digit')
      value = value * base + BigInt(digit)
    }
    return negative ? -value : value
  }

  private maskValue(value: bigint): bigint {
    const bits = BigInt(this.wordSize)
    const mask = (1n << bits) - 1n
    return value & mask
  }

  private signedProgrammerValue(masked: bigint): bigint {
    const bits = BigInt(this.wordSize)
    const signBit = 1n << (bits - 1n)
    return (masked & signBit) !== 0n ? masked - (1n << bits) : masked
  }

  private updateBinaryDigits(): void {
    const masked = this.maskValue(this.programmerValue())
    const bits = this.wordSize
    this.binaryDigits = new Array(64).fill(false)
    for (let index = 0; index < bits; index++) {
      this.binaryDigits[index] = ((masked >> BigInt(index)) & 1n) === 1n
    }
  }

  send(command: CalculatorCommand): void {
    if (this.errorKey) {
      if (command !== CMD.clear && command !== CMD.clearEntry) return
      this.commandLog.push(command)
      if (command === CMD.clear) this.resetAll()
      else this.resetExpression()
      this.errorKey = null
      return
    }
    this.commandLog.push(command)
    if (command !== CMD.equals) this.displayEquals = false
    if (this.mode === 'programmer') {
      this.sendProgrammer(command)
      return
    }
    if (this.mode === 'standard') {
      this.sendStandard(command)
      return
    }
    this.sendScientific(command)
  }

  private sendStandard(command: CalculatorCommand): void {
    if (isDigitCommand(command)) {
      this.typeDigits(digitFromCommand(command))
      return
    }
    switch (command) {
      case CMD.decimal:
        this.typeDecimal()
        return
      case CMD.sign:
        this.toggleSign()
        return
      case CMD.back:
        this.backspace()
        return
      case CMD.clearEntry:
        this.input = ''
        this.value = Rational.zero()
        return
      case CMD.clear:
        this.resetAll()
        return
      case CMD.add:
      case CMD.subtract:
      case CMD.multiply:
      case CMD.divide:
      case CMD.mod:
      case CMD.power:
      case CMD.root:
      case CMD.logBaseY:
        this.applyStandardBinary(command)
        return
      case CMD.equals:
        this.standardEquals()
        return
      case CMD.percent:
        this.applyStandardPercent()
        return
      case CMD.fe:
        this.fToE = !this.fToE
        return
      case CMD.pi:
        this.setImmediateValue(fixedToRational(FIXED_PI))
        return
      case CMD.euler:
        this.setImmediateValue(fixedToRational(FIXED_E))
        return
      default:
        this.applyUnary(command, false)
    }
  }

  private sendScientific(command: CalculatorCommand): void {
    if (isDigitCommand(command)) {
      this.typeDigits(digitFromCommand(command))
      return
    }
    switch (command) {
      case CMD.decimal:
        this.typeDecimal()
        return
      case CMD.sign:
        this.toggleSign()
        return
      case CMD.back:
        this.backspace()
        return
      case CMD.clearEntry:
        this.input = ''
        return
      case CMD.clear:
        this.resetAll()
        return
      case CMD.add:
      case CMD.subtract:
      case CMD.multiply:
      case CMD.divide:
      case CMD.mod:
      case CMD.power:
      case CMD.root:
      case CMD.logBaseY:
        this.pushScientificOperator(command)
        return
      case CMD.equals:
        this.scientificEquals()
        return
      case CMD.percent:
        this.pushPercent()
        return
      case CMD.openParen:
        if (this.input) {
          this.commitInputToken()
        }
        this.tokens.push({ kind: 'lparen', commandIndex: command })
        this.parenCount += 1
        return
      case CMD.closeParen:
        if (this.parenCount <= 0) return
        if (this.input) this.commitInputToken()
        this.tokens.push({ kind: 'rparen', commandIndex: command })
        this.parenCount -= 1
        return
      case CMD.fe:
        this.fToE = !this.fToE
        return
      case CMD.exp:
        if (this.input && !this.input.includes('e') && !this.input.includes('E')) this.input += 'e'
        return
      case CMD.deg:
        this.angleMode = 'deg'
        return
      case CMD.rad:
        this.angleMode = 'rad'
        return
      case CMD.grad:
        this.angleMode = 'grad'
        return
      case CMD.pi:
        this.insertConstant(fixedToRational(FIXED_PI))
        return
      case CMD.euler:
        this.insertConstant(fixedToRational(FIXED_E))
        return
      case CMD.rand:
        this.insertConstant(this.randomValue())
        return
      default:
        this.applyUnary(command, true)
    }
  }

  private sendProgrammer(command: CalculatorCommand): void {
    if (isDigitCommand(command)) {
      this.typeDigits(digitFromCommand(command))
      return
    }
    if (command >= CMD.a && command <= CMD.f) {
      this.typeDigits(hexDigitFromCommand(command))
      return
    }
    if (command >= CMD.bitFlipStart && command <= CMD.bitFlipEnd) {
      this.toggleBit(command - CMD.bitFlipStart)
      return
    }
    switch (command) {
      case CMD.clear:
        this.resetAll()
        return
      case CMD.clearEntry:
        this.input = ''
        this.accumulator = Rational.zero()
        return
      case CMD.back:
        if (this.input) this.input = this.input.slice(0, -1)
        else this.accumulator = Rational.zero()
        return
      case CMD.sign:
        this.toggleProgrammerSign()
        return
      case CMD.equals:
        this.programmerEquals()
        return
      case CMD.rotateLeft:
        this.rotateProgrammer(1, false)
        return
      case CMD.rotateRight:
        this.rotateProgrammer(-1, false)
        return
      case CMD.rotateLeftCarry:
        this.rotateProgrammer(1, true)
        return
      case CMD.rotateRightCarry:
        this.rotateProgrammer(-1, true)
        return
      case CMD.add:
      case CMD.subtract:
      case CMD.multiply:
      case CMD.divide:
      case CMD.mod:
      case CMD.and:
      case CMD.or:
      case CMD.xor:
      case CMD.nand:
      case CMD.nor:
      case CMD.leftShift:
      case CMD.rightShift:
      case CMD.leftShiftLogical:
        this.applyProgrammerBinary(command)
        return
      case CMD.not:
        this.applyProgrammerNot()
        return
      case CMD.hex:
        this.setRadix(16)
        return
      case CMD.dec:
        this.setRadix(10)
        return
      case CMD.oct:
        this.setRadix(8)
        return
      case CMD.bin:
        this.setRadix(2)
        return
      case CMD.qword:
        this.setWordSize(64)
        return
      case CMD.dword:
        this.setWordSize(32)
        return
      case CMD.word:
        this.setWordSize(16)
        return
      case CMD.byte:
        this.setWordSize(8)
        return
      default:
        return
    }
  }

  private typeDigits(digit: string): void {
    if (this.justEvaluated) this.resetExpression()
    if (this.mode === 'programmer') {
      const value = Number.parseInt(digit, this.radix)
      if (!Number.isInteger(value) || value >= this.radix) return
      if (this.radix === 10) {
        const base = this.input === '0' ? '' : this.input === '-0' ? '-' : this.input
        const candidate = `${base}${digit}`
        const numeric = BigInt(candidate || '0')
        const magnitude = numeric < 0n ? -numeric : numeric
        const limit = numeric < 0n ? 1n << BigInt(this.wordSize - 1) : (1n << BigInt(this.wordSize - 1)) - 1n
        if (magnitude > limit) return
      } else {
        const maxDigits = this.maxProgrammerDigits()
        if (this.input.replace('-', '').length >= maxDigits) return
      }
    } else {
      const maxDigits = this.mode === 'standard' ? 16 : 32
      if (this.input.replace('-', '').replace('.', '').length >= maxDigits) {
        return
      }
    }
    if (this.input === '0' && digit !== '') this.input = digit
    else if (this.input === '-0') this.input = `-${digit}`
    else this.input += digit
    this.errorKey = null
  }

  private maxProgrammerDigits(): number {
    return Math.max(1, Math.floor(this.wordSize / Math.log2(this.radix)))
  }

  private typeDecimal(): void {
    if (this.mode === 'programmer') return
    if (this.justEvaluated) this.resetExpression()
    if (this.input.includes('.')) return
    if (!this.input) this.input = '0.'
    else this.input += '.'
  }

  private toggleSign(): void {
    if (this.mode === 'programmer') {
      this.toggleProgrammerSign()
      return
    }
    if (this.input) {
      this.input = this.input.startsWith('-') ? this.input.slice(1) : `-${this.input}`
    } else {
      this.value = this.value.negate()
    }
  }

  private toggleProgrammerSign(): void {
    if (this.input) {
      const value = this.parseProgrammerInput(this.input)
      const negated = this.signedProgrammerValue(this.maskValue(-value))
      this.input = this.radix === 10 ? negated.toString() : this.maskValue(-value).toString(this.radix)
      const digits = this.input.replace('-', '')
      if (!digits) this.input = ''
      return
    }
    const value = this.programmerValue()
    const negated = this.maskValue(-value)
    this.accumulator = new Rational(this.signedProgrammerValue(negated))
    this.input = ''
    this.updateBinaryDigits()
  }

  private backspace(): void {
    if (this.justEvaluated) {
      this.resetExpression()
    }
    if (this.input) {
      this.input = this.input.slice(0, -1)
      if (this.input === '-') this.input = ''
    } else if (this.mode === 'programmer') {
      this.accumulator = Rational.zero()
    } else {
      this.value = Rational.zero()
    }
  }

  private resetExpression(): void {
    this.input = ''
    this.value = Rational.zero()
    this.tokens = []
    this.pendingOperator = null
    this.accumulator = Rational.zero()
    this.hasAccumulator = false
    this.lastOperator = null
    this.lastOperand = null
    this.justEvaluated = false
    this.parenCount = 0
    this.commandLog = []
    this.lastDisplayTokens = []
    this.displayEquals = false
  }

  private resetAll(): void {
    this.resetExpression()
    this.errorKey = null
    this.carryBit = 0
    this.shift = false
    this.hyp = false
    if (this.mode === 'programmer') {
      this.accumulator = Rational.zero()
      this.updateBinaryDigits()
    }
  }

  private setImmediateValue(value: Rational): void {
    this.input = ''
    this.value = value
    this.justEvaluated = true
  }

  private applyStandardBinary(command: number): void {
    const op = opText(command)
    if (!op) return
    if (this.justEvaluated) {
      this.tokens = []
      this.justEvaluated = false
    }
    if (!this.input && this.pendingOperator) {
      const last = this.tokens[this.tokens.length - 1]
      if (last && last.kind === 'operator') {
        last.value = op
        last.commandIndex = command
      }
      this.pendingOperator = op
      this.lastOperator = op
      return
    }
    const operand = this.currentStandardOperand()
    if (operand === null) return
    const operandText = this.expressionNumberText(operand)
    if (this.tokens.length === 0 || this.tokens[this.tokens.length - 1]?.kind === 'operator') {
      this.tokens.push({ kind: 'number', value: operand, text: operandText, commandIndex: -1 })
    }
    if (this.pendingOperator && this.hasAccumulator) {
      const result = this.evaluateBinary(this.accumulator, operand, this.pendingOperator)
      if (result === null) return
      this.recordStandardHistory(result)
      this.accumulator = result
      this.tokens = [{ kind: 'number', value: result, text: this.expressionNumberText(result), commandIndex: -1 }]
    } else {
      this.accumulator = operand
      this.hasAccumulator = true
    }
    this.value = this.accumulator
    this.input = ''
    this.pendingOperator = op
    this.lastOperator = op
    this.lastOperand = operand
    this.tokens.push({ kind: 'operator', value: op, commandIndex: command })
  }

  private currentStandardOperand(): Rational | null {
    if (this.input) {
      try {
        return Rational.fromDecimalString(this.input)
      } catch {
        this.errorKey = 'invalid_input'
        return null
      }
    }
    return this.value
  }

  private standardEquals(): void {
    this.displayEquals = false
    const operand = this.currentStandardOperand()
    if (operand === null) return
    const hadInput = Boolean(this.input)
    if (this.input) {
      this.tokens.push({ kind: 'number', value: operand, text: this.expressionNumberText(operand), commandIndex: -1 })
    } else if (this.tokens.length === 0) {
      this.tokens.push({ kind: 'number', value: operand, text: this.expressionNumberText(operand), commandIndex: -1 })
    }
    let result = operand
    if (this.pendingOperator && this.hasAccumulator) {
      const computed = this.evaluateBinary(this.accumulator, operand, this.pendingOperator)
      if (computed === null) {
        if (hadInput) this.tokens.pop()
        return
      }
      result = computed
      this.lastOperator = this.pendingOperator
      this.lastOperand = operand
    } else if (!this.pendingOperator && this.lastOperator && this.lastOperand) {
      const computed = this.evaluateBinary(operand, this.lastOperand, this.lastOperator)
      if (computed === null) {
        if (hadInput) this.tokens.pop()
        return
      }
      result = computed
      this.tokens = [
        { kind: 'number', value: operand, text: this.expressionNumberText(operand), commandIndex: -1 },
        { kind: 'operator', value: this.lastOperator, commandIndex: -1 },
        { kind: 'number', value: this.lastOperand, text: this.expressionNumberText(this.lastOperand), commandIndex: -1 },
      ]
    }
    const expression = this.expressionText(this.tokens, true)
    const shouldRecord = !(this.justEvaluated && !this.pendingOperator && !this.lastOperator)
    this.value = result
    this.input = ''
    this.pendingOperator = null
    this.accumulator = result
    this.hasAccumulator = true
    this.justEvaluated = true
    this.displayEquals = true
    this.lastDisplayTokens = this.renderExpressionTokens(this.tokens, true)
    if (shouldRecord) this.recordHistory(result, expression)
  }

  private applyStandardPercent(): void {
    const operand = this.currentStandardOperand()
    if (operand === null) return
    let percentValue: Rational
    if (this.pendingOperator === '+' || this.pendingOperator === '-') {
      percentValue = this.accumulator.multiply(operand).divide(Rational.fromInt(100))
    } else if (this.pendingOperator === '×' || this.pendingOperator === '÷') {
      percentValue = operand.divide(Rational.fromInt(100))
    } else {
      percentValue = Rational.zero()
    }
    this.tokens.push({ kind: 'number', value: percentValue, text: this.expressionNumberText(percentValue), commandIndex: -1 })
    this.value = percentValue
    this.input = ''
    this.justEvaluated = true
  }

  private pushScientificOperator(command: number): void {
    const op = opText(command)
    if (!op) return
    if (this.input) this.commitInputToken()
    if (this.tokens.length === 0 && this.justEvaluated) {
      this.tokens.push({ kind: 'number', value: this.value, text: scientificNumberText(this.value), commandIndex: -1 })
    }
    const last = this.tokens[this.tokens.length - 1]
    if (last && last.kind === 'operator') {
      last.value = op
      last.commandIndex = command
      return
    }
    if (this.tokens.length === 0) return
    this.tokens.push({ kind: 'operator', value: op, commandIndex: command })
    this.justEvaluated = false
  }

  private pushPercent(): void {
    if (!this.input) return
    let operand: Rational
    try {
      operand = Rational.fromDecimalString(this.input)
    } catch {
      this.errorKey = 'invalid_input'
      this.input = ''
      return
    }
    const left = this.lastNumberValue() ?? this.value
    const percentValue = this.pendingOperator === '+' || this.pendingOperator === '-'
      ? left.multiply(operand).divide(Rational.fromInt(100))
      : operand.divide(Rational.fromInt(100))
    this.tokens.push({ kind: 'number', value: percentValue, text: this.expressionNumberText(percentValue), commandIndex: -1 })
    this.value = percentValue
    this.input = ''
  }

  private lastNumberValue(): Rational | null {
    for (let index = this.tokens.length - 1; index >= 0; index--) {
      const token = this.tokens[index]
      if (token.kind === 'number') return token.value
      if (token.kind === 'operator') return null
    }
    return null
  }

  private commitInputToken(): void {
    if (!this.input) return
    let value: Rational
    try {
      value = Rational.fromDecimalString(this.input)
    } catch {
      this.errorKey = 'invalid_input'
      this.input = ''
      return
    }
    this.tokens.push({ kind: 'number', value, text: this.expressionNumberText(value), commandIndex: -1 })
    this.input = ''
  }

  private scientificEquals(): void {
    this.displayEquals = false
    if (this.input) this.commitInputToken()
    if (this.tokens.length === 0) {
      if (this.lastOperator && this.lastOperand) {
        const computed = this.evaluateBinary(this.value, this.lastOperand, this.lastOperator)
        if (computed !== null) {
          this.value = computed
          this.justEvaluated = true
          this.recordHistory(computed)
        }
      }
      return
    }
    const parsed = this.parseTokens(this.tokens)
    if (!parsed) return
    let result: Rational
    try {
      result = this.evaluateAst(parsed)
    } catch (error) {
      this.failFromError(error)
      return
    }
    const expression = this.expressionText(this.tokens, true)
    this.value = result
    this.lastDisplayTokens = this.renderExpressionTokens(this.tokens, true)
    this.tokens = []
    this.input = ''
    this.parenCount = 0
    this.justEvaluated = true
    this.lastOperator = null
    this.lastOperand = null
    this.recordHistory(result, expression)
  }

  private applyUnary(command: number, scientific: boolean): void {
    const fn = this.unaryName(command)
    if (!fn) {
      if (command === CMD.fe) this.fToE = !this.fToE
      return
    }
    if (scientific) {
      this.applyScientificUnary(fn, command)
      return
    }
    this.applyStandardUnary(fn, command)
  }

  private applyScientificUnary(fn: string, command: number): void {
    const fnToken: SciToken = { kind: 'function', value: fn, commandIndex: command }
    let operand: Rational | null = null
    let tokens: SciToken[]
    if (this.input) {
      try {
        operand = Rational.fromDecimalString(this.input)
      } catch {
        this.errorKey = 'invalid_input'
        this.input = ''
        return
      }
      const group: SciToken[] = [fnToken, { kind: 'number', value: operand, text: this.expressionNumberText(operand), commandIndex: -1 }, { kind: 'rparen', commandIndex: command }]
      tokens = this.tokens.length > 0 ? [...this.tokens, ...group] : group
      this.input = ''
    } else if (this.tokens.length === 0) {
      operand = this.value
      tokens = [fnToken, { kind: 'number', value: operand, text: this.expressionNumberText(operand), commandIndex: -1 }, { kind: 'rparen', commandIndex: command }]
    } else {
      const last = this.tokens[this.tokens.length - 1]
      const start = last.kind === 'operator' ? this.tokens.length : this.lastOperandStart()
      const group = this.tokens.slice(start)
      operand = this.evaluateTokenGroup(group) ?? this.value
      tokens = [...this.tokens.slice(0, start), fnToken, ...group, { kind: 'rparen', commandIndex: command }]
    }
    try {
      const result = this.evaluateUnary(operand, fn)
      this.value = result
      this.tokens = tokens
      this.justEvaluated = true
    } catch (error) {
      this.failFromError(error)
    }
  }

  private lastOperandStart(): number {
    let depth = 0
    for (let index = this.tokens.length - 1; index >= 0; index--) {
      const token = this.tokens[index]
      if (token.kind === 'rparen') depth++
      else if (token.kind === 'lparen') {
        depth--
        if (depth === 0) return index
      } else if (token.kind === 'function' && depth === 1) return index
      else if (token.kind === 'operator' && depth === 0) return index + 1
    }
    return 0
  }

  private evaluateTokenGroup(group: SciToken[]): Rational | null {
    try {
      const parsed = this.parseTokens(group)
      return parsed ? this.evaluateAst(parsed) : null
    } catch {
      this.failFromError(new Error('Invalid input'))
      return null
    }
  }

  private applyStandardUnary(fn: string, command: number): void {
    let operand: Rational
    if (this.input) {
      try {
        operand = Rational.fromDecimalString(this.input)
      } catch {
        this.errorKey = 'invalid_input'
        this.input = ''
        return
      }
    } else {
      operand = this.value
    }
    try {
      const result = this.evaluateUnary(operand, fn)
      const group: SciToken[] = this.input
        ? [
            { kind: 'function', value: fn, commandIndex: command },
            { kind: 'number', value: operand, text: this.expressionNumberText(operand), commandIndex: -1 },
            { kind: 'rparen', commandIndex: command },
          ]
        : this.tokens.length > 0
          ? [
              { kind: 'function', value: fn, commandIndex: command },
              ...this.tokens,
              { kind: 'rparen', commandIndex: command },
            ]
          : [
              { kind: 'function', value: fn, commandIndex: command },
              { kind: 'number', value: operand, text: this.expressionNumberText(operand), commandIndex: -1 },
              { kind: 'rparen', commandIndex: command },
            ]
      const expression = this.expressionText(group, true)
      this.recordHistory(result, expression)
      this.tokens = group
      this.lastDisplayTokens = this.renderExpressionTokens(group, true)
      this.value = result
      this.accumulator = result
      this.hasAccumulator = true
      this.input = ''
      this.justEvaluated = true
    } catch (error) {
      this.failFromError(error)
    }
  }

  private recordStandardHistory(result: Rational): void {
    if (this.mode !== 'standard') return
    const expression = this.expressionText(this.tokens, true)
    if (!expression.trim()) return
    this.recordHistory(result, expression)
  }

  private unaryName(command: number): string | null {
    switch (command) {
      case CMD.sin:
        return 'sin'
      case CMD.cos:
        return 'cos'
      case CMD.tan:
        return 'tan'
      case CMD.sec:
        return 'sec'
      case CMD.csc:
        return 'csc'
      case CMD.cot:
        return 'cot'
      case CMD.asin:
        return 'asin'
      case CMD.acos:
        return 'acos'
      case CMD.atan:
        return 'atan'
      case CMD.asec:
        return 'asec'
      case CMD.acsc:
        return 'acsc'
      case CMD.acot:
        return 'acot'
      case CMD.sinh:
        return 'sinh'
      case CMD.cosh:
        return 'cosh'
      case CMD.tanh:
        return 'tanh'
      case CMD.sech:
        return 'sech'
      case CMD.csch:
        return 'csch'
      case CMD.coth:
        return 'coth'
      case CMD.asinh:
        return 'asinh'
      case CMD.acosh:
        return 'acosh'
      case CMD.atanh:
        return 'atanh'
      case CMD.asech:
        return 'asech'
      case CMD.acsch:
        return 'acsch'
      case CMD.acoth:
        return 'acoth'
      case CMD.ln:
        return 'ln'
      case CMD.log:
        return 'log'
      case CMD.sqrt:
        return 'sqrt'
      case CMD.square:
        return 'square'
      case CMD.cube:
        return 'cube'
      case CMD.cubeRoot:
        return 'cbrt'
      case CMD.reciprocal:
        return 'reciprocal'
      case CMD.factorial:
        return 'fact'
      case CMD.dms:
        return 'dms'
      case CMD.tenPower:
        return 'tenPower'
      case CMD.twoPower:
        return 'twoPower'
      case CMD.powE:
        return 'exp'
      case CMD.abs:
        return 'abs'
      case CMD.floor:
        return 'floor'
      case CMD.ceil:
        return 'ceil'
      default:
        return null
    }
  }

  private evaluateUnary(value: Rational, name: string): Rational {
    return this.guardResult(this.evaluateUnaryValue(value, name))
  }

  private guardResult(value: Rational): Rational {
    if (value.n.toString().length > 10000 || value.d.toString().length > 10000) throw new RangeError('Overflow')
    return value
  }

  private evaluateUnaryValue(value: Rational, name: string): Rational {
    switch (name) {
      case 'sin':
        return sinValue(value, this.angleMode)
      case 'cos':
        return cosValue(value, this.angleMode)
      case 'tan':
        return tanValue(value, this.angleMode)
      case 'sec':
        return secValue(value, this.angleMode)
      case 'csc':
        return cscValue(value, this.angleMode)
      case 'cot':
        return cotValue(value, this.angleMode)
      case 'asin':
        return asinValue(value, this.angleMode)
      case 'acos':
        return acosValue(value, this.angleMode)
      case 'atan':
        return atanValue(value, this.angleMode)
      case 'asec':
        return acosValue(value.inverse(), this.angleMode)
      case 'acsc':
        return asinValue(value.inverse(), this.angleMode)
      case 'acot':
        return atanValue(value.inverse(), this.angleMode)
      case 'sinh':
        return sinhValue(value)
      case 'cosh':
        return coshValue(value)
      case 'tanh':
        return tanhValue(value)
      case 'sech':
        return coshValue(value).inverse()
      case 'csch':
        return sinhValue(value).inverse()
      case 'coth':
        return tanhValue(value).inverse()
      case 'asinh':
        return asinhValue(value)
      case 'acosh':
        return acoshValue(value)
      case 'atanh':
        return atanhValue(value)
      case 'asech':
        return asinhValue(value.inverse())
      case 'acsch':
        return asinhValue(value.inverse())
      case 'acoth':
        return atanhValue(value.inverse())
      case 'ln':
        return lnValue(value)
      case 'log':
        return log10Value(value)
      case 'sqrt':
        return sqrtValue(value)
      case 'square':
        return value.multiply(value)
      case 'cube':
        return value.multiply(value).multiply(value)
      case 'cbrt':
        return cbrtValue(value)
      case 'reciprocal':
        return value.inverse()
      case 'fact':
        return factorialValue(value)
      case 'dms':
        return dmsValue(value)
      case 'tenPower':
        return powerValue(Rational.fromInt(10), value)
      case 'twoPower':
        return powerValue(Rational.fromInt(2), value)
      case 'exp':
        return expValue(value)
      case 'abs':
        return value.abs()
      case 'floor':
        return value.floor()
      case 'ceil':
        return value.ceil()
      default:
        throw new RangeError('Unknown function')
    }
  }

  private evaluateBinary(left: Rational, right: Rational, op: string): Rational | null {
    try {
      return this.guardResult(this.evaluateBinaryValue(left, right, op))
    } catch (error) {
      this.failFromError(error)
      return null
    }
  }

  private evaluateBinaryValue(left: Rational, right: Rational, op: string): Rational {
    switch (op) {
        case '+':
          return left.add(right)
        case '-':
          return left.subtract(right)
        case '×':
          return left.multiply(right)
        case '÷':
          if (right.isZero()) throw new RangeError(left.isZero() ? 'Result is undefined' : 'Cannot divide by zero')
          return left.divide(right)
        case 'Mod':
          return right.isZero() ? left : left.modulo(right)
        case '^':
          return powerValue(left, right)
        case 'yroot':
          return rootValue(left, right)
      case 'LogBaseY':
        return logBaseValue(right, left)
      default:
        throw new RangeError('Unknown operator')
    }
  }

  private failFromError(error: unknown): void {
    const message = error instanceof Error ? error.message : ''
    if (/undefined/i.test(message)) this.errorKey = 'undefined'
    else if (/divide|zero/i.test(message)) this.errorKey = 'divide_by_zero'
    else if (/overflow|too large/i.test(message)) this.errorKey = 'overflow'
    else this.errorKey = 'invalid_input'
  }

  private recordHistory(result: Rational, expressionOverride?: string): void {
    if (this.mode === 'programmer' || this.suppressHistory) return
    const expression = expressionOverride ?? this.standardExpression(result)
    if (!expression) return
    const entry: HistoryEntry = {
      id: `local_${Date.now()}_${this.history.length}`,
      mode: this.mode,
      expression,
      result: this.formatValue(result),
      tokens: this.expressionTokens(),
      commands: this.commandLog.filter((command) => isReplayableCommand(command)),
      radix: this.radix,
      createdAt: Date.now(),
    }
    this.history = [entry, ...this.history].slice(0, HISTORY_LIMIT)
  }

  private standardExpression(result: Rational): string {
    if (this.tokens.length === 0 && this.lastDisplayTokens.length > 0) {
      return `${this.lastDisplayTokens.map((token) => token.text).join(' ')} = ${this.formatValue(result)}`
    }
    return `${this.expressionTokens().map((token) => token.text).join(' ')} = ${this.formatValue(result)}`
  }

  private insertConstant(value: Rational): void {
    if (this.input) this.commitInputToken()
    this.tokens = []
    this.value = value
    this.justEvaluated = true
  }

  private randomValue(): Rational {
    this.randomSeed = (this.randomSeed + 1) % 1000000
    const value = Math.random()
    return Rational.fromDecimalString(value.toPrecision(16))
  }

  private parseTokens(tokens: SciToken[]): AstNode | null {
    let index = 0
    const peek = (): SciToken | undefined => tokens[index]
    const consume = (): SciToken | undefined => tokens[index++]
    const parseExpression = (): AstNode => parseAddSub()
    const parseAddSub = (): AstNode => {
      let node = parseMulDiv()
      while (true) {
        const token = peek()
        if (!token || token.kind !== 'operator' || (token.value !== '+' && token.value !== '-')) break
        consume()
        node = { kind: 'binary', op: token.value, left: node, right: parseMulDiv() }
      }
      return node
    }
    const parseMulDiv = (): AstNode => {
      let node = parsePower()
      while (true) {
        const token = peek()
        if (!token || token.kind !== 'operator' || !['×', '÷', 'Mod'].includes(token.value)) break
        consume()
        node = { kind: 'binary', op: token.value, left: node, right: parsePower() }
      }
      return node
    }
    const parsePower = (): AstNode => {
      let node = parseUnary()
      while (true) {
        const token = peek()
        if (!token || token.kind !== 'operator' || (token.value !== '^' && token.value !== 'yroot' && token.value !== 'LogBaseY')) return node
        consume()
        node = { kind: 'binary', op: token.value, left: node, right: parseUnary() }
      }
    }
    const parseUnary = (): AstNode => {
      const token = peek()
      if (token && token.kind === 'operator' && token.value === '-') {
        consume()
        return { kind: 'unary', op: '-', value: parseUnary() }
      }
      return parsePrimary()
    }
    const parsePrimary = (): AstNode => {
      const token = consume()
      if (!token) throw new Error('Invalid input')
      if (token.kind === 'number') {
        return { kind: 'number', value: token.value }
      }
      if (token.kind === 'lparen') {
        const node = parseExpression()
        const close = consume()
        if (!close || close.kind !== 'rparen') throw new Error('Invalid input')
        return node
      }
      if (token.kind === 'function') {
        const arg = parsePrimary()
        const close = consume()
        if (!close || close.kind !== 'rparen') throw new Error('Invalid input')
        return { kind: 'call', name: token.value, arg }
      }
      throw new Error('Invalid input')
    }
    try {
      const node = parseExpression()
      if (index !== tokens.length) throw new Error('Invalid input')
      return node
    } catch (error) {
      this.failFromError(error)
      return null
    }
  }

  private evaluateAst(node: AstNode): Rational {
    switch (node.kind) {
      case 'number':
        return node.value
      case 'unary':
        return this.evaluateAst(node.value).negate()
      case 'call':
        return this.evaluateUnary(this.evaluateAst(node.arg), node.name)
      case 'binary':
        return this.evaluateBinaryUnchecked(this.evaluateAst(node.left), this.evaluateAst(node.right), node.op)
    }
  }

  private evaluateBinaryUnchecked(left: Rational, right: Rational, op: string): Rational {
    return this.guardResult(this.evaluateBinaryUncheckedValue(left, right, op))
  }

  private evaluateBinaryUncheckedValue(left: Rational, right: Rational, op: string): Rational {
    switch (op) {
      case '+':
        return left.add(right)
      case '-':
        return left.subtract(right)
      case '×':
        return left.multiply(right)
      case '÷':
        if (right.isZero()) throw new RangeError(left.isZero() ? 'Result is undefined' : 'Cannot divide by zero')
        return left.divide(right)
      case 'Mod':
        return right.isZero() ? left : left.modulo(right)
      case '^':
        return powerValue(left, right)
      case 'yroot':
        return rootValue(left, right)
      case 'LogBaseY':
        return logBaseValue(right, left)
      default:
        throw new RangeError('Unknown operator')
    }
  }

  private applyProgrammerBinary(command: number): void {
    const op = opText(command)
    if (!op) return
    const operand = this.programmerValue()
    this.tokens.push({ kind: 'number', value: new Rational(operand), text: this.programmerTokenText(operand), commandIndex: -1 })
    if (this.pendingOperator) {
      const result = this.evaluateProgrammerBinary(this.accumulator.n / this.accumulator.d, operand, this.pendingOperator)
      this.accumulator = new Rational(result)
    } else {
      this.accumulator = new Rational(this.signedProgrammerValue(this.maskValue(operand)))
    }
    this.input = ''
    this.pendingOperator = op
    this.tokens.push({ kind: 'operator', value: op, commandIndex: command })
    this.updateBinaryDigits()
  }

  private programmerEquals(): void {
    this.displayEquals = false
    if (this.input) {
      const typed = this.programmerValue()
      this.tokens.push({ kind: 'number', value: new Rational(typed), text: this.programmerTokenText(typed), commandIndex: -1 })
    }
    const operand = this.programmerValue()
    if (this.pendingOperator) {
      const result = this.evaluateProgrammerBinary(this.accumulator.n / this.accumulator.d, operand, this.pendingOperator)
      this.accumulator = new Rational(result)
      this.pendingOperator = null
      this.input = ''
      this.updateBinaryDigits()
    } else {
      this.accumulator = new Rational(this.signedProgrammerValue(this.maskValue(operand)))
      this.input = ''
      this.updateBinaryDigits()
    }
    this.displayEquals = true
    this.lastDisplayTokens = this.renderExpressionTokens(this.tokens, true)
  }

  private programmerTokenText(value: bigint): string {
    const masked = this.maskValue(value)
    if (this.radix === 10) return this.signedProgrammerValue(masked).toString()
    return masked.toString(this.radix).toUpperCase()
  }

  private applyProgrammerNot(): void {
    const operand = this.programmerValue()
    const fnToken: SciToken = { kind: 'function', value: 'not', commandIndex: CMD.not }
    const group: SciToken[] = [
      fnToken,
      { kind: 'number', value: new Rational(operand), text: this.programmerTokenText(operand), commandIndex: -1 },
      { kind: 'rparen', commandIndex: CMD.not },
    ]
    this.tokens = this.tokens.length > 0 && !this.input ? [...this.tokens, ...group] : group
    this.accumulator = new Rational(this.signedProgrammerValue(~this.maskValue(operand)))
    this.input = ''
    this.updateBinaryDigits()
  }

  private evaluateProgrammerBinary(left: bigint, right: bigint, op: string): bigint {
    const bits = BigInt(this.wordSize)
    const mask = (1n << bits) - 1n
    const shift = (value: bigint): number => Number(this.maskValue(value) % bits)
    let result: bigint
    switch (op) {
      case '+':
        result = left + right
        break
      case '-':
        result = left - right
        break
      case '×':
        result = left * right
        break
      case '÷':
        if (right === 0n) throw new RangeError('Division by zero')
        result = left / right
        break
      case 'Mod':
        result = right === 0n ? left : left % right
        break
      case 'AND':
        result = left & right
        break
      case 'OR':
        result = left | right
        break
      case 'XOR':
        result = left ^ right
        break
      case 'NAND':
        result = ~(left & right)
        break
      case 'NOR':
        result = ~(left | right)
        break
      case 'Lsh':
        result = left << BigInt(shift(right))
        break
      case 'Rsh':
        result = left >> BigInt(shift(right))
        break
      case 'RoL':
      case 'RoR':
      case 'RoLC':
      case 'RoRC': {
        const amount = shift(right) % this.wordSize
        if (amount === 0) return this.maskValue(left)
        if (op === 'RoL') result = (left << BigInt(amount)) | (left >> BigInt(this.wordSize - amount))
        else if (op === 'RoR') result = (left >> BigInt(amount)) | (left << BigInt(this.wordSize - amount))
        else result = left
        break
      }
      default:
        result = left
    }
    const masked = result & mask
    return this.signedProgrammerValue(masked)
  }

  private rotateProgrammer(direction: 1 | -1, carry: boolean): void {
    const operand = this.programmerValue()
    const value = this.maskValue(operand)
    const bits = BigInt(this.wordSize)
    const mask = (1n << bits) - 1n
    const signBit = bits - 1n
    let rotated: bigint
    if (direction === 1) {
      const msb = (value >> signBit) & 1n
      rotated = (value << 1n) & mask
      rotated |= carry ? BigInt(this.carryBit) : msb
      if (carry) this.carryBit = Number(msb)
    } else {
      const lsb = value & 1n
      rotated = value >> 1n
      rotated |= carry ? BigInt(this.carryBit) << signBit : lsb << signBit
      if (carry) this.carryBit = Number(lsb)
    }
    const fnToken: SciToken = { kind: 'function', value: direction === 1 ? (carry ? 'rolc' : 'rol') : (carry ? 'rorc' : 'ror'), commandIndex: direction === 1 ? CMD.rotateLeft : CMD.rotateRight }
    const numberToken: SciToken = { kind: 'number', value: new Rational(operand), text: this.programmerTokenText(operand), commandIndex: -1 }
    const group: SciToken[] = this.input || this.tokens.length === 0
      ? [fnToken, numberToken, { kind: 'rparen', commandIndex: fnToken.commandIndex }]
      : [fnToken, ...this.tokens, { kind: 'rparen', commandIndex: fnToken.commandIndex }]
    this.tokens = group
    this.accumulator = new Rational(this.signedProgrammerValue(rotated))
    this.input = ''
    this.justEvaluated = true
    this.displayEquals = true
    this.lastDisplayTokens = this.renderExpressionTokens(this.tokens, true)
    this.updateBinaryDigits()
  }

  private setRadix(radix: Radix): void {
    if (this.radix === radix) return
    const value = this.maskValue(this.programmerValue())
    this.radix = radix
    this.input = ''
    this.accumulator = new Rational(this.signedProgrammerValue(value))
    this.updateBinaryDigits()
  }

  private setWordSize(wordSize: WordSize): void {
    const value = this.maskValue(this.programmerValue())
    this.wordSize = wordSize
    this.accumulator = new Rational(this.signedProgrammerValue(this.maskValue(value)))
    this.input = ''
    this.updateBinaryDigits()
  }

  private toggleBit(bit: number): void {
    if (bit < 0 || bit >= this.wordSize) return
    const value = this.maskValue(this.programmerValue()) ^ (1n << BigInt(bit))
    this.accumulator = new Rational(this.signedProgrammerValue(value))
    this.input = ''
    this.tokens = []
    this.lastDisplayTokens = []
    this.updateBinaryDigits()
  }

  getHistory(): HistoryEntry[] {
    return this.history.slice()
  }

  clearHistory(mode?: CalculatorMode): void {
    if (!mode) {
      this.history = []
      return
    }
    this.history = this.history.filter((entry) => entry.mode !== mode)
  }

  recallHistory(index: number): void {
    const entry = this.history[index]
    if (!entry) return
    if (entry.commands.length === 0) {
      this.resetAll()
      this.setMode(entry.mode)
      try {
        this.value = Rational.fromDecimalString(entry.result.replace(/,/g, ''))
        this.input = ''
        this.justEvaluated = true
      } catch {
        this.errorKey = 'invalid_input'
      }
      return
    }
    this.suppressHistory = true
    try {
      this.resetAll()
      this.setMode(entry.mode)
      for (const command of entry.commands) this.send(command)
    } finally {
      this.suppressHistory = false
    }
    if (this.errorKey) this.errorKey = null
  }

  removeHistoryEntry(id: string): void {
    this.history = this.history.filter((entry) => entry.id !== id)
  }

  rememberMemory(): void {
    const value = this.currentMemoryValue()
    if (!value) return
    const entry: MemoryEntry = {
      id: `mem_${Date.now()}_${this.memory.length}`,
      value: value.toRationalValue(),
      sort: 0,
      createdAt: Date.now(),
    }
    this.memory = [entry, ...this.memory].slice(0, MEMORY_LIMIT)
  }

  recallMemory(index = 0): void {
    const entry = this.memory[index]
    if (!entry) return
    this.value = Rational.fromRationalValue(entry.value)
    this.input = ''
    this.justEvaluated = true
  }

  addMemory(index = 0): void {
    const entry = this.memory[index]
    if (!entry) return
    const value = Rational.fromRationalValue(entry.value).add(this.currentMemoryValue() ?? Rational.zero())
    this.memory[index] = { ...entry, value: value.toRationalValue() }
  }

  subtractMemory(index = 0): void {
    const entry = this.memory[index]
    if (!entry) return
    const value = Rational.fromRationalValue(entry.value).subtract(this.currentMemoryValue() ?? Rational.zero())
    this.memory[index] = { ...entry, value: value.toRationalValue() }
  }

  clearMemory(index?: number): void {
    if (index === undefined) this.memory = []
    else this.memory.splice(index, 1)
  }

  private currentMemoryValue(): Rational | null {
    if (this.input) {
      try {
        return Rational.fromDecimalString(this.input)
      } catch {
        return null
      }
    }
    return this.value
  }

  setAngleMode(mode: AngleMode): void {
    this.angleMode = mode
  }

  snapshot(): EngineSnapshot {
    return {
      version: 1,
      mode: this.mode,
      history: this.history.slice(),
      memory: this.memory.slice(),
      displayCommands: this.commandLog.filter((command) => isReplayableCommand(command)),
      radix: this.radix,
      wordSize: this.wordSize,
      angleMode: this.angleMode,
    }
  }

  restore(snapshot: EngineSnapshot): void {
    this.history = snapshot.history.slice()
    this.memory = snapshot.memory.slice()
    this.angleMode = snapshot.angleMode
    this.radix = snapshot.radix
    this.wordSize = snapshot.wordSize
    this.resetAll()
    this.suppressHistory = true
    try {
      this.setMode(snapshot.mode)
      for (const command of snapshot.displayCommands) {
        if (!isReplayableCommand(command)) continue
        this.send(command)
      }
    } finally {
      this.suppressHistory = false
    }
  }
}
