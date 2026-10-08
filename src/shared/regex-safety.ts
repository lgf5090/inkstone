/**
 * The static half of “do not let a typed expression freeze the tab”.
 *
 * Two features hand a reader's regular expression to `RegExp`: a listing's filter box (through
 * `query-match`) and the linter's custom replacements and file-ignore patterns. Both need the same
 * answer before compiling, so the structural reading of the pattern lives here once. A group that
 * repeats while repeating something inside itself multiplies its own backtracking, and so does a
 * repeated alternation whose branches start alike; nothing can stop a match once it has started, so
 * the price of a refusal has to be paid at the keystroke, not at the freeze — and a pattern that
 * arrived through a restored backup has to be refused at the run as well, where there is no
 * keystroke left to charge.
 */

/** Why an expression was not compiled: it does not parse, or it can hang the page on a long input. */
export type PatternRefusal = 'syntax' | 'unsafe'

/** Every `( … )` in the pattern, inner text included; null when the parentheses do not nest. */
export function findGroups(body: string): Array<{ inner: string; close: number }> | null {
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

export function repeatsCatastrophically(body: string, groups: Array<{ inner: string; close: number }>): boolean {
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

/**
 * Whether a stand-alone pattern may be compiled at all. A caller that already knows the difference
 * between a broken expression and a dangerous one reads `findGroups` and `repeatsCatastrophically`
 * itself; this is the answer for a feature that only has to refuse.
 */
export function patternSafety(body: string): PatternRefusal | null {
  const groups = findGroups(body)
  if (!groups) return 'syntax'
  return repeatsCatastrophically(body, groups) ? 'unsafe' : null
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

const COUNT_SPEC = /^\{(\d+)(?:,(\d*))?\}/
