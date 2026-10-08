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
const textOf = (node?: DvNode): string => (node?.kind === 'text' ? node.text : '')

const book = page('Reading/Dune.md', {
    rating: 5,
    file: { name: 'Dune', path: 'Reading/Dune', folder: 'Reading', link: DvLink.file('Reading/Dune'), etags: ['#book', '#sci-fi'], tags: [], inlinks: [], outlinks: [] },
})
const project = page('Site.md', {
    rating: null,
    file: { name: 'Site', path: 'Site', folder: '', etags: ['#project/active'], tags: [], inlinks: [], outlinks: [] },
})

function dvFor(pages: DvSnapshotPage[], current: DvSnapshotPage | null = null, settings = DEFAULT_QUERY_SETTINGS) {
    const nodes: DvNode[] = []
    const dv = createDv({ code: '', pages, current, settings }, (node) => nodes.push(node))
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
        expect(list.distinct().join('/')).toBe('1/2/3/x')
        expect(list.distinct((value) => (typeof value === 'number' ? 1 : 0)).length).toBe(2)
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

describe('the rest of the dv surface', () => {
    it('reads and compares values the way the expression language does', () => {
        const { dv } = dvFor([book, project])
        expect(dv.page('Reading/Dune.md')).not.toBeNull()
        expect(dv.page('Reading/Dune')).not.toBeNull()
        expect(dv.page('Nowhere')).toBeNull()
        expect(dv.pagePaths('#book').array()).toEqual(['Reading/Dune.md'])
        expect(dv.evaluate('rating', book.data).value).toBe(5)
        expect(dv.evaluate('nope.').successful).toBe(false)
        expect(dv.tryEvaluate('nope.')).toBeNull()
        expect(dv.tryEvaluate('2 + 2')).toBe(4)
        expect((dv.parse('1 + 1') as { type: string }).type).toBe('binaryop')
        expect(dv.compare(1, 2)).toBe(-1)
        expect(dv.equal('a', 'a')).toBe(true)
        expect(dv.typeOf(new Date(2024, 0, 1))).toBe('date')
        expect(dv.isArray([1]) && dv.isArray(dv.pages('')) && dv.isDataArray(dv.pages(''))).toBe(true)
        expect(dv.values({ a: 1, b: 2 }).array()).toEqual([1, 2])
        expect(dv.clone({ a: [1, 2] })).toEqual({ a: [1, 2] })
        expect(dv.literal({ [String.fromCharCode(0) + 'dv']: 'date', value: 1746489600000 })).toBeInstanceOf(Date)
        expect(dv.fileLink('Reading/Dune.md', 'Dune')).toBeTruthy()
        expect((dv.sectionLink('A.md', 'h') as { kind: string }).kind).toBe('header')
        expect((dv.blockLink('A.md', 'b') as { kind: string }).kind).toBe('block')
        expect(dv.settings.dateFormat).toBe('yyyy-MM-dd')
    })

    it('renders markdown text for the export path', () => {
        const { dv } = dvFor([book, project])
        expect(dv.markdownTable(['Name', 'Note'], [['a|b', 2]])).toBe('| Name | Note |\n| --- | --- |\n| a\\|b | 2 |')
        expect(dv.markdownList(['x', 'y'])).toBe('- x\n- y')
        expect(dv.markdownList(['x', 'y'], true)).toBe('1. x\n2. y')
        expect(dv.markdownTaskList([{ text: 'a', completed: true }, { text: 'b' }])).toBe('- [x] a\n- [ ] b')
        expect(dv.queryMarkdown('TABLE rating FROM #book')).toContain('| File | rating |')
        expect(dv.queryMarkdown('TABLE rating FROM #book')).toContain('| Dune | 5 |')
        expect(dv.tryQueryMarkdown('TABLE a WHERE')).toBeNull()
        expect(dv.queryMarkdown('TABLE a WHERE')).toBe('')
        expect(dv.tryQuery('TABLE a WHERE')).toBeNull()
        expect(dv.tryQuery('LIST FROM #book')?.length).toBe(1)
    })

    it('keeps a list or an object as HTML only when the export setting asks', () => {
        const html = dvFor([book], null, { ...DEFAULT_QUERY_SETTINGS, allowHtmlInExports: true }).dv
        expect(html.markdownTable(['Name', 'Tags'], [['a', ['x', 'y']]]))
            .toBe('| Name | Tags |\n| --- | --- |\n| a | <ul><li>x</li><li>y</li></ul> |')
        expect(html.markdownTable(['K'], [[{ k: 'v' }]])).toContain('<li><b>k</b>: v</li>')
        const shallow = dvFor([book], null, { ...DEFAULT_QUERY_SETTINGS, allowHtmlInExports: true, maxRecursiveRenderDepth: 1 }).dv
        expect(shallow.markdownTable(['K'], [[[['deep']]]])).toContain('…')
        expect(html.markdownTable(['K'], [[[['deep']]]])).toContain('deep')
        const plain = dvFor([book]).dv
        expect(plain.markdownTable(['Name', 'Tags'], [['a', ['x', 'y']]])).toContain('x, y')
        expect(plain.markdownTable(['Name', 'Tags'], [['a', ['x', 'y']]])).not.toContain('<ul>')
    })

    it('refuses a table whose rows are not as wide as its headers', () => {
        const { dv } = dvFor([book])
        expect(() => dv.markdownTable(['A', 'B'], [['x']])).toThrow(/must match/)
    })

    it('keeps the doors this port does not open shut', () => {
        const { dv } = dvFor([book])
        expect(() => dv.io.load('x')).toThrow(/cannot read files/)
        expect(() => dv.io.fetch('x')).toThrow(/cannot reach the network/)
        expect(() => dv.barchart([])).toThrow(/not part of this port/)
    })

    it('draws a DQL query handed to dv.execute', () => {
        const { dv, nodes } = dvFor([book, project])
        dv.execute('TABLE rating FROM #book')
        const table = nodes.find((node) => node.kind === 'table')
        expect(table?.kind === 'table' && table.header.map(textOf)).toEqual(['File', 'rating'])
        expect(table?.kind === 'table' && table.rows[0]?.map((cell) => cell.kind)).toEqual(['link', 'text'])
        expect(table?.kind === 'table' && textOf(table.rows[0]?.[1])).toBe('5')

        const list = dvFor([book, project])
        list.dv.execute('LIST FROM #book')
        const drawn = list.nodes.find((node) => node.kind === 'list')
        expect(drawn?.kind === 'list' && drawn.items).toHaveLength(1)

        const tasks = dvFor([page('Todo.md', { file: { name: 'Todo', path: 'Todo', link: DvLink.file('Todo'), tasks: [{ text: 'buy milk', completed: false, line: 1, path: 'Todo.md', task: true }] } })])
        tasks.dv.execute('TASK')
        const drawnTasks = tasks.nodes.find((node) => node.kind === 'task')
        expect(drawnTasks?.kind === 'task' && drawnTasks.items.map((item) => item.text.map(textOf).join(''))).toEqual(['buy milk'])

        const broken = dvFor([book])
        broken.dv.execute('TABLE rating WHERE')
        expect(broken.nodes.some((node) => node.kind === 'paragraph' && textOf(node.children[0]).startsWith('Dataview: '))).toBe(true)
        // A query that parses but cannot answer a single row is a failure of its own, not an empty table.
        const failed = dvFor([book])
        failed.dv.execute('TABLE length(1) FROM #book')
        expect(failed.nodes.some((node) => node.kind === 'paragraph' && textOf(node.children[0]).startsWith('Dataview: '))).toBe(true)
        expect(failed.nodes.some((node) => node.kind === 'table')).toBe(false)
    })

    it('draws the value of an expression handed to dv.executeInline', () => {
        const { dv, nodes } = dvFor([book, project])
        dv.executeInline('2 + 2')
        expect(nodes[0]).toEqual({ kind: 'text', text: '4' })
        const link = dvFor([book, project])
        link.dv.executeInline('this.file.link', 'Reading/Dune.md')
        expect(link.nodes[0]?.kind).toBe('link')
    })

    it('normalizes a link target and answers an inline expression without drawing', () => {
        const { dv } = dvFor([book, project])
        expect(dv.normalize('Reading/Dune')).toBe('Reading/Dune.md')
        expect(dv.normalize(DvLink.file('Site'))).toBe('Site.md')
        expect(dv.normalize('Nope')).toBe('Nope')
        const answer = dv.evaluateInline('this.file.name', 'Reading/Dune.md')
        expect(answer.successful && answer.value).toBe('Dune')
        const broken = dv.evaluateInline('this.(')
        expect(broken.successful).toBe(false)
    })

    it('keeps the line a task came from so the drawn box can write back', () => {
        const { dv, nodes } = dvFor([book, project])
        dv.taskList([{ text: 'buy milk', completed: false, line: 7, source: DvLink.file('Reading/Dune') }])
        const task = nodes.find((node) => node.kind === 'task')
        expect(task?.kind === 'task' && task.items.map((item) => [item.line, item.source])).toEqual([[7, 'Reading/Dune']])
        // `file.tasks` carries the path rather than a source link, and a box drawn from it still writes.
        dv.taskList([{ text: 'book it', completed: true, line: 2, path: 'Reading/Dune.md' }])
        const second = nodes.filter((node) => node.kind === 'task')[1]
        expect(second?.kind === 'task' && second.items.map((item) => [item.line, item.source])).toEqual([[2, 'Reading/Dune.md']])
    })

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

    it('carries the rest of the reference DataArray surface', () => {
        const numbers = DvArray.of([3, 1, 2, 2])
        expect(numbers.flatMap((value) => [value as number, (value as number) * 10]).array()).toEqual([3, 30, 1, 10, 2, 20, 2, 20])
        expect(numbers.slice(1, 3).array()).toEqual([1, 2])
        expect(numbers.concat([9]).last()).toBe(9)
        expect(numbers.indexOf(2)).toBe(2)
        expect(numbers.includes(5)).toBe(false)
        expect(numbers.find((value) => (value as number) > 1)).toBe(3)
        expect(numbers.findIndex((value) => (value as number) > 1)).toBe(0)
        expect(numbers.every((value) => (value as number) > 0)).toBe(true)
        expect(numbers.none((value) => (value as number) > 3)).toBe(true)
        expect(numbers.some((value) => (value as number) > 2)).toBe(true)
        expect(numbers.sum()).toBe(8)
        expect(numbers.avg()).toBe(2)
        expect(numbers.min()).toBe(1)
        expect(numbers.max()).toBe(3)
        let seen = 0
        numbers.forEach((value) => { seen += value as number })
        expect(seen).toBe(8)
        const mutated = DvArray.of([1, 2])
        let touched = 0
        const same = mutated.mutate((value) => { touched += value as number })
        expect(touched).toBe(3)
        expect(same.array()).toEqual([1, 2])
        expect(same.sort((value) => -(value as number)).array()).toEqual([2, 1])
    })

    it('groups, re-groups and reads fields through the proxy', () => {
        const { dv } = dvFor([book, project])
        const pages = dv.pages('')
        const grouped = pages.groupBy((value) => (value as { file: { folder: string } }).file.folder)
        expect(grouped.length).toBe(2)
        expect((grouped.first() as { key: string; rows: { length: number } }).key).toBe('')
        expect((grouped.last() as { key: string; rows: { length: number } }).rows.length).toBe(1)
        expect(grouped.groupIn(() => 'all' as never).length).toBe(2)
        // `pages.file.name` is the shorthand real notes use, and it flattens one level.
        const fields = pages as unknown as { file: { name: { join(sep: string): string } } }
        expect(fields.file.name.join('/')).toBe('Dune/Site')
        expect((pages.get(0) as { file: { name: string } }).file.name).toBe('Dune')
        expect(pages.to('rating').array()).toEqual([5])
        expect(pages.into('rating').array()).toEqual([5])
        expect(pages.expand('nope').length).toBe(0)
        expect(Array.isArray(pages)).toBe(false)
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
        const good = dv.query('TABLE rating FROM #book')
        expect(good.successful).toBe(true)
        expect(good.results).toHaveLength(1)
        expect(good.results[0]?.row.rating).toBe(5)
        expect(dv.query('TABLE this.rating FROM #book', 'Reading/Dune.md').results[0]?.row).toEqual({ 'this.rating': 5 })
        expect(dv.tryEvaluate('this.file.name', book.data)).toBe('Dune')
        const bad = dv.query('TABLE a WHERE')
        expect(bad.successful).toBe(false)
        expect(bad.errors[0]?.message).toContain('Expected')
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
