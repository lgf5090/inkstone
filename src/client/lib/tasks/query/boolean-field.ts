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

  /**
   * Accepts any of the four delimiter pairs, not just parentheses.
   *
   * The test is "does this contain a connective and does it parse", because a check written against
   * one delimiter shape rejects `[a] XOR [b]` and `{a} AND {b}` — and a rejected line is not a
   * filter that matches nothing, it is a line the engine reports as unknown.
   */
  canCreateFilterForLine(line: string): boolean {
    const trimmed = line.trim()
    if (!/\b(AND|OR|XOR|NOT)\b/i.test(trimmed)) return false
    return parseBooleanExpression(trimmed, new Date()) !== null
  }

  override createFilterOrErrorMessage(line: string, now?: Date): FilterOrErrorMessage {
    const node = parseBooleanExpression(line.trim(), now ?? new Date())
    if (node === null) return invalidFilter(`unable to parse boolean expression: ${line}`)
    return { filter: (task, info) => evaluate(node, task, info), error: null }
  }
}

/** Parse, or return null so the caller can fall through to another field. */
function parseBooleanExpression(line: string, now: Date): Node | null {
  const tokens = tokenize(line)
  if (tokens === null) return null
  const parser = new Parser(tokens, now)
  const node = parser.parseExpression()
  if (node === null || !parser.atEnd()) return null
  return node
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
      }
      else buffer += char
      depth += 1
      continue
    }
    if (CLOSERS.has(char) || char === '"') {
      if (depth === 0) {
        buffer += char
        continue
      }
      depth -= 1
      if (depth > 0) {
        buffer += char
        continue
      }
      flush()
      out.push(char)
      continue
    }
    buffer += char
  }
  flush()
  if (depth !== 0) return null
  return expandConnectives(out)
}

/**
 * Split `AND NOT` and `OR NOT` into two tokens.
 *
 * They are single instructions to a reader and two nodes to the parser; leaving them glued makes
 * `a AND NOT b` an unrecognisable word, and the whole line then falls out of the boolean field.
 */
function expandConnectives(tokens: string[]): string[] {
  const out: string[] = []
  for (const token of tokens) {
    const matched = /^(AND|OR)\s+NOT$/i.exec(token)
    if (matched) out.push(matched[1]!.toUpperCase(), 'NOT')
    else out.push(token)
  }
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
    if (parsed !== null && parsed.filter !== null) {
      return { kind: 'leaf', filter: parsed.filter, explain: token }
    }
    // A nested expression arrives as one token, because the tokenizer keeps everything between the
    // outer delimiters together. Re-parse it as an expression rather than calling it an unknown
    // instruction, which is what makes `((a) AND (b)) OR (c)` work.
    const nested = parseBooleanExpression(token, this.now)
    if (nested === null) return null
    return { kind: 'leaf', filter: (task, info) => evaluate(nested, task, info), explain: token }
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
