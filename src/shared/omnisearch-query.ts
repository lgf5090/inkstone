/**
 * The query grammar of the Omnisearch prompt. It extends the list search's qualifier set with the
 * operators the reference plugin is known for — `ext:`/`.ext`, `path:`, quoted phrases, and `-` in
 * front of any of them. Unknown `key:value` pairs stay text, so a mistyped qualifier searches for
 * the literal instead of quietly filtering the result set.
 */
import { tagKey } from './markdown-utils'
import { truncateText } from './text-utils'

export const OMNISEARCH_QUERY_MAX_CHARS = 512
const TOKEN_LIMIT = 12
const TAG_LIMIT = 8

export interface ParsedOmnisearchQuery {
  raw: string
  /** The text terms joined, which is what the index is actually asked for. */
  text: string
  terms: string[]
  exact: string[]
  excludeTerms: string[]
  ext: string[]
  excludeExt: string[]
  path: string[]
  excludePath: string[]
  tags: string[]
  excludeTags: string[]
  /** `#tag` terms: they lift matching notes instead of filtering the rest out. */
  boostedTags: string[]
  folder: string | null
  starred: boolean | null
  archived: boolean | null
  trash: boolean
}

type TokenKind = 'text' | 'phrase' | 'tag' | 'ext' | 'keyword'
interface Token {
  kind: TokenKind
  negated: boolean
  key: string
  value: string
}

const KEYWORDS = new Set(['tag', 'ext', 'path', 'folder', 'is', 'in'])
const QUOTED_SPAN = /"([^"]*)"|'([^']*)'/

export function emptyOmnisearchQuery(raw = ''): ParsedOmnisearchQuery {
  return {
    raw,
    text: '',
    terms: [],
    exact: [],
    excludeTerms: [],
    ext: [],
    excludeExt: [],
    path: [],
    excludePath: [],
    tags: [],
    excludeTags: [],
    boostedTags: [],
    folder: null,
    starred: null,
    archived: null,
    trash: false,
  }
}

/**
 * Quoted spans are lifted out before splitting, so `tag:"two words"` stays one value and a phrase
 * never arrives in pieces. A placeholder is one NUL-delimited index; NUL is stripped first so a
 * reader cannot forge one.
 */
function scanTokens(source: string): Token[] {
  const quoted: string[] = []
  const text = source.replace(/\0/g, '').replace(new RegExp(QUOTED_SPAN.source, 'g'), (_all, double, single) => {
    const value = String(double ?? single ?? '').trim()
    if (!value) return ' '
    quoted.push(value)
    return `\u0000${quoted.length - 1}\u0000`
  })
  const tokens: Token[] = []
  for (const piece of text.split(/\s+/)) {
    if (!piece) continue
    const negated = piece.startsWith('-')
    const body = (negated ? piece.slice(1) : piece).replace(/^["']/, '')
    if (!body) continue
    const standalone = /^\u0000(\d+)\u0000$/.exec(body)
    if (standalone) {
      tokens.push({ kind: 'phrase', negated, key: '', value: quoted[Number(standalone[1])] ?? '' })
      continue
    }
    if (body.startsWith('#')) {
      tokens.push({ kind: 'tag', negated, key: 'tag', value: expand(body.slice(1), quoted) })
      continue
    }
    if (body.startsWith('.')) {
      tokens.push({ kind: 'ext', negated, key: 'ext', value: expand(body.slice(1), quoted) })
      continue
    }
    const colon = body.indexOf(':')
    if (colon > 0 && colon < body.length - 1 && KEYWORDS.has(body.slice(0, colon).toLowerCase())) {
      const key = body.slice(0, colon).toLowerCase()
      const raw = body.slice(colon + 1)
      const wrapped = /^\u0000(\d+)\u0000$/.exec(raw)
      if (wrapped) {
        tokens.push({ kind: 'phrase', negated, key, value: quoted[Number(wrapped[1])] ?? '' })
        continue
      }
      tokens.push({ kind: 'keyword', negated, key, value: expand(raw, quoted) })
      continue
    }
    tokens.push({ kind: 'text', negated, key: '', value: expand(body, quoted) })
  }
  return tokens
}

function expand(value: string, quoted: string[]): string {
  return value.replace(/\u0000(\d+)\u0000/g, (_all, index: string) => quoted[Number(index)] ?? '')
}

function push(list: string[], value: string, limit: number): void {
  if (value && !list.includes(value) && list.length < limit) list.push(value)
}

function normalizeExt(value: string): string {
  return value.replace(/\.+/, '').trim().toLowerCase()
}

export function parseOmnisearchQuery(raw: string, fold: (value: string) => string): ParsedOmnisearchQuery {
  // The stored form is cut here as well, so nothing downstream can echo a pasted wall of text.
  const clipped = truncateText(raw, OMNISEARCH_QUERY_MAX_CHARS)
  const query = emptyOmnisearchQuery(clipped)
  for (const token of scanTokens(clipped)) {
    const value = fold(token.value.trim())
    if (!value) continue
    switch (token.kind) {
      case 'phrase':
        if (token.key) {
          applyKeyword(query, token.key, value, token.negated)
          break
        }
        if (token.negated) push(query.excludeTerms, value, TOKEN_LIMIT)
        else {
          push(query.terms, value, TOKEN_LIMIT)
          push(query.exact, value, TOKEN_LIMIT)
        }
        break
      case 'tag':
        push(token.negated ? query.excludeTags : query.boostedTags, tagKey(value), TAG_LIMIT)
        break
      case 'ext': {
        const ext = normalizeExt(value)
        if (ext) push(token.negated ? query.excludeExt : query.ext, ext, TOKEN_LIMIT)
        break
      }
      case 'keyword':
        applyKeyword(query, token.key, value, token.negated)
        break
      case 'text':
        push(token.negated ? query.excludeTerms : query.terms, value, TOKEN_LIMIT)
        break
    }
  }
  query.text = query.terms.join(' ')
  return query
}

function applyKeyword(query: ParsedOmnisearchQuery, key: string, value: string, negated: boolean): void {
  switch (key) {
    case 'tag': {
      const name = tagKey(value.replace(/^#/, ''))
      if (name) push(negated ? query.excludeTags : query.tags, name, TAG_LIMIT)
      return
    }
    case 'ext': {
      const ext = normalizeExt(value)
      if (ext) push(negated ? query.excludeExt : query.ext, ext, TOKEN_LIMIT)
      return
    }
    case 'path':
      push(negated ? query.excludePath : query.path, value, TOKEN_LIMIT)
      return
    case 'folder':
      // The folder qualifier only describes where a note lives, so a negation falls back to the
      // path filter rather than silently matching every note.
      if (negated) push(query.excludePath, value, TOKEN_LIMIT)
      else query.folder = value
      return
    case 'is': {
      const qualifier = value.toLowerCase()
      if (qualifier === 'starred') query.starred = !negated
      else if (qualifier === 'archived') query.archived = !negated
      else if (qualifier === 'unarchived') query.archived = negated
      else if (qualifier === 'trash') query.trash = !negated
      else push(query.terms, `${negated ? '-' : ''}${key}:${value}`, TOKEN_LIMIT)
      return
    }
    case 'in':
      if (value.toLowerCase() === 'trash') query.trash = !negated
      else push(query.terms, `${negated ? '-' : ''}${key}:${value}`, TOKEN_LIMIT)
      return
    default:
      push(query.terms, `${negated ? '-' : ''}${key}:${value}`, TOKEN_LIMIT)
  }
}

export function isOmnisearchQueryEmpty(query: ParsedOmnisearchQuery): boolean {
  return !(
    query.terms.length ||
    query.exact.length ||
    query.ext.length ||
    query.path.length ||
    query.tags.length ||
    query.boostedTags.length ||
    query.folder ||
    query.starred !== null ||
    query.archived !== null ||
    query.trash
  )
}

/** The longest phrase to anchor the excerpt on, which is what a reader actually wants to see. */
export function excerptStringOf(query: ParsedOmnisearchQuery): string {
  if (query.exact.length) {
    return [...query.exact].sort((a, b) => b.length - a.length)[0] ?? ''
  }
  return query.text
}
