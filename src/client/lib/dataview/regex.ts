/**
 * A gate in front of every regular expression a note can write.
 *
 * `regextest`, `regexmatch`, `regexreplace` and `split` all compile author text, and a query block
 * runs on every preview of every reader of a shared note — so one catastrophic pattern in a template
 * would freeze tabs rather than the author's own. The rule is the same one the sidebar's regex filter
 * uses: refuse a group that repeats while repeating something inside it, or a repeated alternation
 * whose branches can start with the same character. Refusing costs the reader one error message; a
 * miss costs a hung tab that no timeout can interrupt.
 */

const MAX_PATTERN_CHARS = 1000
const RISKY_INNER = /[*+?]$|\{\d+,\d*\}$/

/** Compiled and cached, because a table cell reuses its pattern across every row. */
const cache = new Map<string, RegExp | null>()

export function safePattern(pattern: string, flags = ''): RegExp | null {
    const key = `${flags}\u0000${pattern}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const compiled = compile(pattern, flags)
    if (cache.size > 200) cache.clear()
    cache.set(key, compiled)
    return compiled
}

function compile(pattern: string, flags: string): RegExp | null {
    if (pattern.length === 0 || pattern.length > MAX_PATTERN_CHARS) return null
    if (isCatastrophic(pattern)) return null
    try {
        return new RegExp(pattern, flags)
    } catch {
        return null
    }
}

/**
 * Walk the pattern once, pairing parentheses, and reject a group whose quantifier applies to a body
 * that itself ends in a quantifier — `(a+)+`, `(\w*)*`, `((x|xy)+)*`. Nested groups are found by
 * scanning from the innermost close, so a quantifier on an inner group is visible to its parent.
 */
export function isCatastrophic(pattern: string): boolean {
    const groups = findGroups(pattern)
    if (!groups) return true
    for (const group of groups) {
        if (!repeatsAfter(pattern, group.close)) continue
        if (RISKY_INNER.test(group.inner) || repeatsAfter(group.inner, group.inner.length - 1)) return true
        const branches = topLevelAlternatives(group.inner)
        if (branches.length > 1) {
            const starts = branches.map((branch) => branch.trim().charAt(0))
            if (starts.some((first, index) => first !== '' && starts.indexOf(first) !== index)) return true
        }
    }
    return false
}

/** Every `( … )` in the pattern with the index of its closing parenthesis; null when they do not balance. */
function findGroups(body: string): Array<{ inner: string; close: number }> | null {
    const found: Array<{ inner: string; close: number }> = []
    const stack: number[] = []
    let escaped = false
    let inClass = false
    for (let index = 0; index < body.length; index++) {
        const char = body[index]
        if (escaped) {
            escaped = false
            continue
        }
        if (char === '\\') {
            escaped = true
            continue
        }
        if (inClass) {
            if (char === ']') inClass = false
            continue
        }
        if (char === '[') {
            inClass = true
            continue
        }
        if (char === '(') stack.push(index)
        else if (char === ')') {
            const open = stack.pop()
            if (open === undefined) return null
            found.push({ inner: body.slice(open + 1, index), close: index })
        }
    }
    return stack.length === 0 ? found : null
}

/** A quantifier — `*`, `+`, `?`, `{n,m}` — directly after the character at `at`. */
function repeatsAfter(body: string, at: number): boolean {
    const rest = body.slice(at + 1)
    return /^[*+?]|\{\d+,\d*\}/.test(rest) || (rest.startsWith('?') && !rest.startsWith('??'))
}

/** The `|`-separated branches of a group body, ignoring separators inside nested groups or classes. */
function topLevelAlternatives(body: string): string[] {
    const parts: string[] = []
    let depth = 0
    let inClass = false
    let escaped = false
    let start = 0
    for (let index = 0; index < body.length; index++) {
        const char = body[index]!
        if (escaped) {
            escaped = false
            continue
        }
        if (char === '\\') {
            escaped = true
            continue
        }
        if (inClass) {
            if (char === ']') inClass = false
            continue
        }
        if (char === '[') {
            inClass = true
            continue
        }
        if (char === '(') depth += 1
        else if (char === ')') depth -= 1
        else if (char === '|' && depth === 0) {
            parts.push(body.slice(start, index))
            start = index + 1
        }
    }
    parts.push(body.slice(start))
    return parts
}
