import { MEMO_FILTER_MAX_DEPTH } from '../constants'
import type { MemoFilterBinaryOperator, MemoFilterError, MemoFilterNode } from './ast'
import type { MemoFilterToken } from './lexer'

export type MemoFilterParseResult =
  | { ok: true; ast: MemoFilterNode }
  | { ok: false; error: MemoFilterError }

class ParseFailure {
  constructor(readonly detail: MemoFilterError) {}
}

const COMPARISON_OPERATORS: MemoFilterBinaryOperator[] = ['==', '!=', '<', '<=', '>', '>=']

export function parseMemoFilter(tokens: MemoFilterToken[]): MemoFilterParseResult {
  try {
    const parser = new Parser(tokens)
    const ast = parser.parseExpression(1)
    parser.expectEnd()
    return { ok: true, ast }
  } catch (error) {
    if (error instanceof ParseFailure) return { ok: false, error: error.detail }
    throw error
  }
}

function fail(message: string, position: number): never {
  throw new ParseFailure({ message, position })
}

class Parser {
  private index = 0

  constructor(private readonly tokens: MemoFilterToken[]) {}

  parseExpression(depth: number): MemoFilterNode {
    return this.parseOr(depth)
  }

  expectEnd(): void {
    const token = this.peek()
    if (token.kind !== 'eof') fail(`unexpected token "${token.text}"`, token.position)
  }

  private parseOr(depth: number): MemoFilterNode {
    let left = this.parseAnd(depth)
    while (this.atSymbol('||')) {
      const operator = this.advance()
      const right = this.parseAnd(depth)
      left = { kind: 'binary', operator: '||', left, right, position: operator.position }
    }
    return left
  }

  private parseAnd(depth: number): MemoFilterNode {
    let left = this.parseComparison(depth)
    while (this.atSymbol('&&')) {
      const operator = this.advance()
      const right = this.parseComparison(depth)
      left = { kind: 'binary', operator: '&&', left, right, position: operator.position }
    }
    return left
  }

  private parseComparison(depth: number): MemoFilterNode {
    const left = this.parseAdditive(depth)
    const found = this.comparisonOperator()
    if (!found) return left
    const operator = this.advance()
    const right = this.parseAdditive(depth)
    if (this.comparisonOperator()) {
      fail('chained comparisons are not supported', this.peek().position)
    }
    return { kind: 'binary', operator: found, left, right, position: operator.position }
  }

  private parseAdditive(depth: number): MemoFilterNode {
    let left = this.parseUnary(depth)
    while (this.atSymbol('+') || this.atSymbol('-')) {
      const operator = this.advance()
      const right = this.parseUnary(depth)
      left = {
        kind: 'binary',
        operator: operator.text === '+' ? '+' : '-',
        left,
        right,
        position: operator.position,
      }
    }
    return left
  }

  private parseUnary(depth: number): MemoFilterNode {
    if (this.atSymbol('!') || this.atSymbol('-')) {
      const operator = this.advance()
      this.checkDepth(depth + 1, operator.position)
      const operand = this.parseUnary(depth + 1)
      return {
        kind: 'unary',
        operator: operator.text === '!' ? '!' : '-',
        operand,
        position: operator.position,
      }
    }
    return this.parsePostfix(depth)
  }

  private parsePostfix(depth: number): MemoFilterNode {
    let node = this.parsePrimary(depth)
    while (this.atSymbol('.')) {
      this.advance()
      const method = this.peek()
      if (method.kind !== 'identifier') fail('expected a method name', method.position)
      this.advance()
      node = {
        kind: 'call',
        target: node,
        method: method.text,
        args: this.parseArguments(depth),
        position: method.position,
      }
    }
    return node
  }

  private parsePrimary(depth: number): MemoFilterNode {
    const token = this.peek()

    if (token.kind === 'string') {
      this.advance()
      return { kind: 'literal', value: String(token.value), position: token.position }
    }

    if (token.kind === 'number') {
      this.advance()
      return { kind: 'literal', value: Number(token.value), position: token.position }
    }

    if (token.kind === 'identifier') {
      if (token.text === 'true' || token.text === 'false') {
        this.advance()
        return { kind: 'literal', value: token.text === 'true', position: token.position }
      }
      if (token.text === 'null') {
        this.advance()
        return { kind: 'literal', value: null, position: token.position }
      }
      this.advance()
      if (this.atSymbol('(')) {
        return {
          kind: 'call',
          target: null,
          method: token.text,
          args: this.parseArguments(depth),
          position: token.position,
        }
      }
      return { kind: 'field', name: token.text, position: token.position }
    }

    if (this.atSymbol('(')) {
      this.advance()
      this.checkDepth(depth + 1, token.position)
      if (this.atSymbol(')')) fail('expected an expression', this.peek().position)
      const inner = this.parseExpression(depth + 1)
      this.expectSymbol(')')
      return inner
    }

    if (this.atSymbol('[')) {
      this.advance()
      this.checkDepth(depth + 1, token.position)
      return { kind: 'list', items: this.parseListItems(depth + 1), position: token.position }
    }

    if (token.kind === 'eof') fail('unexpected end of expression', token.position)
    fail(`unexpected token "${token.text}"`, token.position)
  }

  private parseListItems(depth: number): MemoFilterNode[] {
    const items: MemoFilterNode[] = []
    if (this.atSymbol(']')) {
      this.advance()
      return items
    }
    while (true) {
      items.push(this.parseExpression(depth))
      if (this.atSymbol(',')) {
        this.advance()
        if (this.atSymbol(']')) {
          this.advance()
          return items
        }
        continue
      }
      this.expectSymbol(']')
      return items
    }
  }

  private parseArguments(depth: number): MemoFilterNode[] {
    this.expectSymbol('(')
    this.checkDepth(depth + 1, this.peek().position)
    const args: MemoFilterNode[] = []
    if (this.atSymbol(')')) {
      this.advance()
      return args
    }
    while (true) {
      args.push(this.parseExpression(depth + 1))
      if (this.atSymbol(',')) {
        this.advance()
        if (this.atSymbol(')')) {
          this.advance()
          return args
        }
        continue
      }
      this.expectSymbol(')')
      return args
    }
  }

  private comparisonOperator(): MemoFilterBinaryOperator | null {
    const token = this.peek()
    if (token.kind === 'symbol' && COMPARISON_OPERATORS.includes(token.text as MemoFilterBinaryOperator)) {
      return token.text as MemoFilterBinaryOperator
    }
    if (token.kind === 'identifier' && token.text === 'in') return 'in'
    return null
  }

  private expectSymbol(text: string): void {
    if (this.atSymbol(text)) {
      this.advance()
      return
    }
    fail(`expected "${text}"`, this.peek().position)
  }

  private checkDepth(depth: number, position: number): void {
    if (depth > MEMO_FILTER_MAX_DEPTH) fail('expression nesting is too deep', position)
  }

  private atSymbol(text: string): boolean {
    const token = this.peek()
    return token.kind === 'symbol' && token.text === text
  }

  private peek(): MemoFilterToken {
    return this.tokens[Math.min(this.index, this.tokens.length - 1)]!
  }

  private advance(): MemoFilterToken {
    const token = this.peek()
    if (token.kind !== 'eof') this.index++
    return token
  }
}
