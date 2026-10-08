/**
 * The DML API as a note's code sees it. This module runs inside the worker, so the cases are about the
 * values that cross the boundary and the shapes the main thread is asked to draw — not about the DOM.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_QUERY_SETTINGS } from './functions'
import { DvDuration, DvLink, Grouping } from './value'
import { DV_PAGE_LIMIT, DvArray, cool, createDv, warm, DV_MARKER, type DvNode, type DvSnapshotPage } from './js-api'

function page(path: string, data: Record<string, unknown>): DvSnapshotPage {
    return { path, data: cool(data) }
}

const nameOf = (value: unknown): string => (value as { file?: { name?: string } }).file?.name ?? ''

const book = page('Reading/Dune.md', {
    rating: 5,
    file: { name: 'Dune', path: 'Reading/Dune', folder: 'Reading', link: DvLink.file('Reading/Dune'), etags: ['#book', '#sci-fi'], tags: [], inlinks: [], outlinks: [] },
})
const project = page('Site.md', {
    rating: null,
    file: { name: 'Site', path: 'Site', folder: '', etags: ['#project/active'], tags: [], inlinks: [], outlinks: [] },
})

function dvFor(pages: DvSnapshotPage[], current: DvSnapshotPage | null = null) {
    const nodes: DvNode[] = []
    const dv = createDv({ code: '', pages, current, settings: DEFAULT_QUERY_SETTINGS }, (node) => nodes.push(node))
    return { dv, nodes }
}

describe('values across the worker boundary', () => {
    it('round-trips the four classes postMessage would flatten', () => {
        const date = new Date(2024, 4, 6, 7, 8)
        const link = new DvLink('Reading/Dune', 'file', null, 'Dune', false)
        const duration = DvDuration.of({ hours: 1 })
        const cooled = cool({ date, link, duration, group: new Grouping('k', [{ x: 1 } as never]) })
        const back = warm(cooled) as Record<string, unknown>
        expect((back.date as Date).getTime()).toBe(date.getTime())
        expect(back.link).toBeInstanceOf(DvLink)
        expect((back.link as DvLink).path).toBe('Reading/Dune')
        expect(back.group).toBeInstanceOf(Grouping)
        expect((back.duration as DvDuration).hours).toBe(1)
        expect(warm(date)).toBe(date)
        expect(warm(link)).toBe(link)
    })

    it('keeps a marker key that no note can write by accident', () => {
        expect(DV_MARKER.charCodeAt(0)).toBe(0)
        expect(warm(cool({ file: { name: 'x' } }))).toEqual({ file: { name: 'x' } })
    })
})

describe('the list a note receives', () => {
    it('chains the helpers without losing the wrapper', () => {
        const list = DvArray.of([3, 1, 2, 2, 'x' as never])
        expect(list.limit(2).map((value) => (typeof value === 'number' ? value * 2 : value)).array()).toEqual([6, 2])
        expect(list.sort().first()).toBe(1)
        expect(list.sort().last()).toBe('x')
        expect(list.where((value) => typeof value === 'number').length).toBe(4)
        expect(list.distinct().join('/')).toBe('3/1/2/x')
        expect([...list].length).toBe(5)
        expect(Array.isArray(list)).toBe(false)
        expect(list.toJSON()).toEqual([3, 1, 2, 2, 'x'])
    })

    it('matches sources the way FROM does, including the boolean forms', () => {
        const { dv } = dvFor([book, project])
        expect(dv.pages('#book').length).toBe(1)
        expect(dv.pages('#project').length).toBe(1)
        expect(dv.pages('!#book').length).toBe(1)
        expect(dv.pages('#book | #project').length).toBe(2)
        expect(dv.pages('#book & #project').length).toBe(0)
        expect(dv.pages('').length).toBe(2)
        expect(dv.pagesByTag('book').length).toBe(1)
        expect(dv.pagesByFolder('Reading').length).toBe(1)
        expect(dv.pages('"Reading"').length).toBe(1)
        expect(dv.pages('#book &').length).toBe(0)
        expect(dv.pages('#nothing').length).toBe(0)
    })

    it('caps the vault it hands over and says so', () => {
        const many = Array.from({ length: DV_PAGE_LIMIT + 5 }, (_, index) => page(`N${index}.md`, { file: { name: `N${index}`, path: `N${index}`, folder: '', etags: [], tags: [], inlinks: [], outlinks: [] } }))
        const { dv } = dvFor(many)
        expect(dv.pages('').length).toBe(DV_PAGE_LIMIT)
        expect(dv.truncated).toBe(true)
    })
})

describe('what a note can ask to be drawn', () => {
    it('takes rows from the wrapper its own map returns', () => {
        const { dv, nodes } = dvFor([book, project])
        dv.table(['Name', 'Rating'], dv.pages('#book').map((value) => [nameOf(value), (value as { rating?: unknown }).rating]))
        const table = nodes.find((node) => node.kind === 'table')
        expect(table?.kind === 'table' && table.header.map((cell) => cell.kind)).toEqual(['text', 'text'])
        expect(table?.kind === 'table' && table.rows).toHaveLength(1)
        expect(table?.kind === 'table' && table.rows[0]?.map((cell) => cell.kind)).toEqual(['text', 'text'])
        expect(table?.kind === 'table' && table.rows[0]?.map((cell) => cell.kind === 'text' && cell.text)).toEqual(['Dune', '5'])
    })

    it('keeps a link a link rather than an empty cell', () => {
        const { dv, nodes } = dvFor([book, project])
        dv.table(['Name'], dv.pages('#book').map((value) => [(value as { file: { link: unknown } }).file.link]))
        const table = nodes.find((node) => node.kind === 'table')
        // A cooled link carries its own `kind`, so reading it as a drawn node would have shown nothing.
        expect(table?.kind === 'table' && table.rows[0]?.map((cell) => cell.kind)).toEqual(['link'])
        expect(nodes.some((node) => node.kind === 'element')).toBe(false)
    })

    it('draws lists, tasks and headings from either array shape', () => {
        const { dv, nodes } = dvFor([book, project])
        dv.list(dv.pages('').map((value) => nameOf(value)))
        dv.numberList(['a', 'b'])
        dv.taskList([{ text: 'one', completed: true }, { text: 'two', completed: false }])
        dv.header(9, 'big')
        dv.header(0, 'small')
        const kinds = nodes.map((node) => node.kind)
        expect(kinds).toEqual(['list', 'list', 'task', 'heading', 'heading'])
        expect(nodes[0]?.kind === 'list' && nodes[0].items).toHaveLength(2)
        expect(nodes[2]?.kind === 'task' && nodes[2].items.map((item) => item.completed)).toEqual([true, false])
        expect(nodes[3]?.kind === 'heading' && nodes[3].level).toBe(6)
        expect(nodes[4]?.kind === 'heading' && nodes[4].level).toBe(1)
    })

    it('refuses a tag that could carry a script, and keeps the class the author asked for', () => {
        const { dv, nodes } = dvFor([book])
        dv.el('script', 'bad', ['x'])
        dv.el('span', 'ok-class', ['y'])
        expect(nodes[0]?.kind === 'element' && nodes[0].tag).toBe('div')
        expect(nodes[1]?.kind === 'element' && nodes[1].class).toBe('ok-class')
    })

    it('runs a DQL query and reports its own failure instead of throwing', () => {
        const { dv } = dvFor([book, project])
        const good = dv.query('TABLE rating', '#book')
        expect(good.successful).toBe(true)
        expect(good.results).toHaveLength(1)
        expect(good.results[0]?.row.rating).toBe(5)
        const bad = dv.query('TABLE a WHERE')
        expect(bad.successful).toBe(false)
        expect(bad.errors[0]?.message).toContain('Expected')
    })

    it('keeps the doors this port does not open shut, with a readable reason', () => {
        const { dv } = dvFor([book])
        expect(() => dv.io.load('x')).toThrow(/cannot read files/)
        expect(() => dv.io.fetch('x')).toThrow(/cannot reach the network/)
        expect(() => dv.execute('x')).toThrow(/dv.query/)
        expect(() => dv.barchart([])).toThrow(/not part of this port/)
    })

    it('formats a value with the reader settings rather than the machine locale', () => {
        const { dv } = dvFor([book])
        expect(dv.toString(new Date(2024, 4, 6))).toBe('2024-05-06')
        expect(dv.string(3.5)).toBe('3.5')
        expect(dv.mdEsc('a*b')).toBe('a\\*b')
        expect(dv.number('42')).toBe(42)
        expect(dv.date('2024-05-06')).toBeInstanceOf(Date)
    })
})
