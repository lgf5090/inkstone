// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import {
  ReaderLibraryStore,
  type ShelfBookInput,
  type ShelfDeletedInput,
  type ShelfHighlightInput,
  type ShelfMergeInput,
} from '../src/worker/reader/store'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-reader'

function book(overrides: Partial<ShelfBookInput> = {}): ShelfBookInput {
  const format = overrides.format ?? 'epub'
  return {
    id: 'book-1',
    title: 'Book One',
    author: 'Author',
    format,
    filename: `book.${format}`,
    language: 'en',
    publisher: '',
    size: 4096,
    unitCount: 10,
    wantsCover: false,
    tocJson: '[]',
    addedAt: 1,
    updatedAt: 100,
    fallbackKey: `reader/${USER}/book-1.${format}`,
    ...overrides,
  }
}

function highlight(overrides: Partial<ShelfHighlightInput> = {}): ShelfHighlightInput {
  return {
    id: 'highlight-1',
    bookId: 'book-1',
    chapter: 1,
    startOffset: 10,
    endOffset: 20,
    quote: 'one',
    prefix: '',
    suffix: '',
    color: 'yellow',
    comment: '',
    createdAt: 1,
    updatedAt: 300,
    ...overrides,
  }
}

function deletions(overrides: Partial<ShelfDeletedInput> = {}): ShelfDeletedInput {
  return {
    books: { ids: [], updatedAt: 0 },
    progress: { ids: [], updatedAt: 0 },
    highlights: { ids: [], updatedAt: 0 },
    marks: { ids: [], updatedAt: 0 },
    stats: { ids: [], updatedAt: 0 },
    notes: { ids: [], updatedAt: 0 },
    groups: { ids: [], updatedAt: 0 },
    vocabulary: null,
    ...overrides,
  }
}

function snapshot(overrides: Partial<ShelfMergeInput> = {}): ShelfMergeInput {
  return {
    books: [],
    progress: [],
    highlights: [],
    marks: [],
    stats: [],
    notes: [],
    vocabulary: null,
    vocabularyUpdatedAt: null,
    groups: [],
    deleted: deletions(),
    ...overrides,
  }
}

let sqlite: DatabaseSync
let store: ReaderLibraryStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  store = new ReaderLibraryStore(makeD1(sqlite), USER)
})

describe('reader snapshot merging', () => {
  it('keeps both devices\' highlights and does not let an old snapshot replace newer progress', async () => {
    await store.merge(snapshot({
      books: [book()],
      progress: [{ bookId: 'book-1', positionJson: '{"kind":"epub","chapter":4,"offset":40}', fraction: 0.8, updatedAt: 500, finishedAt: null }],
      highlights: [highlight({ id: 'from-a', updatedAt: 600 })],
    }))

    await store.merge(snapshot({
      books: [book({ title: 'Stale title', updatedAt: 100 })],
      progress: [{ bookId: 'book-1', positionJson: '{"kind":"epub","chapter":1,"offset":5}', fraction: 0.2, updatedAt: 400, finishedAt: null }],
      highlights: [highlight({ id: 'from-b', quote: 'two', updatedAt: 700 })],
    }))

    const rows = await store.shelf()
    expect(rows.books.map((row) => row.title)).toEqual(['Book One'])
    expect(rows.progress).toMatchObject([{ fraction: 0.8, updated_at: 500 }])
    expect(rows.highlights.map((row) => row.id).sort()).toEqual(['from-a', 'from-b'])
  })

  it('keeps the newer version when two merges race after reading the same snapshot', async () => {
    await store.merge(snapshot({
      books: [book()],
      progress: [{ bookId: 'book-1', positionJson: 'null', fraction: 0.1, updatedAt: 100, finishedAt: null }],
    }))
    await Promise.all([
      store.merge(snapshot({ progress: [{ bookId: 'book-1', positionJson: '{"kind":"epub","chapter":8,"offset":0}', fraction: 0.8, updatedAt: 300, finishedAt: null }] })),
      store.merge(snapshot({ progress: [{ bookId: 'book-1', positionJson: '{"kind":"epub","chapter":2,"offset":0}', fraction: 0.2, updatedAt: 200, finishedAt: null }] })),
    ])
    expect((await store.shelf()).progress).toMatchObject([{ fraction: 0.8, updated_at: 300 }])
  })

  it('ignores stale tombstones and applies explicit highlight, group and book deletions', async () => {
    await store.merge(snapshot({
      books: [book(), book({ id: 'book-2', title: 'Book Two', fallbackKey: `reader/${USER}/book-2.epub` })],
      progress: [
        { bookId: 'book-1', positionJson: 'null', fraction: 0.1, updatedAt: 100, finishedAt: null },
        { bookId: 'book-2', positionJson: 'null', fraction: 0.2, updatedAt: 100, finishedAt: null },
      ],
      highlights: [highlight(), highlight({ id: 'highlight-2', bookId: 'book-2', updatedAt: 100 })],
      marks: [
        { id: 'mark-1', bookId: 'book-1', label: 'one', positionJson: '{"kind":"epub","chapter":1,"offset":0}', createdAt: 1, updatedAt: 100 },
        { id: 'mark-2', bookId: 'book-2', label: 'two', positionJson: '{"kind":"epub","chapter":1,"offset":0}', createdAt: 1, updatedAt: 100 },
      ],
      stats: [
        { bookId: 'book-1', seconds: 10, daysJson: '{}', updatedAt: 100 },
        { bookId: 'book-2', seconds: 20, daysJson: '{}', updatedAt: 100 },
      ],
      notes: [
        { bookId: 'book-1', noteId: 'note-1', updatedAt: 100 },
        { bookId: 'book-2', noteId: 'note-2', updatedAt: 100 },
      ],
      groups: [
        { id: 'group-delete', name: 'Delete', bookIds: ['book-1'], createdAt: 1, updatedAt: 100 },
        { id: 'group-live', name: 'Live', bookIds: ['book-1', 'book-2'], createdAt: 1, updatedAt: 100 },
      ],
    }))
    sqlite.exec(`CREATE TABLE chat_reader_embeddings (
      user_id TEXT NOT NULL, book_id TEXT NOT NULL, page INTEGER NOT NULL, chunk INTEGER NOT NULL,
      title TEXT NOT NULL, text TEXT NOT NULL, vector BLOB NOT NULL, norm REAL NOT NULL,
      indexed_at INTEGER NOT NULL, PRIMARY KEY (user_id, book_id, page, chunk)
    )`)
    sqlite.prepare('INSERT INTO chat_reader_embeddings (user_id, book_id, page, chunk, title, text, vector, norm, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(USER, 'book-1', 1, 0, 'one', 'one', new Uint8Array([1]), 1, 1)
    sqlite.prepare('INSERT INTO chat_reader_embeddings (user_id, book_id, page, chunk, title, text, vector, norm, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(USER, 'book-2', 1, 0, 'two', 'two', new Uint8Array([2]), 1, 1)

    await store.merge(snapshot({
      deleted: deletions({
        books: { ids: ['book-1'], updatedAt: 1000 },
        highlights: { ids: ['highlight-2'], updatedAt: 1000 },
        groups: { ids: ['group-delete'], updatedAt: 1000 },
      }),
    }))

    const rows = await store.shelf()
    expect(rows.books.map((row) => row.id)).toEqual(['book-2'])
    expect(rows.highlights).toEqual([])
    expect(rows.marks.map((row) => row.id)).toEqual(['mark-2'])
    expect(rows.progress.map((row) => row.book_id)).toEqual(['book-2'])
    expect(rows.stats.map((row) => row.book_id)).toEqual(['book-2'])
    expect(rows.notes.map((row) => row.book_id)).toEqual(['book-2'])
    expect(rows.groups.map((row) => [row.id, JSON.parse(row.book_ids)])).toEqual([['group-live', ['book-2']]])
    expect(sqlite.prepare('SELECT book_id FROM chat_reader_embeddings').all()).toEqual([{ book_id: 'book-2' }])

    const tombstoned = new Set(rows.syncVersions.filter((row) => row.deleted === 1).map((row) => `${row.entity}:${row.entity_id}`))
    for (const key of [
      'books:book-1', 'progress:book-1', 'highlights:highlight-1', 'marks:mark-1',
      'stats:book-1', 'notes:book-1', 'highlights:highlight-2', 'groups:group-delete',
    ]) expect(tombstoned.has(key), key).toBe(true)

    await store.merge(snapshot({ deleted: deletions({ highlights: { ids: ['highlight-1'], updatedAt: 999 } }) }))
    expect((await store.shelf()).syncVersions.find((row) => row.entity === 'highlights' && row.entity_id === 'highlight-1')?.updated_at)
      .toBe(1000)
  })

  it('preserves server blob facts for the same format and clears them when the format changes', async () => {
    await store.merge(snapshot({ books: [book({ wantsCover: true })] }))
    sqlite.prepare("UPDATE reader_books SET r2_key = ?, has_blob = 1, cover_key = ?, cover_size = 99 WHERE id = 'book-1'")
      .run(`reader/${USER}/book-1.epub`, `reader/${USER}/book-1.cover.png`)

    await store.merge(snapshot({ books: [book({ title: 'Renamed', updatedAt: 200, wantsCover: true })] }))
    expect(sqlite.prepare('SELECT r2_key, has_blob, cover_key, cover_size, size FROM reader_books WHERE id = ?').get('book-1'))
      .toEqual({ r2_key: `reader/${USER}/book-1.epub`, has_blob: 1, cover_key: `reader/${USER}/book-1.cover.png`, cover_size: 99, size: 4096 })

    const changed = await store.merge(snapshot({
      books: [book({ format: 'pdf', filename: 'book.pdf', size: 8192, updatedAt: 300, wantsCover: true })],
    }))
    expect(changed.missingBlobs).toEqual(['book-1'])
    expect(changed.missingCovers).toEqual(['book-1'])
    expect(sqlite.prepare('SELECT format, r2_key, has_blob, cover_key, cover_size, size FROM reader_books WHERE id = ?').get('book-1'))
      .toEqual({ format: 'pdf', r2_key: `reader/${USER}/book-1.pdf`, has_blob: 0, cover_key: null, cover_size: 0, size: 0 })
  })

  it('merges and deletes vocabulary by its own updatedAt instead of the server clock', async () => {
    await store.merge(snapshot({ vocabulary: 'newer', vocabularyUpdatedAt: 200 }))
    await store.merge(snapshot({ vocabulary: 'older', vocabularyUpdatedAt: 100 }))
    expect((await store.shelf()).meta).toEqual([{ key: 'vocabulary', value: 'newer', updated_at: 200 }])

    await store.merge(snapshot({ deleted: deletions({ vocabulary: { deleted: true, updatedAt: 300 } }) }))
    await store.merge(snapshot({ vocabulary: 'stale', vocabularyUpdatedAt: 250 }))
    const rows = await store.shelf()
    expect(rows.meta).toEqual([])
    expect(rows.syncVersions.find((row) => row.entity === 'vocabulary')).toMatchObject({ updated_at: 300, deleted: 1 })
  })

  it('reports missing objects only for incoming live books', async () => {
    await store.merge(snapshot({ books: [book()] }))
    expect((await store.merge(snapshot())).missingBlobs).toEqual([])
    expect((await store.merge(snapshot({ books: [book({ id: 'book-2', fallbackKey: `reader/${USER}/book-2.epub` })] }))).missingBlobs)
      .toEqual(['book-2'])
  })
})
