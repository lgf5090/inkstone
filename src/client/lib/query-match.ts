import type { FuzzyMatch } from './fuzzy'
import { fuzzyMatch } from './fuzzy'
import { patternSafety } from '@shared/regex-safety'

export type QueryError = 'syntax' | 'unsafe'

export interface Query {
  readonly text: string
  readonly mode: 'fuzzy' | 'regex'
  readonly error: QueryError | null
  readonly pattern: RegExp | null
}

// Tighter than the shared ceiling on purpose: this box recompiles on every keystroke, so refusing a
// long expression costs the reader one keystroke, while compiling it costs the tab. Exported so the
// test pins the number instead of restating it.
export const MAX_FILTER_PATTERN_CHARS = 160
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
  const refusal = patternSafety(body, MAX_FILTER_PATTERN_CHARS)
  if (refusal) return REFUSED(text, refusal)
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
 * Whether the box has nothing to filter by, or a pattern it refused: either way every row stays.
 *
 * A refused expression is not a search that found nothing. The listing that empties at the same moment
 * the box says it would not compile has given the reader two answers to one question, and the one they
 * act on — "there are no notes called that" — is the wrong one. So the rows stay, and the box is the
 * only thing that speaks. This is the fast-path shape of {@link queryKeeps}, for a caller that would
 * otherwise scan a whole body per row.
 */
export function queryKeepsRows(query: Query): boolean {
  return query.text === '' || query.error !== null
}

/** Whether one row survives the box, ranges for the underline included. */
export function queryKeeps(query: Query, subject: string): boolean {
  return queryKeepsRows(query) || queryMatches(query, subject) !== null
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
