import { CMD, EXPRESSION_MAX_LENGTH } from '../contract'
import type { CalculatorMode, Radix } from '../contract'

export type PasteErrorKey = 'invalid_input' | 'too_long'

export interface PasteResult {
  ok: boolean
  commands: number[]
  errorKey?: PasteErrorKey
}

interface PasteToken {
  kind: 'number' | 'operator' | 'lparen' | 'rparen'
  value: string
}

function normalize(text: string): string {
  return text
    .trim()
    .replace(/[×✕]/g, '*')
    .replace(/[÷]/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/[\uFF08]/g, '(')
    .replace(/[\uFF09]/g, ')')
    .replace(/[\uFF05]/g, '%')
    .replace(/[\uFF0C]/g, ',')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\s+/g, '')
}

function tokenize(text: string, mode: CalculatorMode, radix: Radix): PasteToken[] | null {
  const tokens: PasteToken[] = []
  let index = 0
  let expectOperand = true
  const digitPattern = radix === 16 ? /[0-9a-fA-F]/ : radix === 10 ? /[0-9]/ : radix === 8 ? /[0-7]/ : /[01]/
  while (index < text.length) {
    const char = text[index]
    if (char === '(') {
      tokens.push({ kind: 'lparen', value: char })
      index += 1
      expectOperand = true
      continue
    }
    if (char === ')') {
      tokens.push({ kind: 'rparen', value: char })
      index += 1
      expectOperand = false
      continue
    }
    if ('+-*/%^'.includes(char)) {
      if (char === '^' && mode === 'standard') return null
      if (char === '-' && expectOperand) {
        const start = index
        index += 1
        if (index >= text.length) return null
        const numberStart = index
        while (index < text.length && (digitPattern.test(text[index]) || (mode !== 'programmer' && (text[index] === '.' || text[index].toLowerCase() === 'e')))) {
          index += 1
        }
        if (index === numberStart) return null
        tokens.push({ kind: 'number', value: text.slice(start, index) })
        expectOperand = false
        continue
      }
      if (expectOperand) {
        if (char === '+') {
          index += 1
          continue
        }
        return null
      }
      tokens.push({ kind: 'operator', value: char })
      index += 1
      expectOperand = true
      continue
    }
    if (digitPattern.test(char) || (mode !== 'programmer' && char === '.')) {
      const start = index
      while (index < text.length) {
        const current = text[index]
        if (digitPattern.test(current) || (mode !== 'programmer' && (current === '.' || current.toLowerCase() === 'e'))) {
          index += 1
          continue
        }
        if (mode !== 'programmer' && (current === '+' || current === '-') && index > start && (text[index - 1] === 'e' || text[index - 1] === 'E')) {
          index += 1
          continue
        }
        break
      }
      const value = text.slice(start, index)
      if (mode !== 'programmer' && !/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return null
      tokens.push({ kind: 'number', value })
      expectOperand = false
      continue
    }
    return null
  }
  if (expectOperand && tokens.length > 0) return null
  return tokens
}

export function parsePasteCommands(text: string, mode: CalculatorMode, radix: Radix = 10): PasteResult {
  if (text.length > EXPRESSION_MAX_LENGTH) return { ok: false, commands: [], errorKey: 'too_long' }
  const normalized = normalize(text)
  if (!normalized) return { ok: false, commands: [], errorKey: 'invalid_input' }
  if (mode === 'programmer' && radix !== 10) {
    // Programmer pastes are parsed as an integer in the current radix.
    if (!/^-?[0-9a-fA-F]+$/.test(normalized)) return { ok: false, commands: [], errorKey: 'invalid_input' }
    const negative = normalized.startsWith('-')
    const digits = negative ? normalized.slice(1) : normalized
    const commands: number[] = []
    for (const char of digits) {
      const upper = char.toUpperCase()
      if (upper >= '0' && upper <= '9') commands.push(CMD.digit0 + Number(upper))
      else commands.push(CMD.a + (upper.charCodeAt(0) - 65))
    }
    if (negative) commands.push(CMD.sign)
    return { ok: true, commands }
  }
  const tokens = tokenize(normalized, mode, radix)
  if (!tokens) return { ok: false, commands: [], errorKey: 'invalid_input' }
  let depth = 0
  const commands: number[] = []
  for (const token of tokens) {
    if (token.kind === 'lparen') {
      depth += 1
      commands.push(CMD.openParen)
      continue
    }
    if (token.kind === 'rparen') {
      depth -= 1
      if (depth < 0) return { ok: false, commands: [], errorKey: 'invalid_input' }
      commands.push(CMD.closeParen)
      continue
    }
    if (token.kind === 'operator') {
      switch (token.value) {
        case '+':
          commands.push(CMD.add)
          break
        case '-':
          commands.push(CMD.subtract)
          break
        case '*':
          commands.push(CMD.multiply)
          break
        case '/':
          commands.push(CMD.divide)
          break
        case '%':
          commands.push(mode === 'programmer' ? CMD.mod : CMD.percent)
          break
        case '^':
          commands.push(mode === 'scientific' ? CMD.power : CMD.xor)
          break
      }
      continue
    }
    const negative = token.value.startsWith('-')
    const value = negative ? token.value.slice(1) : token.value
    for (const char of value) {
      if (char === '.') commands.push(CMD.decimal)
      else if (char === 'e' || char === 'E') commands.push(CMD.exp)
      else if (char >= '0' && char <= '9') commands.push(CMD.digit0 + Number(char))
      else {
        const upper = char.toUpperCase()
        if (upper >= 'A' && upper <= 'F') commands.push(CMD.a + (upper.charCodeAt(0) - 65))
      }
    }
    if (negative) commands.push(CMD.sign)
  }
  if (depth !== 0) return { ok: false, commands: [], errorKey: 'invalid_input' }
  return { ok: true, commands }
}

export function validatePasteExpression(text: string, mode: CalculatorMode, radix: Radix = 10): string | null {
  const result = parsePasteCommands(text, mode, radix)
  return result.ok ? null : result.errorKey ?? 'invalid_input'
}
