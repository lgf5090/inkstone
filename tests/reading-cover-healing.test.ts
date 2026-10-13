// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibrary } from '../src/client/features/reading/store/library'

const kv = vi.hoisted(() => ({ data: new Map<string, unknown>() }))

vi.mock('idb-keyval', () => {
  const asMap = (store: unknown) => (store as { __map?: Map<string, unknown> } | undefined)?.__map ?? kv.data
  return {
    createStore: (name: string) => ({ name, __map: kv.data }),
    get: async (key: string, store: unknown) => asMap(store).get(key),
    set: async (key: string, value: unknown, store: unknown) => { asMap(store).set(key, value) },
    setMany: async (entries: [string, unknown][], store: unknown) => {
      for (const [key, value] of entries) asMap(store).set(key, value)
    },
    getMany: async (keys: string[], store: unknown) => keys.map((key) => asMap(store).get(key)),
    del: async (key: string, store: unknown) => { asMap(store).delete(key) },
    delMany: async (keys: string[], store: unknown) => { for (const key of keys) asMap(store).delete(key) },
    clear: async (store: unknown) => { asMap(store).clear() },
    update: async (key: string, updater: (value: unknown) => unknown, store: unknown) => {
      asMap(store).set(key, updater(asMap(store).get(key)))
    },
    entries: async (store: unknown) => [...asMap(store).entries()],
  }
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const MARKUP = new TextEncoder().encode('<html xmlns="http://www.w3.org/1999/xhtml"><body>x</body></html>')
const coverKey = (id: string) => `user:u1:reading:cover:${id}`

/**
 * A device that already stored a cover before the importer checked what it was holding has the broken
 * thing in IndexedDB right now — including on the account that reported this. The label says image/png,
 * so only the bytes can say otherwise, and the bad entry has to go rather than be painted again: it is a
 * cache of something the book file still holds, and leaving it would also offer markup up as a cover to
 * store on the account.
 */
async function seed(id: string, bytes: Uint8Array, type: string) {
  kv.data.set(`user:u1:reading:library`, {
    books: [{ id, format: 'epub', title: '一本书', author: '', language: '', publisher: '', filename: `${id}.epub`, size: 10, addedAt: 1, unitCount: 1, coverPath: 'cover.png', toc: [] }],
    progress: {}, highlights: {}, marks: {}, stats: {}, notes: { byBook: {} },
  })
  kv.data.set(coverKey(id), new Blob([bytes as unknown as BlobPart], { type }))
  await useLibrary.getState().bindUser('u1')
  return useLibrary.getState()
}

beforeEach(() => {
  kv.data.clear()
  useLibrary.setState({ userId: null, status: 'idle', books: [], covers: {} })
  URL.createObjectURL = vi.fn(() => 'blob:cover')
  URL.revokeObjectURL = vi.fn()
})

describe('a cover already on the device', () => {
  it('paints one that really is a picture', async () => {
    const state = await seed('good', PNG, 'image/png')
    expect(state.covers.good).toBe('blob:cover')
    expect(kv.data.has(coverKey('good'))).toBe(true)
  })

  it('drops one whose bytes are a page, whatever it is labelled', async () => {
    const state = await seed('bad', MARKUP, 'image/png')
    expect(state.covers.bad).toBeUndefined()
    expect(kv.data.has(coverKey('bad'))).toBe(false)
    // The book is still on the shelf — only the cover went.
    expect(state.books.map((one) => one.id)).toEqual(['bad'])
  })
})
