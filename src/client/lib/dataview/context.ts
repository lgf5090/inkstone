/**
 * The expression evaluator.
 *
 * A `Context` is one query's worth of state: the settings that decide how values render, the link
 * handler that decides when two spellings of a note name are the same note, the globals (`this`,
 * `row`) and the field evaluator. Variable lookup, index semantics and function dispatch follow
 * Dataview exactly, including the two that users rely on most: indexing an array by a *string* maps
 * over the array (`file.tasks.text`), and indexing a link resolves the target note
 * (`[[Some note]].rating`).
 */

import type { Field } from './ast'
import { Fields } from './ast'
import { DvDuration, DvLink, Values, type DataObject, type Lambda, type Literal } from './value'
import { evaluateBinaryOp } from './binaryop'
import { DEFAULT_FUNCTIONS, DEFAULT_QUERY_SETTINGS, type FunctionContext, type FunctionImpl, type QueryRuntimeSettings } from './functions'

export interface LinkHandler {
    /** The page data behind a link, or null when the note does not exist or is not indexed yet. */
    resolve(path: string): DataObject | null
    /** The canonical path for comparisons: an existing note resolves, a missing one is left alone. */
    normalize(path: string): string
    exists(path: string): boolean
}

export interface ContextOptions {
    linkHandler: LinkHandler
    settings?: QueryRuntimeSettings
    globals?: Record<string, Literal>
    functions?: Record<string, FunctionImpl>
}

const MONTH_MILLIS = 30.436875 * 86_400_000
const YEAR_MILLIS = 365.25 * MONTH_MILLIS

export class Context implements FunctionContext {
    readonly settings: QueryRuntimeSettings
    readonly linkHandler: LinkHandler
    readonly globals: Record<string, Literal>
    readonly functions: Record<string, FunctionImpl>

    constructor(options: ContextOptions) {
        this.linkHandler = options.linkHandler
        this.settings = options.settings ?? DEFAULT_QUERY_SETTINGS
        this.globals = options.globals ?? {}
        this.functions = options.functions ?? DEFAULT_FUNCTIONS
    }

    set(name: string, value: Literal): this {
        this.globals[name] = value
        return this
    }

    normalizeLink(path: string): string {
        return this.linkHandler.normalize(path)
    }

    linkExists(path: string): boolean {
        return this.linkHandler.exists(path)
    }

    resolveLink(path: string): DataObject | null {
        return this.linkHandler.resolve(path)
    }

    /** Evaluate a field, throwing on failure. Callers that want per-row errors catch at the row. */
    evaluate(field: Field, data: Record<string, Literal> = {}): Literal {
        switch (field.type) {
            case 'literal':
                return field.value
            case 'variable':
                if (field.name in data) return data[field.name]!
                if (field.name in this.globals) return this.globals[field.name]!
                return null
            case 'negated':
                return !Values.isTruthy(this.evaluate(field.child, data))
            case 'binaryop': {
                const left = this.evaluate(field.left, data)
                // `and` / `or` short-circuit, which is what makes `x and x.y != null` safe.
                if (field.op === '&' && !Values.isTruthy(left)) return false
                if (field.op === '|' && Values.isTruthy(left)) return true
                const right = this.evaluate(field.right, data)
                const result = evaluateBinaryOp(field.op, left, right, this.linkHandler.normalize)
                if (!result.ok) throw new Error(result.error)
                return result.value
            }
            case 'list':
                return field.values.map((value) => this.evaluate(value, data))
            case 'object': {
                const result: DataObject = {}
                for (const [key, value] of Object.entries(field.values)) result[key] = this.evaluate(value, data)
                return result
            }
            case 'lambda': {
                const captured = { ...data }
                return ((...args: Literal[]) => {
                    const scope = { ...captured }
                    for (let index = 0; index < Math.min(args.length, field.params.length); index++) {
                        scope[field.params[index]!] = args[index] ?? null
                    }
                    return this.evaluate(field.body, scope)
                }) satisfies Lambda
            }
            case 'func': {
                const args = field.args.map((arg) => this.evaluate(arg, data))
                // A lambda callee (`((x) => x + 1)(2)`) closes over this context already, so it is
                // called directly; a named callee is looked up in the function table.
                if (Values.isFunction(field.callee)) return (field.callee as unknown as (...values: Literal[]) => Literal)(...args)
                const name = field.callee.type === 'variable'
                    ? field.callee.name
                    : Values.toString(this.evaluate(field.callee, data), this.settings, this.settings.locale)
                const impl = typeof name === 'string' ? this.functions[name] : undefined
                if (!impl) throw new Error(`Unrecognized function name '${String(name)}'`)
                try {
                    return impl(this, ...args)
                } catch (error) {
                    throw error instanceof Error ? error : new Error(String(error))
                }
            }
            case 'index':
                return this.indexInto(field, data)
            default:
                throw new Error(`Unrecognized field '${(field as { type: string }).type}'`)
        }
    }

    /** Best-effort evaluation for diagnostics: never throws, reports the failure instead. */
    attempt(field: Field, data: Record<string, Literal> = {}): { ok: true; value: Literal } | { ok: false; error: string } {
        try {
            return { ok: true, value: this.evaluate(field, data) }
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
    }

    private indexInto(field: Extract<Field, { type: 'index' }>, data: Record<string, Literal>): Literal {
        const raw = this.evaluate(field.index, data)
        if (!(Values.isString(raw) || Values.isNumber(raw) || Values.isNull(raw))) throw new Error('Can only index with a string or number')
        if (Values.isNull(raw)) return null
        const index = raw

        // `row.x` reads the row plus the globals, so `row.file.name` works as well as `file.name`.
        const object: Literal = field.object.type === 'variable' && field.object.name === 'row'
            ? { ...this.globals, ...data } as DataObject
            : this.evaluate(field.object, data)

        switch (Values.typeOf(object)) {
            case 'object': {
                if (!Values.isString(index)) throw new Error('can only index into objects with strings (a.b or a["b"])')
                return (object as DataObject)[index] ?? null
            }
            case 'link': {
                if (!Values.isString(index)) throw new Error('can only index into links with strings (a.b or a["b"])')
                const resolved = this.linkHandler.resolve((object as DvLink).path)
                if (!resolved) return null
                return resolved[index] ?? null
            }
            case 'array': {
                const list = object as Literal[]
                if (Values.isNumber(index)) return index >= list.length || index < 0 ? null : list[index] ?? null
                return list.map((item) => {
                    try {
                        return this.evaluate(Fields.index(Fields.literal(item), Fields.literal(index)))
                    } catch {
                        return null
                    }
                })
            }
            case 'string': {
                if (!Values.isNumber(index)) throw new Error('string indexing requires a numeric index (string[index])')
                const text = object as string
                return index >= text.length || index < 0 ? null : text[index] ?? null
            }
            case 'date':
                return datePart(object as Date, index)
            case 'duration':
                return durationPart(object as DvDuration, index)
            case 'grouping': {
                const rows = (object as unknown as { rows: DataObject[] }).rows
                if (Values.isNumber(index)) return rows[index] ?? null
                return rows.map((row) => this.evaluate(Fields.index(Fields.literal(row), Fields.literal(index))))
            }
            default:
                return null
        }
    }

    /** Compare two values the way an operator would, which the sort step needs directly. */
    compare(one: Literal | undefined, other: Literal | undefined): number {
        return Values.compare(one, other, this.linkHandler.normalize)
    }
}

/** `date.year`/`.month`/`.day`/`.weekday`/…, mirroring the units the reference exposes. */
function datePart(date: Date, unit: Literal): Literal {
    if (!Values.isString(unit)) throw new Error('date indexing requires a string representing the unit')
    switch (unit) {
        case 'year': return date.getFullYear()
        case 'month': return date.getMonth() + 1
        case 'day': return date.getDate()
        case 'hour': return date.getHours()
        case 'minute': return date.getMinutes()
        case 'second': return date.getSeconds()
        case 'millisecond': return date.getMilliseconds()
        case 'weekday': return ((date.getDay() + 6) % 7) + 1
        case 'week': return Math.floor((date.getDate() - 1) / 7) + 1
        case 'weekyear': return isoWeek(date)
        default: return null
    }
}

function isoWeek(date: Date): number {
    const target = new Date(date.getTime())
    const dayNumber = (target.getDay() + 6) % 7
    target.setDate(target.getDate() - dayNumber + 3)
    const firstThursday = new Date(target.getFullYear(), 0, 4)
    const shift = ((firstThursday.getDay() + 6) % 7) - 3
    firstThursday.setDate(firstThursday.getDate() - shift + 3)
    return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
}

/**
 * Duration units are totals rather than calendar parts, matching luxon's `shiftTo(unit)`:
 * `dur(90 days).months` is about 2.96, not 2.
 */
function durationPart(duration: DvDuration, unit: Literal): Literal {
    if (!Values.isString(unit)) throw new Error('duration indexing requires a string representing the unit')
    const millis = duration.toMillis()
    switch (unit) {
        case 'year': case 'years': return millis / YEAR_MILLIS
        case 'month': case 'months': return millis / MONTH_MILLIS
        case 'week': case 'weeks': return millis / (7 * 86_400_000)
        case 'day': case 'days': return millis / 86_400_000
        case 'hour': case 'hours': return millis / 3_600_000
        case 'minute': case 'minutes': return millis / 60_000
        case 'second': case 'seconds': return millis / 1_000
        case 'millisecond': case 'milliseconds': return millis
        default: return null
    }
}
