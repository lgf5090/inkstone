/**
 * The arithmetic behind `{{MVALUE}}`.
 *
 * The reference plugin evaluates that token with mathjs. Inkstone has no such dependency and the
 * expression arrives as user text that a shared notebook may hand to a stranger's browser, so this
 * is a total re-implementation of the arithmetic half of the language: numbers, `+ - * / % ^`,
 * parentheses, unary minus, a fixed function table and two constants. Anything else — assignment,
 * a unit conversion, an identifier that is not a function — is a parse error naming what it found,
 * never a value. There is no `eval`, no `Function`, and no way to reach a property.
 */

export interface MathResult {
  value: number | null
  /** A short, locale-free reason. The UI wraps it in its own message. */
  error: string | null
}

const FUNCTIONS: Readonly<Record<string, (...args: number[]) => number>> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  trunc: Math.trunc,
  sqrt: (value) => Math.sqrt(value),
  cbrt: Math.cbrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  pow: Math.pow,
  min: (...args) => Math.min(...args),
  max: (...args) => Math.max(...args),
  hypot: Math.hypot,
}

const CONSTANTS: Readonly<Record<string, number>> = {
  pi: Math.PI,
  e: Math.E,
}

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  '%': 2,
  '^': 3,
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'operator'; value: string }

const MAX_EXPRESSION_LENGTH = 400
const MAX_TOKENS = 200

function tokenize(input: string): { tokens: Token[]; error: string | null } {
  const tokens: Token[] = []
  let index = 0
  while (index < input.length) {
    const char = input[index]!
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char >= '0' && char <= '9' || (char === '.' && /\d/.test(input[index + 1] ?? ''))) {
      const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(input.slice(index))
      if (!match) return { tokens, error: `bad number at ${index}` }
      const value = Number(match[0])
      if (!Number.isFinite(value)) return { tokens, error: `bad number "${match[0]}"` }
      tokens.push({ kind: 'number', value })
      if (tokens.length > MAX_TOKENS) return { tokens, error: 'expression is too long' }
      index += match[0].length
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(index))!
      tokens.push({ kind: 'name', value: match[0].toLowerCase() })
      if (tokens.length > MAX_TOKENS) return { tokens, error: 'expression is too long' }
      index += match[0].length
      continue
    }
    if ('+-*/%^(),'.includes(char)) {
      tokens.push({ kind: 'operator', value: char })
      index += 1
      if (tokens.length > MAX_TOKENS) return { tokens, error: 'expression is too long' }
      continue
    }
    return { tokens, error: `unexpected "${char}"` }
  }
  return { tokens, error: null }
}

/**
 * Precedence climbing over the token list. `pos` is threaded through by hand so a syntax error can
 * say where it stopped, and every failure path returns a value of `null` rather than throwing.
 */
class Parser {
  private index = 0

  constructor(private readonly tokens: readonly Token[]) {}

  error: string | null = null

  parse(): number | null {
    const value = this.binary(0)
    if (this.error !== null) return null
    if (this.index < this.tokens.length) {
      this.error = `unexpected "${this.describe(this.tokens[this.index]!)}"`
      return null
    }
    return value
  }

  private binary(precedence: number): number | null {
    let left = this.unary()
    if (this.error !== null) return null
    while (true) {
      const token = this.peek()
      if (!token || token.kind !== 'operator') return left
      const operator = BINARY_PRECEDENCE[token.value]
      if (operator === undefined || operator <= precedence) return left
      this.index += 1
      // `^` is the one right-associative operator, so it recurses one level looser: 2^3^2 is 512.
      const right = this.binary(token.value === '^' ? operator - 1 : operator)
      if (this.error !== null) return null
      const combined = apply(token.value, left ?? 0, right ?? 0)
      if (combined === null) {
        this.error = `${left} ${token.value} ${right} has no answer`
        return null
      }
      left = combined
    }
  }

  private unary(): number | null {
    const token = this.peek()
    if (token && token.kind === 'operator' && (token.value === '-' || token.value === '+')) {
      this.index += 1
      const inner = this.unary()
      if (this.error !== null) return null
      return token.value === '-' ? -(inner ?? 0) : inner
    }
    return this.primary()
  }

  private primary(): number | null {
    const token = this.peek()
    if (!token) {
      this.error = 'the expression ends early'
      return null
    }
    if (token.kind === 'number') {
      this.index += 1
      return token.value
    }
    if (token.kind === 'operator' && token.value === '(') {
      this.index += 1
      const inner = this.binary(0)
      if (this.error !== null) return null
      const close = this.peek()
      if (!close || close.value !== ')') {
        this.error = 'a parenthesis was never closed'
        return null
      }
      this.index += 1
      return inner
    }
    if (token.kind === 'name') {
      this.index += 1
      if (!(token.value in FUNCTIONS) && !(token.value in CONSTANTS)) {
        this.error = `"${token.value}" is not a number, function or constant`
        return null
      }
      if (token.value in CONSTANTS) return CONSTANTS[token.value]!
      const open = this.peek()
      if (!open || open.value !== '(') {
        this.error = `${token.value} needs ( )`
        return null
      }
      this.index += 1
      const args: number[] = []
      if (this.peek()?.value !== ')') {
        while (true) {
          const argument = this.binary(0)
          if (this.error !== null) return null
          args.push(argument ?? 0)
          const separator = this.peek()
          if (separator?.value === ',') {
            this.index += 1
            continue
          }
          break
        }
      }
      const close = this.peek()
      if (!close || close.value !== ')') {
        this.error = 'a call was never closed'
        return null
      }
      this.index += 1
      if (args.length === 0) {
        this.error = `${token.value} got no arguments`
        return null
      }
      return FUNCTIONS[token.value]!(...args)
    }
    this.error = `unexpected "${this.describe(token)}"`
    return null
  }

  private peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private describe(token: Token): string {
    return token.kind === 'number' ? String(token.value) : token.value
  }
}

function apply(symbol: string, left: number, right: number): number | null {
  switch (symbol) {
    case '+': return left + right
    case '-': return left - right
    case '*': return left * right
    case '/': return right === 0 ? null : left / right
    case '%': return right === 0 ? null : left % right
    case '^': return left ** right
    default: return null
  }
}

/** Evaluate one arithmetic expression, with `round` applied the way a note author expects. */
export function evaluateMathExpression(input: string): MathResult {
  const text = (input ?? '').trim()
  if (!text) return { value: null, error: 'nothing to calculate' }
  if (text.length > MAX_EXPRESSION_LENGTH) return { value: null, error: 'expression is too long' }
  const { tokens, error } = tokenize(text)
  if (error) return { value: null, error }
  const parser = new Parser(tokens)
  const value = parser.parse()
  if (parser.error) return { value: null, error: parser.error }
  if (value === null || !Number.isFinite(value))
    return { value: null, error: 'the answer is not a finite number' }
  return { value, error: null }
}

/** Render a computed answer the way the token writes it into a note: no float noise, no trailing zeros. */
export function formatMathValue(value: number): string {
  if (Number.isInteger(value)) return String(value)
  const rounded = Math.round((value + Number.EPSILON) * 1e10) / 1e10
  return String(rounded)
}
