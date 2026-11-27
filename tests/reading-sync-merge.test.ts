import { describe, expect, it } from 'vitest'
import { emptyDeletions, mergeRemoteLibrary, tombstonePayload, type LibraryData } from '../src/client/features/reading/sync-merge'
import type { BookRecord, Highlight } from '../src/client/features/reading/types'

function book(id: string, updatedAt: number): BookRecord {
  return { id, format: 'epub', title: id, author: '', language: '', publisher: '', filename: `${id}.epub`, size: 1, addedAt: 1, updatedAt, unitCount: 1, coverPath: null, toc: [] }
}

function mark(id: string, updatedAt: number): Highlight {
  return { id, bookId: 'b1', chapter: 0, start: 0, end: 1, color: 'yellow', quote: id, prefix: '', suffix: '', comment: '', createdAt: updatedAt, updatedAt }
}

function data(over: Partial<LibraryData> = {}): LibraryData {
  return {
    books: [book('b1', 10)], progress: {}, highlights: {}, marks: {}, stats: {},
    notes: { byBook: {}, updatedAt: {}, vocabulary: null, vocabularyUpdatedAt: null },
    groups: [], deleted: emptyDeletions(), ...over,
  }
}

describe('mergeRemoteLibrary', () => {
  it('keeps both devices highlights and rejects an older progress snapshot', () => {
    const local = data({
      progress: { b1: { bookId: 'b1', position: { kind: 'epub', chapter: 0, offset: 20 }, fraction: 0.4, updatedAt: 40, finishedAt: null } },
      highlights: { b1: [mark('mine', 20)] },
    })
    const remote = data({
      progress: { b1: { bookId: 'b1', position: { kind: 'epub', chapter: 0, offset: 5 }, fraction: 0.1, updatedAt: 30, finishedAt: null } },
      highlights: { b1: [mark('theirs', 25)] },
    })
    const merged = mergeRemoteLibrary(local, remote)
    expect(merged.highlights.b1?.map((one) => one.id).sort()).toEqual(['mine', 'theirs'])
    expect(merged.progress.b1?.position).toEqual({ kind: 'epub', chapter: 0, offset: 20 })
  })

  it('applies a newer tombstone but keeps a newer local edit', () => {
    const local = data({ highlights: { b1: [mark('keep', 50), mark('remove', 20)] } })
    const remote = data()
    remote.deleted.highlights = [
      { id: 'remove', bookId: 'b1', updatedAt: 40 },
      { id: 'keep', bookId: 'b1', updatedAt: 30 },
    ]
    const merged = mergeRemoteLibrary(local, remote)
    expect(merged.highlights.b1?.map((one) => one.id)).toEqual(['keep'])
    expect(merged.deleted.highlights.map((one) => one.id)).toEqual(['remove'])
  })

  it('cascades a book tombstone into children and groups', () => {
    const local = data({
      highlights: { b1: [mark('h1', 20)] },
      marks: { b1: [{ id: 'm1', bookId: 'b1', label: 'mark', position: { kind: 'fixed', page: 1 }, createdAt: 20, updatedAt: 20 }] },
      progress: { b1: { bookId: 'b1', position: null, fraction: 0.2, updatedAt: 20, finishedAt: null } },
      groups: [{ id: 'g1', name: 'Reading', bookIds: ['b1'], createdAt: 1, updatedAt: 1 }],
    })
    const remote = data({ books: [] })
    remote.deleted.books = [{ id: 'b1', bookId: '', updatedAt: 60 }]
    const merged = mergeRemoteLibrary(local, remote)
    expect(merged.books).toEqual([])
    expect(merged.highlights).toEqual({})
    expect(merged.marks).toEqual({})
    expect(merged.progress).toEqual({})
    expect(merged.groups[0]?.bookIds).toEqual([])
    expect(merged.deleted.highlights[0]).toMatchObject({ id: 'h1', updatedAt: 60 })
  })

  it('merges vocabulary by version and deletion', () => {
    const local = data({ notes: { byBook: {}, updatedAt: {}, vocabulary: 'old', vocabularyUpdatedAt: 10 } })
    const remote = data({ notes: { byBook: {}, updatedAt: {}, vocabulary: 'new', vocabularyUpdatedAt: 20 } })
    expect(mergeRemoteLibrary(local, remote).notes.vocabulary).toBe('new')
    remote.deleted.vocabulary = { deleted: true, updatedAt: 30 }
    const merged = mergeRemoteLibrary(local, remote)
    expect(merged.notes.vocabulary).toBeNull()
    expect(merged.deleted.vocabulary?.updatedAt).toBe(30)
  })

  it('converts local tombstones to the server entity timestamp contract', () => {
    const deleted = emptyDeletions()
    deleted.highlights = [{ id: 'h1', bookId: 'b1', updatedAt: 10 }, { id: 'h2', bookId: 'b1', updatedAt: 20 }]
    expect(tombstonePayload(deleted).highlights).toEqual({ ids: ['h1', 'h2'], updatedAt: 20 })
  })
})
