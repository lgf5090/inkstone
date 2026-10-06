import { tagKey } from './markdown-utils'

export interface ParsedQuery {
  text: string
  terms: string[]
  tags: string[]
  excludedTags: string[]
  folder: string | null
  starred: boolean | null
  archived: boolean | null
  trash: boolean
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
