/**
 * Binary operator dispatch: the arithmetic, concatenation, date arithmetic and comparison rules a
 * query's expressions run on.
 *
 * The table is Dataview's, including its fallback order (exact pair, then right-`*`, then left-`*`,
 * then both), because `WHERE due + dur(1 week) < today` depends on the mixed-type rules and not on
 * whatever a local rewrite would find natural. Comparison is universal: any two values compare, which
 * is what makes `SORT` never fail on a column with mixed types.
 */

import type { BinaryOp } from './ast'
import { DvDuration, DvLink, Values, compareValues, type Literal } from './value'
import { normalizeDuration } from './expression'

export type BinaryOpResult = { ok: true; value: Literal } | { ok: false; error: string }

type Wildcard = '*'
type RuleKey = `${string},${BinaryOp},${string}`

interface BinaryRule {
    left: LiteralTypeKey
    op: BinaryOp
    right: LiteralTypeKey
    impl: (left: never, right: never) => Literal
}

type LiteralTypeKey = Wildcard | 'null' | 'string' | 'number' | 'boolean' | 'date' | 'duration' | 'link' | 'array' | 'object' | 'function' | 'grouping'

function key(op: BinaryOp, left: LiteralTypeKey, right: LiteralTypeKey): RuleKey {
    return `${left},${op},${right}`
}

const RULES: BinaryRule[] = [
    { left: 'number', op: '+', right: 'number', impl: (a, b) => (a as number) + (b as number) },
    { left: 'number', op: '-', right: 'number', impl: (a, b) => (a as number) - (b as number) },
    { left: 'number', op: '*', right: 'number', impl: (a, b) => (a as number) * (b as number) },
    { left: 'number', op: '/', right: 'number', impl: (a, b) => (a as number) / (b as number) },
    { left: 'number', op: '%', right: 'number', impl: (a, b) => (a as number) % (b as number) },

    { left: 'string', op: '+', right: '*', impl: (a, b) => (a as string) + Values.toString(b as Literal) },
    { left: '*', op: '+', right: 'string', impl: (a, b) => Values.toString(a as Literal) + (b as string) },
    { left: 'string', op: '*', right: 'number', impl: (a, b) => ((b as number) < 0 ? '' : (a as string).repeat(b as number)) },
    { left: 'number', op: '*', right: 'string', impl: (a, b) => ((a as number) < 0 ? '' : (b as string).repeat(a as number)) },

    // `left - right` counts forward from the right-hand date, which is the direction a reader means.
    { left: 'date', op: '-', right: 'date', impl: (a, b) => dateDiff(b as Date, a as Date) },
    { left: 'date', op: '-', right: 'duration', impl: (a, b) => addDuration(a as Date, (b as DvDuration).scale(-1)) },
    { left: 'date', op: '+', right: 'duration', impl: (a, b) => addDuration(a as Date, b as DvDuration) },
    { left: 'duration', op: '+', right: 'date', impl: (a, b) => addDuration(b as Date, a as DvDuration) },

    { left: 'duration', op: '+', right: 'duration', impl: (a, b) => normalizeDuration((a as DvDuration).plus(b as DvDuration)) },
    { left: 'duration', op: '-', right: 'duration', impl: (a, b) => normalizeDuration((a as DvDuration).minus(b as DvDuration)) },
    { left: 'duration', op: '/', right: 'number', impl: (a, b) => normalizeDuration((a as DvDuration).scale(1 / (b as number))) },
    { left: 'duration', op: '*', right: 'number', impl: (a, b) => normalizeDuration((a as DvDuration).scale(b as number)) },
    { left: 'number', op: '*', right: 'duration', impl: (a, b) => normalizeDuration((b as DvDuration).scale(a as number)) },

    { left: 'array', op: '+', right: 'array', impl: (a, b) => [...(a as Literal[]), ...(b as Literal[])] },
    { left: 'object', op: '+', right: 'object', impl: (a, b) => ({ ...(a as Record<string, Literal>), ...(b as Record<string, Literal>) }) },

    { left: 'null', op: '+', right: 'null', impl: () => null },
    { left: 'null', op: '-', right: 'null', impl: () => null },
    { left: 'null', op: '*', right: 'null', impl: () => null },
    { left: 'null', op: '/', right: 'null', impl: () => null },
    { left: 'null', op: '%', right: 'null', impl: () => null },
    { left: 'date', op: '+', right: 'null', impl: () => null },
    { left: 'null', op: '+', right: 'date', impl: () => null },
    { left: 'date', op: '-', right: 'null', impl: () => null },
    { left: 'null', op: '-', right: 'date', impl: () => null },
]

const RULE_MAP = new Map<RuleKey, BinaryRule['impl']>(RULES.map((rule) => [key(rule.op, rule.left, rule.right), rule.impl]))

const COMPARE_OPS: readonly BinaryOp[] = ['<', '<=', '>', '>=', '=', '!=']

/**
 * Evaluate one binary operator. `normalizeLink` is the context's link canonicaliser, so two spellings
 * of the same note compare equal in a `WHERE` clause and in a sort.
 */
export function evaluateBinaryOp(op: BinaryOp, left: Literal, right: Literal, normalizeLink: (path: string) => string): BinaryOpResult {
    if (op === '&' || op === '|') {
        const a = safeTruthy(left)
        const b = safeTruthy(right)
        if (a === undefined || b === undefined) return { ok: false, error: `Cannot test truthiness of '${Values.typeOf(op === '&' ? left : right)}'` }
        return { ok: true, value: op === '&' ? a && b : a || b }
    }

    const leftType = Values.typeOf(left)
    const rightType = Values.typeOf(right)
    if (!leftType || !rightType) return { ok: false, error: `Unrecognized value '${Values.toString(left)}' or '${Values.toString(right)}'` }

    if (COMPARE_OPS.includes(op)) {
        const order = compareValues(left, right, normalizeLink)
        const passed = op === '<' ? order < 0 : op === '<=' ? order <= 0 : op === '>' ? order > 0 : op === '>=' ? order >= 0 : order === 0
        return { ok: true, value: passed }
    }

    const impl = RULE_MAP.get(key(op, leftType, rightType))
        ?? RULE_MAP.get(key(op, leftType, '*'))
        ?? RULE_MAP.get(key(op, '*', rightType))
        ?? RULE_MAP.get(key(op, '*', '*'))
    if (!impl) return { ok: false, error: `No implementation for '${leftType} ${op} ${rightType}'` }
    try {
        return { ok: true, value: impl(left as never, right as never) }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
}

function safeTruthy(value: Literal): boolean | undefined {
    if (Values.typeOf(value) === undefined) return undefined
    return Values.isTruthy(value)
}

export function normalizeLinkPath(link: DvLink, normalize: (path: string) => string): DvLink {
    return new DvLink(normalize(link.path), link.kind, link.subpath, link.display, link.embed)
}

/**
 * Add a calendar duration to an instant. Months and years are applied first and clamped to the end of
 * the target month, so `2024-01-31 + 1 month` is `2024-02-29` rather than `2024-03-02`.
 */
export function addDuration(date: Date, duration: DvDuration): Date {
    const result = new Date(date.getTime())
    const calendarMonths = duration.years * 12 + duration.months
    if (calendarMonths !== 0) {
        const whole = Math.trunc(calendarMonths)
        const day = result.getDate()
        result.setDate(1)
        result.setMonth(result.getMonth() + whole)
        const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()
        result.setDate(Math.min(day, lastDay))
        const fractional = calendarMonths - whole
        if (fractional !== 0) result.setTime(result.getTime() + Math.round(fractional * 30.436875 * 86_400_000))
    }
    const days = duration.weeks * 7 + duration.days
    const wholeDays = Math.trunc(days)
    if (wholeDays !== 0) result.setDate(result.getDate() + wholeDays)
    const clock = (days - wholeDays) * 86_400_000 + duration.hours * 3_600_000 + duration.minutes * 60_000 + duration.seconds * 1_000
    if (clock !== 0) result.setTime(result.getTime() + Math.round(clock))
    return result
}

/** The calendar difference between two instants, with months and years borrowed the way a reader counts them. */
export function dateDiff(from: Date, to: Date): DvDuration {
    if (from.getTime() === to.getTime()) return new DvDuration()
    const sign = from.getTime() < to.getTime() ? 1 : -1
    const high = sign > 0 ? to : from
    const low = sign > 0 ? from : to

    let years = high.getFullYear() - low.getFullYear()
    let months = high.getMonth() - low.getMonth()
    if (months < 0) {
        years -= 1
        months += 12
    }
    // The whole-month step can overshoot when the lower date's day does not exist in the target month
    // twice in a row (Jan 31 → Feb 29 → Mar 31), so back off a month until the anchor is not past `high`.
    let anchor = addDuration(low, new DvDuration({ years, months }))
    while (anchor.getTime() > high.getTime()) {
        months -= 1
        if (months < 0) {
            months = 11
            years -= 1
        }
        anchor = addDuration(low, new DvDuration({ years, months }))
    }

    let elapsed = high.getTime() - anchor.getTime()
    const days = Math.floor(elapsed / 86_400_000)
    elapsed -= days * 86_400_000
    const hours = Math.floor(elapsed / 3_600_000)
    elapsed -= hours * 3_600_000
    const minutes = Math.floor(elapsed / 60_000)
    elapsed -= minutes * 60_000

    return new DvDuration({
        years: sign * years,
        months: sign * months,
        days: sign * days,
        hours: sign * hours,
        minutes: sign * minutes,
        seconds: sign * (elapsed / 1_000),
    }).normalized()
}
