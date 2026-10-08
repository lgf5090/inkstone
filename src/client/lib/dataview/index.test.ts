import { describe, expect, it } from 'vitest'
import { DataviewIndex, leaves, type IndexNote } from './index'
import { Sources, type Source } from './ast'
import { Values, type DataObject } from './value'

interface Fixture {
    notes: Map<string, IndexNote>
    bodies: Map<string, string>
    /** Notes the store holds a body for in memory — the ones the reader has opened. */
    opened: Set<string>
    fetches: string[][]
    backlinkCalls: string[]
    backlinks: Map<string, string[]>
}

function note(id: string, overrides: Partial<IndexNote> = {}): IndexNote {
    return {
        id,
        title: id,
        folder: '',
        tags: [],
        createdAt: Date.UTC(2024, 0, 1),
        updatedAt: Date.UTC(2024, 0, 2),
        rev: 1,
        charCount: 20,
        wordCount: 4,
        starred: false,
        pinned: false,
        archived: false,
        ...overrides,
    }
}

function fixture(entries: Array<Partial<IndexNote> & { id: string }>, bodies: Record<string, string> = {}): Fixture {
    return {
        notes: new Map(entries.map((entry) => [entry.id, note(entry.id, entry)])),
        bodies: new Map(Object.entries(bodies)),
        opened: new Set<string>(),
        fetches: [],
        backlinkCalls: [],
        backlinks: new Map(),
    }
}

function indexFor(state: Fixture, bodyLimit = 500): DataviewIndex {
    return new DataviewIndex({
        notes: () => [...state.notes.values()].map((item) => (
            state.opened.has(item.id) ? { ...item, content: state.bodies.get(item.id) ?? '' } : item
        )),
        loadContent: async (ids) => {
            state.fetches.push([...ids])
            const out = new Map<string, string>()
            for (const id of ids) {
                const body = state.bodies.get(id)
                if (body !== undefined) out.set(id, body)
            }
            return out
        },
        incomingLinks: async (id) => {
            state.backlinkCalls.push(id)
            return state.backlinks.get(id) ?? []
        },
    }, bodyLimit)
}

const ALPHA = ['---', 'rating: 4', '---', '#book', 'Author:: Ursula', '', '- [ ] buy milk [due:: 2024-05-06]', ''].join('\n')

describe('index source resolution', () => {
    it('answers a folder source from summaries alone, with no body outstanding', () => {
        const state = fixture([{ id: 'a', folder: 'Reading' }, { id: 'b', folder: 'Reading/Books' }, { id: 'c', folder: 'Work' }])
        const index = indexFor(state)
        index.sync()
        const { ids, needBodies } = index.candidates(Sources.folder('Reading'))
        expect([...ids].sort()).toEqual(['a', 'b'])
        expect([...needBodies]).toEqual([])
    })

    it('matches a note whose own title is the folder name', () => {
        const state = fixture([{ id: 'a', title: 'Reading' }, { id: 'b', title: 'Other' }])
        const index = indexFor(state)
        index.sync()
        expect([...index.candidates(Sources.folder('Reading')).ids]).toEqual(['a'])
    })

    it('matches a tag and everything under it', () => {
        const state = fixture([
            { id: 'a', tags: ['project/active'] },
            { id: 'b', tags: ['project'] },
            { id: 'c', tags: ['other'] },
        ])
        const index = indexFor(state)
        index.sync()
        // The server writes note_tags from the note's content, so a prose `#book` reaches the summary
        // and a tag query never has to read a body to know who matches.
        expect([...index.candidates(Sources.tag('#project')).ids].sort()).toEqual(['a', 'b'])
        expect([...index.candidates(Sources.tag('#project')).needBodies]).toEqual([])
    })

    it('cross-checks a parsed page for a tag the summary has not caught up with', async () => {
        const state = fixture([{ id: 'a' }, { id: 'b', tags: ['book'] }], { a: ALPHA })
        const index = indexFor(state)
        index.sync()
        expect([...index.candidates(Sources.tag('#book')).ids]).toEqual(['b'])
        await index.load(['a'])
        expect([...index.candidates(Sources.tag('#book')).ids].sort()).toEqual(['a', 'b'])
    })

    it('composes and, or and negation exactly', () => {
        const state = fixture([
            { id: 'a', tags: ['x'], folder: 'Archive' },
            { id: 'b', tags: ['x'] },
            { id: 'c', tags: ['y'] },
            { id: 'd', tags: ['w'] },
        ])
        const index = indexFor(state)
        index.sync()
        const ids = (source: Source) => [...index.candidates(source).ids].sort()
        expect(ids(Sources.or(Sources.tag('#x'), Sources.tag('#y')))).toEqual(['a', 'b', 'c'])
        expect(ids(Sources.and(Sources.tag('#x'), Sources.folder('Archive')))).toEqual(['a'])
        expect(ids(Sources.negate(Sources.folder('Archive')))).toEqual(['b', 'c', 'd'])
        expect(ids({ type: 'negate', child: Sources.or(Sources.tag('#x'), Sources.tag('#y')) } as Source)).toEqual(['d'])
    })

    it('reads backlinks from the adapter once and caches them until the next sync', async () => {
        const state = fixture([{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }])
        state.backlinks.set('a', ['b'])
        const index = indexFor(state)
        index.sync()
        const source = Sources.link('Alpha', true)
        expect(index.linksPending(source)).toBe(true)
        await index.prepareLinks('Alpha')
        expect(index.linksPending(source)).toBe(false)
        expect([...index.candidates(source).ids]).toEqual(['b'])
        await index.prepareLinks('Alpha')
        expect(state.backlinkCalls).toEqual(['a'])
        index.sync()
        expect(index.linksPending(source)).toBe(true)
    })

    it('resolves an outgoing source once the target page is read', async () => {
        const state = fixture([{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }], { a: 'Points at [[Beta]].' })
        const index = indexFor(state)
        index.sync()
        const source = Sources.link('Alpha', false)
        expect([...index.candidates(source).needBodies]).toEqual(['a'])
        await index.load(['a'])
        expect([...index.candidates(source).ids]).toEqual(['b'])
    })

    it('scans parsed pages for an unresolved target name and asks for the rest', () => {
        const state = fixture([{ id: 'a' }, { id: 'b' }], { a: 'See [[Ghost]].', b: 'plain' })
        const index = indexFor(state)
        index.sync()
        const { ids, needBodies } = index.candidates(Sources.link('Ghost', true))
        expect([...ids].sort()).toEqual(['a', 'b'])
        expect([...needBodies].sort()).toEqual(['a', 'b'])
    })

    it('walks a source tree in written order', () => {
        const tree = Sources.and(Sources.tag('#a'), Sources.negate(Sources.folder('X')))
        expect(leaves(tree).map((leaf) => leaf.type)).toEqual(['tag', 'folder'])
    })

    it('resolves a link to a note id from its summary title, before any body is read', () => {
        const state = fixture([{ id: 'a', title: 'Alpha', folder: 'Reading' }])
        const index = indexFor(state)
        index.sync()
        expect(index.noteIdForLink('Alpha')).toBe('a')
        expect(index.noteIdForLink('Reading/Alpha')).toBe('a')
        expect(index.noteIdForLink('Alpha.md')).toBe('a')
        expect(index.noteIdForLink('Missing')).toBeUndefined()
    })

    it('resolves a printed path with or without the extension it carries', () => {
        const state = fixture([
            { id: 'a', title: 'Alpha', folder: 'Reading' },
            { id: 'b', title: 'Beta', folder: '' },
        ])
        const index = indexFor(state)
        index.sync()
        expect(index.noteIdForPath('Reading/Alpha.md')).toBe('a')
        expect(index.noteIdForPath('Reading/Alpha')).toBe('a')
        expect(index.noteIdForPath('reading/alpha.md')).toBe('a')
        expect(index.noteIdForPath('Beta.md')).toBe('b')
        expect(index.noteIdForPath('Alpha')).toBe('a')
        expect(index.noteIdForPath('Reading/Gamma')).toBeUndefined()
    })

    it('keeps two notes of the same title apart by their path', () => {
        const state = fixture([
            { id: 'a', title: 'Alpha', folder: 'Reading' },
            { id: 'b', title: 'Alpha', folder: 'Writing' },
        ])
        const index = indexFor(state)
        index.sync()
        expect(index.noteIdForPath('Reading/Alpha.md')).toBe('a')
        expect(index.noteIdForPath('Reading/Alpha')).toBe('a')
        expect(index.noteIdForPath('Writing/Alpha.md')).toBe('b')
        expect(index.noteIdForPath('Writing/Alpha')).toBe('b')
    })
})

describe('index body loading', () => {
    it('parses what a load hands back', async () => {
        const state = fixture([{ id: 'a' }], { a: ALPHA })
        const index = indexFor(state)
        index.sync()
        const truncated = await index.load(['a'])
        expect(truncated).toBe(false)
        expect(index.pageOf('a')?.fields.get('Author')).toBe('Ursula')
        expect(index.getStatus().parsed).toBe(1)
        expect(index.getStatus().phase).toBe('ready')
    })

    it('remembers a note the backend declined, until its revision moves', async () => {
        const state = fixture([{ id: 'a', rev: 3 }])
        const index = indexFor(state)
        index.sync()
        await index.load(['a'])
        expect(state.fetches).toEqual([['a']])
        await index.load(['a'])
        expect(state.fetches).toHaveLength(1)
        state.notes.set('a', note('a', { rev: 4 }))
        index.sync()
        await index.load(['a'])
        expect(state.fetches).toHaveLength(2)
    })

    it('caps the bodies one query may pull and says so', async () => {
        const state = fixture([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { a: 'x', b: 'y' })
        const index = indexFor(state, 2)
        index.sync()
        const truncated = await index.load(['a', 'b', 'c'])
        expect(truncated).toBe(true)
        expect(index.getStatus().phase).toBe('limited')
        expect(index.getStatus().truncated).toBe(true)
    })

    it('re-parses an edited note and forgets a deleted one', async () => {
        const state = fixture([{ id: 'a' }], { a: 'Rating:: 1' })
        const index = indexFor(state)
        index.sync()
        await index.load(['a'])
        expect(index.pageOf('a')?.fields.get('Rating')).toBe(1)
        // The reader opens the note, so from here the store itself carries the body.
        state.opened.add('a')
        state.bodies.set('a', 'Rating:: 2')
        state.notes.set('a', note('a', { rev: 2, updatedAt: Date.UTC(2024, 0, 3) }))
        index.sync()
        expect(index.pageOf('a')?.fields.get('Rating')).toBe(2)
        state.notes.delete('a')
        index.sync()
        expect(index.pageOf('a')).toBeUndefined()
    })

    it('drops a page it can no longer vouch for, then re-reads it on the next query', async () => {
        const state = fixture([{ id: 'a' }], { a: 'moved' })
        const index = indexFor(state)
        index.sync()
        await index.load(['a'])
        expect(index.pageOf('a')?.path).toBe('a.md')
        // A folder drag keeps no in-memory body, so the parsed page is stale and must not be shown.
        state.notes.set('a', note('a', { folder: 'Two', rev: 2 }))
        index.sync()
        expect(index.pageOf('a')).toBeUndefined()
        const { rails } = await index.resolveRails(Sources.everything())
        expect(rails.map((rail) => (rail.id as { path: string }).path)).toEqual(['Two/a.md'])
    })

    it('resolveRails loads what it needs and returns the rows', async () => {
        const state = fixture(
            [{ id: 'a', tags: ['book'] }, { id: 'b', tags: ['book'] }],
            { a: ALPHA, b: '#book\nrating:: 9' },
        )
        const index = indexFor(state)
        index.sync()
        const { rails, truncated } = await index.resolveRails(Sources.tag('#book'))
        expect(truncated).toBe(false)
        expect(rails.map((rail) => (rail.id as { path: string }).path).sort()).toEqual(['a.md', 'b.md'])
        const first = rails.find((rail) => (rail.id as { path: string }).path === 'a.md')
        const data = first?.data as DataObject
        expect((data.file as DataObject).name).toBe('a')
        expect(data.rating).toBe(4)
    })

    it('exposes the current note as its own serialized object', async () => {
        const state = fixture([{ id: 'a' }], { a: ALPHA })
        const index = indexFor(state)
        index.sync()
        expect(index.currentData('a')).toBeNull()
        await index.load(['a'])
        const data = index.currentData('a')
        expect(data).not.toBeNull()
        expect(Values.isObject(data?.file)).toBe(true)
    })

    it('computes incoming links for a serialized page', async () => {
        const state = fixture([{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }], { a: 'plain', b: 'See [[Alpha]].' })
        const index = indexFor(state)
        index.sync()
        await index.load(['a', 'b'])
        const data = index.serialize('a')
        const inlinks = (data?.file as DataObject | undefined)?.inlinks as Array<{ path: string }>
        expect(inlinks.map((link) => link.path)).toEqual(['Beta.md'])
    })

    it('notifies subscribers once per burst and stops on unsubscribe', () => {
        const state = fixture([{ id: 'a' }])
        const index = indexFor(state)
        let calls = 0
        const off = index.subscribe(() => { calls += 1 })
        index.sync()
        index.sync()
        index.flush()
        expect(calls).toBe(1)
        off()
        index.sync()
        index.flush()
        expect(calls).toBe(1)
    })

    it('ingests an editor commit without a round-trip', () => {
        const state = fixture([{ id: 'a' }])
        const index = indexFor(state)
        index.sync()
        index.ingest(note('a', { rev: 5 }), 'Rating:: 7')
        expect(index.pageOf('a')?.fields.get('Rating')).toBe(7)
        expect(index.allNoteIds()).toEqual(['a'])
    })
})
