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
        pageOf: (id: string) => ({ path: `${id.toUpperCase()}.md` }),
        serialize: (id: string) => (state.parsed.has(id) ? { file: { name: id, path: `${id.toUpperCase()}.md`, etags: [], tags: [], inlinks: [], outlinks: [] } } : null),
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
