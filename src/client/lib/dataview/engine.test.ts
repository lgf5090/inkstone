import { describe, expect, it } from 'vitest'
import { Context } from './context'
import { DEFAULT_QUERY_SETTINGS } from './functions'
import type { LinkHandler } from './context'
import { executeCore, executeQuery, expandTasks } from './engine'
import { parseQuery } from './expression'
import { Fields, type Field, type QueryOperation } from './ast'
import { DvLink, Grouping, Values, type DataObject, type Literal } from './value'

const handler: LinkHandler = { resolve: () => null, normalize: (path) => path, exists: () => false }

function ctx(): Context {
    return new Context({ linkHandler: handler, settings: DEFAULT_QUERY_SETTINGS })
}

function rail(name: string, data: Record<string, Literal>) {
    return { id: DvLink.file(name), data: data as DataObject }
}

function where(clause: Field): QueryOperation {
    return { type: 'where', clause }
}

describe('query pipeline', () => {
    const rows = [
        rail('A.md', { rating: 4, done: false, tags: ['x', 'y'] }),
        rail('B.md', { rating: 9, done: true, tags: ['y'] }),
        rail('C.md', { rating: 1, done: false, tags: [] }),
    ]

    it('filters with WHERE and keeps the order', () => {
        const result = executeCore(rows, ctx(), [where(Fields.binaryOp('>', Fields.variable('rating'), Fields.literal(2)))])
        if (!result.ok) throw new Error(result.error)
        expect(result.value.rows.map((row) => (row.id as DvLink).path)).toEqual(['A.md', 'B.md'])
    })

    it('collects a per-row failure without failing the query', () => {
        // A comparison never throws (mixed types order by type name), so the failure has to come from
        // a function that rejects the value — that is the realistic half-broken column.
        const mixed = [rail('A.md', { name: 'x' }), rail('B.md', { name: 5 })]
        const clause = Fields.binaryOp('>', Fields.func(Fields.variable('upper'), [Fields.variable('name')]), Fields.literal('A'))
        const result = executeCore(mixed, ctx(), [where(clause)])
        if (!result.ok) throw new Error(result.error)
        expect(result.value.rows.map((row) => (row.id as DvLink).path)).toEqual(['A.md'])
        expect(result.value.errors).toHaveLength(1)
        expect(result.value.errors[0]?.message).toContain('where')
    })

    it('fails when every row fails', () => {
        const bad = [rail('A.md', {}), rail('B.md', {})]
        const result = executeCore(bad, ctx(), [where(Fields.binaryOp('+', Fields.variable('rating'), Fields.literal(1)))])
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.error).toContain("Every row failed during 'where'")
    })

    it('sorts by several keys with directions', () => {
        const result = executeCore(rows, ctx(), [{
            type: 'sort',
            fields: [
                { field: Fields.variable('done'), direction: 'descending' },
                { field: Fields.variable('rating'), direction: 'ascending' },
            ],
        }])
        if (!result.ok) throw new Error(result.error)
        expect(result.value.rows.map((row) => (row.id as DvLink).path)).toEqual(['B.md', 'C.md', 'A.md'])
    })

    it('limits with an expression and rejects a non-number', () => {
        const ok = executeCore(rows, ctx(), [{ type: 'limit', amount: Fields.literal(2) }])
        if (!ok.ok) throw new Error(ok.error)
        expect(ok.value.rows).toHaveLength(2)
        const bad = executeCore(rows, ctx(), [{ type: 'limit', amount: Fields.literal('two') }])
        expect(bad.ok).toBe(false)
        if (bad.ok) return
        expect(bad.error).toContain("limit should be a number")
    })

    it('flattens a list into one row per element', () => {
        const result = executeCore(rows, ctx(), [{ type: 'flatten', field: { name: 'tag', field: Fields.variable('tags') } }])
        if (!result.ok) throw new Error(result.error)
        expect(result.value.rows.map((row) => row.data.tag)).toEqual(['x', 'y', 'y'])
    })

    it('groups rows and remembers that the id is now a group', () => {
        const result = executeCore(rows, ctx(), [{ type: 'group', field: { name: 'done', field: Fields.variable('done') } }])
        if (!result.ok) throw new Error(result.error)
        expect(result.value.idMeaning).toEqual({ type: 'group', name: 'done', on: { type: 'path' } })
        expect(result.value.rows).toHaveLength(2)
        const first = result.value.rows[0]
        expect(Values.isGrouping(first?.id)).toBe(true)
        expect((first?.id as Grouping).rows.length + (result.value.rows[1]?.id as Grouping).rows.length).toBe(3)
    })

    it('runs the whole DQL pipeline for a table', () => {
        const query = parseQuery('TABLE rating, done AS "Status" FROM -#archived WHERE rating > 0 SORT rating DESC LIMIT 2')
        const result = executeQuery(query, rows, ctx(), null)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.value.kind).toBe('table')
        if (result.value.kind !== 'table') return
        expect(result.value.names).toEqual(['name', 'rating', 'Status'])
        expect(result.value.rows.map((row) => (row.id as DvLink).path)).toEqual(['B.md', 'A.md'])
        expect(query.source.type).toBe('negate')
    })

    it('reads a grouped table row by its key', () => {
        const query = parseQuery('TABLE rating GROUP BY done')
        const result = executeQuery(query, rows, ctx(), null)
        if (!result.ok) throw new Error(result.error)
        expect(result.value.kind).toBe('table')
        if (result.value.kind !== 'table') return
        expect(result.value.rows.map((row) => row.id)).toEqual([false, true])
    })

    it('keeps the members of a grouped list', () => {
        const query = parseQuery('LIST rating GROUP BY done')
        const result = executeQuery(query, rows, ctx(), null)
        if (!result.ok) throw new Error(result.error)
        if (result.value.kind !== 'list') throw new Error('expected a list')
        expect(result.value.items.map((item) => item.id)).toEqual([false, true])
        expect(result.value.items.map((item) => item.members)).toEqual([[4, 1], [9]])
    })

    it('names the grouped notes when the list gives no expression', () => {
        const pages = [
            rail('A.md', { done: false, file: { name: 'A', link: DvLink.file('A.md') } as unknown as DataObject }),
            rail('B.md', { done: true, file: { name: 'B', link: DvLink.file('B.md') } as unknown as DataObject }),
        ]
        const result = executeQuery(parseQuery('LIST GROUP BY done'), pages, ctx(), null)
        if (!result.ok) throw new Error(result.error)
        if (result.value.kind !== 'list') throw new Error('expected a list')
        expect(result.value.items.map((item) => item.members.map((member) => (member as DvLink).path))).toEqual([['A.md'], ['B.md']])
    })

    it('lists values with an id alongside', () => {
        const query = parseQuery('LIST rating')
        const result = executeQuery(query, rows, ctx(), null)
        if (!result.ok) throw new Error(result.error)
        if (result.value.kind !== 'list') throw new Error('expected a list')
        expect(result.value.items.map((item) => item.value)).toEqual([4, 9, 1])
        expect((result.value.items[0]?.id as DvLink).path).toBe('A.md')
    })

    it('honours LIST WITHOUT ID and a bare LIST', () => {
        const withoutId = parseQuery('LIST WITHOUT ID rating')
        const result = executeQuery(withoutId, rows, ctx(), null)
        if (!result.ok) throw new Error(result.error)
        if (result.value.kind !== 'list') throw new Error('expected a list')
        expect(result.value.showId).toBe(false)

        const plain = parseQuery('LIST')
        const plainResult = executeQuery(plain, rows, ctx(), null)
        if (!plainResult.ok) throw new Error(plainResult.error)
        if (plainResult.value.kind !== 'list') throw new Error('expected a list')
        expect(plainResult.value.items.map((item) => item.value)).toEqual([null, null, null])
    })

    it('expands notes into their tasks for a TASK query', () => {
        const taskRail = rail('A.md', {
            file: { tasks: [{ text: 'buy milk', completed: false, link: { path: 'A.md#^1', kind: 'block' } }] } as unknown as Literal,
        })
        const expanded = expandTasks([taskRail], ctx())
        expect(expanded).toHaveLength(1)
        expect(expanded[0]?.data.text).toBe('buy milk')
        const query = parseQuery('TASK WHERE !completed')
        const result = executeQuery(query, [taskRail], ctx(), null)
        if (!result.ok) throw new Error(result.error)
        expect(result.value.kind).toBe('task')
        if (result.value.kind !== 'task') return
        expect(result.value.tasks).toHaveLength(1)
    })

    it('buckets a calendar by day and ignores non-dates', () => {
        const dated = [
            rail('A.md', { day: new Date(2024, 4, 6, 13) as Literal }),
            rail('B.md', { day: new Date(2024, 4, 6) as Literal }),
            rail('C.md', { day: 'not a date' as Literal }),
        ]
        const query = parseQuery('CALENDAR day')
        const result = executeQuery(query, dated, ctx(), null)
        if (!result.ok) throw new Error(result.error)
        if (result.value.kind !== 'calendar') throw new Error('expected a calendar')
        expect(result.value.days).toHaveLength(1)
        expect(result.value.days[0]?.rows).toHaveLength(2)
    })

    it('binds `this` to the note the block lives in', () => {
        const query = parseQuery('LIST this.file.name')
        const self: DataObject = { file: { name: 'Home' } as unknown as Literal }
        const result = executeQuery(query, [rail('A.md', {})], ctx(), self)
        if (!result.ok) throw new Error(result.error)
        if (result.value.kind !== 'list') throw new Error('expected a list')
        expect(result.value.items[0]?.value).toBe('Home')
    })
})

