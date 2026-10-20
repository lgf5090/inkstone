import { Field } from './field'
import { invalidFilter, type FilterOrErrorMessage, type SearchInfo } from './values'
import type { Task } from '../model/task'
import { parseSimpleFilterInstruction } from './instructions'

type Node =
  | { kind: 'leaf'; filter: (task: Task, info: SearchInfo) => boolean; explain: string }
  | { kind: 'not'; operand: Node }
  | { kind: 'and' | 'or' | 'xor'; operands: Node[] }

/**
 * `(a) AND (b)`, `NOT (a)`, and the rest of the algebra that combines filters.
 *
 * Written as a small recursive-descent parser rather than pulled in from an expression library:
 * the grammar is four connectives and four delimiter pairs, and a dependency would have to be
 * audited for every reader forever to save a hundred lines once.
 *
 * Precedence is `NOT` then `AND`/`XOR` then `OR`, which is what a reader typing a compound line
 * expects and what the reference plugin's answers agree with on every case in its own suite.
 */
class BooleanField extends Field {
  fieldName(): string {
    return 'boolean'
  }

  canCreateFilterForLine(line: string): boolean {
    const trimmed = line.trim()
    if (!trimmed.startsWith('(') && !/\b(AND|OR|XOR|NOT)\b/i.test(trimmed)) return false
    return /\)\s*(AND|OR|XOR)\s*\(|^(AND|OR|XOR|NOT)\b|\b(AND|OR|XOR|NOT)\s+($|\()/i.test(trimmed)
      || trimmed.startsWith('(')
  }

  override createFilterOrErrorMessage(line: string, now?: Date): FilterOrErrorMessage {
    const tokens = tokenize(line.trim())
    if (tokens === null) return invalidFilter(`unbalanced delimiters in: ${line}`)
    const parser = new Parser(tokens, now ?? new Date())
    const node = parser.parseExpression()
    if (node === null) return invalidFilter(`unable to parse boolean expression: ${line}`)
    if (!parser.atEnd()) return invalidFilter(`trailing text in: ${line}`)
    return { filter: (task, info) => evaluate(node, task, info), error: null }
  }
}

const CLOSERS = new Set<string>([')', ']', '}'])

function tokenize(line: string): string[] | null {
  const out: string[] = []
  let depth = 0
  let buffer = ''
  const flush = (): void => {
    const trimmed = buffer.trim()
    if (trimmed !== '') out.push(trimmed)
    buffer = ''
  }

  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (char === '(' || char === '[' || char === '{' || char === '"') {
      if (depth === 0) {
        flush()
        out.push(char)
        depth += 1
        continue
      }
      buffer += char
      continue
    }
    if (depth > 0 && (CLOSERS.has(char) || char === '"')) {
      flush()
      out.push(char)
      depth -= 1
      continue
    }
    buffer += char
  }
  flush()
  if (depth !== 0) return null
  return out
}

const CONNECTIVES = new Set(['AND', 'OR', 'XOR', 'NOT'])

class Parser {
  private cursor = 0

  constructor(private readonly tokens: string[], private readonly now: Date) {}

  atEnd(): boolean {
    return this.cursor >= this.tokens.length
  }

  parseExpression(): Node | null {
    return this.parseOr()
  }

  private parseOr(): Node | null {
    const first = this.parseAnd()
    if (first === null) return null
    const operands: Node[] = [first]
    while (this.peekWord() === 'OR') {
      this.cursor += 1
      const next = this.parseAnd()
      if (next === null) return null
      operands.push(next)
    }
    return operands.length === 1 ? first : { kind: 'or', operands }
  }

  private parseAnd(): Node | null {
    let left = this.parseNot()
    if (left === null) return null
    for (;;) {
      const connective = this.peekWord()
      if (connective !== 'AND' && connective !== 'XOR') break
      this.cursor += 1
      const right = this.parseNot()
      if (right === null) return null
      left = connective === 'AND'
        ? (left.kind === 'and' ? { kind: 'and', operands: [...left.operands, right] } : { kind: 'and', operands: [left, right] })
        : { kind: 'xor', operands: [left, right] }
    }
    return left
  }

  private parseNot(): Node | null {
    if (this.peekWord() === 'NOT') {
      this.cursor += 1
      const operand = this.parseNot()
      if (operand === null) return null
      return { kind: 'not', operand }
    }
    return this.parseOperand()
  }

  private parseOperand(): Node | null {
    const token = this.tokens[this.cursor]
    if (token === undefined) return null
    if (token === '(' || token === '[' || token === '{' || token === '"') {
      this.cursor += 1
      const inner = this.parseExpression()
      if (inner === null) return null
      const closer = this.tokens[this.cursor]
      if (closer === ')' || closer === ']' || closer === '}' || closer === '"') this.cursor += 1
      return inner
    }
    if (CONNECTIVES.has(token.toUpperCase())) return null
    this.cursor += 1
    const parsed = parseSimpleFilterInstruction(token, this.now)
    if (parsed === null || parsed.filter === null) return null
    return { kind: 'leaf', filter: parsed.filter, explain: token }
  }

  private peekWord(): string | null {
    const token = this.tokens[this.cursor]
    if (token === undefined) return null
    const upper = token.toUpperCase()
    return CONNECTIVES.has(upper) ? upper : null
  }
}

function evaluate(node: Node, task: Task, info: SearchInfo): boolean {
  switch (node.kind) {
    case 'leaf':
      return node.filter(task, info)
    case 'not':
      return !evaluate(node.operand, task, info)
    case 'and':
      return node.operands.every((operand) => evaluate(operand, task, info))
    case 'or':
      return node.operands.some((operand) => evaluate(operand, task, info))
    case 'xor': {
      const truthy = node.operands.filter((operand) => evaluate(operand, task, info)).length
      return truthy === 1
    }
  }
}

export const booleanField = new BooleanField()
