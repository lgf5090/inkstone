import type { FuzzyMatch } from './fuzzy'
import { fuzzyMatch } from './fuzzy'

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
const COUNT_SPEC = /^\{(\d+)(?:,(\d*))?\}/

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

/**
 * A group that repeats while repeating something inside itself multiplies its own backtracking, and
 * so does a repeated alternation whose branches start alike. Both are refused before the engine runs,
 * because nothing can stop a match once it has started: the price of a refusal is one keystroke, the
 * price of missing one is a frozen tab. It errs toward refusing — a name filter has no use for `(a+)+`.
 */
function repeatsCatastrophically(body: string, groups: Array<{ inner: string; close: number }>): boolean {
  for (const group of groups) {
    if (!repeatsAfter(body, group.close)) continue
    if (hasRiskyQuantifier(group.inner)) return true
    const branches = topLevelAlternatives(group.inner)
    if (branches.length > 1) {
      const starts = branches.map((branch) => branch.trim().charAt(0))
      if (starts.some((first, index) => first !== '' && starts.indexOf(first) !== index)) return true
    }
  }
  return false
}

/** Every `( … )` in the pattern, inner text included; null when the parentheses do not nest. */
function findGroups(body: string): Array<{ inner: string; close: number }> | null {
  const found: Array<{ inner: string; close: number }> = []
  const stack: number[] = []
  for (let index = 0, classAt = -1; index < body.length; index++) {
    const char = body[index]!
    if (char === '\\') { index++; continue }
    if (classAt >= 0) { if (char === ']') classAt = -1; continue }
    if (char === '[') { classAt = index; continue }
    if (char === '(') { stack.push(index); continue }
    if (char !== ')') continue
    const open = stack.pop()
    if (open === undefined) return null
    found.push({ inner: body.slice(open + 1, index), close: index })
  }
  return stack.length ? null : found
}

/** Whether the atom ending at `close` is repeated more than twice, or an unknown number of times. */
function repeatsAfter(body: string, close: number): boolean {
  let index = close + 1
  while (body[index] === '?') index++
  const char = body[index]
  if (char === '+' || char === '*') return true
  if (char !== '{') return false
  const spec = COUNT_SPEC.exec(body.slice(index))
  if (!spec) return false
  const low = Number(spec[1])
  const high = spec[2] === undefined ? low : spec[2] === '' ? Infinity : Number(spec[2])
  return high !== low || high > 2 || low === 0
}

/** Any quantifier that is not inside a class, not a group prefix, and not a fixed `{1}` or `{2}`. */
function hasRiskyQuantifier(inner: string): boolean {
  for (let index = 0, classAt = -1; index < inner.length; index++) {
    const char = inner[index]!
    if (char === '\\') { index++; continue }
    if (classAt >= 0) { if (char === ']') classAt = -1; continue }
    if (char === '[') { classAt = index; continue }
    if (char === '*' || char === '+') return true
    if (char === '?') {
      if (index > 0 && inner[index - 1] !== '(') return true
      continue
    }
    if (char !== '{') continue
    const spec = COUNT_SPEC.exec(inner.slice(index))
    if (!spec) continue
    const low = Number(spec[1])
    const high = spec[2] === undefined ? low : spec[2] === '' ? Infinity : Number(spec[2])
    if (high !== low || high > 2 || low === 0) return true
  }
  return false
}

/** The group body cut at every `|` that is not inside a nested group or a class. */
function topLevelAlternatives(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let classAt = -1
  let start = 0
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]!
    if (char === '\\') { index++; continue }
    if (classAt >= 0) { if (char === ']') classAt = -1; continue }
    if (char === '[') { classAt = index; continue }
    if (char === '(') depth++
    else if (char === ')') depth--
    else if (char === '|' && depth === 0) {
      parts.push(inner.slice(start, index))
      start = index + 1
    }
  }
  parts.push(inner.slice(start))
  return parts
}
