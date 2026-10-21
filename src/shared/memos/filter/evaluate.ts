import type { MemoVisibility } from '../types'
import type { MemoFilterBinaryOperator, MemoFilterCallNode, MemoFilterError, MemoFilterNode } from './ast'
import {
  createLocalDatePartsReader,
  isMemoFilterDatePart,
  parseDurationSeconds,
  parseTimestampSeconds,
  readMemoFilterDatePart,
  type MemoFilterDatePart,
  type MemoFilterLocalDate,
} from './datetime'
import { prepareMemoFilter } from './validate'

export interface MemoFilterRecord {
  id: string
  creatorId: string
  content: string
  tags: string[]
  visibility: MemoVisibility
  pinned: boolean
  spaceId: string | null
  size: number
  hasLink: boolean
  hasCode: boolean
  hasTaskList: boolean
  hasIncompleteTasks: boolean
  hasLocation: boolean
  createdAt: number
  updatedAt: number
}

export interface MemoFilterContext {
  viewerId: string
  now: number
  timeZone: string
}

export interface MemoFilter {
  readonly expression: string
  matches(record: MemoFilterRecord, context: MemoFilterContext): boolean
}

export type MemoFilterCompileResult = { ok: true; filter: MemoFilter } | { ok: false; error: MemoFilterError }

type MemoFilterValue = string | number | boolean | string[] | null

interface Binding {
  name: string
  value: string
  parent: Binding | null
}

interface DateReader {
  timeZone: string
  read: (seconds: number) => MemoFilterLocalDate
}

function fold(value: string): string {
  return value.toLocaleLowerCase()
}

function invalidNode(node: MemoFilterNode): Error {
  return new Error(`memo filter: cannot evaluate a "${node.kind}" node here`)
}

function isCreatorField(node: MemoFilterNode): boolean {
  return node.kind === 'field' && node.name === 'creator'
}

export function compileMemoFilter(expression: string): MemoFilterCompileResult {
  const prepared = prepareMemoFilter(expression)
  if (!prepared.ok) return { ok: false, error: prepared.error }
  const evaluator = new Evaluator(prepared.ast)
  return {
    ok: true,
    filter: {
      expression,
      matches: (record, context) => evaluator.matches(record, context),
    },
  }
}

class Evaluator {
  private readonly regexes = new Map<string, RegExp | null>()
  private dateReader: DateReader | null = null

  constructor(private readonly ast: MemoFilterNode) {}

  matches(record: MemoFilterRecord, context: MemoFilterContext): boolean {
    return this.booleanValue(this.ast, record, context, null, 'expression') === true
  }

  private evaluate(
    node: MemoFilterNode,
    record: MemoFilterRecord,
    context: MemoFilterContext,
    binding: Binding | null,
  ): MemoFilterValue {
    switch (node.kind) {
      case 'literal':
        return node.value
      case 'list':
        return node.items.map((item) => this.stringValue(item, record, context, binding, 'list item'))
      case 'field':
        return this.readField(node.name, record, context, binding)
      case 'unary':
        return this.evaluateUnary(node.operator, node.operand, record, context, binding)
      case 'binary':
        return this.evaluateBinary(node.operator, node.left, node.right, record, context, binding, node.position)
      case 'call':
        return this.evaluateCall(node, record, context, binding)
    }
  }

  private readField(
    name: string,
    record: MemoFilterRecord,
    context: MemoFilterContext,
    binding: Binding | null,
  ): MemoFilterValue {
    for (let current = binding; current; current = current.parent) {
      if (current.name === name) return current.value
    }
    switch (name) {
      case 'content':
        return record.content
      case 'visibility':
        return record.visibility.toUpperCase()
      case 'pinned':
        return record.pinned
      case 'space':
        return record.spaceId === null ? null : `spaces/${record.spaceId}`
      case 'tag':
      case 'tags':
        return record.tags
      case 'size':
        return record.size
      case 'has_task_list':
        return record.hasTaskList
      case 'has_incomplete_tasks':
        return record.hasIncompleteTasks
      case 'has_link':
        return record.hasLink
      case 'has_code':
        return record.hasCode
      case 'has_location':
        return record.hasLocation
      case 'created_ts':
        return record.createdAt
      case 'updated_ts':
        return record.updatedAt
      case 'now':
        return context.now
      case 'creator':
        return `users/${record.creatorId}`
      default:
        throw new Error(`memo filter: unknown field "${name}" reached evaluation`)
    }
  }

  private evaluateUnary(
    operator: '!' | '-',
    operandNode: MemoFilterNode,
    record: MemoFilterRecord,
    context: MemoFilterContext,
    binding: Binding | null,
  ): MemoFilterValue {
    if (operator === '!') {
      return !this.booleanValue(operandNode, record, context, binding, 'operand of "!"')
    }
    return -this.numberValue(operandNode, record, context, binding, 'operand of "-"')
  }

  private evaluateBinary(
    operator: MemoFilterBinaryOperator,
    leftNode: MemoFilterNode,
    rightNode: MemoFilterNode,
    record: MemoFilterRecord,
    context: MemoFilterContext,
    binding: Binding | null,
    position: number,
  ): MemoFilterValue {
    if (operator === '&&') {
      return (
        this.booleanValue(leftNode, record, context, binding, 'left side of "&&"') &&
        this.booleanValue(rightNode, record, context, binding, 'right side of "&&"')
      )
    }
    if (operator === '||') {
      return (
        this.booleanValue(leftNode, record, context, binding, 'left side of "||"') ||
        this.booleanValue(rightNode, record, context, binding, 'right side of "||"')
      )
    }

    if (operator === 'in') {
      const left = this.evaluate(leftNode, record, context, binding)
      const right = this.evaluate(rightNode, record, context, binding)
      if (!Array.isArray(right)) throw invalidNode(rightNode)
      if (Array.isArray(left)) return left.some((entry) => right.includes(entry))
      if (typeof left !== 'string') throw invalidNode(leftNode)
      return right.includes(left)
    }

    const left = this.evaluate(leftNode, record, context, binding)
    const right = this.evaluate(rightNode, record, context, binding)

    if (operator === '==') return this.areEqual(leftNode, rightNode, left, right, context)
    if (operator === '!=') return !this.areEqual(leftNode, rightNode, left, right, context)
    if (operator === '+' || operator === '-') {
      if (typeof left !== 'number' || typeof right !== 'number') throw invalidNode(rightNode)
      return operator === '+' ? left + right : left - right
    }

    if (typeof left !== 'number' || typeof right !== 'number') {
      throw new Error(`memo filter: operator "${operator}" reached evaluation without numbers at ${position}`)
    }
    switch (operator) {
      case '<':
        return left < right
      case '<=':
        return left <= right
      case '>':
        return left > right
      case '>=':
        return left >= right
    }
  }

  private areEqual(
    leftNode: MemoFilterNode,
    rightNode: MemoFilterNode,
    left: MemoFilterValue,
    right: MemoFilterValue,
    context: MemoFilterContext,
  ): boolean {
    let resolvedLeft = left
    let resolvedRight = right
    if (isCreatorField(leftNode) && resolvedRight === 'me') resolvedRight = `users/${context.viewerId}`
    if (isCreatorField(rightNode) && resolvedLeft === 'me') resolvedLeft = `users/${context.viewerId}`
    return resolvedLeft === resolvedRight
  }

  private evaluateCall(
    node: MemoFilterCallNode,
    record: MemoFilterRecord,
    context: MemoFilterContext,
    binding: Binding | null,
  ): MemoFilterValue {
    if (node.target === null) return this.evaluateFunction(node, record, context, binding)

    if (this.isSetCall(node, binding)) return this.evaluateSetCall(node, record, context, binding)

    const target = this.evaluate(node.target, record, context, binding)

    if (Array.isArray(target)) return this.evaluateComprehension(node, target, record, context, binding)
    if (typeof target === 'number') return this.evaluateDateAccessor(node, target, context)
    if (typeof target !== 'string') throw invalidNode(node.target)

    const argument = this.evaluate(node.args[0]!, record, context, binding)
    if (typeof argument !== 'string') throw invalidNode(node.args[0]!)

    switch (node.method) {
      case 'contains':
        return fold(target).includes(fold(argument))
      case 'startsWith':
        return fold(target).startsWith(fold(argument))
      case 'endsWith':
        return fold(target).endsWith(fold(argument))
      case 'matches': {
        const regex = this.regex(argument)
        return regex ? regex.test(target) : false
      }
      default:
        throw new Error(`memo filter: unknown string method "${node.method}" reached evaluation`)
    }
  }

  private evaluateFunction(
    node: MemoFilterCallNode,
    record: MemoFilterRecord,
    context: MemoFilterContext,
    binding: Binding | null,
  ): MemoFilterValue {
    if (node.method === 'size') {
      const value = this.evaluate(node.args[0]!, record, context, binding)
      if (typeof value === 'string') return [...value].length
      if (Array.isArray(value)) return value.length
      throw invalidNode(node.args[0]!)
    }
    const argument = node.args[0]
    if (!argument || argument.kind !== 'literal' || typeof argument.value !== 'string') throw invalidNode(node)
    if (node.method === 'duration') {
      const seconds = parseDurationSeconds(argument.value)
      if (seconds === null) throw new Error('memo filter: invalid duration literal reached evaluation')
      return seconds
    }
    if (node.method === 'timestamp') {
      const seconds = parseTimestampSeconds(argument.value)
      if (seconds === null) throw new Error('memo filter: invalid timestamp literal reached evaluation')
      return seconds
    }
    throw new Error(`memo filter: unknown function "${node.method}" reached evaluation`)
  }

  private isSetCall(node: MemoFilterCallNode, binding: Binding | null): boolean {
    if (node.target === null || node.target.kind !== 'field' || node.target.name !== 'sets') return false
    for (let current = binding; current; current = current.parent) {
      if (current.name === 'sets') return false
    }
    return true
  }

  private evaluateSetCall(
    node: MemoFilterCallNode,
    record: MemoFilterRecord,
    context: MemoFilterContext,
    binding: Binding | null,
  ): boolean {
    const tags = this.stringListValue(node.args[0]!, record, context, binding, 'tags')
    const values = this.stringListValue(node.args[1]!, record, context, binding, 'value list')
    switch (node.method) {
      case 'contains':
        return values.every((value) => tags.includes(value))
      case 'intersects':
        return values.some((value) => tags.includes(value))
      case 'equivalent': {
        const distinct = [...new Set(values)]
        return distinct.every((value) => tags.includes(value)) && new Set(tags).size === distinct.length
      }
      default:
        throw new Error(`memo filter: unknown sets method "${node.method}" reached evaluation`)
    }
  }

  private evaluateDateAccessor(
    node: MemoFilterCallNode,
    seconds: number,
    context: MemoFilterContext,
  ): number {
    if (!isMemoFilterDatePart(node.method)) {
      throw new Error(`memo filter: unknown date accessor "${node.method}" reached evaluation`)
    }
    const part: MemoFilterDatePart = node.method
    return readMemoFilterDatePart(this.dateParts(context.timeZone)(seconds), part)
  }

  private evaluateComprehension(
    node: MemoFilterCallNode,
    tags: string[],
    record: MemoFilterRecord,
    context: MemoFilterContext,
    binding: Binding | null,
  ): boolean {
    const bindingNode = node.args[0]
    const predicate = node.args[1]
    if (!bindingNode || bindingNode.kind !== 'field' || !predicate) throw invalidNode(node)
    const matchesTag = (tag: string): boolean =>
      this.booleanValue(predicate, record, context, { name: bindingNode.name, value: tag, parent: binding }, 'lambda predicate')

    switch (node.method) {
      case 'exists':
        return tags.some(matchesTag)
      case 'all':
        return tags.length > 0 && tags.every(matchesTag)
      case 'exists_one':
        return tags.filter(matchesTag).length === 1
      default:
        throw new Error(`memo filter: unknown tags method "${node.method}" reached evaluation`)
    }
  }

  private regex(pattern: string): RegExp | null {
    if (this.regexes.has(pattern)) return this.regexes.get(pattern) ?? null
    let regex: RegExp | null = null
    try {
      regex = new RegExp(pattern)
    } catch {
      regex = null
    }
    this.regexes.set(pattern, regex)
    return regex
  }

  private dateParts(timeZone: string): (seconds: number) => MemoFilterLocalDate {
    if (!this.dateReader || this.dateReader.timeZone !== timeZone) {
      this.dateReader = { timeZone, read: createLocalDatePartsReader(timeZone) }
    }
    return this.dateReader.read
  }

  private booleanValue(
    node: MemoFilterNode,
    record: MemoFilterRecord,
    context: MemoFilterContext,
    binding: Binding | null,
    role: string,
  ): boolean {
    const value = this.evaluate(node, record, context, binding)
    if (typeof value !== 'boolean') throw new Error(`memo filter: ${role} is not a boolean`)
    return value
  }

  private numberValue(
    node: MemoFilterNode,
    record: MemoFilterRecord,
    context: MemoFilterContext,
    binding: Binding | null,
    role: string,
  ): number {
    const value = this.evaluate(node, record, context, binding)
    if (typeof value !== 'number') throw new Error(`memo filter: ${role} is not a number`)
    return value
  }

  private stringValue(
    node: MemoFilterNode,
    record: MemoFilterRecord,
    context: MemoFilterContext,
    binding: Binding | null,
    role: string,
  ): string {
    const value = this.evaluate(node, record, context, binding)
    if (typeof value !== 'string') throw new Error(`memo filter: ${role} is not a string`)
    return value
  }

  private stringListValue(
    node: MemoFilterNode,
    record: MemoFilterRecord,
    context: MemoFilterContext,
    binding: Binding | null,
    role: string,
  ): string[] {
    const value = this.evaluate(node, record, context, binding)
    if (!Array.isArray(value)) throw new Error(`memo filter: ${role} is not a string list`)
    return value
  }
}
