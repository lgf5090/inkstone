/**
 * The formula property: a small arithmetic language over the card's other properties.
 *
 * Deliberately not JavaScript. A board is shared, and an expression typed by one member runs in
 * everyone's browser and in the server's exports, so the grammar is a fixed set of operators and
 * functions with no property access, no assignment and no host objects. A reference is written
 * `{Property name}`, which is what the column header shows, and an unknown name is zero rather than an
 * error so a renamed property degrades instead of blanking the column.
 */

type Token =
  | { kind: 'number', value: number }
  | { kind: 'string', value: string }
  | { kind: 'ref', value: string }
  | { kind: 'ident', value: string }
  | { kind: 'op', value: string }

type Value = number | string | boolean | null

const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '(', ')', ',', '<', '>', '!'] as const

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < source.length) {
    const char = source[at]!
    if (/\s/.test(char)) { at += 1; continue }
    if (char === '{') {
      const end = source.indexOf('}', at + 1)
      if (end < 0) throw new Error('unclosed reference')
      tokens.push({ kind: 'ref', value: source.slice(at + 1, end).trim() })
      at = end + 1
      continue
    }
    if (char === '"' || char === "'") {
      let text = ''
      at += 1
      while (at < source.length && source[at] !== char) { text += source[at]; at += 1 }
      if (source[at] !== char) throw new Error('unclosed string')
      tokens.push({ kind: 'string', value: text })
      at += 1
      continue
    }
    const number = /^\d+(?:\.\d+)?/.exec(source.slice(at))
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]) })
      at += number[0].length
      continue
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at))
    if (ident) {
      tokens.push({ kind: 'ident', value: ident[0] })
      at += ident[0].length
      continue
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, at))
    if (!operator) throw new Error(`unexpected character ${char}`)
    tokens.push({ kind: 'op', value: operator })
    at += operator.length
  }
  return tokens
}

function asNumber(value: Value): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === null) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function asText(value: Value): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function asBoolean(value: Value): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (value === null) return false
  return value !== ''
}

export function evaluateProjectFormula(expression: string, values: ReadonlyMap<string, string>): string {
  const trimmed = expression.trim()
  if (!trimmed) return ''
  let tokens: Token[]
  try { tokens = tokenize(trimmed) } catch { return '' }
  let cursor = 0

  const peek = (): Token | undefined => tokens[cursor]
  const eat = (kind: Token['kind'], value?: string): boolean => {
    const token = peek()
    if (!token || token.kind !== kind || (value !== undefined && token.value !== value)) return false
    cursor += 1
    return true
  }
  const expect = (kind: Token['kind'], value: string): void => {
    if (!eat(kind, value)) throw new Error(`expected ${value}`)
  }

  const primary = (): Value => {
    if (eat('op', '(')) {
      const value = or()
      expect('op', ')')
      return value
    }
    if (eat('op', '-')) return -asNumber(primary())
    if (eat('op', '!')) return !asBoolean(primary())
    const token = peek()
    if (!token) throw new Error('unexpected end')
    if (token.kind === 'number') { cursor += 1; return token.value }
    if (token.kind === 'string') { cursor += 1; return token.value }
    if (token.kind === 'ref') {
      cursor += 1
      const raw = values.get(token.value.toLowerCase()) ?? ''
      const numeric = raw.trim() === '' ? Number.NaN : Number(raw)
      return Number.isFinite(numeric) ? numeric : raw
    }
    if (token.kind === 'ident') {
      cursor += 1
      if (!eat('op', '(')) {
        const upper = token.value.toUpperCase()
        if (upper === 'TRUE') return true
        if (upper === 'FALSE') return false
        throw new Error(`unknown name ${token.value}`)
      }
      const args: Value[] = []
      if (!eat('op', ')')) {
        do { args.push(or()) } while (eat('op', ','))
        expect('op', ')')
      }
      return call(token.value.toUpperCase(), args)
    }
    throw new Error('unexpected token')
  }

  const mul = (): Value => {
    let left = primary()
    for (;;) {
      if (eat('op', '*')) left = asNumber(left) * asNumber(primary())
      else if (eat('op', '/')) {
        const right = asNumber(primary())
        left = right === 0 ? null : asNumber(left) / right
      } else if (eat('op', '%')) {
        const right = asNumber(primary())
        left = right === 0 ? null : asNumber(left) % right
      } else return left
    }
  }

  const add = (): Value => {
    let left = mul()
    for (;;) {
      if (eat('op', '+')) {
        const right = mul()
        left = asNumber(left) + asNumber(right)
      } else if (eat('op', '-')) left = asNumber(left) - asNumber(mul())
      else return left
    }
  }

  const compare = (): Value => {
    const left = add()
    for (const operator of ['<=', '>=', '==', '!=', '<', '>'] as const) {
      if (!eat('op', operator)) continue
      const right = add()
      const bothNumbers = typeof left !== 'string' && typeof right !== 'string'
      const a = bothNumbers ? asNumber(left) : asText(left)
      const b = bothNumbers ? asNumber(right) : asText(right)
      if (operator === '<=') return a <= b
      if (operator === '>=') return a >= b
      if (operator === '==') return a === b
      if (operator === '!=') return a !== b
      if (operator === '<') return a < b
      return a > b
    }
    return left
  }

  const and = (): Value => {
    let left = compare()
    while (eat('op', '&&')) left = asBoolean(left) && asBoolean(compare())
    return left
  }

  const or = (): Value => {
    let left = and()
    while (eat('op', '||')) left = asBoolean(left) || asBoolean(and())
    return left
  }

  function call(name: string, args: Value[]): Value {
    const numbers = (): number[] => args.map(asNumber)
    switch (name) {
      case 'SUM': return numbers().reduce((sum, value) => sum + value, 0)
      case 'AVG': {
        const list = numbers()
        return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0
      }
      case 'MIN': return numbers().length ? Math.min(...numbers()) : 0
      case 'MAX': return numbers().length ? Math.max(...numbers()) : 0
      case 'ABS': return Math.abs(asNumber(args[0] ?? 0))
      case 'ROUND': {
        const digits = Math.max(0, Math.min(6, Math.round(asNumber(args[1] ?? 0))))
        const factor = 10 ** digits
        return Math.round(asNumber(args[0] ?? 0) * factor) / factor
      }
      case 'IF': return asBoolean(args[0] ?? false) ? (args[1] ?? '') : (args[2] ?? '')
      case 'TODAY': {
        const day = new Date()
        day.setHours(0, 0, 0, 0)
        return day.getTime()
      }
      case 'DAYS': return Math.round((asNumber(args[1] ?? 0) - asNumber(args[0] ?? 0)) / 86_400_000)
      case 'LEN': return asText(args[0] ?? '').length
      case 'CONCAT': return args.map(asText).join('')
      default: throw new Error(`unknown function ${name}`)
    }
  }

  try {
    const value = or()
    if (cursor !== tokens.length) return ''
    if (value === null) return ''
    if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : ''
    if (typeof value === 'boolean') return value ? '✓' : ''
    return value
  } catch {
    return ''
  }
}
