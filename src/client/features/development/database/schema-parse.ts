import type { ParsedColumn, ParsedTable, TableIndexInfo } from '@shared/development/database/types'

interface Token {
  type: 'ident' | 'string' | 'number' | 'punct'
  text: string
  raw: string
  quoted: boolean
}

const COLUMN_CONSTRAINTS = new Set([
  'PRIMARY',
  'NOT',
  'NULL',
  'UNIQUE',
  'DEFAULT',
  'CHECK',
  'REFERENCES',
  'COLLATE',
  'GENERATED',
  'AUTOINCREMENT',
  'CONSTRAINT',
])

const WORD_CHAR = /[\p{L}\p{N}_$]/u
const DIGIT = /[0-9]/
const OPERATORS = new Set(['||', '->', '->>', '<=', '>=', '!=', '==', '<>', '<<', '>>'])

function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const length = sql.length

  while (i < length) {
    const ch = sql[i]!
    const next = sql[i + 1]

    if (/\s/.test(ch)) {
      i++
      continue
    }

    if (ch === '-' && next === '-') {
      while (i < length && sql[i] !== '\n') i++
      continue
    }

    if (ch === '/' && next === '*') {
      i += 2
      while (i < length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i = Math.min(length, i + 2)
      continue
    }

    if (ch === "'") {
      let j = i + 1
      let raw = "'"
      while (j < length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            raw += "''"
            j += 2
            continue
          }
          raw += "'"
          j++
          break
        }
        raw += sql[j]
        j++
      }
      tokens.push({ type: 'string', text: raw, raw, quoted: false })
      i = j
      continue
    }

    if (ch === '"' || ch === '`') {
      const quote = ch
      let j = i + 1
      let text = ''
      while (j < length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            text += quote
            j += 2
            continue
          }
          j++
          break
        }
        text += sql[j]
        j++
      }
      tokens.push({ type: 'ident', text, raw: sql.slice(i, j), quoted: true })
      i = j
      continue
    }

    if (ch === '[') {
      const end = sql.indexOf(']', i + 1)
      const stop = end < 0 ? length : end + 1
      tokens.push({
        type: 'ident',
        text: end < 0 ? sql.slice(i + 1) : sql.slice(i + 1, end),
        raw: sql.slice(i, stop),
        quoted: true,
      })
      i = stop
      continue
    }

    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(next ?? ''))) {
      let j = i
      if (ch === '0' && (next === 'x' || next === 'X')) {
        j += 2
        while (j < length && /[0-9A-Fa-f]/.test(sql[j]!)) j++
      } else {
        let seenDot = false
        let seenExponent = false
        while (j < length) {
          const current = sql[j]!
          if (DIGIT.test(current)) {
            j++
            continue
          }
          if (current === '.' && !seenDot && !seenExponent) {
            seenDot = true
            j++
            continue
          }
          if ((current === 'e' || current === 'E') && !seenExponent) {
            seenExponent = true
            j++
            if (sql[j] === '+' || sql[j] === '-') j++
            continue
          }
          break
        }
      }
      const raw = sql.slice(i, j)
      tokens.push({ type: 'number', text: raw, raw, quoted: false })
      i = j
      continue
    }

    if (WORD_CHAR.test(ch)) {
      let j = i
      while (j < length && WORD_CHAR.test(sql[j]!)) j++
      const raw = sql.slice(i, j)
      tokens.push({ type: 'ident', text: raw, raw, quoted: false })
      i = j
      continue
    }

    const three = sql.slice(i, i + 3)
    if (OPERATORS.has(three)) {
      tokens.push({ type: 'punct', text: three, raw: three, quoted: false })
      i += 3
      continue
    }
    const two = sql.slice(i, i + 2)
    if (OPERATORS.has(two)) {
      tokens.push({ type: 'punct', text: two, raw: two, quoted: false })
      i += 2
      continue
    }

    tokens.push({ type: 'punct', text: ch, raw: ch, quoted: false })
    i++
  }

  return tokens
}

function upper(token: Token | undefined): string {
  if (!token || token.type !== 'ident' || token.quoted) return ''
  return token.text.toUpperCase()
}

function isKeyword(token: Token | undefined, keyword: string): boolean {
  return upper(token) === keyword
}

function renderTokens(tokens: Token[]): string {
  let out = ''
  let needsSpace = false
  for (const token of tokens) {
    if (token.type === 'punct') {
      if (token.text === '(') {
        out += '('
        needsSpace = false
        continue
      }
      if (token.text === ')') {
        out += ')'
        needsSpace = true
        continue
      }
      if (token.text === '.') {
        out += '.'
        needsSpace = false
        continue
      }
      if (token.text === ',') {
        out = `${out.replace(/\s+$/, '')}, `
        needsSpace = false
        continue
      }
      out = `${out.replace(/\s+$/, '')} ${token.text} `
      needsSpace = false
      continue
    }
    if (needsSpace && out && !out.endsWith(' ') && !out.endsWith('(') && !out.endsWith('.')) {
      out += ' '
    }
    out += token.raw
    needsSpace = true
  }
  return out.trim()
}

function splitTopLevel(tokens: Token[]): Token[][] {
  const parts: Token[][] = []
  let depth = 0
  let current: Token[] = []
  for (const token of tokens) {
    if (token.type === 'punct' && token.text === '(') depth++
    if (token.type === 'punct' && token.text === ')') depth--
    if (token.type === 'punct' && token.text === ',' && depth === 0) {
      parts.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) parts.push(current)
  return parts
}

function findMatchingParen(tokens: Token[], start: number): number {
  let depth = 0
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.type === 'punct' && token.text === '(') depth++
    else if (token.type === 'punct' && token.text === ')') {
      depth--
      if (depth <= 0) return i
    }
  }
  return tokens.length - 1
}

function skipOnConflict(tokens: Token[], start: number): number {
  if (isKeyword(tokens[start], 'ON') && isKeyword(tokens[start + 1], 'CONFLICT')) {
    return Math.min(tokens.length, start + 3)
  }
  return start
}

function simpleIndexColumn(term: Token[]): string | null {
  const first = term[0]
  if (!first || first.type !== 'ident') return null
  let i = 1
  while (i < term.length) {
    const keyword = upper(term[i])
    if (keyword === 'COLLATE' && term[i + 1]?.type === 'ident') {
      i += 2
      continue
    }
    if (keyword === 'ASC' || keyword === 'DESC') {
      i++
      continue
    }
    if (keyword === 'NULLS' && (isKeyword(term[i + 1], 'FIRST') || isKeyword(term[i + 1], 'LAST'))) {
      i += 2
      continue
    }
    return null
  }
  return first.text
}

function parseReferences(tokens: Token[], start: number): {
  references: { table: string; column?: string }
  next: number
} | null {
  let i = start + 1
  const nameParts: string[] = []
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token.type !== 'ident') break
    nameParts.push(token.text)
    i++
    if (tokens[i]?.type === 'punct' && tokens[i]!.text === '.') {
      i++
      continue
    }
    break
  }
  if (nameParts.length === 0) return null

  let column: string | undefined
  if (tokens[i]?.type === 'punct' && tokens[i]!.text === '(') {
    const end = findMatchingParen(tokens, i)
    const columns = splitTopLevel(tokens.slice(i + 1, end))
      .map((part) => simpleIndexColumn(part))
      .filter((name): name is string => Boolean(name))
    column = columns.length > 0 ? columns.join(', ') : undefined
    i = end + 1
  }

  for (;;) {
    const keyword = upper(tokens[i])
    if (keyword === 'ON' && (isKeyword(tokens[i + 1], 'DELETE') || isKeyword(tokens[i + 1], 'UPDATE'))) {
      i += 2
      const action = upper(tokens[i])
      if (action === 'SET' || action === 'NO') i += 2
      else i += 1
      continue
    }
    if (keyword === 'MATCH') {
      i += 2
      continue
    }
    if (keyword === 'NOT' && isKeyword(tokens[i + 1], 'DEFERRABLE')) {
      i += 2
      continue
    }
    if (keyword === 'DEFERRABLE') {
      i++
      if (isKeyword(tokens[i], 'INITIALLY')) i += 2
      continue
    }
    break
  }

  return { references: { table: nameParts.join('.'), column }, next: i }
}

function parseColumn(tokens: Token[]): ParsedColumn | null {
  const first = tokens[0]
  if (!first || first.type !== 'ident') return null

  const column: ParsedColumn = {
    name: first.text,
    type: '',
    notNull: false,
    pk: false,
    pkPosition: 0,
    default: null,
    unique: false,
    check: null,
    collate: null,
    generated: null,
    autoIncrement: false,
  }

  let i = 1
  const typeTokens: Token[] = []
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token.type === 'ident' && !token.quoted && COLUMN_CONSTRAINTS.has(token.text.toUpperCase())) break
    typeTokens.push(token)
    i++
  }
  column.type = renderTokens(typeTokens)

  while (i < tokens.length) {
    const token = tokens[i]!
    if (token.type !== 'ident' || token.quoted) {
      i++
      continue
    }
    const keyword = token.text.toUpperCase()

    if (keyword === 'PRIMARY') {
      i++
      if (isKeyword(tokens[i], 'KEY')) {
        column.pk = true
        column.pkPosition = 1
        i++
      }
      if (isKeyword(tokens[i], 'ASC') || isKeyword(tokens[i], 'DESC')) i++
      continue
    }

    if (keyword === 'AUTOINCREMENT') {
      column.autoIncrement = true
      i++
      continue
    }

    if (keyword === 'NOT') {
      i++
      if (isKeyword(tokens[i], 'NULL')) {
        column.notNull = true
        i++
      }
      i = skipOnConflict(tokens, i)
      continue
    }

    if (keyword === 'NULL') {
      column.notNull = false
      i++
      i = skipOnConflict(tokens, i)
      continue
    }

    if (keyword === 'UNIQUE') {
      column.unique = true
      i++
      i = skipOnConflict(tokens, i)
      continue
    }

    if (keyword === 'DEFAULT') {
      i++
      const expression: Token[] = []
      let depth = 0
      let firstExpression = true
      while (i < tokens.length) {
        const current = tokens[i]!
        const isConstraint =
          current.type === 'ident'
          && !current.quoted
          && COLUMN_CONSTRAINTS.has(current.text.toUpperCase())
        if (depth === 0 && isConstraint && !(firstExpression && current.text.toUpperCase() === 'NULL')) break
        if (current.type === 'punct' && current.text === '(') depth++
        else if (current.type === 'punct' && current.text === ')') {
          depth--
          if (depth < 0) break
        }
        expression.push(current)
        i++
        firstExpression = false
      }
      column.default = expression.length > 0 ? renderTokens(expression) : null
      continue
    }

    if (keyword === 'CHECK') {
      i++
      if (tokens[i]?.type === 'punct' && tokens[i]!.text === '(') {
        const end = findMatchingParen(tokens, i)
        column.check = renderTokens(tokens.slice(i, end + 1))
        i = end + 1
      }
      continue
    }

    if (keyword === 'COLLATE') {
      i++
      if (tokens[i]?.type === 'ident') {
        column.collate = tokens[i]!.text
        i++
      }
      continue
    }

    if (keyword === 'REFERENCES') {
      const parsed = parseReferences(tokens, i)
      if (!parsed) {
        i++
        continue
      }
      column.references = parsed.references
      i = parsed.next
      continue
    }

    if (keyword === 'GENERATED') {
      i++
      if (isKeyword(tokens[i], 'ALWAYS')) i++
      if (isKeyword(tokens[i], 'AS')) i++
      if (tokens[i]?.type === 'punct' && tokens[i]!.text === '(') {
        const end = findMatchingParen(tokens, i)
        let generated = renderTokens(tokens.slice(i, end + 1))
        i = end + 1
        if (isKeyword(tokens[i], 'STORED') || isKeyword(tokens[i], 'VIRTUAL')) {
          generated += ` ${upper(tokens[i])}`
          i++
        }
        column.generated = generated
      }
      continue
    }

    if (keyword === 'CONSTRAINT') {
      i += 2
      continue
    }

    i++
  }

  return column
}

function isTableConstraint(part: Token[]): boolean {
  const first = part[0]
  if (!first || first.type !== 'ident' || first.quoted) return false
  const keyword = first.text.toUpperCase()
  if (keyword === 'PRIMARY') return isKeyword(part[1], 'KEY')
  if (keyword === 'FOREIGN') return isKeyword(part[1], 'KEY')
  if (keyword === 'UNIQUE' || keyword === 'CHECK') {
    return part[1]?.type === 'punct' && part[1]!.text === '('
  }
  if (keyword === 'CONSTRAINT') {
    const kind = upper(part[2])
    return kind === 'PRIMARY' || kind === 'FOREIGN' || kind === 'UNIQUE' || kind === 'CHECK'
  }
  return false
}

function tableConstraintOffset(part: Token[]): number {
  return upper(part[0]) === 'CONSTRAINT' ? 2 : 0
}

function primaryKeyFromConstraint(part: Token[]): string[] {
  const offset = tableConstraintOffset(part)
  if (!isKeyword(part[offset], 'PRIMARY')) return []
  let open = offset + 1
  while (open < part.length && !(part[open]!.type === 'punct' && part[open]!.text === '(')) open++
  if (open >= part.length) return []
  const end = findMatchingParen(part, open)
  return splitTopLevel(part.slice(open + 1, end))
    .map((term) => simpleIndexColumn(term))
    .filter((name): name is string => Boolean(name))
}

export function parseCreateTable(sql: string): ParsedTable | null {
  try {
    const tokens = tokenize(sql)
    if (!isKeyword(tokens[0], 'CREATE')) return null

    let i = 1
    let sawTable = false
    while (i < tokens.length) {
      const keyword = upper(tokens[i])
      if (keyword === 'TABLE') {
        sawTable = true
        i++
        break
      }
      if (keyword === 'INDEX' || keyword === 'VIEW' || keyword === 'TRIGGER') return null
      i++
    }
    if (!sawTable) return null

    if (isKeyword(tokens[i], 'IF')) {
      if (!isKeyword(tokens[i + 1], 'NOT') || !isKeyword(tokens[i + 2], 'EXISTS')) return null
      i += 3
    }

    const nameParts: string[] = []
    while (i < tokens.length) {
      const token = tokens[i]!
      if (token.type !== 'ident') break
      nameParts.push(token.text)
      i++
      if (tokens[i]?.type === 'punct' && tokens[i]!.text === '.') {
        i++
        continue
      }
      break
    }
    if (nameParts.length === 0) return null
    const name = nameParts[nameParts.length - 1]!

    if (!(tokens[i]?.type === 'punct' && tokens[i]!.text === '(')) return null
    const close = findMatchingParen(tokens, i)
    if (close <= i) return null
    const body = tokens.slice(i + 1, close)
    i = close + 1

    let withoutRowid = false
    let strict = false
    while (i < tokens.length) {
      if (isKeyword(tokens[i], 'WITHOUT') && isKeyword(tokens[i + 1], 'ROWID')) {
        withoutRowid = true
        i += 2
        continue
      }
      if (isKeyword(tokens[i], 'STRICT')) {
        strict = true
        i++
        continue
      }
      i++
    }

    const columns: ParsedColumn[] = []
    const tableConstraints: string[] = []
    let tablePrimaryKey: string[] = []

    for (const part of splitTopLevel(body)) {
      if (part.length === 0) continue
      if (isTableConstraint(part)) {
        tableConstraints.push(renderTokens(part))
        const primaryKey = primaryKeyFromConstraint(part)
        if (primaryKey.length > 0) tablePrimaryKey = primaryKey
        continue
      }
      const column = parseColumn(part)
      if (column) columns.push(column)
    }

    if (tablePrimaryKey.length > 0) {
      tablePrimaryKey.forEach((columnName, position) => {
        const target = columns.find(
          (column) => column.name.toLowerCase() === columnName.toLowerCase(),
        )
        if (target) {
          target.pk = true
          target.pkPosition = position + 1
        }
      })
    }

    return {
      name,
      sql,
      columns,
      tableConstraints,
      withoutRowid,
      strict,
    }
  } catch {
    return null
  }
}

export function parseCreateIndex(sql: string): Omit<TableIndexInfo, 'name' | 'sql'> | null {
  try {
    const tokens = tokenize(sql)
    if (!isKeyword(tokens[0], 'CREATE')) return null

    let i = 1
    let unique = false
    if (isKeyword(tokens[i], 'UNIQUE')) {
      unique = true
      i++
    }
    if (!isKeyword(tokens[i], 'INDEX')) return null
    i++

    if (isKeyword(tokens[i], 'IF')) {
      if (!isKeyword(tokens[i + 1], 'NOT') || !isKeyword(tokens[i + 2], 'EXISTS')) return null
      i += 3
    }

    if (tokens[i]?.type !== 'ident') return null
    i++
    if (tokens[i]?.type === 'punct' && tokens[i]!.text === '.') {
      i++
      if (tokens[i]?.type !== 'ident') return null
      i++
    }

    if (!isKeyword(tokens[i], 'ON')) return null
    i++

    if (tokens[i]?.type !== 'ident') return null
    i++
    if (tokens[i]?.type === 'punct' && tokens[i]!.text === '.') {
      i++
      if (tokens[i]?.type !== 'ident') return null
      i++
    }

    if (!(tokens[i]?.type === 'punct' && tokens[i]!.text === '(')) return null
    const end = findMatchingParen(tokens, i)
    if (end <= i) return null

    const columns: string[] = []
    for (const term of splitTopLevel(tokens.slice(i + 1, end))) {
      const column = simpleIndexColumn(term)
      if (column) columns.push(column)
    }
    return { unique, columns, origin: 'c' }
  } catch {
    return null
  }
}

export function parseIndexesFromSchema(
  objects: ReadonlyArray<{ type: string; name: string; sql: string | null }>,
): TableIndexInfo[] {
  const indexes: TableIndexInfo[] = []
  for (const object of objects) {
    if (object.type !== 'index' || !object.sql) continue
    const parsed = parseCreateIndex(object.sql)
    indexes.push(
      parsed
        ? { name: object.name, sql: object.sql, ...parsed }
        : { name: object.name, sql: object.sql, unique: false, columns: [], origin: 'c' },
    )
  }
  return indexes
}

export function extractSqlIdentifiers(sql: string): string[] {
  return tokenize(sql)
    .filter((token) => token.type === 'ident')
    .map((token) => token.text)
}
