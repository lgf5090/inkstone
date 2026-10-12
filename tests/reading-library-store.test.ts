// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { useLibrary } from '../src/client/features/reading/store/library'

/**
 * The library store is exercised through its merge, not its persistence: the point of the check is what
 * a file from outside can talk the app into believing, and IndexedDB is not the interesting half.
 */
function exportOf(books: unknown[]): string {
  return JSON.stringify({ version: 1, books, progress: {}, highlights: {}, marks: {}, stats: {}, notes: { byBook: {} } })
}

beforeEach(() => {
  useLibrary.setState({ books: [], progress: {}, highlights: {}, marks: {}, stats: {}, notes: { byBook: {}, vocabulary: null } })
})

describe('importing a library file', () => {
  it('refuses something that is not an export', async () => {
    await expect(useLibrary.getState().importLibrary('{"books":"nope"}')).rejects.toThrow(/not a reading-library export/)
  })

  it('keeps a well-formed record', async () => {
    const result = await useLibrary.getState().importLibrary(exportOf([
      { id: 'b1', format: 'epub', title: '一本', author: '', language: '', publisher: '', filename: 'a.epub', size: 1, addedAt: 2, unitCount: 3, coverPath: null, toc: [] },
    ]))
    expect(result.books).toBe(1)
    expect(useLibrary.getState().books.map((one) => one.id)).toEqual(['b1'])
  })

  it('drops a record whose format the reader cannot open', async () => {
    const result = await useLibrary.getState().importLibrary(exportOf([
      { id: 'b2', format: 'exe', title: 'x', filename: 'x', size: 1, addedAt: 1, unitCount: 1, toc: [] },
      { id: 'b3', format: 'pdf', title: 'y', filename: 'y', size: 1, addedAt: 1, unitCount: 1, toc: [] },
    ]))
    expect(result.books).toBe(1)
    expect(result.rejected).toBe(1)
    expect(useLibrary.getState().books.map((one) => one.id)).toEqual(['b3'])
  })

  it('drops a record that would decide which engine runs from a bad field', async () => {
    await useLibrary.getState().importLibrary(exportOf([
      { id: '', format: 'epub', title: 'no id', filename: 'a', size: 1, addedAt: 1, unitCount: 1, toc: [] },
      { id: 'b4', format: 'epub', title: 'no count', filename: 'a', size: 1, addedAt: 1, toc: [] },
      { id: 'b5', format: 'epub', title: 'ok', filename: 'a', size: 1, addedAt: 1, unitCount: 1, toc: 'not-a-list' },
    ]))
    expect(useLibrary.getState().books.map((one) => one.id)).toEqual(['b5'])
    expect(useLibrary.getState().books[0]!.toc).toEqual([])
  })

  it('merges highlights by id instead of doubling a re-imported list', async () => {
    const mark = { id: 'h1', bookId: 'b1', chapter: 0, start: 1, end: 2, color: 'yellow', quote: 'q', prefix: '', suffix: '', comment: '', createdAt: 1, updatedAt: 1 }
    await useLibrary.getState().importLibrary(exportOf([{ id: 'b1', format: 'epub', title: 'x', filename: 'a', size: 1, addedAt: 1, unitCount: 1, toc: [] }]))
    useLibrary.setState({ highlights: { b1: [mark] } })
    await useLibrary.getState().importLibrary(JSON.stringify({
      books: [{ id: 'b1', format: 'epub', title: 'x', filename: 'a', size: 1, addedAt: 1, unitCount: 1, toc: [] }],
      highlights: { b1: [mark, { ...mark, id: 'h2' }] },
      progress: {}, marks: {}, stats: {},
    }))
    expect(useLibrary.getState().highlights.b1?.map((one) => one.id)).toEqual(['h1', 'h2'])
  })
})
