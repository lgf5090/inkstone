export type TemplateHelper = (args: string[]) => string

export interface TemplateVariables {
  propertyName: string
  propertyValue: string
  [name: string]: string
}

const MAX_TEMPLATE_LENGTH = 512
const MAX_OUTPUT_LENGTH = 4096
const MAX_DEPTH = 5
const MAX_NODES = 2000

const NAME_WORD = /^[A-Za-z_][A-Za-z0-9_]*$/

const RESERVED_WORDS = new Set(['true', 'false', 'null'])

interface RenderBudget {
  nodes: number
}


export function renderPropertyTemplate(
  template: string,
  variables: TemplateVariables,
  helpers: Record<string, TemplateHelper>,
): string | null {
  if (typeof template !== 'string' || !template.length || template.length > MAX_TEMPLATE_LENGTH)
    return null
  const budget: RenderBudget = { nodes: 0 }
  try {
    const out = evaluate(template, variables, helpers, 0, budget)
    if (out.length > MAX_OUTPUT_LENGTH)
      return null
    return out
  }
  catch {
    return null
  }
}

function evaluate(
  source: string,
  variables: TemplateVariables,
  helpers: Record<string, TemplateHelper>,
  depth: number,
  budget: RenderBudget,
): string {
  if (depth > MAX_DEPTH)
    return ''
  let out = ''
  let index = 0
  while (index < source.length) {
    if (source[index] === '\\' && source.startsWith('{{', index + 1)) {
      out += '{{'
      index += 3
      continue
    }
    const open = source.indexOf('{{', index)
    if (open < 0) {
      out += source.slice(index)
      break
    }
    out += source.slice(index, open)
    const close = findClosing(source, open + 2)
    if (close < 0) {
      out += source.slice(open)
      break
    }
    out += evaluateExpression(source.slice(open + 2, close), variables, helpers, depth + 1, budget)
    index = close + 2
  }
  return out
}

function findClosing(source: string, from: number): number {
  let depth = 0
  let index = from
  while (index < source.length) {
    if (source.startsWith('{{', index)) {
      depth += 1
      index += 2
      continue
    }
    if (source.startsWith('}}', index)) {
      if (depth === 0)
        return index
      depth -= 1
      index += 2
      continue
    }
    if (source[index] === '"' || source[index] === "'") {
      index = skipQuoted(source, index)
      continue
    }
    index += 1
  }
  return -1
}

function skipQuoted(source: string, start: number): number {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === quote)
      return index + 1
    if (source.startsWith('}}', index))
      break
    index += 1
  }
  return index
}

function evaluateExpression(
  inner: string,
  variables: TemplateVariables,
  helpers: Record<string, TemplateHelper>,
  depth: number,
  budget: RenderBudget,
): string {
  if (depth > MAX_DEPTH)
    throw new TemplateFailure('depth')
  const tokens = tokenize(inner, variables, helpers, depth, budget)
  if (!tokens.length)
    return ''
  const first = tokens[0]!
  if (first.callee) {
    if (Object.prototype.hasOwnProperty.call(helpers, first.text))
      return helpers[first.text]!(tokens.slice(1).map(token => token.text))
    throw new TemplateFailure(first.text)
  }
  return tokens.map(token => token.text).join('')
}

class TemplateFailure extends Error {}

interface Token {
  text: string
  callee: boolean
}

function tokenize(
  inner: string,
  variables: TemplateVariables,
  helpers: Record<string, TemplateHelper>,
  depth: number,
  budget: RenderBudget,
): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < inner.length) {
    if (++budget.nodes > MAX_NODES)
      throw new TemplateFailure('budget')
    const char = inner[index]!
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      const end = skipQuoted(inner, index)
      tokens.push({ text: unquote(inner.slice(index + 1, end - 1)), callee: false })
      index = end
      continue
    }
    if (char === '{' && inner.startsWith('{{', index)) {
      const close = findClosing(inner, index + 2)
      if (close < 0) {
        index += 2
        continue
      }
      const nested = evaluateExpression(inner.slice(index + 2, close), variables, helpers, depth + 1, budget)
      tokens.push({ text: nested, callee: false })
      index = close + 2
      continue
    }
    let next = index
    while (next < inner.length && !' \t\n\r'.includes(inner[next]!) && !inner.startsWith('}}', next))
      next += 1
    const word = inner.slice(index, next)
    index = next
    if (!word)
      continue
    if (Object.prototype.hasOwnProperty.call(variables, word)) {
      tokens.push({ text: variables[word] ?? '', callee: false })
      continue
    }
    if (RESERVED_WORDS.has(word) || isNumber(word)) {
      tokens.push({ text: word === 'null' ? '' : word, callee: false })
      continue
    }
    if (!tokens.length && NAME_WORD.test(word)) {
      tokens.push({ text: word, callee: true })
      continue
    }
    throw new TemplateFailure(word)
  }
  return tokens
}

function isNumber(word: string): boolean {
  return /^-?\d+(?:\.\d+)?$/.test(word)
}

function unquote(value: string): string {
  return value.replace(/\\(["'\\])/g, '$1')
}
