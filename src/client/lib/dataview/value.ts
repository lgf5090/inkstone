/**
 * The value model every Dataview expression speaks.
 *
 * A `Literal` is deliberately a closed union rather than `unknown`: the comparison order, the
 * truthiness rule and the rendering rule are all defined by *which* member of the union a value is,
 * and a query must give the same answer whether it ran in a table cell, a `WHERE` clause or a sort
 * key. Dates are plain `Date`s so they survive a structured clone into the DML worker; durations are
 * a class because `2 months` and `60 days` are not the same quantity.
 */

/** An interface rather than `Record<string, Literal>`: the deferred shape is what breaks the cycle. */
export interface DataObject {
    [key: string]: Literal
}
export type Lambda = (...args: Literal[]) => Literal
export type Literal =
    | string
    | number
    | boolean
    | null
    | DvLink
    | Date
    | DvDuration
    | Literal[]
    | DataObject
    | Lambda
    | Grouping

export type LiteralTypeName =
    | 'null'
    | 'string'
    | 'number'
    | 'boolean'
    | 'date'
    | 'duration'
    | 'link'
    | 'array'
    | 'object'
    | 'function'
    | 'grouping'

export type LinkKind = 'file' | 'header' | 'block'

const LINK_TYPES: readonly LinkKind[] = ['file', 'header', 'block']

export class DvLink {
    path: string
    kind: LinkKind
    subpath: string | null
    display: string | null
    embed: boolean

    constructor(path: string, kind: LinkKind = 'file', subpath: string | null = null, display: string | null = null, embed = false) {
        this.path = path
        this.kind = LINK_TYPES.includes(kind) ? kind : 'file'
        this.subpath = subpath
        this.display = display
        this.embed = embed
    }

    static file(path: string, display: string | null = null, embed = false): DvLink {
        return new DvLink(path, 'file', null, display, embed)
    }

    static header(path: string, header: string, display?: string): DvLink {
        return new DvLink(path, 'header', header, display ?? header)
    }

    static block(path: string, block: string, display?: string): DvLink {
        return new DvLink(path, 'block', block, display ?? block)
    }

    /**
     * A bare `X` may name a file, a `X#h` a header and `X^id` a block; a leading `#` or `^` means the
     * current file. Guessing here is what lets `[[]]` links written in prose compare equal to the same
     * target written as a link literal in a query.
     */
    static infer(value: string, embed = false, display: string | null = null): DvLink {
        if (value.startsWith('#')) return new DvLink('', 'header', value.slice(1), display ?? value.slice(1), embed)
        if (value.startsWith('^')) return new DvLink('', 'block', value.slice(1), display ?? value.slice(1), embed)
        const hash = value.lastIndexOf('#')
        if (hash > 0) return new DvLink(value.slice(0, hash), 'header', value.slice(hash + 1), display ?? value.slice(hash + 1), embed)
        const caret = value.lastIndexOf('^')
        if (caret > 0) return new DvLink(value.slice(0, caret), 'block', value.slice(caret + 1), display ?? value.slice(caret + 1), embed)
        return new DvLink(value, 'file', null, display, embed)
    }

    get name(): string {
        const slash = this.path.lastIndexOf('/')
        return (slash < 0 ? this.path : this.path.slice(slash + 1)).replace(/\.md$/i, '')
    }

    withDisplay(display: string | null): DvLink {
        return new DvLink(this.path, this.kind, this.subpath, display, this.embed)
    }

    /** The Markdown spelling, which is also what a table cell shows for an unlabelled link. */
    markdown(): string {
        const prefix = this.embed ? '![[' : '[['
        const target = this.subpath === null
            ? this.path
            : this.kind === 'block' ? `${this.path}^${this.subpath}` : `${this.path}#${this.subpath}`
        return this.display === null || this.display === target
            ? `${prefix}${target}]]`
            : `${prefix}${target}|${this.display}]]`
    }
}

const intlCache = new Map<string, Intl.DateTimeFormat>()
function intlFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = `${locale}|${JSON.stringify(options)}`
    let formatter = intlCache.get(key)
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, options)
        intlCache.set(key, formatter)
    }
    return formatter
}

/** Move whole multiples of `ratio` out of `amount` and into `target`. */
function fold(amount: number, target: number, ratio: number): [number, number] {
    const whole = Math.trunc(amount / ratio)
    return [amount - whole * ratio, target + whole]
}

/**
 * Months and years are calendar quantities, so `2024-01-31 + 1 month` is `2024-02-29`, not a
 * 30-day drift. Keeping the calendar fields in the class (rather than a millisecond count) is what
 * lets `dur(3 months)` and `date(2024-01-01)` be added at all.
 */
export class DvDuration {
    years = 0
    months = 0
    weeks = 0
    days = 0
    hours = 0
    minutes = 0
    seconds = 0

    constructor(source: Partial<Pick<DvDuration, 'years' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds'>> = {}) {
        this.years = source.years ?? 0
        this.months = source.months ?? 0
        this.weeks = source.weeks ?? 0
        this.days = source.days ?? 0
        this.hours = source.hours ?? 0
        this.minutes = source.minutes ?? 0
        this.seconds = source.seconds ?? 0
    }

    static of(units: Partial<Pick<DvDuration, 'years' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds'>>): DvDuration {
        return new DvDuration(units)
    }

    /**
     * Fold each unit into the next larger one the way luxon's `shiftToAll().normalize()` does:
     * `90 minutes` becomes `1 hour 30 minutes`, `9 days` becomes `1 week 2 days`, `13 months` becomes
     * `1 year 1 month`. A fractional remainder stays in the smaller unit rather than being dropped.
     */
    normalized(): DvDuration {
        let seconds = this.seconds
        let minutes = this.minutes
        let hours = this.hours
        let days = this.days
        let weeks = this.weeks
        ;[seconds, minutes] = fold(seconds, minutes, 60)
        ;[minutes, hours] = fold(minutes, hours, 60)
        ;[hours, days] = fold(hours, days, 24)
        ;[days, weeks] = fold(days, weeks, 7)
        const [months, years] = fold(this.months, this.years, 12)
        return new DvDuration({ years, months, weeks, days, hours, minutes, seconds })
    }

    plus(other: DvDuration): DvDuration {
        return new DvDuration({
            years: this.years + other.years,
            months: this.months + other.months,
            weeks: this.weeks + other.weeks,
            days: this.days + other.days,
            hours: this.hours + other.hours,
            minutes: this.minutes + other.minutes,
            seconds: this.seconds + other.seconds,
        })
    }

    minus(other: DvDuration): DvDuration {
        return this.plus(other.scale(-1))
    }

    scale(factor: number): DvDuration {
        return new DvDuration({
            years: this.years * factor,
            months: this.months * factor,
            weeks: this.weeks * factor,
            days: this.days * factor,
            hours: this.hours * factor,
            minutes: this.minutes * factor,
            seconds: this.seconds * factor,
        })
    }

    /**
     * A fixed-length approximation used only for comparison and for the `<unit>` accessor of a
     * duration that has no calendar part. Months carry the mean Gregorian month so `6 months` and
     * `182 days` stay distinguishable.
     */
    toMillis(): number {
        return (this.years * 365.25 * 24 * 60 * 60
            + this.months * 30.436875 * 24 * 60 * 60
            + (this.weeks * 7 + this.days) * 24 * 60 * 60
            + this.hours * 3600
            + this.minutes * 60
            + this.seconds) * 1000
    }

    as(unit: string): number {
        switch (unit) {
            case 'years': return this.years
            case 'months': return this.months
            case 'weeks': return this.weeks
            case 'days': return this.weeks * 7 + this.days
            case 'hours': return this.hours
            case 'minutes': return this.minutes
            case 'seconds': return this.seconds
            default: return this.toMillis() / 1000
        }
    }

    /** The `4 days 3 hours` spelling a query can feed back to `dur()`. */
    markdown(): string {
        const parts: string[] = []
        const push = (amount: number, word: string) => {
            if (!amount) return
            parts.push(`${amount} ${word}${Math.abs(amount) === 1 ? '' : 's'}`)
        }
        const normalized = this.normalized()
        push(normalized.years, 'year')
        push(normalized.months, 'month')
        push(normalized.weeks, 'week')
        push(normalized.days, 'day')
        push(normalized.hours, 'hour')
        push(normalized.minutes, 'minute')
        push(normalized.seconds, 'second')
        return parts.length ? parts.join(' ') : '0 seconds'
    }
}

/** The grouped row set a `GROUP BY` produces; rendered as a list, indexed as an array. */
export class Grouping {
    key: Literal
    rows: DataObject[]

    constructor(key: Literal, rows: DataObject[]) {
        this.key = key
        this.rows = rows
    }

    get length(): number { return this.rows.length }
}

export interface ValueRenderSettings {
    renderNullAs: string
    dateFormat: string
    datetimeFormat: string
    durationFormat: string
}

export const DEFAULT_RENDER_SETTINGS: ValueRenderSettings = {
    renderNullAs: '—',
    dateFormat: 'yyyy-MM-dd',
    datetimeFormat: 'yyyy-MM-dd HH:mm',
    durationFormat: 'long',
}

/**
 * The member of the union a value is, or `undefined` for the values that are never truthy and never
 * comparable — `null`, `NaN`, an invalid date. The name doubles as the sort key between types.
 */
function wrapValue(value: Literal | undefined): LiteralTypeName | undefined {
    if (value === null || value === undefined) return 'null'
    if (value instanceof DvLink) return 'link'
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : 'date'
    if (value instanceof DvDuration) return 'duration'
    if (value instanceof Grouping) return 'grouping'
    if (Array.isArray(value)) return 'array'
    switch (typeof value) {
        case 'string': return 'string'
        case 'number': return Number.isNaN(value) ? undefined : 'number'
        case 'boolean': return 'boolean'
        case 'function': return 'function'
        case 'object': return 'object'
        default: return undefined
    }
}

function pad(value: number, width = 2): string {
    const text = String(Math.trunc(Math.abs(value)))
    return value < 0 ? `-${text.padStart(width, '0')}` : text.padStart(width, '0')
}

/**
 * A small subset of the date-format token language, long tokens before short ones so `MMMM` is not
 * read as four `M`s. Unmatched characters pass through, which is what makes a locale-specific suffix
 * such as the Chinese day mark a legal format character.
 */
export function formatDateTokenized(date: Date, pattern: string, locale: string): string {
    if (Number.isNaN(date.getTime())) return ''
    if (pattern === 'ff') return intlFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
    if (pattern === 'fFF' || pattern === 'FFF') return intlFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    let out = ''
    let index = 0
    while (index < pattern.length) {
        if (pattern[index] === "'") {
            const end = pattern.indexOf("'", index + 1)
            out += end < 0 ? pattern.slice(index + 1) : pattern.slice(index + 1, end)
            index = end < 0 ? pattern.length : end + 1
            continue
        }
        const token = /^(yyyy|yy|MMMM|MMM|MM|dd|d|HHH|HH|H|hh|h|mm|m|ss|s|EEEE|EEE|a|ZZZ|Z)/.exec(pattern.slice(index))
        if (!token) {
            out += pattern[index] ?? ''
            index += 1
            continue
        }
        out += formatToken(date, token[1]!, locale)
        index += token[1]!.length
    }
    return out
}

function formatToken(date: Date, token: string, locale: string): string {
    const localized = (options: Intl.DateTimeFormatOptions) => intlFormat(locale, options).format(date)
    switch (token) {
        case 'yyyy': return String(date.getFullYear())
        case 'yy': return pad(date.getFullYear() % 100)
        case 'MMMM': return localized({ month: 'long' })
        case 'MMM': return localized({ month: 'short' })
        case 'MM': return pad(date.getMonth() + 1)
        case 'M': return String(date.getMonth() + 1)
        case 'dd': return pad(date.getDate())
        case 'd': return String(date.getDate())
        case 'HHH': return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
        case 'HH': return pad(date.getHours())
        case 'H': return String(date.getHours())
        case 'hh': return pad(date.getHours() % 12 || 12)
        case 'h': return String(date.getHours() % 12 || 12)
        case 'mm': return pad(date.getMinutes())
        case 'm': return String(date.getMinutes())
        case 'ss': return pad(date.getSeconds())
        case 's': return String(date.getSeconds())
        case 'EEEE': return localized({ weekday: 'long' })
        case 'EEE': return localized({ weekday: 'short' })
        case 'a': return localized({ hour: 'numeric', dayPeriod: 'narrow' })
        case 'ZZZ': case 'Z': return timeZoneOffset(date)
        default: return token
    }
}

function timeZoneOffset(date: Date): string {
    const minutes = -date.getTimezoneOffset()
    const sign = minutes < 0 ? '-' : '+'
    const abs = Math.abs(minutes)
    return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function formatDurationReadable(duration: DvDuration, style: string): string {
    if (style === 'short') return duration.markdown().replace(/years?|months?|weeks?|days?|hours?|minutes?|seconds?/g, (word) => word[0]!)
    if (style === 'tiny') return duration.markdown().replace(/[^0-9 ]/g, '').trim().replace(/\s+/g, '')
    return duration.markdown()
}

/**
 * Total ordering used by `SORT` and by the comparison operators. Nulls come first, then each type in
 * the order the union names them, so a mixed column still sorts deterministically instead of throwing
 * or falling back to source order.
 */
export function compareValues(left: Literal | undefined, right: Literal | undefined, normalize?: (path: string) => string): number {
    if (left === undefined) left = null
    if (right === undefined) right = null
    if (left === null && right === null) return 0
    if (left === null) return -1
    if (right === null) return 1

    const a = wrapValue(left)
    const b = wrapValue(right)
    if (!a && !b) return 0
    if (!a) return -1
    if (!b) return 1
    if (a !== b) return a < b ? -1 : 1
    if (left === right) return 0

    switch (a) {
        case 'string': return compareStrings(left as string, right as string)
        case 'number': return (left as number) < (right as number) ? -1 : 1
        case 'boolean': return (left as boolean) === (right as boolean) ? 0 : (left as boolean) ? 1 : -1
        case 'date': return compareDates(left as Date, right as Date)
        case 'duration': return (left as DvDuration).toMillis() - (right as DvDuration).toMillis()
        case 'link': {
            const one = normalize ? normalize((left as DvLink).path) : (left as DvLink).path
            const other = normalize ? normalize((right as DvLink).path) : (right as DvLink).path
            const byPath = compareStrings(one, other)
            if (byPath !== 0) return byPath
            return compareStrings((left as DvLink).subpath ?? '', (right as DvLink).subpath ?? '')
        }
        case 'array': {
            const one = left as Literal[]
            const other = right as Literal[]
            for (let index = 0; index < Math.min(one.length, other.length); index++) {
                const result = compareValues(one[index], other[index], normalize)
                if (result !== 0) return result
            }
            return one.length - other.length
        }
        case 'grouping': {
            const one = left as Grouping
            const other = right as Grouping
            return compareValues(one.key, other.key, normalize)
        }
        case 'object': {
            const one = Object.keys(left as DataObject).sort()
            const other = Object.keys(right as DataObject).sort()
            return compareStrings(one.join(','), other.join(','))
        }
        default: return 0
    }
}

/**
 * Numbers embedded in text order naturally, so `Task 2` sorts before `Task 10`. Without this a column
 * of titles or of `1.1`-style version strings sorts in an order readers call a bug.
 */
export function compareStrings(left: string, right: string): number {
    const result = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base', caseFirst: 'lower' })
    return result === 0 ? left.localeCompare(right) : result
}

function compareDates(left: Date, right: Date): number {
    const a = left.getTime()
    const b = right.getTime()
    return a === b ? 0 : a < b ? -1 : 1
}

export namespace Values {
    export function isString(value: unknown): value is string { return typeof value === 'string' }
    export function isNumber(value: unknown): value is number { return typeof value === 'number' && !Number.isNaN(value) }
    export function isBoolean(value: unknown): value is boolean { return typeof value === 'boolean' }
    export function isNull(value: unknown): value is null | undefined { return value === null || value === undefined }
    export function isArray(value: unknown): value is Literal[] { return Array.isArray(value) }
    export function isObject(value: unknown): value is DataObject {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
            && !(value instanceof Date) && !(value instanceof DvLink) && !(value instanceof DvDuration)
            && !(value instanceof Grouping)
    }
    export function isFunction(value: unknown): value is Lambda { return typeof value === 'function' }
    export function isLink(value: unknown): value is DvLink { return value instanceof DvLink }
    export function isDate(value: unknown): value is Date { return value instanceof Date && !Number.isNaN(value.getTime()) }
    export function isDuration(value: unknown): value is DvDuration { return value instanceof DvDuration }
    export function isGrouping(value: unknown): value is Grouping { return value instanceof Grouping }

    export function typeOf(value: Literal | undefined): LiteralTypeName | undefined {
        return wrapValue(value)
    }

    export function isTruthy(value: Literal): boolean {
        const wrapped = wrapValue(value)
        if (!wrapped) return false
        switch (wrapped) {
            case 'number': return (value as number) !== 0
            case 'string': return (value as string).length > 0
            case 'boolean': return value as boolean
            case 'link': return (value as DvLink).path.length > 0 || (value as DvLink).subpath !== null
            case 'date': return (value as Date).getTime() !== 0
            case 'duration': return (value as DvDuration).toMillis() !== 0
            case 'object': return Object.keys(value as DataObject).length > 0
            case 'array': return (value as Literal[]).length > 0
            case 'grouping': return (value as Grouping).rows.length > 0
            case 'function': return true
            default: return false
        }
    }

    export function deepCopy<T extends Literal>(value: T): T {
        if (value === null || value === undefined) return value
        if (Array.isArray(value)) return value.map((item) => deepCopy(item)) as T
        if (value instanceof Date) return new Date(value.getTime()) as T
        if (value instanceof DvDuration) return new DvDuration(value) as T
        if (value instanceof DvLink) return value.withDisplay(value.display) as unknown as T
        if (value instanceof Grouping) return new Grouping(deepCopy(value.key), value.rows.map((row) => deepCopy(row) as DataObject)) as unknown as T
        if (Values.isObject(value)) {
            const result: DataObject = {}
            for (const [key, item] of Object.entries(value as DataObject)) result[key] = deepCopy(item)
            return result as T
        }
        return value
    }

    /** Apply `transform` to every leaf of a nested structure, keeping arrays and objects in shape. */
    export function mapLeaves(value: Literal, transform: (leaf: Literal) => Literal): Literal {
        if (Array.isArray(value)) return value.map((item) => mapLeaves(item, transform))
        if (value instanceof Date || value instanceof DvDuration || value instanceof DvLink) return transform(value)
        if (Values.isObject(value)) {
            const result: DataObject = {}
            for (const [key, item] of Object.entries(value)) result[key] = mapLeaves(item, transform)
            return result
        }
        return transform(value)
    }

    /**
     * The text a cell shows. Only the outermost array is unwrapped — a nested list keeps its brackets
     * so a reader can see the difference between one value and several.
     */
    export function toString(
        value: Literal | undefined,
        settings: ValueRenderSettings = DEFAULT_RENDER_SETTINGS,
        locale = 'en-US',
        recursive = false,
    ): string {
        const wrapped = wrapValue(value === undefined ? null : value)
        if (!wrapped) return settings.renderNullAs
        switch (wrapped) {
            case 'string': return value as string
            case 'number': return numberText(value as number)
            case 'boolean': return value ? 'true' : 'false'
            case 'link': return (value as DvLink).display ?? (value as DvLink).name
            case 'date': return formatDateTokenized(value as Date, settings.dateFormat, locale)
            case 'duration': return formatDurationReadable(value as DvDuration, settings.durationFormat)
            case 'array': {
                const items = (value as Literal[]).map((item) => toString(item, settings, locale, true))
                return recursive ? `[${items.join(', ')}]` : items.join(', ')
            }
            case 'grouping': return toString((value as Grouping).key, settings, locale, true)
            case 'object': {
                const entries = Object.entries(value as DataObject).map(([key, item]) => `${key}: ${toString(item, settings, locale, true)}`)
                return `{${entries.join(', ')}}`
            }
            case 'function': return '<function>'
            default: return settings.renderNullAs
        }
    }

    /** Integers print bare, fractions keep at most six significant digits and never use `1e21`. */
    export function numberText(value: number): string {
        if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value)
        if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity'
        const fixed = value.toFixed(6)
        return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    }

    export function compare(left: Literal | undefined, right: Literal | undefined, normalize?: (path: string) => string): number {
        return compareValues(left, right, normalize)
    }
}
