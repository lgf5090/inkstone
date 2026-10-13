// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { LIMITS } from '../src/shared/constants'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { readerLibraryRoutes } from '../src/worker/routes/reader-library'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

interface FakeObject { body: ReadableStream; size: number; httpMetadata?: { contentType?: string }; upload: (value: unknown) => Promise<void> }

const buckets = new Map<string, Uint8Array>()
// Real R2 keeps the content type a put declared and hands it back on get, so the double has to or a
// route that reads it looks like a route that does not.
const types = new Map<string, string>()
const r2 = {
  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new TextEncoder().encode(String(value))
    buckets.set(key, bytes)
    if (options?.httpMetadata?.contentType) types.set(key, options.httpMetadata.contentType)
    return { key }
  },
  async get(key: string): Promise<FakeObject | null> {
    const bytes = buckets.get(key)
    if (!bytes) return null
    return {
      size: bytes.byteLength,
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

function book(overrides: Record<string, unknown> = {}) {
  return {
    id: 'book-1', format: 'epub', title: '道德经', author: '老子', language: 'zh', publisher: '',
    filename: 'dao.epub', size: 4096, addedAt: 1000, unitCount: 3, hasCover: false,
    toc: [{ label: '第一章', position: { kind: 'epub', chapter: 0, offset: 0 } }],
    ...overrides,
  }
}

function library(overrides: Record<string, unknown> = {}) {
  return {
    books: [book()],
    progress: { 'book-1': { bookId: 'book-1', position: { kind: 'epub', chapter: 0, offset: 120 }, fraction: 0.25, updatedAt: 2000, finishedAt: null } },
    highlights: { 'book-1': [{ id: 'h1', bookId: 'book-1', chapter: 0, start: 10, end: 24, quote: '道可道', prefix: '', suffix: '', color: 'yellow', comment: '要重读', createdAt: 3, updatedAt: 3 }] },
    marks: { 'book-1': [{ id: 'm1', bookId: 'book-1', label: '第 2 章处', position: { kind: 'epub', chapter: 1, offset: 0 }, createdAt: 4 }] },
    stats: { 'book-1': { bookId: 'book-1', seconds: 900, days: { '2026-10-12': 600, '2026-10-13': 300, junk: 5 } } },
    notes: { byBook: { 'book-1': 'note-9' }, vocabulary: 'note-vocab' },
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
    expect(answer.library.progress['book-1'].position).toEqual({ kind: 'epub', chapter: 0, offset: 120 })
    expect(answer.library.highlights['book-1'][0].comment).toBe('要重读')
    expect(answer.library.marks['book-1'][0].label).toBe('第 2 章处')
    expect(answer.library.notes).toEqual({ byBook: { 'book-1': 'note-9' }, vocabulary: 'note-vocab' })
    // A day key that is not a date is dropped rather than stored as noise.
    expect(answer.library.stats['book-1'].days).toEqual({ '2026-10-12': 600, '2026-10-13': 300 })
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

  it('replaces the state wholesale, so a deleted highlight stays deleted', async () => {
    await send('PUT', '/library', { library: library() })
    await send('PUT', '/library', { library: library({ highlights: { 'book-1': [] }, books: [] }) })
    const answer = await (await send('GET', '/library')).json() as { library: any }
    expect(answer.library.books).toEqual([])
    expect(answer.library.highlights).toEqual({})
  })
})

describe('what a client is not allowed to choose', () => {
  it('refuses a format the reader cannot open', async () => {
    const response = await send('PUT', '/library', { library: library({ books: [book({ format: 'exe' })] }) })
    expect(response.status).toBe(400)
  })

  it('refuses an id that could climb out of the account folder', async () => {
    for (const id of ['../../etc/passwd', 'a'.repeat(120), '', 'reader/../bob/x', 'a~b']) {
      const response = await send('PUT', '/library', { library: library({ books: [book({ id })] }) })
      expect(response.status, id).toBe(400)
    }
  })

  it('accepts the ids the shelf really mints, colons and all', async () => {
    const id = 'file:dao-de-jing.epub:13993'
    const response = await send('PUT', '/library', { library: library({ books: [book({ id })] }) })
    expect(response.status).toBe(200)
    await send('PUT', `/books/${encodeURIComponent(id)}/blob`, undefined, new Uint8Array([1, 2]))
    const got = await send('GET', `/books/${encodeURIComponent(id)}/blob`)
    expect(got.status).toBe(200)
    expect(buckets.has(`reader/${ALICE}/${id}.epub`)).toBe(true)
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

  it('names the files the device still has to send, and stops once they arrive', async () => {
    const first = await (await send('PUT', '/library', { library: library() })).json() as { missingBlobs: string[] }
    expect(first.missingBlobs).toEqual(['book-1'])
    await send('PUT', '/books/book-1/blob', undefined, new Uint8Array([1, 2, 3]))
    const again = await (await send('PUT', '/library', { library: library() })).json() as { missingBlobs: string[] }
    expect(again.missingBlobs).toEqual([])
  })

  it('takes the file and the reading with it when a book is removed', async () => {
    await send('PUT', '/library', { library: library() })
    await send('PUT', '/books/book-1/blob', undefined, new Uint8Array([1, 2, 3]))
    expect((await send('DELETE', '/books/book-1')).status).toBe(200)
    expect(buckets.size).toBe(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM reader_books').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM reader_highlights').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM reader_stats').get()).toEqual({ n: 0 })
  })
})

describe('the account budget', () => {
  it('reports what the shelf is using', async () => {
    await send('PUT', '/library', { library: library() })
    await send('PUT', '/books/book-1/blob', undefined, new Uint8Array(1000))
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
    const response = await send('PUT', '/books/book-1/blob', undefined, new Uint8Array(4096))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'reader_space_exceeded' } })
  })

  it('charges a re-upload only for the difference it makes', async () => {
    await send('PUT', '/library', { library: library({ books: [book(), book({ id: 'book-2' })] }) })
    sqlite.prepare('UPDATE reader_books SET size = ? WHERE id = ?').run(NEAR_FULL - 4096, 'book-2')
    sqlite.prepare('UPDATE reader_books SET size = ? WHERE id = ?').run(4096, 'book-1')
    // The same size again: the old bytes are given back before the new ones are charged.
    expect((await send('PUT', '/books/book-1/blob', undefined, new Uint8Array(4096))).status).toBe(200)
    // A bigger file has to pay the difference, and there is none left to pay it with.
    const bigger = await send('PUT', '/books/book-1/blob', undefined, new Uint8Array(1024 * 1024))
    expect(bigger.status).toBe(403)
    expect(await bigger.json()).toMatchObject({ error: { code: 'reader_space_exceeded' } })
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
    const put = (bytes: Uint8Array) => app.request('/api/reader/books/book-1/cover', {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes,
    }, { DB: db, FILES: r2 } as unknown as AppBindings['Bindings'])
    await put(new Uint8Array(4096))
    // The shelf is nearly full; the same size again is legal because the old cover is given back first.
    await send('PUT', '/library', {
      library: library({ books: [book({ hasCover: true, size: LIMITS.readerQuotaBytes - 4096 })] }),
    })
    expect((await put(new Uint8Array(4096))).status).toBe(200)
    const over = await (await put(new Uint8Array(8192))).json() as { error: { code: string } }
    expect(over.error.code).toBe('reader_space_exceeded')
  })

  it('lists a cover the server never received, and stops once it arrives', async () => {
    const first = await (await send('PUT', '/library', { library: library({ books: [book({ hasCover: true })] }) })).json() as { missingCovers: string[] }
    expect(first.missingCovers).toEqual(['book-1'])
    await app.request('/api/reader/books/book-1/cover', {
      method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: new Uint8Array([1, 2]),
    }, { DB: db, FILES: r2 } as unknown as AppBindings['Bindings'])
    const again = await (await send('PUT', '/library', { library: library({ books: [book({ hasCover: true })] }) })).json() as { missingCovers: string[] }
    expect(again.missingCovers).toEqual([])
  })

  it('takes the cover object with the book', async () => {
    await send('PUT', '/library', { library: library() })
    await app.request('/api/reader/books/book-1/cover', {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array([1, 2]),
    }, { DB: db, FILES: r2 } as unknown as AppBindings['Bindings'])
    expect(buckets.size).toBe(1)
    await send('DELETE', '/books/book-1')
    expect(buckets.size).toBe(0)
  })
})
