// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibrary } from '../src/client/features/reading/store/library'
import type { LibraryData } from '../src/client/features/reading/sync-merge'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
  pull: vi.fn(),
  push: vi.fn(),
}))

vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  get: mocks.get,
  set: mocks.set,
  del: mocks.del,
}))
vi.mock('../src/client/features/reading/store/cloud', () => ({
  IDLE_SYNC: { phase: 'idle', bookId: null, sent: 0, total: 0, message: null, at: 0 },
  pullLibrary: mocks.pull,
  pushLibrary: mocks.push,
  uploadBookBytes: vi.fn(),
  uploadCoverBytes: vi.fn(),
  downloadBookBytes: vi.fn(),
  deleteBookOnServer: vi.fn(async () => undefined),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function shelf(title: string): LibraryData {
  return {
    books: title ? [{ id: title, format: 'epub', title, author: '', language: '', publisher: '', filename: `${title}.epub`, size: 1, addedAt: 1, updatedAt: 1, unitCount: 1, coverPath: null, toc: [] }] : [],
    progress: {}, highlights: {}, marks: {}, stats: {},
    notes: { byBook: {}, updatedAt: {}, vocabulary: null, vocabularyUpdatedAt: null },
    groups: [],
    deleted: { books: [], progress: [], highlights: [], marks: [], stats: [], notes: [], groups: [], vocabulary: null },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  URL.createObjectURL = vi.fn(() => 'blob:cover')
  URL.revokeObjectURL = vi.fn()
  useLibrary.setState({ userId: null, status: 'idle', books: [], progress: {}, highlights: {}, marks: {}, stats: {}, notes: { byBook: {}, updatedAt: {}, vocabulary: null, vocabularyUpdatedAt: null }, groups: [], deleted: shelf('').deleted, covers: {}, sync: { phase: 'idle', bookId: null, sent: 0, total: 0, message: null, at: 0 } })
  mocks.pull.mockResolvedValue({ library: shelf(''), usage: null })
  mocks.push.mockResolvedValue({ at: Date.now(), missingBlobs: [], missingCovers: [], usage: null })
})

describe('reading account epochs', () => {
  it('does not let an older account load overwrite the newer account', async () => {
    const alice = deferred<LibraryData>()
    const bob = deferred<LibraryData>()
    mocks.get.mockImplementation((key: string) => key.includes('user:alice:reading:library') ? alice.promise : key.includes('user:bob:reading:library') ? bob.promise : Promise.resolve(undefined))
    const first = useLibrary.getState().bindUser('alice')
    const second = useLibrary.getState().bindUser('bob')
    bob.resolve(shelf('Bob book'))
    await second
    alice.resolve(shelf('Alice book'))
    await first
    expect(useLibrary.getState().userId).toBe('bob')
    expect(useLibrary.getState().books.map((one) => one.title)).toEqual(['Bob book'])
  })

  it('waits for the first pull before pushing an empty local shelf', async () => {
    const pull = deferred<{ library: LibraryData; usage: null }>()
    mocks.get.mockResolvedValue(undefined)
    mocks.pull.mockReturnValue(pull.promise)
    await useLibrary.getState().bindUser('alice')
    const push = useLibrary.getState().syncPush()
    await Promise.resolve()
    expect(mocks.push).not.toHaveBeenCalled()
    pull.resolve({ library: shelf('Cloud book'), usage: null })
    await push
    expect(mocks.push).toHaveBeenCalledTimes(1)
    expect(useLibrary.getState().books.map((one) => one.title)).toEqual(['Cloud book'])
  })
})
