import { tagKey } from './markdown-utils'

export type NoteDateOperator = '=' | '!=' | '>' | '>=' | '<' | '<='

export interface NoteDateFilter {
  operator: NoteDateOperator
  time: number
  end?: number
}

export interface NotePropertyFilter {
  key: string
  operator: 'exists' | '=' | '!='
  value?: string
}

export interface ParsedQuery {
  text: string
  terms: string[]
  tags: string[]
  excludedTags: string[]
  folder: string | null
  starred: boolean | null
  archived: boolean | null
  trash: boolean
  created: NoteDateFilter | null
  updated: NoteDateFilter | null
  properties: NotePropertyFilter[]
}

export function emptyParsedQuery(): ParsedQuery {
  return {
    text: '',
    terms: [],
    tags: [],
    excludedTags: [],
    folder: null,
    starred: null,
    archived: null,
    trash: false,
    created: null,
    updated: null,
    properties: [],
  }
}

const TOKEN_RE = /(-?[A-Za-z]+):"([^"]*)"|"([^"]*)"|(\S+)/g

export function parseQuery(raw: string): ParsedQuery {
  const parsed = emptyParsedQuery()
  const plain: string[] = []

  for (const match of raw.matchAll(TOKEN_RE)) {
    const quotedKey = match[1]
    const quotedValue = match[2]
    const quoted = match[3]
    const bare = match[4]
    if (quotedKey !== undefined) {
      const negated = quotedKey.startsWith('-')
      const key = (negated ? quotedKey.slice(1) : quotedKey).toLowerCase()
      const value = quotedValue?.trim() ?? ''
      if (key === 'tag' && value) pushTag(parsed, value, negated)
      else if (key === 'folder' && value && !negated) parsed.folder = value
      else if (key === 'property' && value && !negated) {
        const filter = parsePropertyFilter(value)
        if (filter) parsed.properties.push(filter)
        else if (value) {
          parsed.terms.push(`${quotedKey}:${value}`)
          plain.push(`${quotedKey}:${value}`)
        }
      }
      else if (!negated && (key === 'created' || key === 'updated')) {
        const filter = parseNoteDate(value)
        if (filter) parsed[key] = filter
        else if (value) {
          parsed.terms.push(`${quotedKey}:${value}`)
          plain.push(`${quotedKey}:${value}`)
        }
      }
      else if (value) {
        const token = `${quotedKey}:${value}`
        parsed.terms.push(token)
        plain.push(token)
      }
      continue
    }
    if (quoted !== undefined) {
      if (quoted.trim()) {
        parsed.terms.push(quoted.trim())
        plain.push(quoted.trim())
      }
      continue
    }
    const token = bare ?? ''
    const colon = token.indexOf(':')
    if (colon > 0) {
      const rawKey = token.slice(0, colon)
      const negated = rawKey.startsWith('-')
      const key = (negated ? rawKey.slice(1) : rawKey).toLowerCase()
      const value = token.slice(colon + 1)
      if (key === 'tag' && value) {
        pushTag(parsed, value, negated)
        continue
      }
      if (key === 'folder' && value && !negated) {
        parsed.folder = value
        continue
      }
      if (!negated && (key === 'created' || key === 'updated')) {
        const filter = parseNoteDate(value)
        if (filter) {
          parsed[key] = filter
          continue
        }
      }
      if (key === 'property' && value && !negated) {
        const filter = parsePropertyFilter(value)
        if (filter) {
          parsed.properties.push(filter)
          continue
        }
      }
      if (key === 'is' && !negated) {
        const qualifier = value.toLowerCase()
        if (qualifier === 'starred') parsed.starred = true
        else if (qualifier === 'archived') parsed.archived = true
        else if (qualifier === 'unarchived') parsed.archived = false
        else if (qualifier) {
          parsed.terms.push(token)
          plain.push(token)
        }
        if (qualifier) continue
      }
      if (key === 'in' && !negated && value.toLowerCase() === 'trash') {
        parsed.trash = true
        continue
      }
    }
    if (token) {
      parsed.terms.push(token)
      plain.push(token)
    }
  }

  parsed.terms = [...new Set(parsed.terms)].slice(0, 12)
  parsed.tags = dedupeTags(parsed.tags).slice(0, 8)
  parsed.excludedTags = dedupeTags(parsed.excludedTags).slice(0, 8)
  parsed.properties = parsed.properties.slice(0, 8)
  parsed.text = plain.slice(0, 12).join(' ')
  return parsed
}

function pushTag(parsed: ParsedQuery, value: string, negated: boolean): void {
  const name = value.replace(/^#/, '').trim()
  if (!name) return
  ;(negated ? parsed.excludedTags : parsed.tags).push(name)
}

function dedupeTags(names: string[]): string[] {
  const seen = new Map<string, string>()
  for (const name of names) {
    const key = tagKey(name)
    if (!seen.has(key)) seen.set(key, name)
  }
  return [...seen.values()]
}

const NOTE_QUERY_OR_BRANCHES_MAX = 8
const DAY_MS = 86_400_000

export function parseQueryBranches(raw: string): ParsedQuery[] {
  const source = raw.trim()
  if (!source) return [emptyParsedQuery()]
  const branches: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < source.length && branches.length < NOTE_QUERY_OR_BRANCHES_MAX - 1; index++) {
    const char = source[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quoted) {
      escaped = true
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (quoted || source.slice(index, index + 2).toLowerCase() !== 'or') continue
    const before = index === 0 ? ' ' : source[index - 1]!
    const after = source[index + 2] ?? ' '
    if (!/\s/.test(before) || !/\s/.test(after)) continue
    const branch = source.slice(start, index).trim()
    if (branch) branches.push(branch)
    index += 1
    start = index + 1
  }
  branches.push(source.slice(start).trim())
  return branches.filter(Boolean).map(parseQuery)
}

export function matchesNoteDate(value: number, filter: NoteDateFilter): boolean {
  switch (filter.operator) {
    case '=': return filter.end === undefined ? value === filter.time : value >= filter.time && value < filter.end
    case '!=': return filter.end === undefined ? value !== filter.time : value < filter.time || value >= filter.end
    case '>': return filter.end === undefined ? value > filter.time : value >= filter.end
    case '>=': return value >= filter.time
    case '<': return value < filter.time
    case '<=': return filter.end === undefined ? value <= filter.time : value < filter.end
  }
}

function parsePropertyFilter(raw: string): NotePropertyFilter | null {
  const source = raw.trim()
  if (source.startsWith('=')) return null
  const comparison = /^(.+?)(!=|=)(.*)$/.exec(source)
  const key = (comparison?.[1] ?? raw).trim().replace(/^["']|["']$/g, '').slice(0, 128)
  if (!key) return null
  if (!comparison) return { key, operator: 'exists' }
  const value = comparison[3]!.trim().replace(/^["']|["']$/g, '').slice(0, 200)
  if (!value) return null
  return { key, operator: comparison[2] === '!=' ? '!=' : '=', value }
}

function parseNoteDate(raw: string): NoteDateFilter | null {
  const match = /^(>=|<=|!=|>|<|=)?\s*(.+)$/.exec(raw.trim())
  if (!match) return null
  const operator = (match[1] ?? '=') as NoteDateOperator
  const value = match[2]!.trim()
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (day) {
    const year = Number(day[1])
    const month = Number(day[2])
    const date = Number(day[3])
    const time = Date.UTC(year, month - 1, date)
    const back = new Date(time)
    if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== date) return null
    return { operator, time, end: time + DAY_MS }
  }
  const time = Date.parse(value)
  return Number.isFinite(time) ? { operator, time } : null
}
