// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { fixtureEpub } from './reading-fixtures'
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

/**
 * The id a book gets when the reader drops a file is minted from that file's name, and the name is the
 * reader's own. So the interesting inputs are the names people really use: Chinese, Japanese, a space,
 * brackets — and the two the shelf route will not carry in an R2 key, a path separator and a dot-dot.
 *
 * Whatever the minting rule does, its output has to be something the route accepts and the same twice,
 * because a second import of one file that yields a new id silently leaves the first id's highlights
 * behind.
 */
async function idFor(name: string, bytes: Uint8Array = fixtureEpub()): Promise<string> {
  useLibrary.setState({ books: [] })
  const file = new File([new Uint8Array(bytes)] as unknown as BlobPart[], name, { type: 'application/epub+zip' })
  const result = await useLibrary.getState().addFiles([file])
  // An import that quietly failed would leave nothing to assert on, so prove the drive took effect.
  expect(result.failed, JSON.stringify(result.failed)).toEqual([])
  expect(result.added).toHaveLength(1)
  return result.added[0]!.id
}

beforeEach(() => {
  kv.data.clear()
  URL.createObjectURL = vi.fn(() => 'blob:reading/cover')
  URL.revokeObjectURL = vi.fn()
  useLibrary.setState({ userId: '', books: [], progress: {}, highlights: {}, marks: {}, stats: {}, notes: { byBook: {}, vocabulary: null }, groups: [] })
})

describe('the id a dropped file gets', () => {
  it('carries a Chinese file name whole', async () => {
    expect(await idFor('凡人修仙传.epub')).toMatch(/^file:凡人修仙传\.epub:\d+$/)
  })

  it('keeps the punctuation a real title has', async () => {
    const id = await idFor('三体 (全集).epub')
    expect(id.startsWith('file:三体 (全集).epub:')).toBe(true)
    expect(id.trim()).toBe(id)
  })

  it('takes the separator out, because the id becomes an R2 key', async () => {
    // A backslash is a legal file name on macOS and Linux, and two of them is the case a replace that
    // forgot its / flag would let through.
    const id = await idFor('背\\影\\終.epub')
    expect(id).not.toContain('\\')
    expect(id).not.toContain('/')
    expect(id.startsWith('file:背_影_終.epub:')).toBe(true)
  })

  it('takes a dot-dot out for the same reason', async () => {
    const id = await idFor('a..b.epub')
    expect(id).not.toContain('..')
    expect(id.startsWith('file:a.b.epub:')).toBe(true)
  })

  it('hashes a name longer than the shelf accepts instead of cutting it', async () => {
    const name = `${'漫'.repeat(LIMITS.readerIdMaxChars)}.epub`
    const id = await idFor(name)
    // A cut would still be a legal id, so length alone is not the check: it must not be a prefix of the name.
    expect(id.length).toBeLessThanOrEqual(LIMITS.readerIdMaxChars)
    expect(id).not.toContain(`${'漫'.repeat(20)}`)
    expect(id.startsWith('file:n')).toBe(true)
  })

  it('gives the same file the same id, so re-importing does not orphan its marks', async () => {
    const bytes = fixtureEpub()
    const first = await idFor('凡人修仙传.epub', bytes)
    expect(await idFor('凡人修仙传.epub', bytes)).toBe(first)
    const long = `${'漫'.repeat(LIMITS.readerIdMaxChars)}.epub`
    const hashed = await idFor(long, bytes)
    expect(await idFor(long, bytes)).toBe(hashed)
  })

  it('refuses the second copy of one file as a duplicate rather than a new book', async () => {
    const bytes = fixtureEpub()
    useLibrary.setState({ books: [] })
    const file = () => new File([new Uint8Array(bytes)] as unknown as BlobPart[], '凡人修仙传.epub', { type: 'application/epub+zip' })
    const twice = await useLibrary.getState().addFiles([file(), file()])
    expect(twice.added).toHaveLength(1)
    expect(twice.failed.map((one) => one.reason)).toEqual(['duplicate'])
  })
})
