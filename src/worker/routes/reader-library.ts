/**
 * The reader's shelf, on the server.
 *
 * A book is two things: the bytes, which go to R2 under `reader/<user>/<id>.<ext>`, and the account's
 * reading of it — the shelf row, the position, the highlights — which go to the `reader_*` tables. The
 * browser keeps its own copy of both (IndexedDB, so a plane reads offline), and this route is what makes
 * a second device and a cleared browser find the same shelf.
 *
 * Two rules hold it together. A client names a book by id only: the R2 key is derived here from the
 * authenticated user and the row, so no request can read or overwrite another account's file. And the
 * state arrives whole — the local store is the author of record and a push replaces what the server had,
 * which is the only merge that cannot lose a highlight to a clock skew.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { readJson } from '../lib/request'
import { readerBookKey, readerCoverKey } from '../db/reader-schema'
import {
  ReaderLibraryStore,
  type ShelfBookInput,
  type ShelfGroupInput,
  type ShelfHighlightInput,
  type ShelfMarkInput,
  type ShelfNoteInput,
  type ShelfProgressInput,
  type ShelfStatInput,
} from '../reader/store'
import { assertReaderRoom, readerUsage } from '../db/quota'
import { LIMITS, READER_COVER_TYPES } from '@shared/constants'

type BookFormat = 'epub' | 'pdf' | 'cbz'

export const readerLibraryRoutes = new Hono<AppBindings>()
readerLibraryRoutes.use('*', requireAuth)

/** A novel is megabytes; a scanned art book is tens. Above this the reader should carry the file by hand. */
const MAX_BOOK_BYTES = LIMITS.readerBookMaxBytes
const MAX_COVER_BYTES = LIMITS.readerCoverMaxBytes
/** Which image types a cover may be, and the extension the key gets. Anything else is refused. */
const COVER_EXTENSIONS = READER_COVER_TYPES
const COVER_MIME_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(READER_COVER_TYPES).map(([type, extension]) => [extension, type]),
)
/** A group's name, trimmed the way the device trims it, or nothing if it is not usable. */
function groupNameOf(row: Record<string, unknown>): string {
  return typeof row.name === 'string' ? row.name.trim().replace(/\s+/g, ' ').slice(0, GROUP_NAME_MAX) : ''
}

/** The whole shelf's reading state, which is text and small. */
const MAX_LIBRARY_BYTES = 6 * 1024 * 1024
const GROUPS_MAX = 60
const GROUP_NAME_MAX = 40
const GROUP_BOOKS_MAX = 500
const MAX_ROWS = 5000

const EXTENSIONS: Record<BookFormat, string> = { epub: 'epub', pdf: 'pdf', cbz: 'cbz' }
const CONTENT_TYPES: Record<BookFormat, string> = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  cbz: 'application/vnd.comicbook+zip',
}

/**
 * Ids the reader app mints itself: `book-…` from the package, and `file:<name>:<size>` when the only
 * handle it has is the file the reader dropped in.
 *
 * The name in the middle is whatever the reader called the file, in their own language, with their own
 * punctuation, so this is a list of what may NOT appear rather than an ASCII allowlist. An allowlist
 * rejected most of the world's books: a file named in Chinese got a 400 on sync, and every one of my
 * tests passed because every fixture I had written was named in ASCII.
 *
 * What still may not appear, and why: a path separator or a dot-dot, because the id is a component of
 * the R2 key; a double quote or a control character, because the id also goes into a download header;
 * a leading tilde, because that is how a home-relative path starts; leading or trailing whitespace,
 * because a device claims a book it already holds by comparing ids byte for byte. An id is never
 * trimmed into validity, so these are refused rather than fixed.
 */
const ID_UNSAFE = /[\\/\u0000-\u001f\u007f-\u009f"]/

function isSaneId(value: string): boolean {
  if (!value || value.length > LIMITS.readerIdMaxChars) return false
  if (value.trim() !== value) return false
  if (value.includes('..') || value.startsWith('~')) return false
  return !ID_UNSAFE.test(value)
}

function requireId(value: string | undefined, what: string): string {
  if (typeof value !== 'string' || !isSaneId(value)) {
    throw ApiError.badRequest(`${what} is not a valid identifier`)
  }
  return value
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * An identifier is checked before it is used, never trimmed into validity.
 *
 * `textOf` would slice an id that is a character over the ceiling down to something that passes, and the
 * reader's book would come back under a different name than it went out.
 */
function idOf(row: Record<string, unknown>, key: string, what: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw ApiError.badRequest(`${what} is not a valid identifier`)
  return requireId(value, what)
}

function textOf(row: Record<string, unknown>, key: string, max: number, fallback = ''): string {
  const value = row[key]
  if (typeof value !== 'string') return fallback
  return value.slice(0, max)
}

function numberOf(row: Record<string, unknown>, key: string, fallback = 0): number {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

/**
 * The name a download arrives with, spelled the way a header has to be.
 *
 * A header value is a ByteString: a name in Chinese, which is the whole point of this shelf, throws on
 * `Response` construction rather than arriving mangled. So the readable name goes out in `filename*`
 * percent-encoded as UTF-8 (RFC 5987), with an ASCII `filename` in front of it for a client that does not
 * know the extension.
 */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_|~]/

function rfc5987(value: string): string {
  let out = ''
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte)
    out += ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** The name the reader gave the file, or the id if the row predates it, with the format's extension on. */
function downloadFilename(stored: string, id: string, extension: string): string {
  const base = stored.trim() || id.trim() || 'book'
  return /\.[A-Za-z0-9]+$/.test(base) ? base : `${base}.${extension}`
}

function contentDisposition(full: string): string {
  const ascii = full.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `inline; filename="${ascii}"; filename*=UTF-8''${rfc5987(full)}`
}

function store(c: Context<AppBindings>, userId: string): ReaderLibraryStore {
  return new ReaderLibraryStore(c.env.DB, userId)
}

/** One account's whole shelf, in the shape the local store holds it. */
async function loadLibrary(c: Context<AppBindings>, userId: string) {
  const rows = await store(c, userId).shelf()
  const vocabulary = rows.meta.find((row) => row.key === 'vocabulary')?.value ?? null
  return {
    books: rows.books.map((row) => ({
      id: row.id,
      format: row.format,
      title: row.title,
      author: row.author,
      language: row.language,
      publisher: row.publisher,
      filename: row.filename,
      size: row.size,
      addedAt: row.added_at,
      unitCount: row.unit_count,
      hasCover: row.has_cover === 1,
      hasBlob: row.has_blob === 1,
      // A path, not a secret: the route resolves it against the authenticated account.
      coverUrl: row.cover_key ? `/api/reader/books/${encodeURIComponent(row.id)}/cover` : null,
      toc: JSON.parse(row.toc || '[]') as unknown[],
    })),
    progress: Object.fromEntries(rows.progress.map((row) => [row.book_id, {
      bookId: row.book_id,
      position: JSON.parse(row.position) as unknown,
      fraction: row.fraction,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at ?? null,
    }])),
    highlights: Object.fromEntries(group(rows.highlights, (row) => row.book_id, (row) => ({
      id: row.id, bookId: row.book_id, chapter: row.chapter, start: row.start_offset, end: row.end_offset,
      quote: row.quote, prefix: row.prefix, suffix: row.suffix, color: row.color, comment: row.comment,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }))),
    marks: Object.fromEntries(group(rows.marks, (row) => row.book_id, (row) => ({
      id: row.id, bookId: row.book_id, label: row.label, position: JSON.parse(row.position) as unknown,
      createdAt: row.created_at,
    }))),
    stats: Object.fromEntries(rows.stats.map((row) => [row.book_id, {
      bookId: row.book_id, seconds: row.seconds, days: JSON.parse(row.days || '{}') as Record<string, number>,
    }])),
    notes: {
      byBook: Object.fromEntries(rows.notes.map((row) => [row.book_id, row.note_id])),
      vocabulary: typeof vocabulary === 'string' ? vocabulary : null,
    },
    groups: rows.groups.map((row) => ({
      id: row.id,
      name: row.name,
      bookIds: JSON.parse(row.book_ids || '[]') as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  }
}

/** Rows bucketed by the book they belong to, which is how the local store keys its maps. */
function group<TRow, TShape>(
  rows: readonly TRow[],
  bookIdOf: (row: TRow) => string,
  shape: (row: TRow) => TShape,
): [string, TShape[]][] {
  const out = new Map<string, TShape[]>()
  for (const row of rows) {
    const bookId = bookIdOf(row)
    const bucket = out.get(bookId) ?? []
    bucket.push(shape(row))
    out.set(bookId, bucket)
  }
  return [...out.entries()]
}

readerLibraryRoutes.get('/library', async (c) => {
  const userId = requireId(c.get('userId'), 'User id')
  return c.json({
    ok: true as const,
    library: await loadLibrary(c, userId),
    usage: await readerUsage(c.env.DB, userId),
  })
})

/**
 * Replace the account's reading state with what the device holds.
 *
 * Everything here is the trust boundary: an id, a format or a length the client got wrong is refused
 * before the store is asked for anything. The store keeps the server's own facts and lands the whole
 * shelf in one batch; see `reader/store.ts`.
 */
readerLibraryRoutes.put('/library', async (c) => {
  const userId = requireId(c.get('userId'), 'User id')
  const body = asRecord(await readJson<Record<string, unknown>>(c, MAX_LIBRARY_BYTES), 'Body')
  const library = asRecord(body.library, 'library')

  const books = Array.isArray(library.books) ? library.books.slice(0, MAX_ROWS) : []
  if (books.length > LIMITS.readerBooksMaxPerUser) {
    throw ApiError.badRequest(`A shelf holds at most ${LIMITS.readerBooksMaxPerUser} books`)
  }
  const bookIds = new Set<string>()
  const bookRows: ShelfBookInput[] = []
  for (const raw of books) {
    const row = asRecord(raw, 'book')
    const id = idOf(row, 'id', 'Book id')
    bookIds.add(id)
    // The shelf says a book has a cover by naming the file inside it; `hasCover` is the same fact after
    // a round trip. Either shape counts, so a cover is never left behind because of a field name.
    const wantsCover = row.hasCover === true || (typeof row.coverPath === 'string' && row.coverPath.length > 0)
    const format = textOf(row, 'format', 8) as BookFormat
    if (!(format in EXTENSIONS)) throw ApiError.badRequest(`Unsupported book format: ${format}`)
    bookRows.push({
      id,
      title: textOf(row, 'title', 300, 'Untitled'),
      author: textOf(row, 'author', 200),
      format,
      filename: textOf(row, 'filename', 240, `${id}.${EXTENSIONS[format]}`),
      language: textOf(row, 'language', 12),
      publisher: textOf(row, 'publisher', 200),
      size: Math.max(0, numberOf(row, 'size')),
      unitCount: Math.max(0, numberOf(row, 'unitCount')),
      wantsCover,
      tocJson: JSON.stringify(Array.isArray(row.toc) ? row.toc.slice(0, 800) : []),
      addedAt: numberOf(row, 'addedAt', Date.now()),
      updatedAt: Date.now(),
      fallbackKey: readerBookKey(userId, id, EXTENSIONS[format]),
    })
  }

  const progressSource = asRecord(library.progress, 'progress')
  const progress: ShelfProgressInput[] = []
  for (const [bookId, raw] of Object.entries(progressSource).slice(0, MAX_ROWS)) {
    const row = asRecord(raw, 'progress')
    const id = requireId(bookId, 'Book id')
    progress.push({
      bookId: id,
      positionJson: JSON.stringify(row.position ?? null),
      fraction: Math.min(1, Math.max(0, numberOf(row, 'fraction') || Number(row.fraction) || 0)),
      updatedAt: numberOf(row, 'updatedAt', Date.now()),
      finishedAt: typeof row.finishedAt === 'number' ? row.finishedAt : null,
    })
  }

  const highlights: ShelfHighlightInput[] = []
  const highlightsSource = asRecord(library.highlights, 'reader_highlights')
  for (const [bookId, raw] of Object.entries(highlightsSource).slice(0, MAX_ROWS)) {
    const id = requireId(bookId, 'Book id')
    if (!Array.isArray(raw)) continue
    for (const item of raw.slice(0, MAX_ROWS)) {
      const row = asRecord(item, 'row')
      highlights.push({
        id: idOf(row, 'id', 'Row id'),
        bookId: id,
        chapter: numberOf(row, 'chapter'),
        startOffset: numberOf(row, 'start'),
        endOffset: numberOf(row, 'end'),
        quote: textOf(row, 'quote', 20000),
        prefix: textOf(row, 'prefix', 200),
        suffix: textOf(row, 'suffix', 200),
        color: textOf(row, 'color', 12, 'yellow'),
        comment: textOf(row, 'comment', 4000),
        createdAt: numberOf(row, 'createdAt', Date.now()),
        updatedAt: numberOf(row, 'updatedAt', Date.now()),
      })
    }
  }

  const marks: ShelfMarkInput[] = []
  const marksSource = asRecord(library.marks, 'reader_marks')
  for (const [bookId, raw] of Object.entries(marksSource).slice(0, MAX_ROWS)) {
    const id = requireId(bookId, 'Book id')
    if (!Array.isArray(raw)) continue
    for (const item of raw.slice(0, MAX_ROWS)) {
      const row = asRecord(item, 'row')
      marks.push({
        id: idOf(row, 'id', 'Row id'),
        bookId: id,
        label: textOf(row, 'label', 200, 'Mark'),
        positionJson: JSON.stringify(row.position ?? null),
        createdAt: numberOf(row, 'createdAt', Date.now()),
      })
    }
  }

  const statsSource = asRecord(library.stats, 'stats')
  const stats: ShelfStatInput[] = []
  for (const [bookId, raw] of Object.entries(statsSource).slice(0, MAX_ROWS)) {
    const id = requireId(bookId, 'Book id')
    const row = asRecord(raw, 'stat')
    const days = asRecord(row.days, 'days')
    const clean: Record<string, number> = {}
    for (const [day, seconds] of Object.entries(days).slice(0, 4000)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof seconds === 'number' && seconds > 0) clean[day] = Math.trunc(seconds)
    }
    stats.push({ bookId: id, seconds: Math.max(0, numberOf(row, 'seconds')), daysJson: JSON.stringify(clean) })
  }

  const notesSource = asRecord(library.notes ?? {}, 'notes')
  const byBook = asRecord(notesSource.byBook ?? {}, 'notes.byBook')
  const notes: ShelfNoteInput[] = []
  for (const [bookId, noteId] of Object.entries(byBook).slice(0, MAX_ROWS)) {
    const id = requireId(bookId, 'Book id')
    if (typeof noteId !== 'string') continue
    notes.push({ bookId: id, noteId: noteId.slice(0, 64) })
  }

  // A group is only worth keeping if the shelf it points at still exists, and two groups with the
  // same name would be one group the reader cannot tell apart.
  const seenGroups = new Set<string>()
  const groups: ShelfGroupInput[] = []
  for (const raw of (Array.isArray(library.groups) ? library.groups : []).slice(0, GROUPS_MAX)) {
    const row = asRecord(raw, 'group')
    const id = idOf(row, 'id', 'Group id')
    const name = groupNameOf(row)
    if (!name || seenGroups.has(id) || seenGroups.has(name.toLowerCase())) continue
    seenGroups.add(id)
    seenGroups.add(name.toLowerCase())
    const members = Array.isArray(row.bookIds)
      ? [...new Set(row.bookIds.filter((one: unknown): one is string => typeof one === 'string' && bookIds.has(one)))].slice(0, GROUP_BOOKS_MAX)
      : []
    groups.push({
      id,
      name,
      bookIds: members,
      createdAt: numberOf(row, 'createdAt', Date.now()),
      updatedAt: numberOf(row, 'updatedAt', Date.now()),
    })
  }

  const { missingBlobs, missingCovers } = await store(c, userId).replace({
    books: bookRows, progress, highlights, marks, stats, notes, groups,
    vocabulary: typeof notesSource.vocabulary === 'string' ? notesSource.vocabulary.slice(0, 64) : null,
  })
  return c.json({
    ok: true as const,
    updatedAt: Date.now(),
    missingBlobs,
    missingCovers,
    usage: await readerUsage(c.env.DB, userId),
  })
})

/**
 * The book's bytes. The row decides the extension, so the only thing a client can name is an id.
 */
readerLibraryRoutes.put('/books/:id/blob', async (c) => {
  const userId = requireId(c.get('userId'), 'User id')
  const id = requireId(c.req.param('id'), 'Book id')
  const library = store(c, userId)
  const row = await library.bookForBlob(id)
  if (!row) throw ApiError.notFound('Unknown book')
  const format = row.format as BookFormat
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > MAX_BOOK_BYTES) throw ApiError.badRequest('That file is too large for the shelf')
  const bytes = await c.req.arrayBuffer()
  if (!bytes.byteLength) throw ApiError.badRequest('The upload was empty')
  if (bytes.byteLength > MAX_BOOK_BYTES) {
    throw new ApiError(413, 'reader_book_too_large', `A book may be at most ${MAX_BOOK_BYTES} bytes`)
  }
  // The account's budget, charged for the difference the new file makes rather than its whole size.
  await assertReaderRoom(c.env.DB, userId, bytes.byteLength, 0, row.size ?? 0)

  const r2 = c.env.FILES
  if (!r2) throw ApiError.notFound('R2 storage is not configured')
  const key = readerBookKey(userId, id, EXTENSIONS[format])
  await r2.put(key, bytes, { httpMetadata: { contentType: CONTENT_TYPES[format] } })
  await library.markBlobStored(id, key, bytes.byteLength)
  return c.json({ ok: true as const, size: bytes.byteLength, key })
})

/** The bytes back, with a length a download can measure itself against. */
readerLibraryRoutes.get('/books/:id/blob', async (c) => {
  const userId = requireId(c.get('userId'), 'User id')
  const id = requireId(c.req.param('id'), 'Book id')
  const row = await store(c, userId).bookForDownload(id)
  if (!row) throw ApiError.notFound('Unknown book')
  const r2 = c.env.FILES
  if (!r2) throw ApiError.notFound('R2 storage is not configured')
  const object = await r2.get(row.r2_key)
  if (!object) throw ApiError.notFound('The file is not in storage')
  const format = row.format as BookFormat
  return new Response(object.body, {
    headers: {
      'Content-Type': CONTENT_TYPES[format] ?? 'application/octet-stream',
      'Content-Length': String(object.size),
      'Content-Disposition': contentDisposition(downloadFilename(row.filename ?? '', id, EXTENSIONS[format])),
      'Cache-Control': 'private, max-age=3600',
    },
  })
})

/**
 * The cover on its own, so a device that has never held the book can still paint the shelf.
 *
 * Reading a 40 MB archive to find one 200 kB image is the wrong trade on a phone, and it is the reason
 * this is a separate object rather than a field on the book.
 */
/**
 * The header each accepted cover type must start with.
 *
 * The declared content type is the client's, and a client that is wrong about one has already been wrong
 * here: a book whose cover href was an XHTML page put 1 kB of markup behind a `.cover.png` key, and every
 * device that later pulled the shelf painted a broken tile. The type decides the R2 key and the response
 * header, so the bytes have to agree with it before anything is written.
 */
const COVER_MAGIC: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  // WebP is `RIFF....WEBP`, so this one is read at offset 8.
  'image/webp': [0x57, 0x45, 0x42, 0x50],
}

function isDeclaredImage(type: string, bytes: Uint8Array): boolean {
  const magic = COVER_MAGIC[type]
  if (!magic) return false
  const at = type === 'image/webp' ? 8 : 0
  if (bytes.byteLength < at + magic.length) return false
  return magic.every((byte, index) => bytes[at + index] === byte)
}

readerLibraryRoutes.put('/books/:id/cover', async (c) => {
  const userId = requireId(c.get('userId'), 'User id')
  const id = requireId(c.req.param('id'), 'Book id')
  const library = store(c, userId)
  const row = await library.bookForCover(id)
  if (!row) throw ApiError.notFound('Unknown book')
  const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  const extension = COVER_EXTENSIONS[type]
  if (!extension) throw ApiError.badRequest('A cover must be a PNG, JPEG or WebP image')
  const buffer = await c.req.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  if (!buffer.byteLength) throw ApiError.badRequest('The cover was empty')
  if (!isDeclaredImage(type, bytes)) throw ApiError.badRequest('The cover is not the image its type claims')
  if (buffer.byteLength > MAX_COVER_BYTES) throw ApiError.badRequest('That cover is too large')
  await assertReaderRoom(c.env.DB, userId, buffer.byteLength, 0, row.cover_size ?? 0)

  const r2 = c.env.FILES
  if (!r2) throw ApiError.notFound('R2 storage is not configured')
  const key = readerCoverKey(userId, id, extension)
  if (row.cover_key && row.cover_key !== key) await r2.delete(row.cover_key).catch(() => {})
  await r2.put(key, buffer, { httpMetadata: { contentType: type } })
  await library.setCover(id, key, buffer.byteLength)
  return c.json({ ok: true as const, size: buffer.byteLength, key })
})

readerLibraryRoutes.get('/books/:id/cover', async (c) => {
  const userId = requireId(c.get('userId'), 'User id')
  const id = requireId(c.req.param('id'), 'Book id')
  const row = await store(c, userId).coverKeyOf(id)
  if (!row?.cover_key) throw ApiError.notFound('No cover for that book')
  const object = await c.env.FILES?.get(row.cover_key)
  if (!object) throw ApiError.notFound('The cover is not in storage')
  return new Response(object.body, {
    headers: {
      // The type was recorded when the cover went up; the key's extension is what to say when it
      // predates that, and it beats claiming every unknown cover is a PNG.
      'Content-Type': object.httpMetadata?.contentType ?? COVER_MIME_BY_EXTENSION[row.cover_key.slice(row.cover_key.lastIndexOf('.') + 1)] ?? 'application/octet-stream',
      'Content-Length': String(object.size),
      'Cache-Control': 'private, max-age=604800',
    },
  })
})

readerLibraryRoutes.delete('/books/:id', async (c) => {
  const userId = requireId(c.get('userId'), 'User id')
  const id = requireId(c.req.param('id'), 'Book id')
  const library = store(c, userId)
  const row = await library.bookObjects(id)
  if (!row) return c.json({ ok: true as const, removed: false })
  await Promise.all([
    c.env.FILES?.delete(row.r2_key),
    row.cover_key ? c.env.FILES?.delete(row.cover_key) : Promise.resolve(),
  ])
  await library.deleteBook(id)
  return c.json({ ok: true as const, removed: true })
})
