import type { MemoFilterError } from './ast'

export type MemoFilterTokenKind = 'identifier' | 'string' | 'number' | 'symbol' | 'eof'

export interface MemoFilterToken {
  kind: MemoFilterTokenKind
  text: string
  value: string | number | null
  position: number
}

export type MemoFilterTokenizeResult =
  | { ok: true; tokens: MemoFilterToken[] }
  | { ok: false; error: MemoFilterError }

const SYMBOLS = ['&&', '||', '==', '!=', '<=', '>=', '!', '<', '>', '(', ')', '[', ']', ',', '.', '+', '-']

const isDigit = (char: string) => char >= '0' && char <= '9'
const isIdentifierStart = (char: string) => /[A-Za-z_]/.test(char)
const isIdentifierPart = (char: string) => /[A-Za-z0-9_]/.test(char)

export function tokenizeMemoFilter(source: string): MemoFilterTokenizeResult {
  const tokens: MemoFilterToken[] = []
  let index = 0

  while (index < source.length) {
    const char = source[index]!

    if (/\s/.test(char)) {
      index++
      continue
    }

    if (char === '"' || char === "'") {
      const literal = readString(source, index)
      if (!literal.ok) return literal
      tokens.push({ kind: 'string', text: source.slice(index, literal.next), value: literal.value, position: index })
      index = literal.next
      continue
    }

    if (isDigit(char)) {
      const number = readNumber(source, index)
      if (!number.ok) return number
      tokens.push({ kind: 'number', text: source.slice(index, number.next), value: number.value, position: index })
      index = number.next
      continue
    }

    if (isIdentifierStart(char)) {
      let next = index + 1
      while (next < source.length && isIdentifierPart(source[next]!)) next++
      tokens.push({ kind: 'identifier', text: source.slice(index, next), value: null, position: index })
      index = next
      continue
    }

    const symbol = SYMBOLS.find((candidate) => source.startsWith(candidate, index))
    if (symbol) {
      tokens.push({ kind: 'symbol', text: symbol, value: null, position: index })
      index += symbol.length
      continue
    }

    return { ok: false, error: { message: `unexpected character "${char}"`, position: index } }
  }

  tokens.push({ kind: 'eof', text: '', value: null, position: source.length })
  return { ok: true, tokens }
}

function readString(
  source: string,
  start: number,
): { ok: true; value: string; next: number } | { ok: false; error: MemoFilterError } {
  const quote = source[start]!
  let value = ''
  let index = start + 1

  while (index < source.length) {
    const char = source[index]!
    if (char === quote) return { ok: true, value, next: index + 1 }
    if (char === '\n' || char === '\r') {
      return { ok: false, error: { message: 'unterminated string literal', position: start } }
    }
    if (char !== '\\') {
      value += char
      index++
      continue
    }

    const escaped = source[index + 1]
    if (escaped === undefined) {
      return { ok: false, error: { message: 'unterminated string literal', position: start } }
    }
    index += 2
    const simple = ESCAPES[escaped]
    if (simple !== undefined) {
      value += simple
      continue
    }
    if (escaped === 'u') {
      const hex = source.slice(index, index + 4)
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
        return { ok: false, error: { message: 'invalid unicode escape', position: index - 2 } }
      }
      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += 4
      continue
    }
    return { ok: false, error: { message: `invalid escape sequence "\\${escaped}"`, position: index - 2 } }
  }

  return { ok: false, error: { message: 'unterminated string literal', position: start } }
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  "'": "'",
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

function readNumber(
  source: string,
  start: number,
): { ok: true; value: number; next: number } | { ok: false; error: MemoFilterError } {
  let index = start
  while (index < source.length && isDigit(source[index]!)) index++
  if (source[index] === '.') {
    index++
    if (!isDigit(source[index] ?? '')) {
      return { ok: false, error: { message: 'malformed number literal', position: start } }
    }
    while (index < source.length && isDigit(source[index]!)) index++
  }
  const value = Number(source.slice(start, index))
  if (!Number.isFinite(value)) {
    return { ok: false, error: { message: 'number literal is out of range', position: start } }
  }
  return { ok: true, value, next: index }
}
