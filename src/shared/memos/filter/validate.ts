import { MEMO_FILTER_MAX_BYTES, MEMO_FILTER_MAX_DEPTH, MEMO_FILTER_REGEX_MAX_LENGTH } from '../constants'
import { patternSafety } from '../../regex-safety'
import type { MemoFilterBinaryOperator, MemoFilterCallNode, MemoFilterError, MemoFilterNode } from './ast'
import { isMemoFilterDatePart, parseDurationSeconds, parseTimestampSeconds } from './datetime'
import { tokenizeMemoFilter } from './lexer'
import { parseMemoFilter } from './parser'

export interface MemoFilterValidation {
  ok: boolean
  error?: MemoFilterError
}

export type MemoFilterPreparation = { ok: true; ast: MemoFilterNode } | { ok: false; error: MemoFilterError }

type MemoFilterValueType =
  | 'string'
  | 'nullable-string'
  | 'number'
  | 'bool'
  | 'timestamp'
  | 'duration'
  | 'tags'
  | 'strings'
  | 'null'

const FIELD_TYPES: Record<string, MemoFilterValueType> = {
  content: 'string',
  visibility: 'string',
  pinned: 'bool',
  space: 'nullable-string',
  tag: 'tags',
  tags: 'tags',
  size: 'number',
  has_task_list: 'bool',
  has_incomplete_tasks: 'bool',
  has_link: 'bool',
  has_code: 'bool',
  has_location: 'bool',
  created_ts: 'timestamp',
  updated_ts: 'timestamp',
  now: 'timestamp',
  creator: 'string',
}

const STRING_METHODS = ['contains', 'startsWith', 'endsWith', 'matches']
const SET_METHODS = ['contains', 'intersects', 'equivalent']
const COMPREHENSION_METHODS = ['exists', 'all', 'exists_one']
const EMPTY_SCOPE: ReadonlySet<string> = new Set<string>()

class ValidationFailure {
  constructor(readonly detail: MemoFilterError) {}
}

function fail(message: string, position: number): never {
  throw new ValidationFailure({ message, position })
}

export function prepareMemoFilter(expression: string): MemoFilterPreparation {
  if (
    expression.length > MEMO_FILTER_MAX_BYTES ||
    new TextEncoder().encode(expression).length > MEMO_FILTER_MAX_BYTES
  ) {
    return {
      ok: false,
      error: { message: `expression is longer than ${MEMO_FILTER_MAX_BYTES} bytes`, position: 0 },
    }
  }

  const tokenized = tokenizeMemoFilter(expression)
  if (!tokenized.ok) return tokenized

  const parsed = parseMemoFilter(tokenized.tokens)
  if (!parsed.ok) return parsed

  try {
    const type = new Inspector().inspect(parsed.ast, 1, EMPTY_SCOPE)
    if (type !== 'bool') fail('expression must evaluate to a boolean', parsed.ast.position)
    return { ok: true, ast: parsed.ast }
  } catch (error) {
    if (error instanceof ValidationFailure) return { ok: false, error: error.detail }
    throw error
  }
}

export function validateMemoFilter(expression: string): MemoFilterValidation {
  const prepared = prepareMemoFilter(expression)
  if (prepared.ok) return { ok: true }
  return { ok: false, error: prepared.error }
}

class Inspector {
  inspect(node: MemoFilterNode, depth: number, scope: ReadonlySet<string>): MemoFilterValueType {
    if (depth > MEMO_FILTER_MAX_DEPTH) fail('expression nesting is too deep', node.position)
    switch (node.kind) {
      case 'literal':
        return literalType(node.value)
      case 'list':
        return this.inspectList(node.items)
      case 'field':
        return this.inspectField(node.name, node.position, scope)
      case 'unary':
        return this.inspectUnary(node.operator, this.inspect(node.operand, depth + 1, scope), node.position)
      case 'binary':
        return this.inspectBinary(node.operator, node.left, node.right, depth, scope, node.position)
      case 'call':
        return this.inspectCall(node, depth, scope)
    }
  }

  private inspectList(items: MemoFilterNode[]): MemoFilterValueType {
    for (const item of items) {
      if (item.kind !== 'literal' || typeof item.value !== 'string') {
        fail('list literals may only contain strings', item.position)
      }
    }
    return 'strings'
  }

  private inspectField(name: string, position: number, scope: ReadonlySet<string>): MemoFilterValueType {
    if (scope.has(name)) return 'string'
    const type = FIELD_TYPES[name]
    if (!type) fail(`unknown field "${name}"`, position)
    return type
  }

  private inspectUnary(
    operator: '!' | '-',
    operand: MemoFilterValueType,
    position: number,
  ): MemoFilterValueType {
    if (operator === '!') {
      if (operand !== 'bool') fail('"!" expects a boolean', position)
      return 'bool'
    }
    if (operand !== 'number') fail('unary "-" expects a number', position)
    return 'number'
  }

  private inspectBinary(
    operator: MemoFilterBinaryOperator,
    leftNode: MemoFilterNode,
    rightNode: MemoFilterNode,
    depth: number,
    scope: ReadonlySet<string>,
    position: number,
  ): MemoFilterValueType {
    const left = this.inspect(leftNode, depth + 1, scope)
    const right = this.inspect(rightNode, depth + 1, scope)

    if (operator === '&&' || operator === '||') {
      if (left !== 'bool' || right !== 'bool') fail(`"${operator}" expects booleans`, position)
      return 'bool'
    }

    if (operator === '==' || operator === '!=') {
      return this.inspectEquality(left, right, leftNode.position, rightNode.position, position)
    }

    if (operator === 'in') {
      if (left !== 'string' && left !== 'tags') {
        fail('"in" expects a string or tags on the left', leftNode.position)
      }
      if (right !== 'strings' && right !== 'tags') {
        fail('"in" expects a list or tags on the right', rightNode.position)
      }
      return 'bool'
    }

    if (operator === '+' || operator === '-') {
      return this.inspectArithmetic(operator, left, right, position)
    }

    if (left !== right) fail(`cannot order ${left} against ${right}`, position)
    if (left !== 'number' && left !== 'timestamp' && left !== 'duration') {
      fail(`operator "${operator}" expects numbers or timestamps`, position)
    }
    return 'bool'
  }

  private inspectEquality(
    left: MemoFilterValueType,
    right: MemoFilterValueType,
    leftPosition: number,
    rightPosition: number,
    position: number,
  ): MemoFilterValueType {
    if (left === 'null' || right === 'null') {
      const other = left === 'null' ? right : left
      if (other !== 'nullable-string' && other !== 'null') {
        fail('null may only be compared with space', left === 'null' ? rightPosition : leftPosition)
      }
      return 'bool'
    }
    if (left === 'nullable-string' || right === 'nullable-string') {
      const other = left === 'nullable-string' ? right : left
      if (other !== 'string' && other !== 'nullable-string') {
        fail(`cannot compare ${left} with ${right}`, position)
      }
      return 'bool'
    }
    if (left === 'tags' || left === 'strings' || right === 'tags' || right === 'strings') {
      fail('list values cannot be compared directly', position)
    }
    if (left !== right) fail(`cannot compare ${left} with ${right}`, position)
    return 'bool'
  }

  private inspectArithmetic(
    operator: '+' | '-',
    left: MemoFilterValueType,
    right: MemoFilterValueType,
    position: number,
  ): MemoFilterValueType {
    if (left === 'number' && right === 'number') return 'number'
    if (operator === '+' && left === 'timestamp' && right === 'duration') return 'timestamp'
    if (operator === '+' && left === 'duration' && right === 'timestamp') return 'timestamp'
    if (left === 'timestamp' && operator === '-' && right === 'duration') return 'timestamp'
    if (left === 'timestamp' && operator === '-' && right === 'timestamp') return 'duration'
    if (left === 'duration' && right === 'duration') return 'duration'
    fail(`operator "${operator}" does not accept ${left} and ${right}`, position)
  }

  private inspectCall(node: MemoFilterCallNode, depth: number, scope: ReadonlySet<string>): MemoFilterValueType {
    if (node.target === null) return this.inspectFunction(node, depth, scope)

    if (node.target.kind === 'field' && node.target.name === 'sets' && !scope.has('sets')) {
      return this.inspectSetCall(node, depth, scope)
    }

    const target = this.inspect(node.target, depth + 1, scope)

    if (target === 'string') return this.inspectStringMethod(node, depth, scope)
    if (target === 'timestamp') return this.inspectDateAccessor(node)
    if (target === 'tags') return this.inspectComprehension(node, depth, scope)
    fail(`method "${node.method}" is not supported on ${target}`, node.position)
  }

  private inspectFunction(node: MemoFilterCallNode, depth: number, scope: ReadonlySet<string>): MemoFilterValueType {
    if (node.method === 'size') {
      this.expectArgumentCount(node, 1)
      const argument = this.inspect(node.args[0]!, depth + 1, scope)
      if (argument !== 'string' && argument !== 'tags') {
        fail('size() expects a string or tags', node.args[0]!.position)
      }
      return 'number'
    }
    if (node.method === 'duration') {
      this.expectArgumentCount(node, 1)
      const literal = this.expectStringLiteral(node.args[0]!, 'duration() expects a string literal')
      if (parseDurationSeconds(literal) === null) fail('invalid duration literal', node.args[0]!.position)
      return 'duration'
    }
    if (node.method === 'timestamp') {
      this.expectArgumentCount(node, 1)
      const literal = this.expectStringLiteral(node.args[0]!, 'timestamp() expects a string literal')
      if (parseTimestampSeconds(literal) === null) fail('invalid timestamp literal', node.args[0]!.position)
      return 'timestamp'
    }
    fail(`unknown function "${node.method}"`, node.position)
  }

  private inspectStringMethod(
    node: MemoFilterCallNode,
    depth: number,
    scope: ReadonlySet<string>,
  ): MemoFilterValueType {
    if (!STRING_METHODS.includes(node.method)) fail(`unknown string method "${node.method}"`, node.position)
    this.expectArgumentCount(node, 1)
    if (node.method === 'matches') {
      this.checkPattern(node.args[0]!)
      return 'bool'
    }
    const argument = this.inspect(node.args[0]!, depth + 1, scope)
    if (argument !== 'string') fail(`${node.method}() expects a string`, node.args[0]!.position)
    return 'bool'
  }

  private checkPattern(argument: MemoFilterNode): void {
    const pattern = this.expectStringLiteral(argument, 'matches() expects a string literal pattern')
    if (pattern.length > MEMO_FILTER_REGEX_MAX_LENGTH) {
      fail(`regular expression is longer than ${MEMO_FILTER_REGEX_MAX_LENGTH} characters`, argument.position)
    }
    if (patternSafety(pattern, MEMO_FILTER_REGEX_MAX_LENGTH) === 'unsafe') {
      fail('regular expression is too complex', argument.position)
    }
    try {
      new RegExp(pattern)
    } catch {
      fail('invalid regular expression', argument.position)
    }
  }

  private inspectDateAccessor(node: MemoFilterCallNode): MemoFilterValueType {
    if (!isMemoFilterDatePart(node.method)) fail(`unknown date accessor "${node.method}"`, node.position)
    this.expectArgumentCount(node, 0)
    return 'number'
  }

  private inspectComprehension(
    node: MemoFilterCallNode,
    depth: number,
    scope: ReadonlySet<string>,
  ): MemoFilterValueType {
    if (!COMPREHENSION_METHODS.includes(node.method)) {
      fail(`unknown tags method "${node.method}"`, node.position)
    }
    this.expectArgumentCount(node, 2)
    const binding = node.args[0]!
    if (binding.kind !== 'field') fail('tags method expects a lambda variable', binding.position)
    if (FIELD_TYPES[binding.name]) {
      fail(`lambda variable "${binding.name}" conflicts with a field`, binding.position)
    }
    const boundScope = new Set(scope)
    boundScope.add(binding.name)
    const predicate = this.inspect(node.args[1]!, depth + 1, boundScope)
    if (predicate !== 'bool') fail('lambda predicate must be a boolean', node.args[1]!.position)
    return 'bool'
  }

  private inspectSetCall(
    node: MemoFilterCallNode,
    depth: number,
    scope: ReadonlySet<string>,
  ): MemoFilterValueType {
    if (!SET_METHODS.includes(node.method)) fail(`unknown sets method "${node.method}"`, node.position)
    this.expectArgumentCount(node, 2)
    const values = this.inspect(node.args[0]!, depth + 1, scope)
    if (values !== 'tags') fail('sets methods expect tags as the first argument', node.args[0]!.position)
    const list = this.inspect(node.args[1]!, depth + 1, scope)
    if (list !== 'strings') fail('sets methods expect a string list as the second argument', node.args[1]!.position)
    return 'bool'
  }

  private expectArgumentCount(node: MemoFilterCallNode, expected: number): void {
    if (node.args.length !== expected) {
      fail(`${node.method}() expects ${expected} argument${expected === 1 ? '' : 's'}`, node.position)
    }
  }

  private expectStringLiteral(node: MemoFilterNode, message: string): string {
    if (node.kind !== 'literal' || typeof node.value !== 'string') fail(message, node.position)
    return node.value
  }
}

function literalType(value: string | number | boolean | null): MemoFilterValueType {
  if (value === null) return 'null'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  return 'bool'
}
