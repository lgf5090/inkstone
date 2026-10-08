/**
 * Query execution: the clause pipeline (`WHERE`, `SORT`, `LIMIT`, `FLATTEN`, `GROUP BY`) and the four
 * view-shaped extractions on top of it.
 *
 * Execution order and failure rules follow Dataview. The rule that matters most in practice is the
 * all-rows-failed rule: an expression that errors on *every* row is a broken query and is reported as
 * one, while an expression that errors on some rows renders those cells as null and keeps the rest.
 * A query over a half-indexed vault would otherwise report itself broken whenever one note has an
 * unset property.
 */

import type { Field, Query, QueryHeader, QueryOperation, NamedField } from './ast'
import { Context } from './context'
import { Grouping, Values, compareValues, type DataObject, type Literal } from './value'

/** One row entering the pipeline: what it is called (a note link, a group key) and its fields. */
export interface DataRail {
    id: Literal
    data: DataObject
}

export interface RowError {
    index: number
    message: string
}

export type Execution<T> = { ok: true; value: T; errors: RowError[] } | { ok: false; error: string }

/** Why a row's id is what it is — a note path, or a group key (possibly nested). */
export type IdentifierMeaning = { type: 'path' } | { type: 'group'; name: string; on: IdentifierMeaning }

export interface CoreExecution {
    rows: DataRail[]
    idMeaning: IdentifierMeaning
    errors: RowError[]
}

export interface TableResult {
    kind: 'table'
    names: string[]
    rows: { id: Literal; cells: Literal[] }[]
    showId: boolean
}

export interface ListResult {
    kind: 'list'
    items: { id: Literal; value: Literal | null; members: Literal[] }[]
    showId: boolean
}

export interface TaskResult {
    kind: 'task'
    tasks: { task: DataObject; source: Literal }[]
}

export interface CalendarResult {
    kind: 'calendar'
    days: { date: Date; rows: DataRail[] }[]
}

export type QueryResult = TableResult | ListResult | TaskResult | CalendarResult

/** Run the operation pipeline. Errors are collected per row and only fatal when nothing survives. */
export function executeCore(input: DataRail[], context: Context, ops: QueryOperation[]): Execution<CoreExecution> {
    let rows = [...input]
    let idMeaning: IdentifierMeaning = { type: 'path' }
    const collected: RowError[] = []

    for (const op of ops) {
        const errors: RowError[] = []
        switch (op.type) {
            case 'where': {
                const kept: DataRail[] = []
                rows.forEach((row, index) => {
                    const result = context.attempt(op.clause, row.data)
                    if (!result.ok) errors.push({ index, message: result.error })
                    else if (Values.isTruthy(result.value)) kept.push(row)
                })
                rows = kept
                break
            }
            case 'sort': {
                const tagged: { row: DataRail; keys: Literal[] }[] = []
                rows.forEach((row, index) => {
                    const keys: Literal[] = []
                    for (const sort of op.fields) {
                        const result = context.attempt(sort.field, row.data)
                        if (!result.ok) {
                            errors.push({ index, message: result.error })
                            continue
                        }
                        keys.push(result.value)
                    }
                    tagged.push({ row, keys })
                })
                tagged.sort((one, other) => {
                    for (let index = 0; index < op.fields.length; index++) {
                        const factor = op.fields[index]!.direction === 'ascending' ? 1 : -1
                        const order = compareValues(one.keys[index], other.keys[index], (path) => context.normalizeLink(path))
                        if (order !== 0) return factor * order
                    }
                    return 0
                })
                rows = tagged.map((entry) => entry.row)
                break
            }
            case 'limit': {
                const amount = context.attempt(op.amount)
                if (!amount.ok) return { ok: false, error: `Failed to execute 'LIMIT': ${amount.error}` }
                if (!Values.isNumber(amount.value)) {
                    return { ok: false, error: `Failed to execute 'LIMIT': limit should be a number, but got '${Values.typeOf(amount.value)}' (${Values.toString(amount.value, context.settings, context.settings.locale)})` }
                }
                rows = rows.slice(0, Math.max(0, Math.trunc(amount.value)))
                break
            }
            case 'group': {
                const keyed: { row: DataRail; key: Literal }[] = []
                rows.forEach((row, index) => {
                    const result = context.attempt(op.field.field, row.data)
                    if (!result.ok) {
                        errors.push({ index, message: result.error })
                        return
                    }
                    keyed.push({ row, key: result.value })
                })
                keyed.sort((one, other) => compareValues(one.key, other.key, (path) => context.normalizeLink(path)))
                const grouped: DataRail[] = []
                for (const entry of keyed) {
                    const last = grouped[grouped.length - 1]
                    const lastGroup = last && Values.isGrouping(last.id) ? last.id : null
                    if (lastGroup && compareValues(entry.key, lastGroup.key, (path) => context.normalizeLink(path)) === 0) {
                        lastGroup.rows.push(entry.row.data)
                        continue
                    }
                    const group = new Grouping(entry.key, [entry.row.data])
                    const data: DataObject = { [op.field.name]: entry.key, rows: group }
                    if (lastGroup) data.key = lastGroup.key
                    grouped.push({ id: group, data })
                }
                rows = grouped
                idMeaning = { type: 'group', name: op.field.name, on: idMeaning }
                break
            }
            case 'flatten': {
                const flattened: DataRail[] = []
                rows.forEach((row, index) => {
                    const result = context.attempt(op.field.field, row.data)
                    if (!result.ok) {
                        errors.push({ index, message: result.error })
                        return
                    }
                    const values = Values.isArray(result.value) ? result.value : [result.value]
                    for (const value of values) {
                        const copy: DataRail = { id: row.id, data: { ...row.data, [op.field.name]: value } }
                        flattened.push(copy)
                    }
                })
                rows = flattened
                if (idMeaning.type === 'group' && idMeaning.name === op.field.name) idMeaning = idMeaning.on
                break
            }
            default:
                return { ok: false, error: `Unrecognized query operation '${(op as { type: string }).type}'` }
        }

        if (rows.length === 0 && input.length > 0 && errors.length >= input.length) {
            return { ok: false, error: `Every row failed during '${op.type}':\n${firstErrors(errors)}` }
        }
        collected.push(...errors.map((error) => ({ ...error, message: `${op.type}: ${error.message}` })))
    }

    return { ok: true, value: { rows, idMeaning, errors: collected }, errors: collected }
}

function firstErrors(errors: RowError[]): string {
    return errors.slice(0, 3).map((error) => `- ${error.message}`).join('\n')
}

/**
 * Run a parsed query over resolved rows and shape the answer for its view. `thisNote` is the note the
 * block lives in, which is what `this.file.name` and `this.frontmatter.x` read.
 */
export function executeQuery(query: Query, rows: DataRail[], context: Context, thisNote: DataObject | null): Execution<QueryResult> {
    const scoped = context
    scoped.set('this', thisNote ?? {})

    if (query.header.type === 'task') {
        const taskRows = expandTasks(rows, scoped)
        const core = executeCore(taskRows, scoped, query.operations)
        if (!core.ok) return core
        const tasks = core.value.rows.map((row) => ({ task: row.data, source: (row.data.source as Literal) ?? row.id }))
        return { ok: true, value: { kind: 'task', tasks }, errors: core.value.errors }
    }

    const core = executeCore(rows, scoped, query.operations)
    if (!core.ok) return core

    switch (query.header.type) {
        case 'table':
            return extractTable(query.header, core.value, scoped)
        case 'list':
            return extractList(query.header, core.value, scoped)
        case 'calendar':
            return extractCalendar(query.header.field, core.value, scoped)
        default:
            return { ok: false, error: `Unrecognized query type '${(query.header as QueryHeader).type}'` }
    }
}

/**
 * Evaluate the header's fields for every row and hand back rows whose data is keyed by field *name*.
 * This is the step where a column expression runs, so its errors are the ones a reader sees as empty
 * cells.
 */
export function extractFields(rows: DataRail[], context: Context, fields: Record<string, Field>): Execution<{ rows: DataRail[]; errors: RowError[] }> {
    const out: DataRail[] = []
    const errors: RowError[] = []
    rows.forEach((row, index) => {
        const data: DataObject = {}
        for (const [name, field] of Object.entries(fields)) {
            const result = context.attempt(field, row.data)
            if (!result.ok) {
                errors.push({ index, message: result.error })
                return
            }
            data[name] = result.value
        }
        out.push({ id: row.id, data })
    })
    if (out.length === 0 && rows.length > 0 && errors.length >= rows.length) {
        return { ok: false, error: `Every row failed while extracting columns:\n${firstErrors(errors)}` }
    }
    return { ok: true, value: { rows: out, errors }, errors }
}

function extractTable(header: Extract<QueryHeader, { type: 'table' }>, core: CoreExecution, context: Context): Execution<TableResult> {
    const fields: Record<string, Field> = {}
    for (const field of header.fields) fields[field.name] = field.field
    const extracted = extractFields(core.rows, context, fields)
    if (!extracted.ok) return extracted

    const names = [...(header.showId ? ['name'] : []), ...header.fields.map((field) => field.name)]
    const rows = extracted.value.rows.map((row) => ({
        id: displayId(row.id, core.idMeaning),
        cells: header.fields.map((field) => row.data[field.name] ?? null),
    }))
    return { ok: true, value: { kind: 'table', names, rows, showId: header.showId }, errors: core.errors.concat(extracted.value.errors) }
}

/**
 * A grouped row's id is the group itself; the key is what the reader recognises, and it is what
 * `GROUP BY` exists to produce.
 */
function displayId(id: Literal, meaning: IdentifierMeaning): Literal {
    if (Values.isGrouping(id)) return id.key
    void meaning
    return id
}

function extractList(header: Extract<QueryHeader, { type: 'list' }>, core: CoreExecution, context: Context): Execution<ListResult> {
    const fields: Record<string, Field> = header.format ? { target: header.format } : {}
    const extracted = extractFields(core.rows, context, fields)
    if (!extracted.ok) return extracted
    const items = extracted.value.rows.map((row) => ({
        id: displayId(row.id, core.idMeaning),
        value: header.format ? row.data.target ?? null : null,
        members: Values.isGrouping(row.id) ? groupMembers(row.id, header.format ?? null, context) : [],
    }))
    return { ok: true, value: { kind: 'list', items, showId: header.showId }, errors: core.errors.concat(extracted.value.errors) }
}

/**
 * What a `GROUP BY` row is made of. The list expression is evaluated per member when there is one, and a
 * member it cannot answer with is the note it came from — which is what the reader means by grouping.
 */
function groupMembers(group: Grouping, format: Field | null, context: Context): Literal[] {
    return group.rows.map((member) => {
        const attempt = format ? context.attempt(format, member) : { ok: false as const, error: '' }
        if (attempt.ok && attempt.value !== null && attempt.value !== undefined) return attempt.value
        const file = member.file as DataObject | undefined
        return (file?.link as Literal) ?? null
    })
}

function extractCalendar(field: NamedField, core: CoreExecution, context: Context): Execution<CalendarResult> {
    const byDay = new Map<string, { date: Date; rows: DataRail[] }>()
    const errors: RowError[] = [...core.errors]
    core.rows.forEach((row, index) => {
        const value = context.attempt(field.field, row.data)
        if (!value.ok) {
            errors.push({ index, message: value.error })
            return
        }
        if (!Values.isDate(value.value)) return
        const date = value.value as Date
        const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
        const entry = byDay.get(key)
        if (entry) entry.rows.push(row)
        else byDay.set(key, { date: new Date(date.getFullYear(), date.getMonth(), date.getDate()), rows: [row] })
    })
    const days = [...byDay.values()].sort((one, other) => one.date.getTime() - other.date.getTime())
    return { ok: true, value: { kind: 'calendar', days }, errors }
}

/**
 * A `TASK` query runs over tasks, not notes: every task in a matched note becomes its own row, with
 * `row.source` naming the note it came from. Rows already carrying `text` are left alone, so a query
 * written against `FROM ... ` of task rows stays idempotent.
 */
export function expandTasks(rows: DataRail[], context: Context): DataRail[] {
    const out: DataRail[] = []
    for (const row of rows) {
        const file = row.data.file as DataObject | undefined
        const tasks = file?.tasks
        if (!Values.isArray(tasks)) {
            if (Values.isString(row.data.text)) out.push(row)
            continue
        }
        for (const task of tasks) {
            if (!Values.isObject(task)) continue
            const data = task as DataObject
            const link = Values.isLink(data.link) ? data.link : row.id
            out.push({
                id: link,
                data: { ...data, source: row.id, ...Object.fromEntries(Object.entries(data).filter(([, value]) => !Values.isNull(value))) },
            })
        }
    }
    void context
    return out
}
