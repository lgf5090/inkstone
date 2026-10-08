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
import { parseSource, parseQuery } from './expression'
import type { Source } from './ast'
import { executeCore, type DataRail } from './engine'
import { Context } from './context'
import type { QueryRuntimeSettings } from './functions'

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
 * The DataArray of the port: the helpers a note's code reaches for, over a plain array.
 *
 * It deliberately does not extend `Array`. `map`/`filter`/`sort` on a subclass cannot return the
 * subclass under `Literal`'s union (the base's generic `U[]` refuses a narrower element type), and a
 * class that lies about its own `Array` contract is worse than one that says it is a list with methods.
 * `array()` is the documented way down to a real array.
 */
export class DvArray {
    private readonly items: Literal[]

    private constructor(items: Literal[]) {
        this.items = items
    }

    static of(values: Iterable<unknown>): DvArray {
        return new DvArray(Array.from(values, (value) => (typeof value === 'object' && value !== null && DV_MARKER in (value as Record<string, unknown>) ? value as Literal : value as Literal)))
    }

    get length(): number {
        return this.items.length
    }

    [Symbol.iterator](): Iterator<Literal> {
        return this.items[Symbol.iterator]()
    }

    array(): Literal[] {
        return [...this.items]
    }

    get(index: number): Literal | null {
        return this.items[index] ?? null
    }

    first(): Literal | null {
        return this.items.length ? this.items[0]! : null
    }

    last(): Literal | null {
        return this.items.length ? this.items[this.items.length - 1]! : null
    }

    map(transform: (value: Literal, index: number) => unknown): DvArray {
        return DvArray.of(this.items.map((value, index) => transform(value, index)))
    }

    filter(predicate: (value: Literal, index: number) => unknown): DvArray {
        return DvArray.of(this.items.filter((value, index) => Boolean(predicate(value, index))))
    }

    where(predicate: (value: Literal) => unknown): DvArray {
        return this.filter((value) => predicate(value))
    }

    sort(compare?: (one: Literal, other: Literal) => number): DvArray {
        const copy = [...this.items]
        copy.sort(compare ?? ((one, other) => Values.compare(one, other)))
        return DvArray.of(copy)
    }

    limit(count: number): DvArray {
        return DvArray.of(this.items.slice(0, Math.max(0, Math.trunc(count))))
    }

    join(separator = ', '): string {
        return this.items.map((value) => Values.toString(value)).join(separator)
    }

    distinct(): DvArray {
        const out: Literal[] = []
        for (const value of this.items) {
            if (!out.some((item) => Values.compare(item, value) === 0)) out.push(value)
        }
        return DvArray.of(out)
    }

    /** The shape `dv.table` and `postMessage` both want: a plain JSON list. */
    toJSON(): unknown[] {
        return this.items.map((value) => cool(value)) as unknown[]
    }
}

function nodes(value: unknown): DvNode[] {
    if (value === null || value === undefined) return [{ kind: 'text', text: '' }]
    if (typeof value === 'string') return [{ kind: 'text', text: value }]
    if (typeof value === 'number' || typeof value === 'boolean') return [{ kind: 'text', text: String(value) }]
    if (Array.isArray(value)) return value.flatMap((item) => nodes(item))
    if (isDescriptor(value)) return [value]
    const literal = warm(value)
    // A link a note read off a page arrives as a cooled marker, and a cell holding one is a link in the
    // reader's own page, not a string that happens to spell the note's name.
    if (literal instanceof DvLink) return [{ kind: 'link', path: literal.path, subpath: literal.subpath, display: literal.display, embed: literal.embed }]
    return [{ kind: 'text', text: Values.toString(literal) }]
}

/**
 * What a note's code may hand a list-taking method: a real array, or the `DvArray` its own `map` and
 * `filter` return. A `DvArray` is not an `Array`, so reading it as one would silently draw an empty
 * table out of a query that matched twenty notes.
 */
function asList(value: unknown): unknown[] {
    if (value instanceof DvArray) return value.array()
    if (Array.isArray(value)) return value
    return value === undefined || value === null ? [] : [value]
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
    version: string
    query(text: string, source?: string): DvQueryResult
    execute(code: string): never
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

    return {
        pages: (from = '') => DvArray.of(rowsOf(from).map((row) => row.data as Literal)),
        pagesByTag: (tag: string) => DvArray.of(rowsOf('#' + tag).map((row) => row.data as Literal)),
        pagesByFolder: (folder: string) => DvArray.of(rowsOf(JSON.stringify(folder)).map((row) => row.data as Literal)),
        pagesByLink: (target: string) => DvArray.of(rowsOf('[[' + target + ']]').map((row) => row.data as Literal)),
        current: () => current,
        array: (values: unknown) => DvArray.of(asList(values).map((item) => warm(item))),
        date: (value: unknown) => warm(value) instanceof Date ? warm(value) : Values.isString(value) ? new Date(value as string) : null,
        duration: (value: unknown) => {
            const literal = warm(value)
            return literal instanceof DvDuration ? literal : Values.isString(value) ? parseDurationText(value as string) : null
        },
        number: (value: unknown) => (typeof value === 'number' ? value : Number.parseFloat(String(value))),
        string: (value: unknown) => Values.toString(warm(value)),
        toString: (value: unknown) => Values.toString(warm(value), request.settings, request.settings.locale),
        mdEsc: (value: unknown) => escapeMarkdown(String(value ?? '')),
        version: '0.1.0-inkstone',
        query: (text: string, source = '') => {
            try {
                const query = parseQuery(text)
                const base = rowsOf(source)
                const core = executeCore(base, context, query.operations)
                if (!core.ok) return { successful: false, results: [], errors: [{ message: core.error }], time: 0 }
                const results = core.value.rows.map((row) => {
                    const out: DataObject = {}
                    for (const field of query.header.type === 'table' ? query.header.fields : []) out[field.name] = row.data[field.name] ?? null
                    return { row: out, id: cool(row.id), heading: Values.toString(warm(row.id)) }
                })
                return { successful: true, results, errors: core.value.errors, time: 0 }
            } catch (error) {
                return { successful: false, results: [], errors: [{ message: error instanceof Error ? error.message : String(error) }], time: 0 }
            }
        },
        execute: () => { throw new Error('dv.execute is not available; use dv.query(text) instead') },
        header: (level: number, text: unknown) => emit({ kind: 'heading', level: clampLevel(level), children: nodes(text) }),
        paragraph: (text: unknown) => emit({ kind: 'paragraph', children: nodes(text) }),
        list: (items: unknown) => emit({ kind: 'list', ordered: false, items: asList(items).flatMap((item) => nodes(item)) }),
        numberList: (items: unknown) => emit({ kind: 'list', ordered: true, items: asList(items).flatMap((item) => nodes(item)) }),
        table: (header: unknown, rows: unknown) => {
            const head = asList(header).flatMap((item) => nodes(item))
            const body = asList(rows).map((row) => asList(row).flatMap((cell) => nodes(cell)))
            emit({ kind: 'table', header: head, rows: body })
        },
        taskList: (tasks: unknown, groupByTask = true) => {
            const items = asList(tasks).map((entry) => {
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
                children: asList(children).flatMap((item) => nodes(item)),
            })
        },
        div: (children: unknown) => emit({ kind: 'element', tag: 'div', class: null, attrs: {}, children: asList(children).flatMap((item) => nodes(item)) }),
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

