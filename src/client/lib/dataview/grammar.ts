/**
 * A hand-rolled recursive-descent toolkit with ordered choice and full backtracking.
 *
 * Dataview's own language is written as parser combinators over Parsimmon; a small local copy keeps
 * the grammar readable in the same shape while adding nothing to the bundle. Failure carries the
 * furthest position reached plus what was expected there, which is what lets a block tell the reader
 * `expected a field name at line 1, column 24` instead of `parse error`.
 */

export type ParseState = { ok: true; pos: number; value: unknown } | { ok: false; pos: number; expected: string }

export class ParseFailure extends Error {
    constructor(readonly position: number, readonly expected: string) {
        super(`Expected ${expected} at position ${position}`)
        this.name = 'ParseFailure'
    }
}

/**
 * A parser over `(input, pos)`. `T` is carried by a phantom property because a bare function type
 * would make it invisible to `Parser<infer T>` — and every `seq(...)` result type depends on reading
 * the element types back out of the tuple.
 */
export interface Parser<T> {
    (input: string, pos: number, ctx: ParseCtx): ParseState
    readonly parsed?: T
}

interface ParseCtx {
    furthest: number
    expected: Set<string>
}

function newContext(): ParseCtx {
    return { furthest: -1, expected: new Set() }
}

export function parse<T>(parser: Parser<T>, input: string): T {
    const ctx = newContext()
    const state = parser(input, 0, ctx)
    if (state.ok) return state.value as T
    throw new ParseFailure(ctx.furthest > state.pos ? ctx.furthest : state.pos, ctx.expected.size ? [...ctx.expected].join(' or ') : state.expected)
}

/** Parse the whole input; trailing text that is not whitespace or a comment is an error. */
export function parseAll<T>(parser: Parser<T>, input: string, trailing: Parser<unknown> = whitespace): T {
    const ctx = newContext()
    const state = parser(input, 0, ctx)
    if (!state.ok) throw new ParseFailure(ctx.furthest > state.pos ? ctx.furthest : state.pos, ctx.expected.size ? [...ctx.expected].join(' or ') : state.expected)
    const rest = trailing(input, state.pos, ctx)
    if (rest.ok && rest.pos === input.length) return state.value as T
    const at = rest.ok ? rest.pos : state.pos
    throw new ParseFailure(Math.max(at, ctx.furthest), ctx.expected.size ? `${[...ctx.expected].join(' or ')} or the end of the query` : 'the end of the query')
}

function fail(pos: number, expected: string): ParseState {
    return { ok: false, pos, expected }
}

export function lazy<T>(build: () => Parser<T>): Parser<T> {
    let cached: Parser<T> | null = null
    return (input, pos, ctx) => {
        cached ??= build()
        return cached(input, pos, ctx)
    }
}

export function lit(text: string, label = JSON.stringify(text)): Parser<string> {
    return (input, pos, ctx) => {
        if (ctx.furthest < pos) {
            ctx.furthest = pos
            ctx.expected = new Set([label])
        } else if (ctx.furthest === pos) ctx.expected.add(label)
        return input.startsWith(text, pos) ? { ok: true, pos: pos + text.length, value: text } : fail(pos, label)
    }
}

/** A case-insensitive keyword that must not be followed by an identifier character. */
export function keyword(text: string): Parser<string> {
    const lower = text.toLowerCase()
    return (input, pos, ctx) => {
        const slice = input.slice(pos, pos + text.length).toLowerCase()
        const hit = slice === lower && !isIdentifierTail(input[pos + text.length] ?? '')
        if (ctx.furthest < pos) {
            ctx.furthest = pos
            ctx.expected = new Set([text])
        } else if (ctx.furthest === pos) ctx.expected.add(text)
        return hit ? { ok: true, pos: pos + text.length, value: input.slice(pos, pos + text.length) } : fail(pos, text)
    }
}

export function isIdentifierTail(char: string): boolean {
    return /[\p{Letter}\p{Number}_-]/u.test(char)
}

/**
 * Match a regular expression anchored at `pos`. An empty match succeeds — `[ \t]*` at the end of the
 * input is still a match — and `many` refuses to iterate on a parser that made no progress, so a
 * zero-width result cannot loop.
 */
export function pattern(re: RegExp, label = re.source): Parser<string> {
    return (input, pos, ctx) => {
        if (ctx.furthest < pos) {
            ctx.furthest = pos
            ctx.expected = new Set([label])
        } else if (ctx.furthest === pos) ctx.expected.add(label)
        const match = re.exec(input.slice(pos))
        if (!match || match.index !== 0) return fail(pos, label)
        return { ok: true, pos: pos + match[0].length, value: match[0] }
    }
}

export function map<T, U>(base: Parser<T>, transform: (value: T) => U): Parser<U> {
    return (input, pos, ctx) => {
        const state = base(input, pos, ctx)
        return state.ok ? { ok: true, pos: state.pos, value: transform(state.value as T) } : state
    }
}

export function alt<T>(...parsers: Parser<T>[]): Parser<T> {
    return (input, pos, ctx) => {
        let last: ParseState = fail(pos, 'one of the alternatives')
        for (const parser of parsers) {
            const state = parser(input, pos, ctx)
            if (state.ok) return state
            last = state
        }
        return last
    }
}

type ValuesOf<P extends readonly Parser<unknown>[]> = { [K in keyof P]: P[K] extends Parser<infer T> ? T : never }

/**
 * Sequence with tuple inference: a grammar reads `([, value]) => value` out of the result, which only
 * typechecks if the element types survive as a tuple rather than as `unknown[]`.
 */
export function seq<const P extends readonly Parser<unknown>[]>(...parsers: P): Parser<ValuesOf<P>> {
    return (input, pos, ctx) => {
        const values: unknown[] = []
        let cursor = pos
        for (const parser of parsers) {
            const state = (parser as Parser<unknown>)(input, cursor, ctx)
            if (!state.ok) return state
            values.push(state.value)
            cursor = state.pos
        }
        return { ok: true, pos: cursor, value: values as unknown as ValuesOf<P> }
    }
}

export function many<T>(base: Parser<T>): Parser<T[]> {
    return (input, pos, ctx) => {
        const values: T[] = []
        let cursor = pos
        for (;;) {
            const state = base(input, cursor, ctx)
            if (!state.ok) return { ok: true, pos: cursor, value: values }
            if (state.pos === cursor) return { ok: true, pos: cursor, value: values }
            values.push(state.value as T)
            cursor = state.pos
        }
    }
}

export function many1<T>(base: Parser<T>): Parser<T[]> {
    return map(seq(base, many(base)), ([first, rest]) => [first, ...rest] as T[])
}

export function optional<T>(base: Parser<T>): Parser<T | undefined> {
    return (input, pos, ctx) => {
        const state = base(input, pos, ctx)
        return state.ok ? { ok: true, pos: state.pos, value: state.value as T } : { ok: true, pos, value: undefined }
    }
}

export function sepBy<T>(base: Parser<T>, separator: Parser<unknown>): Parser<T[]> {
    return map(seq(optional(base), many(map(seq(separator, base), ([, second]) => second))), ([first, rest]) => (first ? [first, ...rest] : []) as T[])
}

export function sepBy1<T>(base: Parser<T>, separator: Parser<unknown>): Parser<T[]> {
    return map(seq(base, many(map(seq(separator, base), ([, second]) => second))), ([first, rest]) => [first, ...rest] as T[])
}

export const whitespace: Parser<string> = pattern(/[ \t\r\n]*/, 'whitespace')
export const requiredWhitespace: Parser<string> = pattern(/[ \t\r\n]+/, 'whitespace')
export const optionalWhitespaceOrComment: Parser<string> = map(many(alt(pattern(/[ \t\r\n]*/, 'whitespace'), comment())), (parts) => parts.join(''))

export function comment(): Parser<string> {
    return map(seq(lit('//', 'a comment'), pattern(/[^\n]*/)), ([, text]) => text as string)
}

/** Whitespace-or-comment on both sides of a token, which is what makes `TABLE , x` and line breaks legal. */
export function trimmed<T>(base: Parser<T>, spacer: Parser<unknown> = optionalWhitespaceOrComment): Parser<T> {
    return map(seq(spacer, base, spacer), ([, value]) => value as T)
}
