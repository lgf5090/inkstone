/**
 * Where an article goes when it becomes a note — the rules the reading pane offers but does not
 * implement, tested against the notebook's store as the store is actually called.
 *
 * The behaviours worth pinning are the ones a reader would call broken: saving twice must not make
 * two notes, naming a folder must move the note that already exists rather than start a second one,
 * and "a second copy" must leave the article's first note alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLibrary, type RssEntry, type RssFeed } from '@shared/rss/model'
import { initI18n } from '../../lib/i18n'

const library = { ...emptyLibrary(), savedNotes: {} as Record<string, string> }
const created: Array<{ title: string, content: string, folderId?: string | null }> = []
const rewritten: Array<{ id: string, content: string }> = []
const moved: Array<{ id: string, folderId: string | null }> = []
const notes: Record<string, { id: string, title: string, folderId: string, deletedAt: number | null }> = {
  n1: { id: 'n1', title: 'Alpha', folderId: 'f-a', deletedAt: null },
}

function rememberSavedNote(entryId: string, kind: string, noteId: string): void {
  library.savedNotes[`${entryId}|${kind}`] = noteId
}

vi.mock('../../store/notes', () => ({
  findNoteByTitle: () => null,
  useNotes: {
    getState: () => ({
      notes,
      folders: [{ id: 'f-a', parentId: null, name: 'Alpha', icon: null, color: null, noteCount: 0, createdAt: 1, updatedAt: 1, position: 0 }],
      createNote: vi.fn(async (input: { title: string, content: string, folderId?: string | null }) => {
        created.push(input)
        return 'n-new'
      }),
      createFolder: vi.fn(() => 'f-made'),
      editRemoteContent: vi.fn(async (id: string, transform: (current: string) => string | null) => {
        const next = transform('the previous body')
        if (next !== null) rewritten.push({ id, content: next })
        return 'written'
      }),
      patchNote: vi.fn(async (id: string, patch: { folderId?: string | null }) => {
        moved.push({ id, folderId: patch.folderId ?? null })
      }),
    }),
  },
}))

vi.mock('./store', () => ({ useRss: { getState: () => ({ library, rememberSavedNote }) } }))
vi.mock('../../store/session', () => ({ useSession: { getState: () => ({ settings: { rss: { articleFolder: 'Alpha', dailyNoteTitle: 'YYYY-MM-DD' } } }) } }))
vi.mock('../../store/ui', () => ({ useUi: { getState: () => ({ toast: vi.fn() }) } }))

const { saveArticleAsNote } = await import('./notes')

const feed: RssFeed = { id: 'f1', url: 'https://x.test/feed', title: 'A weekly', siteUrl: '', imageUrl: '', groupId: '', tags: [], order: 0, updatedAt: 0, lastAttemptAt: 0, error: '', errorCount: 0, lastErrorAt: 0, etag: '', lastModified: '', paused: false, pinned: false }
const entry: RssEntry = { id: 'e1', feedId: 'f1', title: 'An article', link: 'https://x.test/1', author: 'A', publishedTs: 1, summary: '', content: '<p>Words.</p>', imageUrl: '', audioUrl: '' }

beforeEach(async () => {
  await initI18n()
  created.length = 0
  rewritten.length = 0
  moved.length = 0
  for (const key of Object.keys(library.savedNotes)) delete library.savedNotes[key]
})

describe('saving an article as a note', () => {
  it('starts one note in the folder the setting names, and remembers it', async () => {
    const result = await saveArticleAsNote(entry, feed)
    expect(result.ok).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0]?.folderId).toBe('f-a')
    expect(created[0]?.content).toContain('url: "https://x.test/1"')
    expect(library.savedNotes['e1|note']).toBe('n-new')
  })

  it('rewrites the note it already made instead of making a second', async () => {
    library.savedNotes['e1|note'] = 'n1'
    await saveArticleAsNote(entry, feed)
    expect(created).toHaveLength(0)
    expect(rewritten.map(item => item.id)).toEqual(['n1'])
    expect(rewritten[0]?.content).toContain('Words.')
  })

  it('moves the note it already made when a folder is named', async () => {
    library.savedNotes['e1|note'] = 'n1'
    await saveArticleAsNote(entry, feed, undefined, { folderId: 'f-made' })
    expect(created, 'no second note for the same article').toHaveLength(0)
    expect(moved).toEqual([{ id: 'n1', folderId: 'f-made' }])
  })

  it('honours a deliberate root, and only when one is named', async () => {
    await saveArticleAsNote(entry, feed, undefined, { folderId: null })
    expect(created[0]?.folderId).toBeNull()
    created.length = 0
    await saveArticleAsNote(entry, feed)
    expect(created[0]?.folderId).toBe('f-a')
  })

  it('keeps a second copy beside the first and remembers it on its own', async () => {
    library.savedNotes['e1|note'] = 'n1'
    await saveArticleAsNote(entry, feed, undefined, { fresh: true })
    expect(created).toHaveLength(1)
    expect(rewritten, 'the reading note is left alone').toEqual([])
    expect(library.savedNotes['e1|copy']).toBe('n-new')
    expect(library.savedNotes['e1|note']).toBe('n1')
  })
})
