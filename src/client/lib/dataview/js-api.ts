/**
 * The Dataview DML API, and the wire format it speaks.
 *
 * This module runs *inside* the worker that hosts a note's code, so it must stay free of the DOM: no
 * `document`, no store, no renderer. What it gets instead is a plain snapshot of the pages the main
 * thread already indexed, and what it gives back is a tree of JSON descriptors that the main thread
 * renders. A note's code therefore cannot reach a node, a cookie, or the network — the same wall the
 * runnable-example sandbox already has, with the same two-second stop for a loop that will not end.
 *
 * Values cross the boundary through `cool`/`warm`: a `Date`, a link and a duration are classes, and
 * `postMessage` would flatten them into objects with no behaviour. The marker is a single key with a
 * `\u0000` in it, which no note can write by accident.
 */

import { DvDuration, DvLink, Grouping, Values, type DataObject, type Literal } from './value'
import { parseField, parseSource, parseQuery } from './expression'
import type { Source } from './ast'
import { executeQuery, type DataRail } from './engine'
import { Context } from './context'
import type { QueryRuntimeSettings } from './functions'
import { DEFAULT_QUERY_SETTINGS } from './functions'

export const DV_MARKER = '\u0000dv'
/** The snapshot ceiling: past this the block is told the answer is incomplete rather than slowed down. */
export const DV_PAGE_LIMIT = 400
export const DV_OUTPUT_LIMIT = 600

export type DvNode =
    | { kind: 'text'; text: string }
    | { kind: 'heading'; level: number; children: DvNode[] }
    | { kind: 'paragraph'; children: DvNode[] }
    | { kind: 'list'; ordered: boolean; items: DvNode[] }
    | { kind: 'task'; items: { text: DvNode[]; completed: boolean; source: string | null }[]; group: boolean }
    | { kind: 'table'; header: DvNode[]; rows: DvNode[][] }
    | { kind: 'grid'; header: DvNode[]; rows: DvNode[][] }
    | { kind: 'element'; tag: string; class: string | null; attrs: Record<string, string>; children: DvNode[] }
    | { kind: 'markdown'; text: string }
    | { kind: 'html'; html: string }
    | { kind: 'link'; path: string; subpath: string | null; display: string | null; embed: boolean }
    | { kind: 'section'; title: string | null; children: DvNode[] }

export interface DvSnapshotPage {
    path: string
    data: unknown
}

export interface DvRequest {
    code: string
    pages: DvSnapshotPage[]
    current: DvSnapshotPage | null
    settings: QueryRuntimeSettings
}

export interface DvReply {
    nodes: DvNode[]
    logs: { type: string; text: string }[]
    errorText: string
    resultText: string
    durationMs: number
    truncated: boolean
}

/** Turn a live value into something `postMessage` can carry without losing what it was. */
export function cool(value: unknown): unknown {
    if (value instanceof Date) return { [DV_MARKER]: 'date', value: value.getTime() }
    if (value instanceof DvLink) return { [DV_MARKER]: 'link', path: value.path, kind: value.kind, subpath: value.subpath, display: value.display, embed: value.embed }
    if (value instanceof DvDuration) return { [DV_MARKER]: 'duration', units: { ...value } }
    if (value instanceof Grouping) return { [DV_MARKER]: 'group', key: cool(value.key), rows: value.rows.map((row) => cool(row)) }
    if (value instanceof DvArray) return value.array().map((item) => cool(item))
    if (Array.isArray(value)) return value.map((item) => cool(item))
    if (value instanceof Map) return { [DV_MARKER]: 'map', entries: [...value.entries()].map(([key, item]) => [String(key), cool(item)]) }
    if (value instanceof Set) return { [DV_MARKER]: 'set', items: [...value].map((item) => cool(item)) }
    if (typeof value === 'function') return { [DV_MARKER]: 'function' }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = cool(item)
        return out
    }
    return value === undefined ? null : value
}

/** The other direction: a marker back into the class it came from. */
export function warm(value: unknown): Literal {
    // A note's own `dv.date(...)` / `dv.duration(...)` hand back real instances, and treating those as
    // plain objects would warm them into an empty record.
    if (value instanceof Date || value instanceof DvLink || value instanceof DvDuration || value instanceof Grouping) return value as Literal
    if (Array.isArray(value)) return value.map((item) => warm(item))
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        const marker = record[DV_MARKER]
        if (marker === 'date') return new Date(Number(record.value))
        if (marker === 'link') return new DvLink(String(record.path), String(record.kind) as DvLink['kind'], (record.subpath as string | null) ?? null, (record.display as string | null) ?? null, Boolean(record.embed))
        if (marker === 'duration') return new DvDuration(record.units as Partial<DvDuration>)
        if (marker === 'group') return new Grouping(warm(record.key), (record.rows as unknown[]).map((row) => warm(row) as DataObject))
        if (marker === 'map') {
            const out: DataObject = {}
            for (const [key, item] of (record.entries as [string, unknown][])) out[key] = warm(item)
            return out
        }
        if (marker === 'set') {
            return (record.items as unknown[]).map((item) => warm(item))
        }
        if (marker === 'function') return null
        const out: DataObject = {}
        for (const [key, item] of Object.entries(record)) out[key] = warm(item)
        return out
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    return null
}

/**
 * The DataArray of the port: the helpers a note's code reaches for, over a list of literals.
 *
 * It deliberately does not extend `Array`. `map`/`filter`/`sort` on a subclass cannot return the
 * subclass under `Literal`'s union (the base's generic `U[]` refuses a narrower element type), and a
 * class that lies about its own `Array` contract is worse than one that says it is a list with methods.
 * `array()` is the documented way down to a real array, and `asList` is the internal one.
 *
 * The object a note holds is a proxy over an instance, which is what makes `pages.file.name` mean
 * `pages.to('file').to('name')` — the shorthand real snippets use constantly. Anything that is not a
 * method name or an index is read as a field, so a typo yields an empty list rather than a crash.
 */
export type DvKeyFunc = (value: Literal, index: number, values: Literal[]) => unknown
export type DvComparator = (one: never, other: never) => number

const DV_ARRAY_MEMBERS = new Set([
    'length', 'values', 'array', 'toJSON', 'toString', 'first', 'last', 'get', 'map', 'filter', 'where',
    'flatMap', 'mutate', 'limit', 'slice', 'concat', 'indexOf', 'find', 'findIndex', 'includes', 'join',
    'sort', 'sortInPlace', 'groupBy', 'groupIn', 'distinct', 'every', 'some', 'none', 'to', 'into',
    'expand', 'forEach', 'sum', 'avg', 'min', 'max',
])

const DV_PASSTHROUGH = new Set(['constructor', 'prototype', '__proto__', 'then', 'inspect', 'nodeType'])

export class DvArray {
    private readonly values: Literal[]
    private readonly settings: QueryRuntimeSettings

    private constructor(values: Literal[], settings: QueryRuntimeSettings) {
        this.values = values
        this.settings = settings
    }

    private wrap<U>(values: U[]): DvArray {
        return DvArray.of(values, this.settings)
    }

    private compare(one: Literal, other: Literal): number {
        return Values.compare(one, other)
    }

    private static readonly PROXY: ProxyHandler<DvArray> = {
        get(target, property) {
            if (typeof property === 'symbol') return Reflect.get(target, property)
            const index = Number(property)
            if (Number.isInteger(index) && String(index) === property) return target.at(index)
            if (DV_ARRAY_MEMBERS.has(property) && !DV_PASSTHROUGH.has(property)) {
                const member = Reflect.get(target, property)
                return typeof member === 'function' ? member.bind(target) : member
            }
            if (DV_PASSTHROUGH.has(property)) return Reflect.get(target, property)
            return target.to(property)
        },
    }

    static of(values: Iterable<unknown>, settings: QueryRuntimeSettings = DEFAULT_QUERY_SETTINGS): DvArray {
        return new Proxy(new DvArray(Array.from(values) as Literal[], settings), DvArray.PROXY)
    }

    get length(): number {
        return this.values.length
    }

    [Symbol.iterator](): Iterator<Literal> {
        return this.values[Symbol.iterator]()
    }

    array(): Literal[] {
        return [...this.values]
    }

    at(index: number): Literal | null {
        return this.values[index < 0 ? this.values.length + index : index] ?? null
    }

    get(index: number): Literal | null {
        return this.at(index)
    }

    first(): Literal | null {
        return this.values.length ? this.values[0]! : null
    }

    last(): Literal | null {
        return this.values.length ? this.values[this.values.length - 1]! : null
    }

    map(transform: DvKeyFunc): DvArray {
        return this.wrap(this.values.map((value, index) => transform(value, index, this.values)))
    }

    filter(predicate: DvKeyFunc): DvArray {
        return this.where(predicate)
    }

    where(predicate: DvKeyFunc): DvArray {
        return this.wrap(this.values.filter((value, index) => Boolean(predicate(value, index, this.values))))
    }

    flatMap(transform: DvKeyFunc): DvArray {
        return this.wrap(this.values.flatMap((value, index) => asRawList(transform(value, index, this.values))))
    }

    mutate(transform: DvKeyFunc): DvArray {
        this.values.forEach((value, index) => {
            transform(value, index, this.values)
        })
        return this
    }

    limit(count: number): DvArray {
        return this.wrap(this.values.slice(0, Math.max(0, Math.trunc(count))))
    }

    slice(start?: number, end?: number): DvArray {
        return this.wrap(this.values.slice(start, end))
    }

    concat(other: Iterable<unknown>): DvArray {
        return this.wrap([...this.values, ...Array.from(other) as Literal[]])
    }

    indexOf(element: Literal, fromIndex = 0): number {
        return this.values.findIndex((value, index) => index >= fromIndex && Values.compare(value, element) === 0)
    }

    find(predicate: DvKeyFunc): Literal | undefined {
        return this.values.find((value, index) => Boolean(predicate(value, index, this.values)))
    }

    findIndex(predicate: DvKeyFunc, fromIndex = 0): number {
        for (let index = fromIndex; index < this.values.length; index++) {
            if (predicate(this.values[index]!, index, this.values)) return index
        }
        return -1
    }

    includes(element: Literal): boolean {
        return this.indexOf(element) >= 0
    }

    join(separator = ', '): string {
        return this.values.map((value) => Values.toString(value, this.settings, this.settings.locale)).join(separator)
    }

    sort(key?: DvKeyFunc, direction?: string, comparator?: (one: never, other: never) => number): DvArray {
        if (!this.values.length) return this
        const read = key ?? ((value: Literal) => value as never)
        const against = comparator ?? ((one: never, other: never) => this.compare(one as never, other as never))
        const descending = typeof direction === 'string' && direction.toLowerCase().startsWith('desc')
        const copy = this.values.map((value, index) => ({ value, key: read(value, index, this.values) }))
        copy.sort((one, other) => {
            const result = against(one.key as never, other.key as never)
            return descending ? -result : result
        })
        return this.wrap(copy.map((entry) => entry.value))
    }

    sortInPlace(key?: DvKeyFunc, direction?: string, comparator?: (one: never, other: never) => number): DvArray {
        const sorted = this.sort(key, direction, comparator).array()
        this.values.splice(0, this.values.length, ...sorted)
        return this
    }

    groupBy(key: DvKeyFunc, comparator?: (one: never, other: never) => number): DvArray {
        if (!this.values.length) return this.wrap([])
        const against = comparator ?? ((one: never, other: never) => this.compare(one as never, other as never))
        const sorted = this.sort(key, 'asc', comparator).array()
        const result: Literal[] = []
        let currentKey = key(sorted[0]!, 0, sorted)
        let rows: Literal[] = [sorted[0]!]
        for (let index = 1; index < sorted.length; index++) {
            const value = sorted[index]!
            const nextKey = key(value, index, sorted)
            if (against(currentKey as never, nextKey as never) !== 0) {
                result.push({ key: currentKey as Literal, rows: this.wrap(rows) } as unknown as Literal)
                currentKey = nextKey
                rows = [value]
                continue
            }
            rows.push(value)
        }
        result.push({ key: currentKey as Literal, rows: this.wrap(rows) } as unknown as Literal)
        return this.wrap(result)
    }

    /** Group inside each existing group when the list is already grouped, and group once otherwise. */
    groupIn(key: DvKeyFunc, comparator?: (one: never, other: never) => number): DvArray {
        const grouped = this.values.length && this.values.every((value) => isGroupRecord(value))
        if (!grouped) return this.groupBy(key as DvKeyFunc, comparator)
        return this.map((value) => {
            const record = value as unknown as { key: Literal; rows: DvArray }
            return { key: record.key, rows: record.rows.groupIn(key, comparator) } as unknown as Literal
        })
    }

    distinct(key?: DvKeyFunc, comparator?: (one: never, other: never) => number): DvArray {
        if (!this.values.length) return this
        const read = key ?? ((value: Literal) => value as never)
        const against = comparator ?? ((one: never, other: never) => this.compare(one as never, other as never))
        const paired = this.map((value, index) => ({ key: read(value, index, this.values), value }) as unknown as Literal).sort((entry) => (entry as { key: unknown }).key as never, 'asc', comparator).array()
        const result: Literal[] = [(paired[0] as { value: Literal }).value]
        for (let index = 1; index < paired.length; index++) {
            const previous = paired[index - 1] as { key: Literal }
            const current = paired[index] as { key: Literal; value: Literal }
            if (against(previous.key as never, current.key as never) !== 0) result.push(current.value)
        }
        return this.wrap(result)
    }

    every(predicate: DvKeyFunc): boolean {
        return this.values.every((value, index) => Boolean(predicate(value, index, this.values)))
    }

    some(predicate: DvKeyFunc): boolean {
        return this.values.some((value, index) => Boolean(predicate(value, index, this.values)))
    }

    none(predicate: DvKeyFunc): boolean {
        return this.values.every((value, index) => !predicate(value, index, this.values))
    }

    /** Map to a field, flattening one level — the shorthand `pages.file.name` runs through. */
    to(field: string): DvArray {
        const result: Literal[] = []
        for (const child of this.values) {
            const value = fieldOf(child, field)
            if (value === undefined || value === null) continue
            for (const item of asRawList(value)) result.push(item as Literal)
        }
        return this.wrap(result)
    }

    /** Like `to`, but a list-valued field stays one value instead of being spread. */
    into(field: string): DvArray {
        const result: Literal[] = []
        for (const child of this.values) {
            const value = fieldOf(child, field)
            if (value === undefined || value === null) continue
            result.push(value as Literal)
        }
        return this.wrap(result)
    }

    /** Walk a tree of lists through `field`, keeping every node that has one. */
    expand(field: string): DvArray {
        const result: Literal[] = []
        const queue: unknown[] = [...this.values]
        while (queue.length) {
            const next = queue.pop()
            const value = fieldOf(next, field)
            if (value === undefined || value === null) continue
            for (const item of asRawList(value)) queue.push(item)
            result.push(next as Literal)
        }
        return this.wrap(result)
    }

    forEach(action: DvKeyFunc): void {
        this.values.forEach((value, index) => {
            action(value, index, this.values)
        })
    }

    sum(): number {
        return this.values.reduce<number>((total, value) => total + asNumber(value), 0)
    }

    avg(): number {
        return this.values.length ? this.sum() / this.values.length : 0
    }

    min(): number {
        return this.values.length ? Math.min(...this.numeric()) : Number.NaN
    }

    max(): number {
        return this.values.length ? Math.max(...this.numeric()) : Number.NaN
    }

    toString(): string {
        return `[${this.values.map((value) => Values.toString(value, this.settings, this.settings.locale)).join(', ')}]`
    }

    /** The shape `dv.table` and `postMessage` both want: a plain JSON list. */
    toJSON(): unknown[] {
        return this.values.map((value) => cool(value)) as unknown[]
    }

    private numeric(): number[] {
        return this.values.map(asNumber)
    }
}

/** What a note's arithmetic makes of a value: a number, or seconds for a duration. */
function asNumber(value: unknown): number {
    if (typeof value === 'number') return value
    if (value instanceof DvDuration) return value.toMillis() / 1000
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : 0
}

/** A `{ key, rows }` record, which is what `groupBy` produces and `groupIn` recurses into. */
function isGroupRecord(value: unknown): boolean {
    return Boolean(value && typeof value === 'object' && 'key' in (value as Record<string, unknown>) && 'rows' in (value as Record<string, unknown>))
}

/** One field of one value, reading through the shapes a page actually holds. */
function fieldOf(value: unknown, field: string): unknown {
    if (value === null || value === undefined) return null
    if (value instanceof DvArray) return value.array().map((item) => fieldOf(item, field)).filter((item) => item !== null)
    if (value instanceof Grouping) return fieldOf(value.rows, field)
    if (Array.isArray(value)) return value.map((item) => fieldOf(item, field)).filter((item) => item !== null)
    if (value instanceof DvLink) return (value as unknown as Record<string, unknown>)[field]
    return (value as Record<string, unknown>)[field]
}

/** A list-taking value from a note's code: a real array, a `DvArray`, or a single thing. */
function asRawList(value: unknown): unknown[] {
    if (value instanceof DvArray) return value.array()
    if (Array.isArray(value)) return value
    return value === undefined || value === null ? [] : [value]
}

function nodes(value: unknown): DvNode[] {
    if (value === null || value === undefined) return [{ kind: 'text', text: '' }]
    if (typeof value === 'string') return [{ kind: 'text', text: value }]
    if (typeof value === 'number' || typeof value === 'boolean') return [{ kind: 'text', text: String(value) }]
    // A data array is a proxy, so it has to be read as a list before anything looks at its shape —
    // `Array.isArray` is false for it, and treating it as an object would print its private fields.
    if (value instanceof DvArray) return value.array().flatMap((item) => nodes(item))
    if (Array.isArray(value)) return value.flatMap((item) => nodes(item))
    if (isDescriptor(value)) return [value]
    const literal = warm(value)
    // A link a note read off a page arrives as a cooled marker, and a cell holding one is a link in the
    // reader's own page, not a string that happens to spell the note's name.
    if (literal instanceof DvLink) return [{ kind: 'link', path: literal.path, subpath: literal.subpath, display: literal.display, embed: literal.embed }]
    return [{ kind: 'text', text: Values.toString(literal) }]
}


const NODE_KINDS = new Set(['text', 'heading', 'paragraph', 'list', 'task', 'table', 'grid', 'element', 'markdown', 'html', 'link', 'section'])

/**
 * A value the note built with `dv.el` and friends, rather than a page value that merely looks like one:
 * a cooled link carries its own `kind` (`'file'`), so the marker has to be read first.
 */
function isDescriptor(value: unknown): value is DvNode {
    if (!value || typeof value !== 'object') return false
    if (DV_MARKER in (value as Record<string, unknown>)) return false
    return NODE_KINDS.has(String((value as { kind?: unknown }).kind))
}

/** What `dv.query(text)` hands back: the reference project's own shape, errors included. */
export interface DvQueryResult {
    successful: boolean
    results: { row: DataObject; id: unknown; heading: string }[]
    errors: { message: string }[]
    time: number
}

/**
 * The whole surface a note's code can reach. Naming it is what keeps `dv.pages(...)` typed as a list a
 * note can map over, both here and in the tests that stand in for the worker.
 */
export interface DvApi {
    pages(from?: string): DvArray
    pagesByTag(tag: string): DvArray
    pagesByFolder(folder: string): DvArray
    pagesByLink(target: string): DvArray
    current(): DataObject
    array(values: unknown): DvArray
    date(value: unknown): Literal
    duration(value: unknown): Literal
    number(value: unknown): number
    string(value: unknown): string
    toString(value: unknown): string
    mdEsc(value: unknown): string
    typeOf(value: unknown): string
    isArray(value: unknown): boolean
    isDataArray(value: unknown): boolean
    compare(one: unknown, other: unknown): number
    equal(one: unknown, other: unknown): boolean
    values(value: unknown): DvArray
    clone(value: unknown): Literal
    literal(value: unknown): Literal
    func(callback: (...args: Literal[]) => unknown): (...args: Literal[]) => unknown
    fileLink(path: string, display?: string | null, embed?: boolean): Literal
    sectionLink(path: string, section: string, display?: string | null): Literal
    blockLink(path: string, blockId: string, display?: string | null): Literal
    page(path: string): DataObject | null
    pagePaths(from?: string): DvArray
    parse(expression: string): unknown
    evaluate(expression: string, value?: unknown): { successful: boolean; value: Literal | null; error: string | null }
    tryEvaluate(expression: string, value?: unknown): Literal | null
    queryMarkdown(text: string, originFile?: string): string
    tryQueryMarkdown(text: string, originFile?: string): string | null
    tryQuery(text: string, originFile?: string): DvArray | null
    markdownTable(header: unknown, rows: unknown): string
    markdownList(items: unknown, ordered?: boolean): string
    markdownTaskList(tasks: unknown): string
    settings: QueryRuntimeSettings
    version: string
    query(text: string, originFile?: string): DvQueryResult
    execute(code: string): never
    executeInline(code: string, source?: string): never
    header(level: number, text: unknown): void
    paragraph(text: unknown): void
    list(items: unknown): void
    numberList(items: unknown): void
    table(header: unknown, rows: unknown): void
    taskList(tasks: unknown, group?: boolean): void
    span(child: unknown): void
    el(tag: string, value: unknown, children?: unknown): void
    div(children: unknown): void
    renderMarkdown(text: unknown): void
    renderHtml(html: unknown): void
    startSection(title: string): void
    endSection(): void
    io: { load(path: string): never; fetch(url: string): never; asString(value: unknown): string }
    barchart(items: unknown): never
    truncated: boolean
}

/**
 * Build the `dv` object for one run. `emit` collects what the note wants shown, which is the only way
 * code in the worker can affect the page — it has no element to touch.
 */
export function createDv(request: DvRequest, emit: (node: DvNode) => void): DvApi {
    const pages = request.pages.slice(0, DV_PAGE_LIMIT)
    const truncated = request.pages.length > pages.length
    const current = request.current ? (warm(request.current.data) as DataObject) : {}
    const byPath = new Map(pages.map((page) => [page.path, page.data]))

    const context = new Context({
        linkHandler: {
            resolve: (path) => {
                const found = byPath.get(path) ?? byPath.get(`${path}.md`)
                return found ? (warm(found) as DataObject) : null
            },
            normalize: (path) => (byPath.has(path) ? path : byPath.has(`${path}.md`) ? `${path}.md` : path),
            exists: (path) => byPath.has(path) || byPath.has(`${path}.md`),
        },
        settings: request.settings,
    })

    const matching = (from: string): DvSnapshotPage[] => {
        if (!from) return pages
        let source: Source
        try {
            source = parseSource(from)
        } catch {
            return []
        }
        return pages.filter((page) => matchesSource(source, page, current.file as Literal | undefined))
    }

    const rowsOf = (from: string): DataRail[] => matching(from).map((page) => ({
        id: DvLink.file(page.path),
        data: warm(page.data) as DataObject,
    }))

    /** Rows for a parsed source, which is what a query's own `FROM` says rather than a string. */
    const rowsForSource = (source: Source): DataRail[] => pages.filter((page) => matchesSource(source, page, current.file as Literal | undefined)).map((page) => ({
        id: DvLink.file(page.path),
        data: warm(page.data) as DataObject,
    }))

    /** The origin file a query runs as: its page, when the snapshot has one. */
    const originData = (originFile?: string): DataObject => {
        if (!originFile) return current
        const found = byPath.get(originFile) ?? byPath.get(`${originFile}.md`)
        return found ? (warm(found) as DataObject) : current
    }

    /**
     * A query rendered as Markdown text, which is what `dv.queryMarkdown` and the export path use.
     * Each view shape gets the text a reader would have written by hand: a pipe table, a bullet list,
     * a task list, or one line per day.
     */
    const runMarkdown = (text: string, originFile?: string): string | null => {
        let parsed
        try {
            parsed = parseQuery(text)
        } catch {
            return null
        }
        const result = executeQuery(parsed, rowsForSource(parsed.source), context, originData(originFile))
        if (!result.ok) return null
        const cell = (value: unknown) => escapeMarkdownCells(Values.toString(warm(value), request.settings, request.settings.locale))
        switch (result.value.kind) {
            case 'table': {
                const head = `| ${result.value.names.map(cell).join(' | ')} |`
                const rule = `| ${result.value.names.map(() => '---').join(' | ')} |`
                const body = result.value.rows.map((row) => `| ${[cell(row.id), ...row.cells.map(cell)].join(' | ')} |`)
                return [head, rule, ...body].join('\n')
            }
            case 'list':
                return result.value.items.map((item) => `- ${[item.id, item.value].filter((part) => part !== null && part !== '').map(cell).join(': ')}`).join('\n')
            case 'task':
                return result.value.tasks.map((entry) => `- [${entry.task.completed ? 'x' : ' '}] ${cell(entry.task.text)}`).join('\n')
            case 'calendar':
                return result.value.days.map((day) => `- ${Values.toString(day.date, request.settings, request.settings.locale)} · ${day.rows.length}`).join('\n')
            default:
                return null
        }
    }

    /**
     * A query run for a note's code. The columns are the *computed* ones — going through the same
     * extraction a block uses is what makes `TABLE this.rating` and `TABLE round(x / 2)` answer,
     * rather than reading a field name out of the page and finding nothing.
     */
    const runQuery = (text: string, originFile?: string): DvQueryResult => {
        try {
            const query = parseQuery(text)
            const result = executeQuery(query, rowsForSource(query.source), context, originData(originFile))
            if (!result.ok) return { successful: false, results: [], errors: [{ message: result.error }], time: 0 }
            const view = result.value
            const results: DvQueryResult['results'] = []
            if (view.kind === 'table') {
                for (const row of view.rows) {
                    const out: DataObject = {}
                    view.names.slice(view.showId ? 1 : 0).forEach((name, index) => {
                        out[name] = row.cells[index] ?? null
                    })
                    results.push({ row: out, id: cool(row.id), heading: Values.toString(warm(row.id)) })
                }
            } else if (view.kind === 'list') {
                for (const item of view.items) results.push({ row: { value: cool(item.value) } as DataObject, id: cool(item.id), heading: Values.toString(warm(item.id)) })
            } else if (view.kind === 'task') {
                for (const entry of view.tasks) results.push({ row: cool(entry.task) as DataObject, id: cool(entry.source), heading: Values.toString(warm(entry.source)) })
            } else {
                for (const day of view.days) results.push({ row: { date: cool(day.date), count: day.rows.length } as DataObject, id: cool(day.date), heading: Values.toString(day.date) })
            }
            return { successful: true, results, errors: [], time: 0 }
        } catch (error) {
            return { successful: false, results: [], errors: [{ message: error instanceof Error ? error.message : String(error) }], time: 0 }
        }
    }

    const attemptEvaluate = (expression: string, value: unknown) => {
        try {
            const field = parseField(expression)
            const scope = value === undefined ? current : (warm(value) as DataObject)
            // The value a note passes to `dv.evaluate` is both the row and `this`, as in the reference.
            context.set('this', scope)
            const result = context.attempt(field, scope as Record<string, Literal>)
            return result.ok
                ? { successful: true, value: result.value ?? null, error: null }
                : { successful: false, value: null, error: result.error }
        } catch (error) {
            return { successful: false, value: null, error: error instanceof Error ? error.message : String(error) }
        }
    }

    return {
        pages: (from = '') => DvArray.of(rowsOf(from).map((row) => row.data as Literal), request.settings),
        pagesByTag: (tag: string) => DvArray.of(rowsOf('#' + tag).map((row) => row.data as Literal), request.settings),
        pagesByFolder: (folder: string) => DvArray.of(rowsOf(JSON.stringify(folder)).map((row) => row.data as Literal), request.settings),
        pagesByLink: (target: string) => DvArray.of(rowsOf('[[' + target + ']]').map((row) => row.data as Literal), request.settings),
        current: () => current,
        array: (values: unknown) => DvArray.of(asRawList(values).map((item) => warm(item)), request.settings),
        date: (value: unknown) => warm(value) instanceof Date ? warm(value) : Values.isString(value) ? new Date(value as string) : null,
        duration: (value: unknown) => {
            const literal = warm(value)
            return literal instanceof DvDuration ? literal : Values.isString(value) ? parseDurationText(value as string) : null
        },
        number: (value: unknown) => (typeof value === 'number' ? value : Number.parseFloat(String(value))),
        string: (value: unknown) => Values.toString(warm(value)),
        toString: (value: unknown) => Values.toString(warm(value), request.settings, request.settings.locale),
        mdEsc: (value: unknown) => escapeMarkdown(String(value ?? '')),
        typeOf: (value: unknown) => Values.typeOf(warm(value)) ?? 'unknown',
        isArray: (value: unknown) => Array.isArray(value) || value instanceof DvArray,
        isDataArray: (value: unknown) => value instanceof DvArray,
        compare: (one: unknown, other: unknown) => Values.compare(warm(one), warm(other)),
        equal: (one: unknown, other: unknown) => Values.compare(warm(one), warm(other)) === 0,
        values: (value: unknown) => DvArray.of(Object.values((warm(value) ?? {}) as Record<string, unknown>), request.settings),
        clone: (value: unknown) => warm(cool(warm(value))),
        literal: (value: unknown) => warm(value),
        func: (callback: (...args: Literal[]) => unknown) => callback,
        fileLink: (path: string, display: string | null = null, embed = false) => new DvLink(String(path), 'file', null, display, embed),
        sectionLink: (path: string, section: string, display: string | null = null) => new DvLink(String(path), 'header', String(section), display, false),
        blockLink: (path: string, blockId: string, display: string | null = null) => new DvLink(String(path), 'block', String(blockId), display, false),
        page: (path: string) => {
            const found = byPath.get(String(path)) ?? byPath.get(`${path}.md`)
            return found ? (warm(found) as DataObject) : null
        },
        pagePaths: (from = '') => DvArray.of(matching(from).map((entry) => entry.path), request.settings),
        parse: (expression: string) => cool(parseField(expression)),
        evaluate: (expression: string, value?: unknown) => attemptEvaluate(expression, value),
        tryEvaluate: (expression: string, value?: unknown) => {
            const result = attemptEvaluate(expression, value)
            return result.successful ? result.value : null
        },
        queryMarkdown: (text: string, originFile?: string) => runMarkdown(text, originFile) ?? '',
        tryQuery: (text: string, originFile?: string) => {
            const result = runQuery(text, originFile)
            return result.successful ? DvArray.of(result.results, request.settings) : null
        },
        tryQueryMarkdown: (text: string, originFile?: string) => runMarkdown(text, originFile),
        markdownTable: (header: unknown, rows: unknown) => {
            const head = asRawList(header)
            const body = asRawList(rows).map((row) => asRawList(row))
            const wide = body.find((row) => row.length !== head.length)
            if (wide) throw new Error(`The number of headers (${head.length}) must match the number of columns (${wide.length})`)
            const cell = (value: unknown) => exportCell(value, request.settings, 0)
            return [`| ${head.map(cell).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n')
        },
        markdownList: (items: unknown, ordered = false) => asRawList(items).map((item, index) => `${ordered ? `${index + 1}.` : '-'} ${Values.toString(warm(item), request.settings, request.settings.locale)}`).join('\n'),
        markdownTaskList: (tasks: unknown) => asRawList(tasks).map((entry) => {
            const task = (entry && typeof entry === 'object' ? entry : {}) as { text?: unknown; completed?: boolean }
            return `- [${task.completed ? 'x' : ' '}] ${Values.toString(warm(task.text ?? ''), request.settings, request.settings.locale)}`
        }).join('\n'),
        settings: request.settings,
        version: '0.1.0-inkstone',
        query: runQuery,
        execute: () => { throw new Error('dv.execute is not available; use dv.query(text) instead') },
        executeInline: () => { throw new Error('dv.executeInline is not available; use dv.tryEvaluate(expression) instead') },
        header: (level: number, text: unknown) => emit({ kind: 'heading', level: clampLevel(level), children: nodes(text) }),
        paragraph: (text: unknown) => emit({ kind: 'paragraph', children: nodes(text) }),
        list: (items: unknown) => emit({ kind: 'list', ordered: false, items: asRawList(items).flatMap((item) => nodes(item)) }),
        numberList: (items: unknown) => emit({ kind: 'list', ordered: true, items: asRawList(items).flatMap((item) => nodes(item)) }),
        table: (header: unknown, rows: unknown) => {
            const head = asRawList(header).flatMap((item) => nodes(item))
            const body = asRawList(rows).map((row) => asRawList(row).flatMap((cell) => nodes(cell)))
            emit({ kind: 'table', header: head, rows: body })
        },
        taskList: (tasks: unknown, groupByTask = true) => {
            const items = asRawList(tasks).map((entry) => {
                const task = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
                const source = task.source
                return {
                    text: nodes(task.text ?? ''),
                    completed: task.completed === true,
                    source: typeof source === 'string' ? source : Values.isLink(source) ? (source as DvLink).path : null,
                }
            })
            emit({ kind: 'task', items, group: Boolean(groupByTask) })
        },
        span: (child: unknown) => emit({ kind: 'element', tag: 'span', class: null, attrs: {}, children: nodes(child) }),
        el: (tag: string, value: unknown, children: unknown = []) => {
            const attrs: Record<string, string> = {}
            const classOf = typeof value === 'string' ? value : null
            const extra = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
            for (const [key, item] of Object.entries(extra)) attrs[/^[a-zA-Z-]+$/.test(key) ? key : 'data-dv'] = String(item ?? '')
            emit({
                kind: 'element',
                tag: SAFE_TAGS.has(tag) ? tag : 'div',
                class: classOf,
                attrs,
                children: asRawList(children).flatMap((item) => nodes(item)),
            })
        },
        div: (children: unknown) => emit({ kind: 'element', tag: 'div', class: null, attrs: {}, children: asRawList(children).flatMap((item) => nodes(item)) }),
        renderMarkdown: (text: unknown) => emit({ kind: 'markdown', text: String(text ?? '') }),
        renderHtml: (html: unknown) => emit({ kind: 'html', html: String(html ?? '') }),
        startSection: (title: string) => emit({ kind: 'section', title: String(title ?? ''), children: [] }),
        endSection: () => { emit({ kind: 'section', title: null, children: [] }) },
        io: {
            load: () => { throw new Error('dv.io.load is not available in Inkstone: a note\'s code cannot read files') },
            fetch: () => { throw new Error('dv.io.fetch is not available in Inkstone: a note\'s code cannot reach the network') },
            asString: (value: unknown) => String(value ?? ''),
        },
        barchart: () => { throw new Error('dv.barchart is not part of this port') },
        truncated,
    }
}

const SAFE_TAGS = new Set(['span', 'div', 'p', 'small', 'em', 'strong', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'b', 'i', 'u', 's', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'section'])

function clampLevel(level: number): number {
    const numeric = Math.trunc(Number(level))
    if (!Number.isFinite(numeric)) return 1
    return Math.min(6, Math.max(1, numeric))
}

function parseDurationText(text: string): DvDuration | null {
    const literal = Values.isString(text) ? text : ''
    const matches = [...literal.matchAll(/(\d+(?:\.\d+)?)\s*(years?|months?|weeks?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)/g)]
    if (!matches.length) return null
    const units: Partial<DvDuration> = {}
    for (const match of matches) {
        const amount = Number.parseFloat(match[1]!)
        const word = match[2]!
        if (/^year/.test(word)) units.years = (units.years ?? 0) + amount
        else if (/^month/.test(word)) units.months = (units.months ?? 0) + amount
        else if (/^week/.test(word)) units.weeks = (units.weeks ?? 0) + amount
        else if (/^day/.test(word)) units.days = (units.days ?? 0) + amount
        else if (/^h/.test(word)) units.hours = (units.hours ?? 0) + amount
        else if (/^m/.test(word)) units.minutes = (units.minutes ?? 0) + amount
        else units.seconds = (units.seconds ?? 0) + amount
    }
    return new DvDuration(units)
}

/** A pipe table cell: the bar is the delimiter, so it has to survive as text. */
function escapeMarkdownCells(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/**
 * One cell of an exported table. `allowHtmlInExports` keeps a list's or an object's shape as HTML, which
 * is what `dv.renderMarkdown` can draw, and the walk stops at the depth the page-side renderer stops at
 * so one note's nested property cannot make the export run away.
 */
function exportCell(value: unknown, settings: QueryRuntimeSettings, depth: number): string {
    if (depth > settings.maxRecursiveRenderDepth) return '…'
    const literal = warm(value)
    if (settings.allowHtmlInExports) {
        if (Values.isArray(literal)) return `<ul>${literal.map((item) => `<li>${exportCell(item, settings, depth + 1)}</li>`).join('')}</ul>`
        if (Values.isObject(literal)) {
            return `<ul>${Object.entries(literal).map(([key, item]) => `<li><b>${exportCell(key, settings, depth + 1)}</b>: ${exportCell(item, settings, depth + 1)}</li>`).join('')}</ul>`
        }
    }
    return escapeMarkdownCells(Values.toString(literal, settings, settings.locale))
}

function escapeMarkdown(text: string): string {
    return text.replace(/([\\`*_[\]{}()#.+!-])/g, '\\$1')
}

/**
 * Source matching over a serialized page. Folder and tag come from `file.*`, which every snapshot
 * carries, so the worker never needs the index a note may not be allowed to see in full.
 */
function matchesSource(source: Source, page: DvSnapshotPage, originLink: Literal | undefined): boolean {
    switch (source.type) {
        case 'empty':
            return false
        case 'binaryop':
            return source.op === '&'
                ? matchesSource(source.left, page, originLink) && matchesSource(source.right, page, originLink)
                : matchesSource(source.left, page, originLink) || matchesSource(source.right, page, originLink)
        case 'negate':
            return !matchesSource(source.child, page, originLink)
        case 'folder': {
            const wanted = source.folder.replace(/\.md$/i, '').toLocaleLowerCase()
            const name = page.path.replace(/\.md$/i, '').toLocaleLowerCase()
            if (!wanted) return true
            return name === wanted || name.startsWith(`${wanted}/`)
        }
        case 'tag': {
            const file = (warm(page.data) as DataObject).file as DataObject | undefined
            const tags = [...((file?.etags as string[] | undefined) ?? []), ...((file?.tags as string[] | undefined) ?? [])]
            const wanted = source.tag.toLocaleLowerCase()
            return tags.some((tag) => {
                const key = tag.toLocaleLowerCase()
                return key === wanted || key.startsWith(`${wanted}/`)
            })
        }
        case 'link': {
            const file = (warm(page.data) as DataObject).file as DataObject | undefined
            const wanted = source.file.replace(/\.md$/i, '').toLocaleLowerCase()
            const inScope = (list: unknown): boolean => Array.isArray(list)
                && list.some((item) => warm(item) instanceof DvLink && (item as unknown as { path: string }).path.replace(/\.md$/i, '').toLocaleLowerCase() === wanted)
            if (source.direction === 'incoming') return inScope(file?.inlinks)
            if (Values.isLink(originLink) && (originLink as DvLink).path.replace(/\.md$/i, '').toLocaleLowerCase() === wanted) return true
            return inScope(file?.outlinks)
        }
        case 'csv':
            return page.path.toLocaleLowerCase().endsWith(source.path.toLocaleLowerCase())
        default:
            return false
    }
}

