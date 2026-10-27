interface TextPart {
  kind: 'text'
  text: string
}

interface PlaceholderPart {
  kind: 'placeholder'
  name: string
}

type SqlPart = TextPart | PlaceholderPart

export type PlaceholderValues = Record<string, string | number | bigint | boolean | null | undefined>

const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/

function scanSql(sql: string): SqlPart[] {
  const parts: SqlPart[] = []
  let text = ''
  let i = 0
  const length = sql.length

  const flush = (): void => {
    if (text) {
      parts.push({ kind: 'text', text })
      text = ''
    }
  }

  while (i < length) {
    const ch = sql[i]!
    const next = sql[i + 1]

    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i
      i++
      while (i < length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      text += sql.slice(start, i)
      continue
    }

    if (ch === '[') {
      const start = i
      i++
      while (i < length) {
        if (sql[i] === ']') {
          if (sql[i + 1] === ']') {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      text += sql.slice(start, i)
      continue
    }

    if (ch === '-' && next === '-') {
      const start = i
      i += 2
      while (i < length && sql[i] !== '\n') i++
      text += sql.slice(start, i)
      continue
    }

    if (ch === '/' && next === '*') {
      const start = i
      i += 2
      while (i < length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i = Math.min(length, i + 2)
      text += sql.slice(start, i)
      continue
    }

    if (ch === ':' && next === ':') {
      text += '::'
      i += 2
      continue
    }

    if (ch === ':' && NAME_START.test(next ?? '')) {
      let j = i + 1
      while (j < length && NAME_CHAR.test(sql[j]!)) j++
      flush()
      parts.push({ kind: 'placeholder', name: sql.slice(i + 1, j) })
      i = j
      continue
    }

    text += ch
    i++
  }

  flush()
  return parts
}

export function findPlaceholders(sql: string): string[] {
  const names: string[] = []
  for (const part of scanSql(sql)) {
    if (part.kind === 'placeholder' && !names.includes(part.name)) names.push(part.name)
  }
  return names
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function literalFor(name: string, values: PlaceholderValues): string {
  if (!Object.prototype.hasOwnProperty.call(values, name)) {
    throw new Error(`Missing value for placeholder :${name}`)
  }
  const value = values[name]
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for placeholder :${name}`)
    return String(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'

  const trimmed = value.trim()
  if (NUMERIC.test(trimmed)) return trimmed
  if (trimmed.toUpperCase() === 'NULL') return 'NULL'
  if (trimmed.toLowerCase() === 'true') return '1'
  if (trimmed.toLowerCase() === 'false') return '0'
  return quoteString(value)
}

export function replacePlaceholders(sql: string, values: PlaceholderValues): string {
  return scanSql(sql)
    .map((part) => (part.kind === 'text' ? part.text : literalFor(part.name, values)))
    .join('')
}
