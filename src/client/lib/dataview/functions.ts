/**
 * The Dataview function library.
 *
 * Dispatch mirrors the reference project's `FunctionBuilder`: a function is a list of variants keyed
 * by argument *type names* with `*` as a wildcard, checked in declaration order, plus a per-arity
 * vectorisation rule that maps the variant over array arguments. Keeping that shape is what makes
 * `map(filter(rows.file.tasks, (t) => !t.completed), (t) => t.text)` behave the way the Dataview docs
 * say it does, including the corners (`length(null)` is 0, `link("a", null)` is a link to a).
 *
 * Every variant implementation takes the context first, then its arguments positionally — the arity
 * the variant declared. `nullish()` adds the null-eats-null variants that most string and number
 * functions share instead of spelling them out eleven times.
 */

import { Fields, type BinaryOp } from './ast'
import { DvLink, Values, compareValues, formatDateTokenized, type DataObject, type Literal, type LiteralTypeName } from './value'
import { normalizeDuration, parseInlineValue, stripTime } from './expression'
import { safePattern } from './regex'

export interface QueryRuntimeSettings {
    renderNullAs: string
    dateFormat: string
    datetimeFormat: string
    durationFormat: string
    locale: string
}

export const DEFAULT_QUERY_SETTINGS: QueryRuntimeSettings = {
    renderNullAs: '',
    dateFormat: 'yyyy-MM-dd',
    datetimeFormat: 'yyyy-MM-dd HH:mm',
    durationFormat: 'long',
    locale: 'en-US',
}

/** The pieces of an evaluation context a function may reach for; `Context` implements it. */
export interface FunctionContext {
    settings: QueryRuntimeSettings
    normalizeLink(path: string): string
    linkExists(path: string): boolean
    resolveLink(path: string): DataObject | null
    /** Evaluate a sub-expression, which is how `contains` and `extract` reuse `=` and indexing. */
    evaluate(field: unknown, data?: Record<string, Literal>): Literal
}

export type FunctionImpl = (context: FunctionContext, ...args: Literal[]) => Literal
type TypeOrAll = LiteralTypeName | '*'

interface Variant {
    args: TypeOrAll[]
    varargs?: boolean
    impl: FunctionImpl
}

class Builder {
    private variants: Variant[] = []
    private vectorised = new Map<number, number[]>()

    constructor(readonly name: string) {}

    add(...types: (TypeOrAll | FunctionImpl)[]): this {
        const impl = types[types.length - 1] as FunctionImpl
        return this.variant({ args: types.slice(0, -1) as TypeOrAll[], impl })
    }

    /** A variant taking any number of arguments; declared last, it is the catch-all for this name. */
    variadic(impl: FunctionImpl): this {
        return this.variant({ args: [], varargs: true, impl })
    }

    vectorize(arity: number, positions: number[]): this {
        this.vectorised.set(arity, positions)
        return this
    }

    /**
     * Register null-eats-null for the given arities, appended last so a `null` argument is answered by
     * these rather than by a `*` variant of the same arity declared earlier.
     */
    nullish(...arities: number[]): this {
        for (const arity of arities) {
            for (let position = 0; position < arity; position++) {
                const args: TypeOrAll[] = Array.from({ length: arity }, (_, index) => (index === position ? 'null' : '*'))
                this.variant({ args, impl: () => null })
            }
        }
        return this
    }

    private variant(entry: Variant): this {
        this.variants.push(entry)
        return this
    }

    build(): FunctionImpl {
        const self: FunctionImpl = (context, ...args) => {
            const types: LiteralTypeName[] = []
            for (const arg of args) {
                const type = Values.typeOf(arg)
                if (!type) throw new Error(`Unrecognized value '${String(arg)}' passed to '${this.name}()'`)
                types.push(type)
            }

            const positions = (this.vectorised.get(types.length) ?? []).filter((position) => types[position] === 'array')
            if (positions.length > 0) {
                const shortest = Math.min(...positions.map((position) => (args[position] as Literal[]).length))
                const result: Literal[] = []
                for (let index = 0; index < shortest; index++) {
                    const sliced = args.map((arg, position) => (positions.includes(position) ? (arg as Literal[])[index] : arg))
                    result.push(self(context, ...(sliced.map((value) => value ?? null) as Literal[])))
                }
                return result
            }

            for (const variant of this.variants) {
                if (variant.varargs) return variant.impl(context, ...args)
                if (variant.args.length !== types.length) continue
                if (variant.args.every((type, index) => type === '*' || type === types[index])) return variant.impl(context, ...args)
            }

            throw new Error(`No implementation of '${this.name}' found for arguments: ${types.join(', ')}`)
        }
        return self
    }
}

function text(value: Literal): string {
    return value as string
}

/** Flatten a nested list of literals, dropping nulls — what `sum`/`min`/`average` work over. */
function flatten(values: Literal[]): Literal[] {
    const out: Literal[] = []
    for (const value of values) {
        if (Values.isArray(value)) out.push(...flatten(value))
        else if (!Values.isNull(value)) out.push(value)
    }
    return out
}

function numbers(values: Literal[]): number[] {
    return flatten(values).filter(Values.isNumber) as number[]
}

/** A higher-order argument, checked at the call the builder already dispatched on. */
function asLambda(value: Literal): (...args: Literal[]) => Literal {
    if (!Values.isFunction(value)) throw new Error('Expected a function argument')
    return value
}

function arithmetic(left: Literal, op: BinaryOp, right: Literal): Literal {
    if (op === '+' && Values.isString(left)) return left + Values.toString(right)
    if (op === '+' && Values.isString(right)) return Values.toString(left) + right
    if (!Values.isNumber(left) || !Values.isNumber(right)) {
        throw new Error(`Cannot apply '${op}' to '${Values.typeOf(left)}' and '${Values.typeOf(right)}'`)
    }
    switch (op) {
        case '+': return left + right
        case '-': return left - right
        case '*': return left * right
        case '/': return left / right
        case '%': return left % right
        default: throw new Error(`'${op}' is not an arithmetic operator`)
    }
}

/** A date literal from a string: the ISO-ish form or a shorthand, else null. */
function parseInlineDate(value: string): Date | null {
    const parsed = parseInlineValue(value.trim())
    return Values.isDate(parsed) ? parsed : null
}

export namespace DefaultFunctions {
    // ---- Constructors ----

    export const list: FunctionImpl = (_context, ...args) => args

    export function object(_context: FunctionContext, ...args: Literal[]): Literal {
        if (args.length % 2 !== 0) throw new Error('object() requires an even number of arguments')
        const result: DataObject = {}
        for (let index = 0; index < args.length; index += 2) {
            const key = args[index]
            if (!Values.isString(key)) throw new Error('object(key, value, ...) must be called with string keys')
            result[key] = args[index + 1] ?? null
        }
        return result
    }

    export const link: FunctionImpl = new Builder('link')
        .add('string', (context, target) => DvLink.file(context.normalizeLink(target as string)))
        .add('link', (_context, target) => target as DvLink)
        .vectorize(1, [0])
        .add('string', 'string', (context, target, display) => DvLink.file(context.normalizeLink(target as string), display as string))
        .add('string', 'string', 'boolean', (context, target, display, embed) => new DvLink(context.normalizeLink(target as string), 'file', null, display as string, embed as boolean))
        .add('link', 'string', (_context, target, display) => (target as DvLink).withDisplay(display as string))
        .vectorize(2, [0, 1])
        .nullish(1, 2)
        .build()

    export const embed: FunctionImpl = new Builder('embed')
        .add('link', (_context, target) => reEmbed(target as DvLink, true))
        .add('link', 'boolean', (_context, target, flag) => reEmbed(target as DvLink, flag as boolean))
        .vectorize(1, [0])
        .vectorize(2, [0, 1])
        .nullish(1, 2)
        .build()

    function reEmbed(link: DvLink, embedded: boolean): DvLink {
        return new DvLink(link.path, link.kind, link.subpath, link.display, embedded)
    }

    export const elink: FunctionImpl = new Builder('elink')
        .add('string', 'string', (_context, url, display) => new DvLink(url as string, 'file', null, display as string))
        .add('string', (_context, url) => new DvLink(url as string, 'file', null, url as string))
        .vectorize(2, [0])
        .vectorize(1, [0])
        .nullish(1, 2)
        .build()

    export const date: FunctionImpl = new Builder('date')
        .add('string', (_context, value) => parseInlineDate(value as string))
        .add('date', (_context, value) => value)
        .add('link', (context, value) => {
            const typed = value as DvLink
            if (typed.display) {
                const fromDisplay = parseInlineDate(typed.display)
                if (fromDisplay) return fromDisplay
            }
            const fromPath = parseInlineDate(typed.path)
            if (fromPath) return fromPath
            const resolved = context.resolveLink(typed.path)
            const file = resolved?.file as DataObject | undefined
            const day = file?.day
            return Values.isDate(day) ? day : null
        })
        .add('string', 'string', (_context, value, format) => {
            const source = value as string
            const pattern = format as string
            if (pattern === 'x' || pattern === 'X') {
                const match = /-?[0-9]+(?:\.[0-9]+)?/.exec(source)
                if (!match) throw new Error(`'${source}' is not a number, which format '${pattern}' expects`)
                return new Date(Number.parseInt(match[0], 10) * (pattern === 'X' ? 1000 : 1))
            }
            return parseWithFormat(source, pattern)
        })
        .vectorize(1, [0])
        .vectorize(2, [0])
        .nullish(1, 2)
        .build()

    export const dur: FunctionImpl = new Builder('dur')
        .add('string', (_context, value) => {
            const parsed = parseInlineValue(text(value).trim())
            return Values.isDuration(parsed) ? normalizeDuration(parsed) : null
        })
        .add('duration', (_context, value) => value)
        .vectorize(1, [0])
        .nullish(1)
        .build()

    export const number: FunctionImpl = new Builder('number')
        .add('number', (_context, value) => value)
        .add('string', (_context, value) => {
            const match = /-?[0-9]+(?:\.[0-9]+)?/.exec(text(value))
            return match ? Number.parseFloat(match[0]) : null
        })
        .add('date', (_context, value) => (value as Date).getTime())
        .add('duration', (_context, value) => (value as { toMillis(): number }).toMillis())
        .vectorize(1, [0])
        .nullish(1)
        .build()

    export const string: FunctionImpl = new Builder('string')
        .add('*', (context, value) => Values.toString(value as Literal, context.settings, context.settings.locale))
        .build()

    export const typeOf: FunctionImpl = new Builder('type')
        .add('*', (_context, value) => Values.typeOf(value as Literal) ?? 'unknown')
        .build()

    // ---- Numeric ----

    export const round: FunctionImpl = new Builder('round')
        .add('number', 'number', (_context, value, places) => {
            const shift = 10 ** Math.max(0, Math.min(12, Math.trunc(places as number)))
            return Math.round(((value as number) + Number.EPSILON) * shift) / shift
        })
        .add('number', (_context, value) => Math.round(value as number))
        .vectorize(2, [0, 1])
        .vectorize(1, [0])
        .nullish(1, 2)
        .build()

    export const trunc: FunctionImpl = new Builder('trunc').add('number', (_context, value) => Math.trunc(value as number)).vectorize(1, [0]).nullish(1).build()
    export const floor: FunctionImpl = new Builder('floor').add('number', (_context, value) => Math.floor(value as number)).vectorize(1, [0]).nullish(1).build()
    export const ceil: FunctionImpl = new Builder('ceil').add('number', (_context, value) => Math.ceil(value as number)).vectorize(1, [0]).nullish(1).build()

    export const min: FunctionImpl = extreme('min', false)
    export const max: FunctionImpl = extreme('max', true)

    function extreme(name: string, takeMax: boolean): FunctionImpl {
        return new Builder(name)
            .add('array', (context, values) => pickExtreme(context, flatten(values as Literal[]), takeMax))
            .variadic((context, ...args) => pickExtreme(context, flatten(args), takeMax))
            .build()
    }

    function pickExtreme(context: FunctionContext, values: Literal[], takeMax: boolean): Literal {
        if (!values.length) return null
        return values.reduce((best, value) => {
            const order = compareValues(value, best, context.normalizeLink)
            return (takeMax ? order > 0 : order < 0) ? value : best
        })
    }

    export const minby: FunctionImpl = (_context, list, func) => byExtreme(list, func, false)
    export const maxby: FunctionImpl = (_context, list, func) => byExtreme(list, func, true)

    function byExtreme(list: Literal | undefined, func: Literal | undefined, takeMax: boolean): Literal {
        if (!Values.isArray(list) || !Values.isFunction(func)) throw new Error('minby/maxby(list, func) wants a list and a function')
        const call = asLambda(func)
        const mapped = list.filter((value) => !Values.isNull(value)).map((value) => ({ value, key: call(value) }))
        if (!mapped.length) return null
        return mapped.reduce((best, candidate) => ((takeMax ? compareValues(candidate.key, best.key) > 0 : compareValues(candidate.key, best.key) < 0) ? candidate : best)).value
    }

    export const sum: FunctionImpl = new Builder('sum')
        .add('array', (_context, values) => fold(numbers(values as Literal[]), '+', 0))
        .variadic((_context, ...args) => fold(numbers(args), '+', 0))
        .build()

    export const product: FunctionImpl = new Builder('product')
        .add('array', (_context, values) => fold(numbers(values as Literal[]), '*', 1))
        .variadic((_context, ...args) => fold(numbers(args), '*', 1))
        .build()

    export const average: FunctionImpl = new Builder('average')
        .add('array', (_context, values) => mean(numbers(values as Literal[])))
        .variadic((_context, ...args) => mean(numbers(args)))
        .build()

    function mean(values: number[]): Literal {
        return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null
    }

    function fold(values: number[], op: BinaryOp, identity: number): Literal {
        return values.reduce((total, value) => (op === '*' ? total * value : total + value), identity)
    }

    // ---- Containment ----

    export const contains: FunctionImpl = new Builder('contains')
        .add('array', '*', (context, list, element) => (list as Literal[]).some((item) => contains(context, item, element as Literal) === true))
        .add('string', 'string', (_context, haystack, needle) => text(haystack).includes(text(needle)))
        .add('object', 'string', (_context, object, key) => text(key) in (object as DataObject))
        .add('*', '*', (context, one, other) => equals(context, one as Literal, other as Literal))
        .vectorize(2, [1])
        .build()

    export const icontains: FunctionImpl = new Builder('icontains')
        .add('array', '*', (context, list, element) => (list as Literal[]).some((item) => icontains(context, item, element as Literal) === true))
        .add('string', 'string', (_context, haystack, needle) => text(haystack).toLocaleLowerCase().includes(text(needle).toLocaleLowerCase()))
        .add('object', 'string', (_context, object, key) => text(key) in (object as DataObject))
        .add('*', '*', (context, one, other) => equals(context, one as Literal, other as Literal))
        .vectorize(2, [1])
        .build()

    export const econtains: FunctionImpl = new Builder('econtains')
        .add('array', '*', (context, list, element) => (list as Literal[]).some((item) => equals(context, element as Literal, item) === true))
        .add('string', 'string', (_context, haystack, needle) => text(haystack).includes(text(needle)))
        .add('object', 'string', (_context, object, key) => text(key) in (object as DataObject))
        .add('*', '*', (context, one, other) => equals(context, one as Literal, other as Literal))
        .vectorize(2, [1])
        .build()

    export const containsword: FunctionImpl = new Builder('containsword')
        .add('string', 'string', (_context, haystack, needle) => {
            const pattern = safePattern(`.*\\b${escapeRegex(text(needle))}\\b.*`, 'i')
            if (!pattern) throw new Error(`Refusing to search with the expression for '${text(needle)}'`)
            return pattern.test(text(haystack))
        })
        .vectorize(2, [0, 1])
        .nullish(2)
        .build()

    function equals(context: FunctionContext, one: Literal, other: Literal): Literal {
        return context.evaluate(Fields.binaryOp('=', Fields.literal(one), Fields.literal(other)))
    }

    // ---- Object / array / string operations ----

    export function extract(context: FunctionContext, ...args: Literal[]): Literal {
        if (args.length === 0) throw new Error('extract(object, key1, ...) requires at least one argument')
        const target = args[0]
        if (Values.isArray(target)) return target.map((value) => extract(context, value, ...args.slice(1)))
        if (Values.isNull(target)) return null
        const result: DataObject = {}
        for (let index = 1; index < args.length; index++) {
            const key = args[index]
            if (!Values.isString(key)) throw new Error('extract(object, key1, ...) must be called with string keys')
            result[key] = context.evaluate(Fields.index(Fields.literal(target), Fields.literal(key)))
        }
        return result
    }

    export const reverse: FunctionImpl = new Builder('reverse')
        .add('array', (_context, values) => [...(values as Literal[])].reverse())
        .add('string', (_context, value) => [...text(value)].reverse().join(''))
        .nullish(1)
        .build()

    export const sort: FunctionImpl = new Builder('sort')
        .add('array', (context, values) => sortList(context, values as Literal[], null))
        .add('array', 'function', (context, values, func) => sortList(context, values as Literal[], func as Literal))
        .add('string', (_context, value) => [...text(value)].sort().join(''))
        .nullish(1, 2)
        .build()

    function sortList(context: FunctionContext, values: Literal[], by: Literal | null): Literal {
        const transform = Values.isFunction(by) ? by : null
        const copy = [...values]
        copy.sort((one, other) => compareValues(transform ? transform(one) : one, transform ? transform(other) : other, context.normalizeLink))
        return copy
    }

    export const length: FunctionImpl = new Builder('length')
        .add('array', (_context, values) => (values as Literal[]).length)
        .add('object', (_context, values) => Object.keys(values as DataObject).length)
        .add('grouping', (_context, values) => (values as unknown as { rows: Literal[] }).rows.length)
        .add('string', (_context, value) => text(value).length)
        .add('null', () => 0)
        .build()

    export const nonnull: FunctionImpl = new Builder('nonnull')
        .add('array', (_context, values) => (values as Literal[]).filter((value) => !Values.isNull(value)))
        .add('null', () => null)
        .build()

    export const firstvalue: FunctionImpl = new Builder('firstvalue')
        .add('array', (_context, values) => (values as Literal[]).find((value) => !Values.isNull(value)) ?? null)
        .add('null', () => null)
        .build()

    export const all: FunctionImpl = new Builder('all')
        .add('array', (_context, values) => (values as Literal[]).every((value) => Values.isTruthy(value)))
        .add('*', (_context, value) => Values.isTruthy(value as Literal))
        .build()

    export const any: FunctionImpl = new Builder('any')
        .add('array', (_context, values) => (values as Literal[]).some((value) => Values.isTruthy(value)))
        .add('*', (_context, value) => Values.isTruthy(value as Literal))
        .build()

    export const none: FunctionImpl = new Builder('none')
        .add('array', (_context, values) => !(values as Literal[]).some((value) => Values.isTruthy(value)))
        .add('*', (_context, value) => !Values.isTruthy(value as Literal))
        .build()

    export const join: FunctionImpl = new Builder('join')
        .add('array', (context, values) => joinList(context, values as Literal[], ', '))
        .add('array', 'string', (context, values, separator) => joinList(context, values as Literal[], text(separator)))
        .add('*', (context, value) => joinList(context, [value as Literal], ', '))
        .add('null', () => '')
        .build()

    function joinList(context: FunctionContext, values: Literal[], separator: string): string {
        return values
            .filter((value) => !Values.isNull(value))
            .map((value) => {
                const rendered = Values.toString(value, context.settings, context.settings.locale, true)
                return Values.isObject(value) ? rendered.replace(/^\{(.*)\}$/, '$1') : rendered
            })
            .join(separator)
    }

    export const filter: FunctionImpl = new Builder('filter')
        .add('array', 'function', (_context, values, predicate) => (values as Literal[]).filter((value) => Values.isTruthy(asLambda(predicate)(value))))
        .add('null', 'function', () => null)
        .build()

    export const map: FunctionImpl = new Builder('map')
        .add('array', 'function', (_context, values, transform) => (values as Literal[]).map((value) => asLambda(transform)(value)))
        .add('*', 'function', (_context, value, transform) => [asLambda(transform)(value as Literal)])
        .add('null', 'function', () => null)
        .build()

    export const flat: FunctionImpl = new Builder('flat')
        .add('array', (_context, values) => flattenDepth(values as Literal[], 1))
        .add('array', 'number', (_context, values, depth) => flattenDepth(values as Literal[], Math.trunc(depth as number)))
        .nullish(1, 2)
        .build()

    /** A local flatten: `Array.prototype.flat` overload resolution drowns on a recursive union. */
    function flattenDepth(values: Literal[], depth: number): Literal[] {
        if (depth <= 0) return [...values]
        const out: Literal[] = []
        for (const value of values) {
            if (Values.isArray(value)) out.push(...flattenDepth(value, depth - 1))
            else out.push(value)
        }
        return out
    }

    export const slice: FunctionImpl = new Builder('slice')
        .add('array', (_context, values) => [...(values as Literal[])])
        .add('array', 'number', (_context, values, start) => (values as Literal[]).slice(start as number))
        .add('array', 'number', 'number', (_context, values, start, end) => (values as Literal[]).slice(start as number, end as number))
        .nullish(1, 2, 3)
        .build()

    export const unique: FunctionImpl = new Builder('unique')
        .add('array', (context, values) => {
            const out: Literal[] = []
            for (const value of values as Literal[]) {
                if (!out.some((item) => equals(context, item, value) === true)) out.push(value)
            }
            return out
        })
        .add('null', () => null)
        .build()

    export const reduce: FunctionImpl = new Builder('reduce')
        .add('array', 'string', (_context, values, op) => {
            const list = values as Literal[]
            if (!list.length) return null
            const operator = op as BinaryOp
            if (!['+', '-', '*', '/', '&', '|'].includes(operator)) throw new Error("reduce(array, op) supports '+', '-', '/', '*', '&', and '|'")
            return list.reduce((total, value) => {
                if (operator === '&' || operator === '|') return operator === '&' ? Values.isTruthy(total) && Values.isTruthy(value) : Values.isTruthy(total) || Values.isTruthy(value)
                return arithmetic(total, operator, value)
            })
        })
        .add('array', 'function', (_context, values, func) => {
            const list = values as Literal[]
            if (!list.length) return null
            const reducer = asLambda(func)
            return list.reduce((total, value) => reducer(total, value))
        })
        .nullish(2)
        .build()

    // ---- String operations ----

    export const regextest: FunctionImpl = new Builder('regextest')
        .add('string', 'string', (_context, pattern, value) => compile(text(pattern)).test(text(value)))
        .vectorize(2, [0, 1])
        .nullish(2)
        .build()

    export const regexmatch: FunctionImpl = new Builder('regexmatch')
        .add('string', 'string', (_context, pattern, value) => {
            const found = compile(text(pattern)).exec(bound(text(value)))
            return found ? found[0] : null
        })
        .vectorize(2, [0, 1])
        .nullish(2)
        .build()

    export const regexreplace: FunctionImpl = new Builder('regexreplace')
        .add('string', 'string', 'string', (_context, value, pattern, replacement) => bound(text(value)).replace(compile(text(pattern), 'g'), text(replacement)))
        .vectorize(3, [0, 1, 2])
        .nullish(3)
        .build()

    function compile(pattern: string, flags = ''): RegExp {
        const compiled = safePattern(pattern, flags)
        if (!compiled) throw new Error(`Refusing to run the regular expression '${pattern}'`)
        return compiled
    }

    /** A ceiling on the text a query-written pattern may be run over: one cell, not a whole vault. */
    const MAX_MATCHED_CHARS = 20_000
    function bound(value: string): string {
        return value.length > MAX_MATCHED_CHARS ? value.slice(0, MAX_MATCHED_CHARS) : value
    }

    export const lower: FunctionImpl = new Builder('lower').add('string', (_context, value) => text(value).toLocaleLowerCase()).vectorize(1, [0]).nullish(1).build()
    export const upper: FunctionImpl = new Builder('upper').add('string', (_context, value) => text(value).toLocaleUpperCase()).vectorize(1, [0]).nullish(1).build()

    export const replace: FunctionImpl = new Builder('replace')
        .add('string', 'string', 'string', (_context, value, needle, replacement) => text(value).split(text(needle)).join(text(replacement)))
        .vectorize(3, [0, 1, 2])
        .nullish(3)
        .build()

    export const split: FunctionImpl = new Builder('split')
        .add('string', 'string', (_context, value, separator) => splitByPattern(text(value), text(separator)))
        .add('string', 'string', 'number', (_context, value, separator, limit) => splitByPattern(text(value), text(separator), limit as number))
        .vectorize(2, [0, 1])
        .vectorize(3, [0, 1, 2])
        .nullish(2, 3)
        .build()

    function splitByPattern(value: string, separator: string, limit?: number): string[] {
        const compiled = compile(separator)
        return value.split(new RegExp(compiled.source, compiled.flags), limit).map((part) => part || '')
    }

    export const startswith: FunctionImpl = new Builder('startswith')
        .add('string', 'string', (_context, value, start) => text(value).startsWith(text(start)))
        .vectorize(2, [0, 1])
        .nullish(2)
        .build()

    export const endswith: FunctionImpl = new Builder('endswith')
        .add('string', 'string', (_context, value, end) => text(value).endsWith(text(end)))
        .vectorize(2, [0, 1])
        .nullish(2)
        .build()

    export const padleft: FunctionImpl = new Builder('padleft')
        .add('string', 'number', (_context, value, width) => text(value).padStart(width as number, ' '))
        .add('string', 'number', 'string', (_context, value, width, padding) => text(value).padStart(width as number, text(padding)))
        .vectorize(2, [0, 1])
        .vectorize(3, [0, 1, 2])
        .nullish(2, 3)
        .build()

    export const padright: FunctionImpl = new Builder('padright')
        .add('string', 'number', (_context, value, width) => text(value).padEnd(width as number, ' '))
        .add('string', 'number', 'string', (_context, value, width, padding) => text(value).padEnd(width as number, text(padding)))
        .vectorize(2, [0, 1])
        .vectorize(3, [0, 1, 2])
        .nullish(2, 3)
        .build()

    export const substring: FunctionImpl = new Builder('substring')
        .add('string', 'number', (_context, value, start) => text(value).substring(start as number))
        .add('string', 'number', 'number', (_context, value, start, end) => text(value).substring(start as number, end as number))
        .vectorize(2, [0, 1])
        .vectorize(3, [0, 1, 2])
        .nullish(2, 3)
        .build()

    export const truncate: FunctionImpl = new Builder('truncate')
        .add('string', 'number', 'string', (_context, value, width, suffix) => clip(text(value), width as number, text(suffix)))
        .add('string', 'number', (_context, value, width) => clip(text(value), width as number, '...'))
        .vectorize(2, [0, 1])
        .vectorize(3, [0, 1, 2])
        .nullish(2, 3)
        .build()

    function clip(source: string, width: number, tail: string): string {
        return source.length > width - tail.length ? source.substring(0, Math.max(0, width - tail.length)) + tail : source
    }

    // ---- Utilities ----

    export const fdefault: FunctionImpl = new Builder('default')
        .add('*', '*', (_context, value, fallback) => (Values.isNull(value) ? fallback as Literal : value as Literal))
        .vectorize(2, [0, 1])
        .build()

    export const ldefault: FunctionImpl = new Builder('ldefault')
        .add('*', '*', (_context, value, fallback) => (Values.isNull(value) ? fallback as Literal : value as Literal))
        .build()

    export const display: FunctionImpl = new Builder('display')
        .add('null', () => '')
        .add('array', (context, values) => (values as Literal[]).map((value) => display(context, value)).join(', '))
        .add('string', (_context, value) => normalizeMarkdownText(text(value)))
        .add('link', (context, value) => {
            const typed = value as DvLink
            if (typed.display) return display(context, typed.display)
            return Values.toString(typed, context.settings, context.settings.locale).replace(/\[\[.*\|(.*)\]\]/, '$1')
        })
        .add('*', (context, value) => Values.toString(value as Literal, context.settings, context.settings.locale))
        .build()

    export const choice: FunctionImpl = new Builder('choice')
        .add('*', '*', '*', (_context, condition, whenTrue, whenFalse) => (Values.isTruthy(condition as Literal) ? whenTrue as Literal : whenFalse as Literal))
        .vectorize(3, [0])
        .build()

    export const striptime: FunctionImpl = new Builder('striptime')
        .add('date', (_context, value) => stripTime(value as Date))
        .vectorize(1, [0])
        .nullish(1)
        .build()

    export const dateformat: FunctionImpl = new Builder('dateformat')
        .add('date', 'string', (context, value, format) => formatDateTokenized(value as Date, text(format), context.settings.locale))
        .vectorize(2, [0])
        .nullish(2)
        .build()

    export const durationformat: FunctionImpl = new Builder('durationformat')
        .add('duration', 'string', (_context, value, format) => {
            const words = (value as { markdown(): string }).markdown()
            const pattern = text(format)
            return words
                .replace(/\b(year|month|week|day|hour|minute|second)s?\b/g, (unit) => (pattern.includes(unit[0]!) ? unit : ''))
                .replace(/\s+/g, ' ')
                .trim() || pattern.replace(/[^a-zA-Z]/g, '')
        })
        .add('duration', (_context, value) => (value as { markdown(): string }).markdown())
        .vectorize(2, [0])
        .nullish(2)
        .build()

    export const localtime: FunctionImpl = new Builder('localtime')
        .add('date', (_context, value) => new Date((value as Date).getTime()))
        .vectorize(1, [0])
        .nullish(1)
        .build()

    export const currencyformat: FunctionImpl = new Builder('currencyformat')
        .add('number', 'string', (context, value, currency) => formatCurrency(value as number, text(currency), context.settings.locale))
        .add('number', (context, value) => formatCurrency(value as number, 'USD', context.settings.locale))
        .vectorize(2, [0])
        .vectorize(1, [0])
        .nullish(1, 2)
        .build()

    function formatCurrency(value: number, currency: string, locale: string): string {
        try {
            return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(value)
        } catch {
            return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(value)
        }
    }

    export const hash: FunctionImpl = new Builder('hash')
        .add('string', 'number', (_context, seed, variant) => cyrb53(text(seed), variant as number))
        .add('string', 'string', (_context, seed, value) => cyrb53(`${text(seed)}${text(value)}`))
        .add('string', 'string', 'number', (_context, seed, value, variant) => cyrb53(`${text(seed)}${text(value)}`, variant as number))
        .build()

    export const meta: FunctionImpl = new Builder('meta')
        .add('link', (_context, value) => {
            const typed = value as DvLink
            return {
                display: typed.display ?? null,
                embed: typed.embed,
                path: typed.path,
                subpath: typed.subpath ?? null,
                type: typed.kind,
            }
        })
        .build()
}

/** Fold `[[Note]]`, `[[Note|Alias]]` and inline markup down to the words a reader would see. */
export function normalizeMarkdownText(source: string): string {
    return source
        .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
        .replace(/\[\[([^\]]*)\]\]/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_~`]+/g, '')
        .trim()
}

/** cyrb53, the 53-bit string hash Dataview uses for `hash()`: two interleaved 32-bit lanes. */
export function cyrb53(source: string, seed = 0): number {
    let h1 = 0xdeadbeef ^ seed
    let h2 = 0x41c6ce57 ^ seed
    for (let index = 0, length = source.length; index < length; index++) {
        const ch = source.charCodeAt(index)
        h1 = Math.imul(h1 ^ ch, 2654435761)
        h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * Parse `value` with the subset of date-format tokens the docs show (`dd/MM/yyyy`,
 * `yyyy-MM-dd'T'HH:mm`); anything else is an error the block reports rather than a wrong date.
 */
function parseWithFormat(value: string, format: string): Date {
    const parts: string[] = []
    let cursor = 0
    while (cursor < format.length) {
        if (format[cursor] === "'") {
            const end = format.indexOf("'", cursor + 1)
            if (end < 0) break
            parts.push(format.slice(cursor, end + 1))
            cursor = end + 1
            continue
        }
        const token = /^(yyyy|yy|MM|dd|HH|hh|mm|ss)/.exec(format.slice(cursor))
        if (token) {
            parts.push(token[1]!)
            cursor += token[1]!.length
            continue
        }
        parts.push(format[cursor]!)
        cursor += 1
    }

    const values: Record<string, number> = {}
    let read = 0
    for (const part of parts) {
        if (!/^yyyy$|^yy$|^MM$|^dd$|^HH$|^hh$|^mm$|^ss$/.test(part)) {
            // Anything else in the pattern is a literal separator the text has to carry.
            if (value.slice(read, read + part.length) !== part) throw new Error(`Can't handle format '${format}' on date string '${value}'`)
            read += part.length
            continue
        }
        const digits = /^\d{1,4}/.exec(value.slice(read))
        if (!digits) throw new Error(`Can't handle format '${format}' on date string '${value}'`)
        values[part] = Number.parseInt(digits[0], 10)
        read += digits[0].length
    }

    const year = values.yyyy ?? (values.yy === undefined ? 1970 : 2000 + values.yy)
    const date = new Date(year, (values.MM ?? 1) - 1, values.dd ?? 1, values.HH ?? values.hh ?? 0, values.mm ?? 0, values.ss ?? 0)
    if (Number.isNaN(date.getTime())) throw new Error(`Can't handle format '${format}' on date string '${value}'`)
    return date
}

export function escapeRegex(source: string): string {
    return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const DEFAULT_FUNCTIONS: Record<string, FunctionImpl> = {
    object: DefaultFunctions.object,
    list: DefaultFunctions.list,
    array: DefaultFunctions.list,
    date: DefaultFunctions.date,
    dur: DefaultFunctions.dur,
    number: DefaultFunctions.number,
    string: DefaultFunctions.string,
    link: DefaultFunctions.link,
    embed: DefaultFunctions.embed,
    elink: DefaultFunctions.elink,
    typeof: DefaultFunctions.typeOf,
    type: DefaultFunctions.typeOf,
    round: DefaultFunctions.round,
    trunc: DefaultFunctions.trunc,
    floor: DefaultFunctions.floor,
    ceil: DefaultFunctions.ceil,
    min: DefaultFunctions.min,
    max: DefaultFunctions.max,
    sum: DefaultFunctions.sum,
    product: DefaultFunctions.product,
    average: DefaultFunctions.average,
    minby: DefaultFunctions.minby,
    maxby: DefaultFunctions.maxby,
    contains: DefaultFunctions.contains,
    icontains: DefaultFunctions.icontains,
    econtains: DefaultFunctions.econtains,
    containsword: DefaultFunctions.containsword,
    extract: DefaultFunctions.extract,
    sort: DefaultFunctions.sort,
    reverse: DefaultFunctions.reverse,
    length: DefaultFunctions.length,
    nonnull: DefaultFunctions.nonnull,
    firstvalue: DefaultFunctions.firstvalue,
    all: DefaultFunctions.all,
    any: DefaultFunctions.any,
    none: DefaultFunctions.none,
    join: DefaultFunctions.join,
    filter: DefaultFunctions.filter,
    map: DefaultFunctions.map,
    flat: DefaultFunctions.flat,
    slice: DefaultFunctions.slice,
    unique: DefaultFunctions.unique,
    reduce: DefaultFunctions.reduce,
    regextest: DefaultFunctions.regextest,
    regexmatch: DefaultFunctions.regexmatch,
    regexreplace: DefaultFunctions.regexreplace,
    replace: DefaultFunctions.replace,
    lower: DefaultFunctions.lower,
    upper: DefaultFunctions.upper,
    split: DefaultFunctions.split,
    startswith: DefaultFunctions.startswith,
    endswith: DefaultFunctions.endswith,
    padleft: DefaultFunctions.padleft,
    padright: DefaultFunctions.padright,
    substring: DefaultFunctions.substring,
    truncate: DefaultFunctions.truncate,
    default: DefaultFunctions.fdefault,
    ldefault: DefaultFunctions.ldefault,
    display: DefaultFunctions.display,
    choice: DefaultFunctions.choice,
    striptime: DefaultFunctions.striptime,
    dateformat: DefaultFunctions.dateformat,
    durationformat: DefaultFunctions.durationformat,
    currencyformat: DefaultFunctions.currencyformat,
    localtime: DefaultFunctions.localtime,
    hash: DefaultFunctions.hash,
    meta: DefaultFunctions.meta,
}
