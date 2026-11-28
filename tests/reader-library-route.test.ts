// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { LIMITS } from '../src/shared/constants'
import { readerUsage } from '../src/worker/db/quota'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { readerLibraryRoutes } from '../src/worker/routes/reader-library'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const BOOK_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])

const mocks = vi.hoisted(() => ({ userId: '' }))

class FixedLengthStreamDouble extends TransformStream<Uint8Array, Uint8Array> {
  constructor(_expected: number) {
    super()
  }
}
vi.stubGlobal('FixedLengthStream', FixedLengthStreamDouble)

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

interface FakeObject { body: ReadableStream; size: number; etag: string; httpMetadata?: { contentType?: string }; upload: (value: unknown) => Promise<void> }

const buckets = new Map<string, Uint8Array>()
// Real R2 keeps the content type a put declared and hands it back on get, so the double has to or a
// route that reads it looks like a route that does not.
const types = new Map<string, string>()
const r2 = {
  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
    const bytes = value instanceof ReadableStream
      ? new Uint8Array(await new Response(value).arrayBuffer())
      : value instanceof ArrayBuffer ? new Uint8Array(value) : new TextEncoder().encode(String(value))
    buckets.set(key, bytes)
    if (options?.httpMetadata?.contentType) types.set(key, options.httpMetadata.contentType)
    return { key }
  },
  async get(key: string, options?: { range?: { offset: number; length: number } }): Promise<FakeObject | null> {
    const stored = buckets.get(key)
    if (!stored) return null
    const bytes = options?.range ? stored.subarray(options.range.offset, options.range.offset + options.range.length) : stored
    return {
      size: bytes.byteLength,
      etag: '"reader-object"',
      httpMetadata: types.has(key) ? { contentType: types.get(key) } : undefined,
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }),
      upload: async () => {},
    }
  },
  async delete(key: string) {
    buckets.delete(key)
    types.delete(key)
  },
}

let sqlite: DatabaseSync
let db: D1Database

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/reader', readerLibraryRoutes)

function bookBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set(BOOK_BYTES.subarray(0, Math.min(size, BOOK_BYTES.length)))
  return bytes
}

function book(overrides: Record<string, unknown> = {}) {
  return {
    id: 'book-1', format: 'epub', title: '道德经', author: '老子', language: 'zh', publisher: '',
    filename: 'dao.epub', size: 4096, addedAt: 1000, updatedAt: 1000, unitCount: 3, hasCover: false,
    toc: [{ label: '第一章', position: { kind: 'epub', chapter: 0, offset: 0 } }],
    ...overrides,
  }
}

function library(overrides: Record<string, unknown> = {}) {
  return {
    books: [book()],
    progress: { 'book-1': { bookId: 'book-1', position: { kind: 'epub', chapter: 0, offset: 120 }, fraction: 0.25, updatedAt: 2000, finishedAt: null } },
    highlights: { 'book-1': [{ id: 'h1', bookId: 'book-1', chapter: 0, start: 10, end: 24, quote: '道可道', prefix: '', suffix: '', color: 'yellow', comment: '要重读', createdAt: 3, updatedAt: 3 }] },
    marks: { 'book-1': [{ id: 'm1', bookId: 'book-1', label: '第 2 章处', position: { kind: 'epub', chapter: 1, offset: 0 }, createdAt: 4, updatedAt: 4 }] },
    stats: { 'book-1': { bookId: 'book-1', seconds: 900, days: { '2026-10-12': 600, '2026-10-13': 300, junk: 5 }, updatedAt: 5 } },
    notes: { byBook: { 'book-1': 'note-9' }, updatedAt: { 'book-1': 6 }, vocabulary: 'note-vocab', vocabularyUpdatedAt: 7 },
    deleted: {
      books: { ids: [], updatedAt: 0 }, progress: { ids: [], updatedAt: 0 },
      highlights: { ids: [], updatedAt: 0 }, marks: { ids: [], updatedAt: 0 },
      stats: { ids: [], updatedAt: 0 }, notes: { ids: [], updatedAt: 0 },
      groups: { ids: [], updatedAt: 0 }, vocabulary: { deleted: false, updatedAt: 0 },
    },
    ...overrides,
  }
}

async function send(method: string, path: string, body?: unknown, raw?: Uint8Array) {
  const init: RequestInit = { method, headers: raw ? { 'Content-Type': 'application/octet-stream' } : undefined }
  if (raw) init.body = raw as unknown as BodyInit
  else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return app.request(`/api/reader${path}`, init, env())
}

function env() {
  return { DB: db, FILES: r2 } as unknown as AppBindings['Bindings']
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  buckets.clear()
  mocks.userId = ALICE
})

describe('the shelf round trip', () => {
  it('sends back what the device stored', async () => {
    expect((await send('PUT', '/library', { library: library() })).status).toBe(200)
    const answer = await (await send('GET', '/library')).json() as { ok: boolean; library: any }
    expect(answer.ok).toBe(true)
    expect(answer.library.books.map((one: any) => one.title)).toEqual(['道德经'])
    expect(answer.library.books[0].toc).toHaveLength(1)
    expect(answer.library.books[0].updatedAt).toBe(1000)
    expect(answer.library.progress['book-1'].position).toEqual({ kind: 'epub', chapter: 0, offset: 120 })
    expect(answer.library.highlights['book-1'][0].comment).toBe('要重读')
    expect(answer.library.marks['book-1'][0].label).toBe('第 2 章处')
    expect(answer.library.marks['book-1'][0].updatedAt).toBe(4)
    expect(answer.library.notes).toEqual({
      byBook: { 'book-1': 'note-9' }, updatedAt: { 'book-1': 6 },
      vocabulary: 'note-vocab', vocabularyUpdatedAt: 7,
    })
    expect(answer.library.deleted.books).toEqual([])
    // A day key that is not a date is dropped rather than stored as noise.
    expect(answer.library.stats['book-1'].days).toEqual({ '2026-10-12': 600, '2026-10-13': 300 })
    expect(answer.library.stats['book-1'].updatedAt).toBe(5)
  })

  it('syncs reader settings with their version', async () => {
    await send('PUT', '/library', { library: library({ settings: { fontSize: 24 }, settingsUpdatedAt: 100 }) })
    const answer = await (await send('GET', '/library')).json() as { library: any }
    expect(answer.library.settings).toEqual({ fontSize: 24 })
    expect(answer.library.settingsUpdatedAt).toBe(100)
    await send('PUT', '/library', { library: library({ settings: { fontSize: 30 }, settingsUpdatedAt: 90 }) })
    const stale = await (await send('GET', '/library')).json() as { library: any }
    expect(stale.library.settings).toEqual({ fontSize: 24 })
  })

  it('round-trips book metadata and content hash', async () => {
    const hash = 'a'.repeat(64)
    await send('PUT', '/library', { library: library({ books: [book({ contentHash: hash, metadata: { series: 'Series', rating: 4.5, tags: ['fantasy'] } })] }) })
    const answer = await (await send('GET', '/library')).json() as { library: any }
    expect(answer.library.books[0]).toMatchObject({ contentHash: hash, metadata: { series: 'Series', rating: 4.5, tags: ['fantasy'] } })
  })

  it('keeps a second account out of the first one\'s shelf', async () => {
    await send('PUT', '/library', { library: library() })
    mocks.userId = BOB
    const empty = await (await send('GET', '/library')).json() as { library: any }
    expect(empty.library.books).toEqual([])
    expect(empty.library.highlights).toEqual({})
    // Bob cannot name Alice's book and have its bytes arrive.
    const stolen = await send('GET', '/books/book-1/blob')
    expect(stolen.status).toBe(404)
  })

  it('lets two accounts shelve the same file without either losing it', async () => {
    // A book id is minted by the reader from the file's name and size, so the same download lands on
    // two shelves as the same string. Sharing one row between them would let Bob's push delete Alice's.
    expect((await send('PUT', '/library', { library: library() })).status).toBe(200)
    mocks.userId = BOB
    expect((await send('PUT', '/library', { library: library() })).status).toBe(200)
    const bob = await (await send('GET', '/library')).json() as { library: any }
    expect(bob.library.books.map((one: any) => one.title)).toEqual(['道德经'])
    mocks.userId = ALICE
    const alice = await (await send('GET', '/library')).json() as { library: any }
    expect(alice.library.books.map((one: any) => one.title)).toEqual(['道德经'])
    expect(alice.library.highlights['book-1']).toHaveLength(1)
    expect(alice.library.progress['book-1'].position).toEqual({ kind: 'epub', chapter: 0, offset: 120 })
  })

  it('keeps omitted records and deletes only explicit tombstones', async () => {
    await send('PUT', '/library', { library: library() })
    await send('PUT', '/library', { library: library({ books: [], highlights: { 'book-1': [] } }) })
    const omitted = await (await send('GET', '/library')).json() as { library: any }
    expect(omitted.library.books).toHaveLength(1)
    expect(omitted.library.highlights['book-1']).toHaveLength(1)

    const deleted = library().deleted as Record<string, unknown>
    await send('PUT', '/library', {
      library: library({
        books: [], highlights: { 'book-1': [] },
        deleted: {
          ...deleted,
          books: { ids: ['book-1'], updatedAt: 3000 },
          highlights: { ids: ['h1'], updatedAt: 3000 },
        },
      }),
    })
    const answer = await (await send('GET', '/library')).json() as { library: any }
    expect(answer.library.books).toEqual([])
    expect(answer.library.highlights).toEqual({})
    expect(answer.library.deleted.books).toEqual([{ id: 'book-1', bookId: '', updatedAt: 3000 }])
    expect(answer.library.deleted.highlights).toEqual([{ id: 'h1', bookId: 'book-1', updatedAt: 3000 }])
  })
})

describe('what a client is not allowed to choose', () => {
  it('refuses a format the reader cannot open', async () => {
    const response = await send('PUT', '/library', { library: library({ books: [book({ format: 'exe' })] }) })
    expect(response.status).toBe(400)
  })

  it('refuses an id that could climb out of the account folder', async () => {
    const tooLong = 'a'.repeat(LIMITS.readerIdMaxChars + 1)
    const ids = ['../../etc/passwd', tooLong, '', 'reader/../bob/x', '~home', 'a/b', 'a\\b', 'a"b', 'a\u0001b', ' lead']
    // A dot-dot with no separator around it cannot climb anything on its own, and is refused anyway:
    // the id is a path component, and the guard should not depend on nobody ever adding a join.
    for (const id of [...ids, '..', 'a..b', 'file:x..y.epub:1']) {
      const response = await send('PUT', '/library', { library: library({ books: [book({ id })] }) })
      expect(response.status, JSON.stringify(id)).toBe(400)
    }
  })

  it('accepts the ids the shelf really mints, colons and all', async () => {
    const id = 'file:dao-de-jing.epub:13993'
    const response = await send('PUT', '/library', { library: library({
      books: [book({ id })], progress: {}, highlights: {}, marks: {}, stats: {}, notes: { byBook: {} },
    }) })
    expect(response.status).toBe(200)
    await send('PUT', `/books/${encodeURIComponent(id)}/blob`, undefined, BOOK_BYTES)
    const got = await send('GET', `/books/${encodeURIComponent(id)}/blob`)
    expect(got.status).toBe(200)
    expect(buckets.has(`reader/${ALICE}/${id}.epub`)).toBe(true)
  })

  /**
   * A book named in Chinese is the common case for this shelf and was a 400 until the id check was an
   * ASCII allowlist, so the whole path gets walked here: the row, its bytes, its cover, its download
   * header and its deletion. The header is the part that would have failed next — a field value is a
   * ByteString, so the name goes out percent-encoded.
   */
  it('walks a book whose name is not ASCII from the row to the download', async () => {
    const id = 'file:凡人修仙传.epub:8500047'
    const name = '凡人修仙传.epub'
    const put = await send('PUT', '/library', { library: library({
      books: [book({ id, filename: name })], progress: {}, highlights: {}, marks: {}, stats: {}, notes: { byBook: {} },
    }) })
    expect(put.status).toBe(200)
    const read = await (await send('GET', '/library')).json() as { library: any }
    expect(read.library.books.map((one: any) => one.id)).toEqual([id])
    expect(read.library.books[0].filename).toBe(name)

    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 7])
    expect((await send('PUT', `/books/${encodeURIComponent(id)}/blob`, undefined, bytes)).status).toBe(200)
    expect(buckets.has(`reader/${ALICE}/${id}.epub`)).toBe(true)

    const got = await send('GET', `/books/${encodeURIComponent(id)}/blob`)
    expect(got.status).toBe(200)
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes)
    const disposition = got.headers.get('content-disposition') ?? ''
    // The name the reader gave the file, not the id it was filed under.
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? ''
    expect(decodeURIComponent(encoded)).toBe(name)
    // A header value is a ByteString, so the plain half has to hold no character above 0x7e and no quote
    // that would end the quoted-string early.
    const plain = disposition.match(/filename="([^"]*)"/)?.[1] ?? ''
    expect(plain).toBeTruthy()
    expect(plain).toMatch(/^[\x20-\x7e]+$/)
    expect(plain.endsWith('.epub')).toBe(true)

    const cover = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])
    const coverPut = await app.request(`/api/reader/books/${encodeURIComponent(id)}/cover`, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: cover as unknown as BodyInit,
    }, env())
    expect(coverPut.status).toBe(200)
    expect((await send('GET', `/books/${encodeURIComponent(id)}/cover`)).status).toBe(200)

    expect((await send('DELETE', `/books/${encodeURIComponent(id)}`)).status).toBe(200)
    expect(buckets.has(`reader/${ALICE}/${id}.epub`)).toBe(false)
  })

  it('builds the R2 key itself, from the row it already trusts', async () => {
    await send('PUT', '/library', { library: library() })
    const row = sqlite.prepare('SELECT r2_key FROM reader_books WHERE id = ?').get('book-1') as { r2_key: string }
    expect(row.r2_key).toBe('reader/user-alice/book-1.epub')
    // A client that sends its own key changes nothing: the row keeps the server's.
    await send('PUT', '/library', { library: library({ books: [book({ r2Key: 'reader/user-bob/other.epub' })] }) })
    expect((sqlite.prepare('SELECT r2_key FROM reader_books WHERE id = ?').get('book-1') as { r2_key: string }).r2_key)
      .toBe('reader/user-alice/book-1.epub')
  })
})

describe('versioned merge validation', () => {
  it('rejects duplicate record ids instead of silently picking one', async () => {
    expect((await send('PUT', '/library', {
      library: library({ books: [book(), book()] }),
    })).status).toBe(400)
    expect((await send('PUT', '/library', {
      library: library({
        books: [book(), book({ id: 'book-2' })],
        highlights: {
          'book-1': [{ id: 'same', bookId: 'book-1', chapter: 0, start: 0, end: 1, quote: 'a', color: 'yellow', createdAt: 1, updatedAt: 2 }],
          'book-2': [{ id: 'same', bookId: 'book-2', chapter: 0, start: 0, end: 1, quote: 'b', color: 'yellow', createdAt: 1, updatedAt: 2 }],
        },
      }),
    })).status).toBe(400)
  })

  it('rejects invalid colors, positions and book references', async () => {
    expect((await send('PUT', '/library', {
      library: library({ highlights: { 'book-1': [{ id: 'h1', chapter: 0, start: 0, end: 1, quote: 'x', color: 'cyan', createdAt: 1, updatedAt: 2 }] } }),
    })).status).toBe(400)
    expect((await send('PUT', '/library', {
      library: library({ progress: { 'book-1': { position: { kind: 'epub', chapter: -1, offset: 0 }, fraction: 0, updatedAt: 2 } } }),
    })).status).toBe(400)
    expect((await send('PUT', '/library', {
      library: library({ marks: { 'book-1': [{ id: 'm1', label: 'x', position: null, createdAt: 1, updatedAt: 2 }] } }),
    })).status).toBe(400)
    expect((await send('PUT', '/library', {
      library: library({ progress: { unknown: { position: null, fraction: 0, updatedAt: 2 } } }),
    })).status).toBe(400)
  })

  it('strictly validates deletion entities, ids and timestamps', async () => {
    const deleted = library().deleted as Record<string, unknown>
    for (const value of [
      { ...deleted, unknown: { ids: [], updatedAt: 1 } },
      { ...deleted, books: { ids: ['book-1', 'book-1'], updatedAt: 1 } },
      { ...deleted, books: { ids: ['book-1'] } },
      { ...deleted, books: { ids: ['../escape'], updatedAt: 1 } },
    ]) {
      expect((await send('PUT', '/library', { library: library({ deleted: value }) })).status).toBe(400)
    }
  })

  it('does not let a group point at a tombstoned book', async () => {
    await send('PUT', '/library', { library: library() })
    const deleted = library().deleted as Record<string, unknown>
    await send('PUT', '/library', {
      library: library({ books: [], deleted: { ...deleted, books: { ids: ['book-1'], updatedAt: 3000 } } }),
    })
    expect((await send('PUT', '/library', {
      library: library({ books: [], groups: [shelfGroup({ updatedAt: 4000 })] }),
    })).status).toBe(200)
    const listed = await (await send('GET', '/library')).json() as { library: any }
    expect(listed.library.groups[0].bookIds).toEqual([])
  })
})

describe('the book bytes', () => {
  it('puts and gets a file under the account prefix', async () => {
    await send('PUT', '/library', { library: library() })
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
    const put = await send('PUT', '/books/book-1/blob', undefined, bytes)
    expect(put.status).toBe(200)
    expect(buckets.has('reader/user-alice/book-1.epub')).toBe(true)
    const got = await send('GET', '/books/book-1/blob')
    expect(got.headers.get('content-length')).toBe(String(bytes.byteLength))
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes)
  })

  it('supports byte ranges and conditional downloads', async () => {
    await send('PUT', '/library', { library: library() })
    await send('PUT', '/books/book-1/blob', undefined, BOOK_BYTES)
    const ranged = await app.request('/api/reader/books/book-1/blob', { headers: { Range: 'bytes=1-3' } }, env())
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 1-3/7')
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(BOOK_BYTES.subarray(1, 4))
    const etag = ranged.headers.get('etag')!
    const cached = await app.request('/api/reader/books/book-1/blob', { headers: { 'If-None-Match': etag } }, env())
    expect(cached.status).toBe(304)
    const invalid = await app.request('/api/reader/books/book-1/blob', { headers: { Range: 'bytes=99-100' } }, env())
    expect(invalid.status).toBe(416)
  })

  it('streams a declared upload into R2 without buffering it in the route', async () => {
    await send('PUT', '/library', { library: library() })
    const response = await app.request('/api/reader/books/book-1/blob', {
      method: 'PUT',
      headers: { 'Content-Length': String(BOOK_BYTES.length) },
      body: BOOK_BYTES,
    }, env())
    expect(response.status).toBe(200)
    const stored = await r2.get('reader/user-alice/book-1.epub')
    expect(stored).not.toBeNull()
    expect(new Uint8Array(await new Response(stored!.body).arrayBuffer())).toEqual(BOOK_BYTES)
  })

  it('rejects a streamed upload whose bytes do not match its declared size', async () => {
    await send('PUT', '/library', { library: library() })
    const response = await app.request('/api/reader/books/book-1/blob', {
      method: 'PUT',
      headers: { 'Content-Length': String(BOOK_BYTES.length + 1) },
      body: BOOK_BYTES,
    }, env())
    expect(response.status).toBe(400)
    expect(buckets.size).toBe(0)
  })

  it('rejects a streamed upload whose bytes do not match its format', async () => {
    await send('PUT', '/library', { library: library() })
    const bytes = new TextEncoder().encode('not a book')
    const response = await app.request('/api/reader/books/book-1/blob', {
      method: 'PUT', headers: { 'Content-Length': String(bytes.length) }, body: bytes,
    }, env())
    expect(response.status).toBe(400)
    expect(buckets.size).toBe(0)
  })

  it('refuses an empty file and one that is too large to hold', async () => {
    await send('PUT', '/library', { library: library() })
    expect((await send('PUT', '/books/book-1/blob', undefined, new Uint8Array(0))).status).toBe(400)
    const oversized = await app.request('/api/reader/books/book-1/blob', {
      method: 'PUT',
      headers: { 'content-length': String(60 * 1024 * 1024) },
      body: new Uint8Array(8),
    }, env())
    expect(oversized.status).toBe(400)
  })

  it('refuses bytes that do not match the row format', async () => {
    await send('PUT', '/library', { library: library() })
    const response = await send('PUT', '/books/book-1/blob', undefined, new TextEncoder().encode('<html>not a book</html>'))
    expect(response.status).toBe(400)
    expect(buckets.size).toBe(0)
  })

  it('names the files the device still has to send, and stops once they arrive', async () => {
    const first = await (await send('PUT', '/library', { library: library() })).json() as { missingBlobs: string[] }
    expect(first.missingBlobs).toEqual(['book-1'])
    await send('PUT', '/books/book-1/blob', undefined, BOOK_BYTES)
    const again = await (await send('PUT', '/library', { library: library() })).json() as { missingBlobs: string[] }
    expect(again.missingBlobs).toEqual([])
  })

  it('takes the file and the reading with it when a book is removed', async () => {
    await send('PUT', '/library', { library: library() })
    await send('PUT', '/books/book-1/blob', undefined, BOOK_BYTES)
    expect((await send('DELETE', '/books/book-1')).status).toBe(200)
    expect(buckets.size).toBe(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM reader_books').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM reader_highlights').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM reader_stats').get()).toEqual({ n: 0 })
    const listed = await (await send('GET', '/library')).json() as { library: any }
    expect(listed.library.deleted.books).toEqual([{ id: 'book-1', bookId: '', updatedAt: expect.any(Number) }])
    expect(listed.library.deleted.highlights).toEqual([{ id: 'h1', bookId: 'book-1', updatedAt: expect.any(Number) }])
  })
})

describe('the account budget', () => {
  it('reports what the shelf is using', async () => {
    await send('PUT', '/library', { library: library() })
    await send('PUT', '/books/book-1/blob', undefined, bookBytes(1000))
    const answer = await (await send('GET', '/library')).json() as { usage: any }
    expect(answer.usage).toMatchObject({ books: 1, bytes: 1000, covers: 0 })
    expect(answer.usage.quotaBytes).toBeGreaterThan(0)
  })

  const NEAR_FULL = 2 * 1024 * 1024 * 1024 - 8

  it('refuses a book that would take the account past its budget', async () => {
    await send('PUT', '/library', { library: library({ books: [book(), book({ id: 'book-2' })] }) })
    // book-2 stands at nearly the whole budget, and book-1 is recorded as holding nothing, so any file
    // the reader sends now is what tips the account over.
    sqlite.prepare('UPDATE reader_books SET size = ? WHERE id = ?').run(NEAR_FULL, 'book-2')
    sqlite.prepare('UPDATE reader_books SET size = 0 WHERE id = ?').run('book-1')
    const response = await send('PUT', '/books/book-1/blob', undefined, bookBytes(4096))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'reader_space_exceeded' } })
  })

  it('charges a re-upload only for the difference it makes', async () => {
    await send('PUT', '/library', { library: library({ books: [book(), book({ id: 'book-2' })] }) })
    sqlite.prepare('UPDATE reader_books SET size = ? WHERE id = ?').run(NEAR_FULL - 4096, 'book-2')
    sqlite.prepare('UPDATE reader_books SET size = ? WHERE id = ?').run(4096, 'book-1')
    // The same size again: the old bytes are given back before the new ones are charged.
    expect((await send('PUT', '/books/book-1/blob', undefined, bookBytes(4096))).status).toBe(200)
    // A bigger file has to pay the difference, and there is none left to pay it with.
    const bigger = await send('PUT', '/books/book-1/blob', undefined, bookBytes(1024 * 1024))
    expect(bigger.status).toBe(403)
    expect(await bigger.json()).toMatchObject({ error: { code: 'reader_space_exceeded' } })
  })

  it('does not let concurrent uploads oversubscribe the budget', async () => {
    await send('PUT', '/library', { library: library({ books: [book({ id: 'book-1', size: 0 }), book({ id: 'book-2', size: 0 }), book({ id: 'book-3', size: 0 })] }) })
    sqlite.prepare('UPDATE reader_books SET size = ? WHERE id = ?').run(LIMITS.readerQuotaBytes - 8, 'book-3')
    const responses = await Promise.all([
      send('PUT', '/books/book-1/blob', undefined, bookBytes(8)),
      send('PUT', '/books/book-2/blob', undefined, bookBytes(8)),
    ])
    expect(responses.map((one) => one.status).sort()).toEqual([200, 403])
    const usage = await readerUsage(db, ALICE)
    expect(usage.bytes + usage.covers).toBeLessThanOrEqual(LIMITS.readerQuotaBytes)
  })

  it('counts pending upload reservations and deletion outbox against the budget', async () => {
    sqlite.prepare('INSERT INTO reader_upload_reservations (user_id, id, bytes, created_at) VALUES (?, ?, ?, ?)')
      .run(ALICE, 'pending', 123, Date.now())
    sqlite.prepare('INSERT INTO reader_storage_deletions (user_id, object_key, bytes, created_at) VALUES (?, ?, ?, ?)')
      .run(ALICE, 'reader/user-alice/old.epub', 456, Date.now())
    const usage = await readerUsage(db, ALICE)
    expect(usage.bytes).toBe(579)
  })

  it('caps a single file before the budget is even consulted', async () => {
    await send('PUT', '/library', { library: library() })
    const response = await app.request('/api/reader/books/book-1/blob', {
      method: 'PUT',
      headers: { 'content-length': String(41 * 1024 * 1024) },
      body: new Uint8Array(8),
    }, env())
    expect(response.status).toBe(400)
  })
})

describe('the cover of a book', () => {
  // The route reads the header of what it is given, so a cover fixture has to be a real one.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 1, 2])
  const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 3, 4])

  it('refuses bytes that are not the image the type claims', async () => {
    await send('PUT', '/library', { library: library({ books: [book({ hasCover: true })] }) })
    const markup = new TextEncoder().encode('<html xmlns="http://www.w3.org/1999/xhtml"><body>x</body></html>')
    const put = await app.request('/api/reader/books/book-1/cover', {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: markup as unknown as BodyInit,
    }, { DB: db, FILES: r2 } as unknown as AppBindings['Bindings'])
    expect(put.status).toBe(400)
    // Nothing was stored, so the account is not charged for an object it does not have.
    expect(buckets.size).toBe(0)
    const listed = await (await send('GET', '/library')).json() as { library: any }
    expect(listed.library.books[0].coverUrl).toBeNull()
  })

  it('stores it apart from the book and hands it back', async () => {
    await send('PUT', '/library', { library: library({ books: [book({ hasCover: true })] }) })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const put = await app.request('/api/reader/books/book-1/cover', {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png,
    }, { DB: db, FILES: r2 } as unknown as AppBindings['Bindings'])
    expect(put.status).toBe(200)
    expect(buckets.has('reader/user-alice/book-1.cover.png')).toBe(true)
    const got = await send('GET', '/books/book-1/cover')
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png)
    // The shelf on another device now knows where to look without holding the book.
    const listed = await (await send('GET', '/library')).json() as { library: any }
    expect(listed.library.books[0].coverUrl).toBe('/api/reader/books/book-1/cover')
  })

  it('refuses anything that is not a picture', async () => {
    await send('PUT', '/library', { library: library() })
    const put = await app.request('/api/reader/books/book-1/cover', {
      method: 'PUT', headers: { 'Content-Type': 'image/svg+xml' }, body: new Uint8Array([1]),
    }, { DB: db, FILES: r2 } as unknown as AppBindings['Bindings'])
    expect(put.status).toBe(400)
  })

  it('names the object after the type it really is', async () => {
    await send('PUT', '/library', { library: library({ books: [book({ hasCover: true })] }) })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9])
    await app.request('/api/reader/books/book-1/cover', {
      method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg,
    }, { DB: db, FILES: r2 } as unknown as AppBindings['Bindings'])
    // A JPEG kept behind a `.png` key is a bucket nobody can reconcile and a browser that has to guess.
    expect(buckets.has('reader/user-alice/book-1.cover.jpg')).toBe(true)
    const got = await send('GET', '/books/book-1/cover')
    expect(got.headers.get('content-type')).toBe('image/jpeg')
  })

  it('counts a cover against the budget it replaces', async () => {
    await send('PUT', '/library', { library: library({ books: [book({ hasCover: true })] }) })
    // A body has to sit on a non-shared buffer, which is what `pngOf` below hands back.
    const put = (bytes: Uint8Array<ArrayBuffer>) => app.request('/api/reader/books/book-1/cover', {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes,
    }, { DB: db, FILES: r2 } as unknown as AppBindings['Bindings'])
    // Sized covers, with a real header on the front, because the route now reads it.
    const pngOf = (size: number) => { const one = new Uint8Array(size); one.set(PNG, 0); return one }
    await put(pngOf(4096))
    // The shelf is nearly full; the same size again is legal because the old cover is given back first.
    await send('PUT', '/library', {
      library: library({ books: [book({ hasCover: true, size: LIMITS.readerQuotaBytes - 4096, updatedAt: 3000 })] }),
    })
    expect((await put(pngOf(4096))).status).toBe(200)
    const over = await (await put(pngOf(8192))).json() as { error: { code: string } }
    expect(over.error.code).toBe('reader_space_exceeded')
  })

  it('lists a cover the server never received, and stops once it arrives', async () => {
    const first = await (await send('PUT', '/library', { library: library({ books: [book({ hasCover: true })] }) })).json() as { missingCovers: string[] }
    expect(first.missingCovers).toEqual(['book-1'])
    await app.request('/api/reader/books/book-1/cover', {
      method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: WEBP,
    }, { DB: db, FILES: r2 } as unknown as AppBindings['Bindings'])
    const again = await (await send('PUT', '/library', { library: library({ books: [book({ hasCover: true })] }) })).json() as { missingCovers: string[] }
    expect(again.missingCovers).toEqual([])
  })

  it('takes the cover object with the book', async () => {
    await send('PUT', '/library', { library: library() })
    await app.request('/api/reader/books/book-1/cover', {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG,
    }, { DB: db, FILES: r2 } as unknown as AppBindings['Bindings'])
    expect(buckets.size).toBe(1)
    await send('DELETE', '/books/book-1')
    expect(buckets.size).toBe(0)
  })
})

function shelfGroup(overrides: Record<string, unknown> = {}) {
  return { id: 'group-1', name: '在读', bookIds: ['book-1'], createdAt: 1000, updatedAt: 2000, ...overrides }
}

describe('the groupings on the shelf', () => {
  it('sends them back the way they went up', async () => {
    await send('PUT', '/library', {
      library: library({ groups: [shelfGroup(), shelfGroup({ id: 'group-2', name: '科幻', bookIds: [], updatedAt: 3000 })] }),
    })
    const listed = await (await send('GET', '/library')).json() as { library: any }
    expect(listed.library.groups).toEqual([
      { id: 'group-2', name: '科幻', bookIds: [], createdAt: 1000, updatedAt: 3000 },
      { id: 'group-1', name: '在读', bookIds: ['book-1'], createdAt: 1000, updatedAt: 2000 },
    ])
  })

  it('keeps a group whose book list is nonsense out of the shelf', async () => {
    await send('PUT', '/library', {
      library: library({ groups: [shelfGroup({ bookIds: ['book-1', 'never-imported', 'book-1', 7, null] })] }),
    })
    const listed = await (await send('GET', '/library')).json() as { library: any }
    expect(listed.library.groups[0].bookIds).toEqual(['book-1'])
  })

  it('drops a second group with the same name and one with no name', async () => {
    await send('PUT', '/library', {
      library: library({ groups: [
        shelfGroup(),
        shelfGroup({ id: 'group-dup', name: ' 在读 ' }),
        shelfGroup({ id: 'group-blank', name: '   ' }),
      ] }),
    })
    const listed = await (await send('GET', '/library')).json() as { library: any }
    expect(listed.library.groups.map((one: any) => one.id)).toEqual(['group-1'])
  })

  it('keeps omitted groups and deletes only an explicit group tombstone', async () => {
    await send('PUT', '/library', { library: library({ groups: [shelfGroup(), shelfGroup({ id: 'group-2', name: '科幻' })] }) })
    await send('PUT', '/library', { library: library({ groups: [shelfGroup({ name: '在读' })] }) })
    const omitted = await (await send('GET', '/library')).json() as { library: any }
    expect(omitted.library.groups.map((one: any) => one.id)).toEqual(['group-1', 'group-2'])

    const deleted = library().deleted as Record<string, unknown>
    await send('PUT', '/library', {
      library: library({ groups: [], deleted: { ...deleted, groups: { ids: ['group-2'], updatedAt: 4000 } } }),
    })
    const listed = await (await send('GET', '/library')).json() as { library: any }
    expect(listed.library.groups.map((one: any) => one.id)).toEqual(['group-1'])
    expect(listed.library.deleted.groups).toEqual([{ id: 'group-2', bookId: '', updatedAt: 4000 }])
  })

  it('takes a book out of every group when the book goes', async () => {
    await send('PUT', '/library', {
      library: library({ groups: [shelfGroup(), shelfGroup({ id: 'group-2', name: '科幻', bookIds: ['book-1'] })] }),
    })
    await send('DELETE', '/books/book-1')
    const listed = await (await send('GET', '/library')).json() as { library: any }
    // The groups are still there — an emptied one is a place the next book goes, not a mistake.
    expect(listed.library.groups.map((one: any) => [one.id, one.bookIds])).toEqual([['group-1', []], ['group-2', []]])
  })

  it('reads a shelf that predates groups as having none', async () => {
    await send('PUT', '/library', { library: library() })
    const listed = await (await send('GET', '/library')).json() as { library: any }
    expect(listed.library.groups).toEqual([])
  })
})
