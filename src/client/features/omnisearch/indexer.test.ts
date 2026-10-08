import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { NoteSummary } from '@shared/types'

const bodies = new Map<string, string>()
const documents = vi.fn(async (ids: string[]) => ({
  items: ids.map((id) => ({
    id,
    title: store.notes[id]?.title ?? '',
    updatedAt: store.notes[id]?.updatedAt ?? 0,
    archived: false,
    starred: Boolean(store.notes[id]?.isStarred),
    folderId: store.notes[id]?.folderId ?? null,
    content: contentById[id] ?? '',
    chars: (contentById[id] ?? '').length,
  })),
  missing: ids.filter((id) => contentById[id] === undefined),
}))

const store = { notes: {} as Record<string, NoteSummary> }
let attachmentList: Array<Record<string, unknown>> = []
const PHOTO = 'z'.repeat(26)
const contentById: Record<string, string> = {}

vi.mock('../../lib/api', () => ({
  api: {
    searchDocuments: (ids: string[]) => documents(ids),
    files: { list: async () => ({ files: attachmentList, nextCursor: null }) },
  },
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
}))

vi.mock('../../lib/db', () => ({
  localDb: {
    getOmnisearchBodies: async (ids: string[]) => new Map(ids.filter((id) => bodies.has(id)).map((id) => [id, bodies.get(id)!])),
    setOmnisearchBodies: async (entries: Array<[string, string]>) => {
      for (const [id, value] of entries) bodies.set(id, value)
    },
    dropOmnisearchBodies: async (ids: string[]) => {
      for (const id of ids) bodies.delete(id)
    },
    loadOmnisearchCache: async () => null,
    saveOmnisearchCache: async () => {},
    clearOmnisearchCache: async () => {},
  },
}))

const { omnisearchIndexer } = await import('./indexer')
const { useNotes } = await import('../../store/notes')
const { useSession } = await import('../../store/session')

function summary(id: string, over: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id,
    title: id,
    excerpt: '',
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 1,
    position: 0,
    createdAt: 1,
    updatedAt: 1000,
    deletedAt: null,
    ...over,
  }
}

function seed(notes: Record<string, NoteSummary>, contents: Record<string, string>): void {
  store.notes = notes
  for (const key of Object.keys(contentById)) delete contentById[key]
  Object.assign(contentById, contents)
  useNotes.setState({ notes, contents: {}, folders: [], tags: [], hydrated: true, loading: false })
}

beforeEach(async () => {
  vi.clearAllMocks()
  bodies.clear()
  omnisearchIndexer.dispose()
  useSession.setState({
    status: 'authed',
    user: null,
    settings: { ...DEFAULT_SETTINGS, search: { ...DEFAULT_SETTINGS.search, pinyinSearch: false } },
  })
})

describe('indexer', () => {
  it('indexes every live note and answers a query from the local index', async () => {
    seed(
      {
        latte: summary('latte', { title: 'Latte art', updatedAt: 5 }),
        espresso: summary('espresso', { title: 'Espresso machine', updatedAt: 6 }),
        gone: summary('gone', { deletedAt: 9 }),
      },
      {
        latte: '## Patterns\n\nlatte foam and a rosetta, see [[Espresso machine]]',
        espresso: 'the gaggia needs descaling and a latte',
      },
    )
    await omnisearchIndexer.start()
    const status = omnisearchIndexer.getStatus()
    expect(status.indexed).toBe(2)
    expect(status.ready).toBe(true)
    expect(status.available).toBe(2)
    const { results } = await omnisearchIndexer.query('latte')
    expect(results.map((result) => result.doc.title).sort()).toEqual(['Espresso machine', 'Latte art'])
    expect(results[0]!.excerpt.lines.length).toBeGreaterThan(0)
  })

  it('keeps the note bodies it indexed so an excerpt needs no network', async () => {
    seed({ one: summary('one', { title: 'One' }) }, { one: 'alpha beta' })
    await omnisearchIndexer.start()
    expect(await omnisearchIndexer.resolveBody('n:one')).toBe('alpha beta')
  })

  it('re-reads only the note whose revision moved', async () => {
    seed({ a: summary('a', { title: 'A' }), b: summary('b', { title: 'B' }) }, { a: 'alpha', b: 'beta' })
    await omnisearchIndexer.start()
    documents.mockClear()
    seed({ a: summary('a', { title: 'A', updatedAt: 77 }), b: summary('b', { title: 'B' }) }, { a: 'alpha changed', b: 'beta' })
    await omnisearchIndexer.reconcile()
    expect(documents).toHaveBeenCalledTimes(1)
    expect(documents.mock.calls[0]![0]).toEqual(['a'])
    expect((await omnisearchIndexer.query('changed')).results).toHaveLength(1)
  })

  it('drops a note that left the library, and its stored body', async () => {
    seed({ a: summary('a', { title: 'A' }), b: summary('b', { title: 'B' }) }, { a: 'alpha', b: 'beta' })
    await omnisearchIndexer.start()
    seed({ a: summary('a', { title: 'A' }) }, { a: 'alpha' })
    await omnisearchIndexer.reconcile()
    expect(omnisearchIndexer.getStatus().indexed).toBe(1)
    expect(bodies.has('b')).toBe(false)
    expect((await omnisearchIndexer.query('beta')).results).toEqual([])
  })

  it('indexes attachment names and shows the note that embeds one', async () => {
    attachmentList = [{ id: PHOTO, filename: 'shot.png', noteId: 'host', size: 12, mime: 'image/png', createdAt: 4 }]
    seed({ host: summary('host', { title: 'Host note' }) }, { host: ['a page with', '/api/files/' + PHOTO, 'in it'].join(' ') })
    await omnisearchIndexer.start()
    expect(omnisearchIndexer.getStatus().indexed).toBe(2)
    const byName = await omnisearchIndexer.query('shot')
    expect(byName.results.map((result) => result.id)).toEqual(['f:' + PHOTO, 'n:host'])
    expect(byName.results[1]!.isEmbed).toBe(true)
    attachmentList = []
  })

  it('indexes the body the editor is holding, not the older server copy', async () => {
    seed({ a: summary('a', { title: 'A' }) }, { a: 'server text' })
    useNotes.setState({ contents: { a: 'unsaved draft text' } })
    await omnisearchIndexer.start()
    expect((await omnisearchIndexer.query('unsaved')).results).toHaveLength(1)
    expect((await omnisearchIndexer.query('server'))).toEqual(expect.objectContaining({ results: [] }))
    expect(await omnisearchIndexer.resolveBody('n:a')).toBe('unsaved draft text')
  })

  it('stops indexing at the reader’s own ceiling and says how many were left out', async () => {
    const notes: Record<string, NoteSummary> = {}
    const contents: Record<string, string> = {}
    for (let index = 0; index < 5; index++) {
      notes[`n${index}`] = summary(`n${index}`, { updatedAt: index })
      contents[`n${index}`] = `body ${index}`
    }
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, search: { ...DEFAULT_SETTINGS.search, maxIndexedNotes: 2, pinyinSearch: false } } })
    seed(notes, contents)
    await omnisearchIndexer.start()
    const status = omnisearchIndexer.getStatus()
    expect(status.indexed).toBe(2)
    expect(status.deferred).toBe(3)
  })

  it('does nothing while the feature is switched off', async () => {
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, search: { ...DEFAULT_SETTINGS.search, enabled: false } } })
    seed({ a: summary('a') }, { a: 'alpha' })
    await omnisearchIndexer.start()
    expect(omnisearchIndexer.getStatus().phase).toBe('off')
    expect((await omnisearchIndexer.query('alpha')).results).toEqual([])
  })

  it('survives a note the server no longer has without asking again', async () => {
    seed({ a: summary('a', { title: 'A' }), ghost: summary('ghost', { title: 'Ghost' }) }, { a: 'alpha' })
    await omnisearchIndexer.start()
    const before = documents.mock.calls.length
    await omnisearchIndexer.reconcile()
    expect(documents.mock.calls.length).toBe(before)
    expect(omnisearchIndexer.getStatus().error).toBeNull()
  })
})
