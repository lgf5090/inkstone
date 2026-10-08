/**
 * The page side of a DML run: what a snapshot contains, and what it does when the index has not read
 * every note yet. The worker itself is not started here — jsdom has no `Worker`, so the run is expected
 * to end with its own error text, which is the other half of the contract: a block never stalls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ parsed: new Set<string>(), loadCalls: [] as string[], ids: ['a', 'b'] }))

vi.mock('./service', () => ({
    querySettings: () => ({ renderNullAs: '—', dateFormat: 'yyyy-MM-dd', datetimeFormat: 'yyyy-MM-dd HH:mm', durationFormat: 'long', locale: 'en-US' }),
    dataviewIndex: {
        allNoteIds: () => [...state.ids],
        universeIds: () => [...state.ids],
        pageOf: (id: string) => (state.parsed.has(id) ? { path: `${id.toUpperCase()}.md` } : undefined),
        serialize: (id: string) => (state.parsed.has(id) ? { file: { name: id, path: `${id.toUpperCase()}.md`, etags: [], tags: [], inlinks: [], outlinks: [] } } : null),
        summaryPage: (id: string) => ({ file: { name: id, path: `${id.toUpperCase()}.md`, etags: [`#${id}`], tags: [`#${id}`], inlinks: [], outlinks: [], lists: [], tasks: [], frontmatter: {} } }),
        load: async (ids: readonly string[]) => {
            state.loadCalls.push(ids.join(','))
            for (const id of ids) state.parsed.add(id)
            return false
        },
    },
}))

beforeEach(() => {
    state.parsed = new Set(['a'])
    state.loadCalls = []
    state.ids = ['a', 'b']
})

describe('the DML snapshot', () => {
    it('asks the index for the notes it could not read before it hands the code over', async () => {
        const { runDataviewJs } = await import('./js')
        const result = await runDataviewJs('dv.paragraph("x")', 'a')
        expect(state.loadCalls).toEqual(['b'])
        expect(result.snapshotOwes).toBe(false)
        expect(result.snapshotShort).toBe(false)
        expect(result.errorText).toBeTruthy()
    })

    it('says so when the window is cut at the page ceiling', async () => {
        const { runDataviewJs } = await import('./js')
        state.ids = Array.from({ length: 405 }, (_, index) => `n${index}`)
        for (const id of state.ids) state.parsed.add(id)
        const result = await runDataviewJs('dv.paragraph("x")', 'a')
        expect(state.loadCalls).toEqual([])
        expect(result.snapshotShort).toBe(true)
    })

    it('keeps a note that is not indexed out of the current object rather than guessing', async () => {
        const { runDataviewJs } = await import('./js')
        const result = await runDataviewJs('dv.paragraph("x")', 'missing')
        expect(state.loadCalls).toEqual(['b'])
        expect(result.snapshotOwes).toBe(false)
    })
})

describe('a task a script drew', () => {
    const taskNode = (line: number | null) => ({
        kind: 'task' as const,
        group: true,
        items: [{ text: [{ kind: 'text' as const, text: 'buy milk' }], completed: false, source: 'Reading/Alpha.md', line }],
    })

    it('carries a real checkbox when the task still names its line', async () => {
        const { renderDvNodes } = await import('./js')
        const drawn = renderDvNodes([taskNode(3) as never])
        const host = document.createElement('div')
        host.append(drawn)
        const box = host.querySelector('input[data-dataview-task]') as HTMLInputElement
        expect(box).not.toBeNull()
        expect(box.type).toBe('checkbox')
        expect(box.getAttribute('aria-label')).toContain('buy milk')
        expect(box.dataset.dataviewTask?.startsWith('b64.')).toBe(true)
    })

    it('falls back to a static mark when the task has no line', async () => {
        const { renderDvNodes } = await import('./js')
        const host = document.createElement('div')
        host.append(renderDvNodes([taskNode(null) as never]))
        expect(host.querySelector('input')).toBeNull()
        expect(host.querySelector('span.dataview-task-checkbox[role="img"]')).not.toBeNull()
    })

    it('spells a link inside the task text the same way the note wrote it', async () => {
        const { renderDvNodes } = await import('./js')
        const { decodeDataValue } = await import('../markdown/data-attr')
        const node = {
            kind: 'task',
            group: true,
            items: [{
                text: [{ kind: 'text', text: 'read ' }, { kind: 'link', path: 'Dune.md', subpath: null, display: 'Dune', embed: false }],
                completed: false,
                source: 'Reading/Alpha.md',
                line: 4,
            }],
        }
        const host = document.createElement('div')
        host.append(renderDvNodes([node as never]))
        const box = host.querySelector('input[data-dataview-task]') as HTMLInputElement
        expect(JSON.parse(decodeDataValue(box.dataset.dataviewTask ?? '')).text).toBe('read Dune')
    })
})
