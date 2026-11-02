export type TrigMode = 'rad' | 'deg' | 'grad'

export type GraphNode =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; op: string; value: GraphNode }
  | { kind: 'binary'; op: string; left: GraphNode; right: GraphNode }
  | { kind: 'call'; name: string; args: GraphNode[] }
  | { kind: 'relation'; op: string; left: GraphNode; right: GraphNode }

export interface ParsedExpression {
  ok: true
  node: GraphNode
  relation: { op: string; left: GraphNode; right: GraphNode } | null
  variables: Set<string>
}

export interface ParseError {
  ok: false
  message: string
  position: number
}

type TokenKind = 'number' | 'ident' | 'operator' | 'lparen' | 'rparen' | 'comma'

interface Token {
  kind: TokenKind
  value: string
  position: number
}

const RELATIONS = new Set(['=', '<', '<=', '>', '>='])

const KNOWN_FUNCTIONS = new Set([
  'sin',
  'cos',
  'tan',
  'sec',
  'csc',
  'cot',
  'asin',
  'acos',
  'atan',
  'asec',
  'acsc',
  'acot',
  'sinh',
  'cosh',
  'tanh',
  'sech',
  'csch',
  'coth',
  'asinh',
  'acosh',
  'atanh',
  'asech',
  'acsch',
  'acoth',
  'sqrt',
  'cbrt',
  'abs',
  'floor',
  'ceil',
  'ln',
  'log',
  'log10',
  'exp',
  'fact',
  'mod',
  'root',
  'pow',
  'min',
  'max',
])

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
}

function tokenize(text: string): Token[] | ParseError {
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (/[0-9.]/.test(char)) {
      const start = index
      let dots = 0
      while (index < text.length && /[0-9.]/.test(text[index])) {
        if (text[index] === '.') dots += 1
        index += 1
      }
      if (dots > 1) return { ok: false, message: 'Too many decimal points', position: start }
      if (index < text.length && (text[index] === 'e' || text[index] === 'E')) {
        index += 1
        if (index < text.length && (text[index] === '+' || text[index] === '-')) index += 1
        while (index < text.length && /[0-9]/.test(text[index])) index += 1
      }
      const value = text.slice(start, index)
      if (!Number.isFinite(Number(value))) return { ok: false, message: 'Invalid number', position: start }
      tokens.push({ kind: 'number', value, position: start })
      continue
    }
    if (/[a-zA-Z_]/.test(char)) {
      const start = index
      while (index < text.length && /[a-zA-Z0-9_]/.test(text[index])) index += 1
      tokens.push({ kind: 'ident', value: text.slice(start, index), position: start })
      continue
    }
    if (char === '(') {
      tokens.push({ kind: 'lparen', value: char, position: index })
      index += 1
      continue
    }
    if (char === ')') {
      tokens.push({ kind: 'rparen', value: char, position: index })
      index += 1
      continue
    }
    if (char === ',') {
      tokens.push({ kind: 'comma', value: char, position: index })
      index += 1
      continue
    }
    if (char === '=' || char === '<' || char === '>' || char === '+' || char === '-' || char === '*' || char === '/' || char === '^' || char === '%' || char === '!') {
      const next = text[index + 1]
      if ((char === '<' || char === '>' || char === '=') && next === '=') {
        tokens.push({ kind: 'operator', value: `${char}=`, position: index })
        index += 2
        continue
      }
      if (char === '=') {
        tokens.push({ kind: 'operator', value: '=', position: index })
        index += 1
        continue
      }
      if (char === '!' && next !== '=') {
        tokens.push({ kind: 'operator', value: '!', position: index })
        index += 1
        continue
      }
      tokens.push({ kind: 'operator', value: char, position: index })
      index += 1
      continue
    }
    return { ok: false, message: `Invalid character "${char}"`, position: index }
  }
  return tokens
}

class Parser {
  private index = 0
  private readonly variables = new Set<string>()

  constructor(private readonly tokens: Token[]) {}

  parse(): GraphNode {
    if (this.tokens.length === 0) throw new ParseFailure('Empty expression', 0)
    const node = this.parseRelation()
    if (this.index < this.tokens.length) throw new ParseFailure(`Unexpected "${this.peek()?.value ?? ''}"`, this.peek()?.position ?? 0)
    return node
  }

  getVariables(): Set<string> {
    return this.variables
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset]
  }

  private consume(): Token {
    const token = this.tokens[this.index]
    if (!token) throw new ParseFailure('Unexpected end of expression', 0)
    this.index += 1
    return token
  }

  private matchOperator(values: string[]): Token | null {
    const token = this.peek()
    if (!token || token.kind !== 'operator' || !values.includes(token.value)) return null
    this.index += 1
    return token
  }

  private parseRelation(): GraphNode {
    const left = this.parseAdditive()
    const token = this.peek()
    if (token && token.kind === 'operator' && RELATIONS.has(token.value)) {
      this.index += 1
      const right = this.parseAdditive()
      return { kind: 'relation', op: token.value, left, right }
    }
    return left
  }

  private parseAdditive(): GraphNode {
    let node = this.parseMultiplicative()
    while (true) {
      const token = this.matchOperator(['+', '-'])
      if (!token) break
      node = { kind: 'binary', op: token.value, left: node, right: this.parseMultiplicative() }
    }
    return node
  }

  private parseMultiplicative(): GraphNode {
    let node = this.parsePower()
    while (true) {
      const token = this.matchOperator(['*', '/', '%'])
      if (token) {
        node = { kind: 'binary', op: token.value, left: node, right: this.parsePower() }
        continue
      }
      if (this.startsPrimary()) {
        node = { kind: 'binary', op: '*', left: node, right: this.parsePower() }
        continue
      }
      break
    }
    return node
  }

  private parsePower(): GraphNode {
    let node = this.parseUnary()
    while (true) {
      const token = this.matchOperator(['^'])
      if (!token) return node
      node = { kind: 'binary', op: '^', left: node, right: this.parseUnary() }
    }
  }

  private parseUnary(): GraphNode {
    const token = this.matchOperator(['+', '-'])
    if (!token) return this.parsePrimary()
    return { kind: 'unary', op: token.value, value: this.parseUnary() }
  }

  private startsPrimary(): boolean {
    const token = this.peek()
    if (!token) return false
    if (token.kind === 'number' || token.kind === 'ident' || token.kind === 'lparen') return true
    return false
  }

  private parsePrimary(): GraphNode {
    const token = this.consume()
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) }
    if (token.kind === 'ident') {
      const name = token.value
      if (this.peek()?.kind === 'lparen' && KNOWN_FUNCTIONS.has(name.toLowerCase())) {
        this.consume()
        const args: GraphNode[] = []
        if (this.peek()?.kind !== 'rparen') {
          while (true) {
            args.push(this.parseRelation())
            if (this.matchOperator([','])) continue
            if (this.peek()?.kind === 'comma') {
              this.consume()
              continue
            }
            break
          }
        }
        const close = this.consume()
        if (close.kind !== 'rparen') throw new ParseFailure('Expected )', close.position)
        if (!KNOWN_FUNCTIONS.has(name.toLowerCase())) throw new ParseFailure(`Unknown function "${name}"`, token.position)
        return { kind: 'call', name: name.toLowerCase(), args }
      }
      if (name in CONSTANTS) return { kind: 'number', value: CONSTANTS[name] }
      this.variables.add(name)
      return { kind: 'variable', name }
    }
    if (token.kind === 'lparen') {
      const node = this.parseRelation()
      const close = this.consume()
      if (close.kind !== 'rparen') throw new ParseFailure('Expected )', close.position)
      return node
    }
    throw new ParseFailure(`Unexpected "${token.value}"`, token.position)
  }
}

export class ParseFailure extends Error {
  constructor(message: string, readonly position: number) {
    super(message)
    this.name = 'ParseFailure'
  }
}

export function parseGraphExpression(text: string): ParsedExpression | ParseError {
  const tokens = tokenize(text)
  if (!Array.isArray(tokens)) return tokens
  try {
    const parser = new Parser(tokens)
    const node = parser.parse()
    return {
      ok: true,
      node,
      relation: node.kind === 'relation' ? node : null,
      variables: parser.getVariables(),
    }
  } catch (error) {
    if (error instanceof ParseFailure) return { ok: false, message: error.message, position: error.position }
    return { ok: false, message: error instanceof Error ? error.message : 'Invalid expression', position: 0 }
  }
}
