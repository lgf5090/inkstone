import type { FuzzyMatch } from './fuzzy'
import { fuzzyMatch } from './fuzzy'
import { findGroups, repeatsCatastrophically } from '@shared/regex-safety'

export type QueryError = 'syntax' | 'unsafe'

export interface Query {
  readonly text: string
  readonly mode: 'fuzzy' | 'regex'
  readonly error: QueryError | null
  readonly pattern: RegExp | null
}

const MAX_PATTERN_CHARS = 160
const MAX_MATCHED_CHARS = 256
const MAX_RANGES = 8
const ALLOWED_FLAGS = 'imsu'
const REGEX_SYNTAX = /^\/(.+)\/([a-z]*)$/s

const EMPTY: Query = { text: '', mode: 'fuzzy', error: null, pattern: null }
const FUZZY = (text: string): Query => ({ text, mode: 'fuzzy', error: null, pattern: null })
const REFUSED = (text: string, error: QueryError): Query => ({ text, mode: 'regex', error, pattern: null })

/**
 * What a listing's filter box was asked for. `/body/flags` is a regular expression and anything
 * else is the fuzzy matcher, which reads Chinese labels by their initials; both answer in the same
 * shape, so a row can underline either without knowing which it got.
 */
export function compileQuery(source: string): Query {
  const text = source.trim()
  if (!text) return EMPTY
  const syntax = REGEX_SYNTAX.exec(text)
  if (!syntax) return FUZZY(text)
  const body = syntax[1]!
  if (body.length > MAX_PATTERN_CHARS) return REFUSED(text, 'unsafe')
  const groups = findGroups(body)
  if (!groups) return REFUSED(text, 'syntax')
  if (repeatsCatastrophically(body, groups)) return REFUSED(text, 'unsafe')
  let flags = 'i'
  for (const flag of syntax[2]!) {
    if (ALLOWED_FLAGS.includes(flag) && !flags.includes(flag)) flags += flag
  }
  try {
    return { text, mode: 'regex', error: null, pattern: new RegExp(body, `${flags}g`) }
  }
  catch {
    return REFUSED(text, 'syntax')
  }
}

/**
 * Where the query lands in a label, or null when it does not. A repeated group's own failure is what
 * makes backtracking explode, so the expression is handed a capped slice: this compares names, and a
 * listing that hands it a body instead of a title is answered from the part of it a reader can see
 * anyway. The fuzzy matcher needs no such ceiling — a scan cannot blow up on length.
 */
export function queryMatches(query: Query, subject: string): FuzzyMatch | null {
  if (query.error) return null
  const pattern = query.pattern
  if (!pattern) return fuzzyMatch(subject, query.text)
  const text = subject.length > MAX_MATCHED_CHARS ? subject.slice(0, MAX_MATCHED_CHARS) : subject
  pattern.lastIndex = 0
  const found = pattern.exec(text)
  if (!found) return null
  if (!found[0]) return { score: 900, ranges: [] }
  const ranges: [number, number][] = [[found.index, found.index + found[0].length]]
  let cursor = found.index + found[0].length
  while (cursor < text.length && ranges.length < MAX_RANGES) {
    pattern.lastIndex = cursor
    const again = pattern.exec(text)
    if (!again || !again[0]) break
    ranges.push([again.index, again.index + again[0].length])
    cursor = again.index + again[0].length
  }
  return { score: 1000 - Math.min(found.index, 200) * 2 + (found.index === 0 ? 300 : 0), ranges }
}
