import { patternSafety } from '@shared/regex-safety'

/**
 * A gate in front of every regular expression a note can write.
 *
 * `regextest`, `regexmatch`, `regexreplace` and `split` all compile author text, and a query block
 * runs on every preview of every reader of a shared note — so one catastrophic pattern in a template
 * would freeze tabs rather than the author's own. The rule is not written here: it is `patternSafety`,
 * the same ceiling and the same shape the sidebar's regex filter and the linter's replacements are
 * checked against, because a pattern cannot be safe to compile in one feature and dangerous in
 * another. Refusing costs the reader one error message; a miss costs a hung tab that no timeout can
 * interrupt.
 */

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
    if (pattern.length === 0 || patternSafety(pattern)) return null
    try {
        return new RegExp(pattern, flags)
    } catch {
        return null
    }
}
