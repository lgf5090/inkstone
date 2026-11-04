import {
  acos,
  asin,
  atan,
  cos,
  evaluate,
  format,
  isUnit,
  parse,
  sin,
  tan,
} from 'mathjs'
import type { AssignmentNode, FunctionAssignmentNode, MathNode, SymbolNode } from 'mathjs'

/** How much text one document may hold before the engine refuses to evaluate it. */
export const TEXTCALC_MAX_LINES = 500
export const TEXTCALC_MAX_CHARS = 20000

export type TextCalcAngleMode = 'deg' | 'rad'

export interface TextCalcSettings {
  angleMode: TextCalcAngleMode
  precision: number
  thousands: boolean
  bases: boolean
}

export const DEFAULT_TEXTCALC_SETTINGS: TextCalcSettings = {
  angleMode: 'rad',
  precision: 10,
  thousands: true,
  bases: true,
}

export type TextCalcLineKind = 'empty' | 'comment' | 'expression' | 'assignment' | 'function'

export type TextCalcErrorCode =
  | 'syntax'
  | 'undefined_symbol'
  | 'undefined_function'
  | 'cycle'
  | 'unit_mismatch'
  | 'evaluate'

export interface TextCalcError {
  code: TextCalcErrorCode
  /** The raw identifier or mathjs message, shown after the localized label. */
  detail?: string
}

export interface TextCalcLineResult {
  /** Zero-based source line, so the gutter and the result rail share one index. */
  index: number
  source: string
  kind: TextCalcLineKind
  /** The formatted value for an expression or an assignment. */
  value?: string
  /** Extra base/unit detail for the result rail. */
  detail?: string
  error?: TextCalcError
  /** The name a line defines, when it defines one. */
  definedName?: string
  /** The parameters of a function definition, in source order. */
  definedParams?: string[]
}

export interface TextCalcLimit {
  kind: 'lines' | 'chars'
  actual: number
  max: number
}

export interface TextCalcEvaluation {
  lines: TextCalcLineResult[]
  /** The last line that produced a value, used by the summary bar. */
  lastValue: { line: number; text: string } | null
  limit: TextCalcLimit | null
  evaluatedCount: number
}

interface ParsedLine {
  index: number
  source: string
  code: string
  kind: TextCalcLineKind
  node: MathNode | null
  parseError: TextCalcError | null
}

interface Definition {
  index: number
  name: string
  node: MathNode
}

const NUMBER_PREFIX = /^(-?)(\d+)(\.\d+)?(e[+-]?\d+)?(.*)$/i

function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** Remove a trailing comment while keeping `#` and `//` inside a quoted literal. */
function stripComment(line: string): string {
  let quote: string | null = null
  for (let position = 0; position < line.length; position++) {
    const char = line[position]
    const next = line[position + 1]
    if (quote) {
      if (char === quote && line[position - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' || (char === '/' && next === '/')) return line.slice(0, position)
  }
  return line
}

function classify(node: MathNode): { kind: TextCalcLineKind; name?: string; params?: string[] } {
  if (node.type === 'AssignmentNode') {
    return { kind: 'assignment', name: (node as unknown as AssignmentNode).name }
  }
  if (node.type === 'FunctionAssignmentNode') {
    const definition = node as unknown as FunctionAssignmentNode
    return { kind: 'function', name: definition.name, params: definition.params }
  }
  return { kind: 'expression' }
}

/** Symbols a node reads, with function names and bound parameters left out. */
function collectSymbols(node: MathNode, bound: Set<string>, symbols: Set<string>): void {
  if (node.type === 'FunctionNode') {
    const call = node as { args?: MathNode[] }
    for (const argument of call.args ?? []) collectSymbols(argument, bound, symbols)
    return
  }
  if (node.type === 'SymbolNode') {
    const symbol = node as SymbolNode
    if (!bound.has(symbol.name)) symbols.add(symbol.name)
    return
  }
  node.forEach((child) => collectSymbols(child, bound, symbols))
}

function readSymbols(node: MathNode, bound: string[] = []): Set<string> {
  const symbols = new Set<string>()
  collectSymbols(node, new Set(bound), symbols)
  return symbols
}

/** A line-node graph, so a forward reference can still be told apart from a real cycle. */
function detectCycles(parsed: ParsedLine[]): Set<number> {
  const definitions: Definition[] = []
  for (const line of parsed) {
    if (!line.node || line.kind !== 'assignment') continue
    definitions.push({
      index: line.index,
      name: (line.node as unknown as AssignmentNode).name,
      node: (line.node as unknown as AssignmentNode).value,
    })
  }

  const byName = new Map<string, number[]>()
  for (const definition of definitions) {
    const lines = byName.get(definition.name) ?? []
    lines.push(definition.index)
    byName.set(definition.name, lines)
  }

  const edges = new Map<number, number[]>()
  for (const definition of definitions) {
    const reads = readSymbols(definition.node)
    for (const name of reads) {
      const candidates = byName.get(name)
      if (!candidates?.length) continue
      const previous = candidates.filter((index) => index < definition.index).at(-1)
      const next = candidates.find((index) => index > definition.index)
      const target = previous ?? next ?? (candidates.includes(definition.index) ? definition.index : null)
      if (target === null) continue
      const list = edges.get(definition.index) ?? []
      list.push(target)
      edges.set(definition.index, list)
    }
  }

  const state = new Map<number, 0 | 1 | 2>()
  const stack: number[] = []
  const inCycle = new Set<number>()
  const visit = (index: number) => {
    state.set(index, 1)
    stack.push(index)
    for (const target of edges.get(index) ?? []) {
      if (state.get(target) === 1) {
        const start = stack.indexOf(target)
        for (let position = start; position < stack.length; position++) inCycle.add(stack[position]!)
        continue
      }
      if (!state.has(target)) visit(target)
    }
    stack.pop()
    state.set(index, 2)
  }
  for (const definition of definitions) {
    if (!state.has(definition.index)) visit(definition.index)
  }
  return inCycle
}

/** Degree mode wraps only plain numbers; a value carrying its own unit keeps its own angle. */
function degreesScope(): Record<string, unknown> {
  const toRadians = (value: unknown) => (
    typeof value === 'number' ? (value * Math.PI) / 180 : value
  )
  const fromRadians = (value: number) => (value * 180) / Math.PI
  return {
    sin: (value: unknown) => sin(toRadians(value) as number),
    cos: (value: unknown) => cos(toRadians(value) as number),
    tan: (value: unknown) => tan(toRadians(value) as number),
    asin: (value: number) => {
      const result = asin(value)
      return typeof result === 'number' ? fromRadians(result) : result
    },
    acos: (value: number) => {
      const result = acos(value)
      return typeof result === 'number' ? fromRadians(result) : result
    },
    atan: (value: number) => {
      const result = atan(value)
      return typeof result === 'number' ? fromRadians(result) : result
    },
  }
}

function groupInteger(text: string): string {
  if (text.includes('e') || text.includes('E')) return text
  const match = NUMBER_PREFIX.exec(text)
  if (!match) return text
  const [, sign, integer, fraction, exponent, rest] = match
  if (!integer || exponent) return text
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}${fraction ?? ''}${rest}`
}

function baseDetail(value: number): string | undefined {
  if (!Number.isSafeInteger(value)) return undefined
  const magnitude = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  return `HEX ${sign}0x${magnitude.toString(16).toUpperCase()} · BIN ${sign}0b${magnitude.toString(2)} · OCT ${sign}0o${magnitude.toString(8)}`
}

function formatValue(value: unknown, settings: TextCalcSettings): { text: string; detail?: string } {
  if (typeof value === 'number') {
    // `auto` notation switches even a seven-digit integer to `1.234567e+6`; an integer keeps its
    // decimal spelling, which is also what the thousands separator and the base detail expect.
    const text = Number.isInteger(value)
      ? format(value, { notation: 'fixed', precision: 0 })
      : format(value, { precision: settings.precision })
    return {
      text: settings.thousands ? groupInteger(text) : text,
      detail: settings.bases ? baseDetail(value) : undefined,
    }
  }
  if (isUnit(value)) {
    const text = format(value, { precision: settings.precision })
    return { text: settings.thousands ? groupInteger(text) : text }
  }
  return { text: format(value, { precision: settings.precision }) }
}

function classifyError(error: unknown): TextCalcError {
  const message = error instanceof Error ? error.message : String(error)
  const undefinedSymbol = /Undefined symbol (\w+)/.exec(message)
  if (undefinedSymbol) return { code: 'undefined_symbol', detail: undefinedSymbol[1] }
  const undefinedFunction = /Undefined function (\w+)/.exec(message)
  if (undefinedFunction) return { code: 'undefined_function', detail: undefinedFunction[1] }
  if (/Units do not match|Unit .* does not match|Cannot convert/i.test(message)) {
    return { code: 'unit_mismatch', detail: message }
  }
  if (/Unexpected|Syntax|Parenthesis|Expected|Invalid|Value expected/i.test(message)) {
    return { code: 'syntax', detail: message }
  }
  return { code: 'evaluate', detail: message }
}

export function evaluateDocument(
  text: string,
  settings: TextCalcSettings = DEFAULT_TEXTCALC_SETTINGS,
): TextCalcEvaluation {
  const sources = splitLines(text)
  if (text.length > TEXTCALC_MAX_CHARS) {
    return {
      lines: [],
      lastValue: null,
      limit: { kind: 'chars', actual: text.length, max: TEXTCALC_MAX_CHARS },
      evaluatedCount: 0,
    }
  }
  if (sources.length > TEXTCALC_MAX_LINES) {
    return {
      lines: [],
      lastValue: null,
      limit: { kind: 'lines', actual: sources.length, max: TEXTCALC_MAX_LINES },
      evaluatedCount: 0,
    }
  }

  const parsed: ParsedLine[] = sources.map((source, index) => {
    const code = stripComment(source).trim()
    if (!code) {
      return { index, source, code, kind: source.trim().startsWith('#') || source.trim().startsWith('//') ? 'comment' : 'empty', node: null, parseError: null }
    }
    try {
      const node = parse(code)
      const kind = classify(node).kind
      return { index, source, code, kind, node, parseError: null }
    } catch (error) {
      return { index, source, code, kind: 'expression', node: null, parseError: classifyError(error) }
    }
  })

  const cycles = detectCycles(parsed)
  const scope: Record<string, unknown> = settings.angleMode === 'deg' ? degreesScope() : {}
  const lines: TextCalcLineResult[] = []
  let lastValue: TextCalcEvaluation['lastValue'] = null
  let evaluatedCount = 0

  for (const line of parsed) {
    if (line.kind === 'empty' || line.kind === 'comment') {
      lines.push({ index: line.index, source: line.source, kind: line.kind })
      continue
    }
    if (line.parseError) {
      lines.push({ index: line.index, source: line.source, kind: 'expression', error: line.parseError })
      continue
    }
    if (cycles.has(line.index)) {
      lines.push({
        index: line.index,
        source: line.source,
        kind: line.kind,
        error: { code: 'cycle' },
      })
      continue
    }

    try {
      const value = evaluate(line.code, scope)
      const classification = line.node ? classify(line.node) : { kind: 'expression' as const }
      if (classification.kind === 'function') {
        const definition = line.node as FunctionAssignmentNode
        const rendered = `${definition.name}(${definition.params.join(', ')})`
        lines.push({
          index: line.index,
          source: line.source,
          kind: 'function',
          value: rendered,
          definedName: definition.name,
          definedParams: definition.params,
        })
        lastValue = { line: line.index, text: rendered }
        evaluatedCount += 1
        continue
      }
      const formatted = formatValue(value, settings)
      lines.push({
        index: line.index,
        source: line.source,
        kind: classification.kind,
        value: formatted.text,
        detail: formatted.detail,
        definedName: classification.name,
      })
      lastValue = { line: line.index, text: formatted.text }
      evaluatedCount += 1
    } catch (error) {
      lines.push({
        index: line.index,
        source: line.source,
        kind: line.kind,
        error: classifyError(error),
      })
    }
  }

  return { lines, lastValue, limit: null, evaluatedCount }
}
