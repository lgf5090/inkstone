import type { ProjectCard, ProjectProperty } from './model'
import { projectMultiValueIds } from './model'
import { parseProjectDateValue } from './date'

type Token =
  | { kind: 'number', value: number }
  | { kind: 'string', value: string }
  | { kind: 'ref', value: string }
  | { kind: 'ident', value: string }
  | { kind: 'op', value: string }

type Value = number | string | boolean | null

const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '(', ')', ',', '<', '>', '!'] as const

export interface ProjectFormulaResult {
  value: string
  error?: string
}

export function projectFormulaReferenceValue(card: ProjectCard, property: ProjectProperty): string {
  const raw = card.values[property.id] ?? ''
  if (property.type === 'select') return property.options.find((option) => option.id === raw)?.value ?? raw
  if (property.type === 'multiSelect') return projectMultiValueIds(raw).map((id) => property.options.find((option) => option.id === id)?.value ?? id).join(', ')
  if (property.type === 'date') {
    const from = parseProjectDateValue(raw)?.from
    return from === undefined ? raw : String(from)
  }
  if (property.type === 'createdBy') return card.createdBy
  if (property.type === 'updatedBy') return card.modifiedBy
  if (property.type === 'createdTime') return String(card.createAt)
  if (property.type === 'updatedTime') return String(card.updateAt)
  return raw
}

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

export function evaluateProjectFormulaResult(expression: string, values: ReadonlyMap<string, string>): ProjectFormulaResult {
  const trimmed = expression.trim()
  if (!trimmed) return { value: '' }
  let tokens: Token[]
  try { tokens = tokenize(trimmed) } catch (error) { return { value: '', error: error instanceof Error ? error.message : 'invalid formula' } }
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
      const key = token.value.toLowerCase()
      if (!values.has(key)) throw new Error(`unknown reference ${token.value}`)
      const raw = values.get(key) ?? ''
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
        if (right === 0) throw new Error('division by zero')
        left = asNumber(left) / right
      } else if (eat('op', '%')) {
        const right = asNumber(primary())
        if (right === 0) throw new Error('division by zero')
        left = asNumber(left) % right
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
    if (cursor !== tokens.length) throw new Error('unexpected token')
    if (value === null) return { value: '' }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { value: '', error: 'non-finite result' }
      return { value: String(Math.round(value * 1e6) / 1e6) }
    }
    if (typeof value === 'boolean') return { value: value ? '✓' : '' }
    return { value }
  } catch (error) {
    return { value: '', error: error instanceof Error ? error.message : 'invalid formula' }
  }
}

export function evaluateProjectFormula(expression: string, values: ReadonlyMap<string, string>): string {
  return evaluateProjectFormulaResult(expression, values).value
}

export function projectFormulaDependencyOrder(properties: readonly ProjectProperty[]): { order: string[], cycles: Set<string>, dependencies: Map<string, string[]> } {
  const formulas = properties.filter((property) => property.type === 'formula' && property.config?.expression)
  const byReference = new Map<string, ProjectProperty>()
  for (const property of formulas) {
    byReference.set(property.id.toLowerCase(), property)
    byReference.set(property.name.trim().toLowerCase(), property)
  }
  const dependencies = new Map<string, string[]>()
  for (const property of formulas) {
    const refs = [...property.config!.expression!.matchAll(/\{([^}]+)\}/g)]
      .map((match) => byReference.get(match[1]!.trim().toLowerCase())?.id)
      .filter((id): id is string => Boolean(id))
    dependencies.set(property.id, [...new Set(refs)])
  }
  const state = new Map<string, number>()
  const cycles = new Set<string>()
  const path: string[] = []
  const order: string[] = []
  const visit = (id: string): void => {
    if (state.get(id) === 2) return
    if (state.get(id) === 1) {
      const start = path.indexOf(id)
      for (const entry of path.slice(start < 0 ? 0 : start)) cycles.add(entry)
      return
    }
    state.set(id, 1)
    path.push(id)
    for (const dependency of dependencies.get(id) ?? []) visit(dependency)
    path.pop()
    state.set(id, 2)
    if (!cycles.has(id)) order.push(id)
  }
  for (const property of formulas) visit(property.id)
  return { order, cycles, dependencies }
}
