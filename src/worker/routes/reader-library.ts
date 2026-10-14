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
import { ReaderLibraryStore } from '../reader/store'
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

/** The book rows a push has to know the server-side answer to: where the bytes and the cover live. */
interface StoredBookRow {
  id: string
  r2_key: string
  has_blob: number
  cover_key: string | null
  cover_size: number
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
 * A full replace inside one `batch` is deliberate: the local store is the author of record, and merging
 * row by row would need a clock the two sides agree on. The book rows keep their server-side `r2_key`,
 * which a client never sends and never chooses.
 */
readerLibraryRoutes.put('/library', async (c) => {
  const userId = requireId(c.get('userId'), 'User id')
  const body = asRecord(await readJson<Record<string, unknown>>(c, MAX_LIBRARY_BYTES), 'Body')
  const library = asRecord(body.library, 'library')
  const existing = await c.env.DB.prepare('SELECT id, r2_key, has_blob, cover_key, cover_size FROM reader_books WHERE user_id = ?1').bind(userId).all<StoredBookRow>()
  const keys = new Map(existing.results.map((row) => [row.id, row.r2_key]))
  const covers = new Map(existing.results
    .filter((row): row is StoredBookRow & { cover_key: string } => Boolean(row.cover_key))
    .map((row) => [row.id, row]))
  // Whether the bytes and the cover are in R2 are the server's facts, so a push that does not mention
  // them keeps them.
  const blobs = new Set(existing.results.filter((row) => row.has_blob === 1).map((row) => row.id))

  const statements: D1PreparedStatement[] = [
    `DELETE FROM reader_books WHERE user_id = ?`,
    `DELETE FROM reader_progress WHERE user_id = ?`,
    `DELETE FROM reader_highlights WHERE user_id = ?`,
    `DELETE FROM reader_marks WHERE user_id = ?`,
    `DELETE FROM reader_stats WHERE user_id = ?`,
    `DELETE FROM reader_notes WHERE user_id = ?`,
    `DELETE FROM reader_groups WHERE user_id = ?`,
  ].map((sql) => c.env.DB.prepare(sql).bind(userId))

  const books = Array.isArray(library.books) ? library.books.slice(0, MAX_ROWS) : []
  if (books.length > LIMITS.readerBooksMaxPerUser) {
    throw ApiError.badRequest(`A shelf holds at most ${LIMITS.readerBooksMaxPerUser} books`)
  }
  const missingBlobs: string[] = []
  const missingCovers: string[] = []
  const bookIds = new Set(books.map((raw) => asRecord(raw, 'book').id))
  const seenGroups = new Set<string>()
  for (const raw of books) {
    const row = asRecord(raw, 'book')
    const id = idOf(row, 'id', 'Book id')
    if (!blobs.has(id)) missingBlobs.push(id)
    // The shelf says a book has a cover by naming the file inside it; `hasCover` is the same fact after
    // a round trip. Either shape counts, so a cover is never left behind because of a field name.
    const wantsCover = row.hasCover === true || (typeof row.coverPath === 'string' && row.coverPath.length > 0)
    if (wantsCover && !covers.has(id)) missingCovers.push(id)
    const format = textOf(row, 'format', 8) as BookFormat
    if (!(format in EXTENSIONS)) throw ApiError.badRequest(`Unsupported book format: ${format}`)
    statements.push(c.env.DB.prepare(
      `INSERT OR REPLACE INTO reader_books (id, user_id, title, author, format, filename, language, publisher, size, unit_count, r2_key, has_cover, toc, added_at, updated_at, has_blob, cover_key, cover_size)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
    ).bind(
      id, userId, textOf(row, 'title', 300, 'Untitled'), textOf(row, 'author', 200), format,
      textOf(row, 'filename', 240, `${id}.${EXTENSIONS[format]}`), textOf(row, 'language', 12), textOf(row, 'publisher', 200),
      Math.max(0, numberOf(row, 'size')), Math.max(0, numberOf(row, 'unitCount')),
      keys.get(id) ?? readerBookKey(userId, id, EXTENSIONS[format]),
      wantsCover ? 1 : 0, JSON.stringify(Array.isArray(row.toc) ? row.toc.slice(0, 800) : []),
      numberOf(row, 'addedAt', Date.now()), Date.now(), blobs.has(id) ? 1 : 0,
      covers.get(id)?.cover_key ?? null, covers.get(id)?.cover_size ?? 0,
    ))
  }

  const progress = asRecord(library.progress, 'progress')
  for (const [bookId, raw] of Object.entries(progress).slice(0, MAX_ROWS)) {
    const row = asRecord(raw, 'progress')
    const id = requireId(bookId, 'Book id')
    statements.push(c.env.DB.prepare(
      `INSERT OR REPLACE INTO reader_progress (user_id, book_id, position, fraction, updated_at, finished_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(userId, id, JSON.stringify(row.position ?? null), Math.min(1, Math.max(0, numberOf(row, 'fraction') || Number(row.fraction) || 0)),
      numberOf(row, 'updatedAt', Date.now()), typeof row.finishedAt === 'number' ? row.finishedAt : null))
  }

  for (const [table, source, columns] of [
    ['reader_highlights', library.highlights, ['id', 'chapter', 'start', 'end', 'quote', 'prefix', 'suffix', 'color', 'comment', 'createdAt', 'updatedAt']],
    ['reader_marks', library.marks, ['id', 'label', 'position', 'createdAt']],
  ] as const) {
    const buckets = asRecord(source, table)
    for (const [bookId, raw] of Object.entries(buckets).slice(0, MAX_ROWS)) {
      const id = requireId(bookId, 'Book id')
      if (!Array.isArray(raw)) continue
      for (const item of raw.slice(0, MAX_ROWS)) {
        const row = asRecord(item, 'row')
        const rowId = idOf(row, 'id', 'Row id')
        if (table === 'reader_highlights') {
          statements.push(c.env.DB.prepare(
            `INSERT OR REPLACE INTO reader_highlights (id, user_id, book_id, chapter, start_offset, end_offset, quote, prefix, suffix, color, comment, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
          ).bind(rowId, userId, id, numberOf(row, 'chapter'), numberOf(row, 'start'), numberOf(row, 'end'),
            textOf(row, 'quote', 20000), textOf(row, 'prefix', 200), textOf(row, 'suffix', 200),
            textOf(row, 'color', 12, 'yellow'), textOf(row, 'comment', 4000),
            numberOf(row, 'createdAt', Date.now()), numberOf(row, 'updatedAt', Date.now())))
        } else {
          statements.push(c.env.DB.prepare(
            `INSERT OR REPLACE INTO reader_marks (id, user_id, book_id, label, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          ).bind(rowId, userId, id, textOf(row, 'label', 200, 'Mark'), JSON.stringify(row.position ?? null),
            numberOf(row, 'createdAt', Date.now())))
        }
        void columns
      }
    }
  }

  const stats = asRecord(library.stats, 'stats')
  for (const [bookId, raw] of Object.entries(stats).slice(0, MAX_ROWS)) {
    const id = requireId(bookId, 'Book id')
    const row = asRecord(raw, 'stat')
    const days = asRecord(row.days, 'days')
    const clean: Record<string, number> = {}
    for (const [day, seconds] of Object.entries(days).slice(0, 4000)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof seconds === 'number' && seconds > 0) clean[day] = Math.trunc(seconds)
    }
    statements.push(c.env.DB.prepare(
      `INSERT OR REPLACE INTO reader_stats (user_id, book_id, seconds, days) VALUES (?1, ?2, ?3, ?4)`,
    ).bind(userId, id, Math.max(0, numberOf(row, 'seconds')), JSON.stringify(clean)))
  }

  const notes = asRecord(library.notes ?? {}, 'notes')
  const byBook = asRecord(notes.byBook ?? {}, 'notes.byBook')
  for (const [bookId, noteId] of Object.entries(byBook).slice(0, MAX_ROWS)) {
    const id = requireId(bookId, 'Book id')
    if (typeof noteId !== 'string') continue
    statements.push(c.env.DB.prepare(
      `INSERT OR REPLACE INTO reader_notes (user_id, book_id, note_id) VALUES (?1, ?2, ?3)`,
    ).bind(userId, id, noteId.slice(0, 64)))
  }
  if (typeof notes.vocabulary === 'string') {
    statements.push(c.env.DB.prepare(
      `INSERT OR REPLACE INTO reader_meta (user_id, key, value, updated_at) VALUES (?1, 'vocabulary', ?2, ?3)`,
    ).bind(userId, notes.vocabulary.slice(0, 64), Date.now()))
  }

  // A group is only worth keeping if the shelf it points at still exists, and two groups with the
  // same name would be one group the reader cannot tell apart.
  const groupStatements = (Array.isArray(library.groups) ? library.groups : []).slice(0, GROUPS_MAX).map((raw) => {
    const row = asRecord(raw, 'group')
    const id = idOf(row, 'id', 'Group id')
    const name = groupNameOf(row)
    if (!name || seenGroups.has(id) || seenGroups.has(name.toLowerCase())) return null
    seenGroups.add(id)
    seenGroups.add(name.toLowerCase())
    const members = Array.isArray(row.bookIds)
      ? [...new Set(row.bookIds.filter((one: unknown): one is string => typeof one === 'string' && bookIds.has(one)))].slice(0, GROUP_BOOKS_MAX)
      : []
    return c.env.DB.prepare(
      `INSERT OR REPLACE INTO reader_groups (id, user_id, name, book_ids, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(id, userId, name, JSON.stringify(members), numberOf(row, 'createdAt', Date.now()), numberOf(row, 'updatedAt', Date.now()))
  }).filter((one): one is D1PreparedStatement => one !== null)

  await c.env.DB.batch([...statements, ...groupStatements] as unknown as D1PreparedStatement[])
  // Telling the device which files are still missing is what lets a shelf that predates the sync — or a
  // book that was on the device when the last push failed — catch up without a second round trip.
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
  const row = await c.env.DB.prepare('SELECT format, size FROM reader_books WHERE user_id = ?1 AND id = ?2')
    .bind(userId, id).first<{ format: string; size: number }>()
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
  await c.env.DB.prepare('UPDATE reader_books SET r2_key = ?1, size = ?2, updated_at = ?3, has_blob = 1 WHERE user_id = ?4 AND id = ?5')
    .bind(key, bytes.byteLength, Date.now(), userId, id).run()
  return c.json({ ok: true as const, size: bytes.byteLength, key })
})

/** The bytes back, with a length a download can measure itself against. */
readerLibraryRoutes.get('/books/:id/blob', async (c) => {
  const userId = requireId(c.get('userId'), 'User id')
  const id = requireId(c.req.param('id'), 'Book id')
  const row = await c.env.DB.prepare('SELECT format, r2_key, filename FROM reader_books WHERE user_id = ?1 AND id = ?2')
    .bind(userId, id).first<{ format: string; r2_key: string; filename: string | null }>()
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
  const row = await c.env.DB.prepare('SELECT cover_key, cover_size FROM reader_books WHERE user_id = ?1 AND id = ?2')
    .bind(userId, id).first<{ cover_key: string | null; cover_size: number }>()
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
  await c.env.DB.prepare('UPDATE reader_books SET cover_key = ?1, cover_size = ?2 WHERE user_id = ?3 AND id = ?4')
    .bind(key, buffer.byteLength, userId, id).run()
  return c.json({ ok: true as const, size: buffer.byteLength, key })
})

readerLibraryRoutes.get('/books/:id/cover', async (c) => {
  const userId = requireId(c.get('userId'), 'User id')
  const id = requireId(c.req.param('id'), 'Book id')
  const row = await c.env.DB.prepare('SELECT cover_key FROM reader_books WHERE user_id = ?1 AND id = ?2')
    .bind(userId, id).first<{ cover_key: string | null }>()
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
  const row = await c.env.DB.prepare('SELECT r2_key, cover_key FROM reader_books WHERE user_id = ?1 AND id = ?2')
    .bind(userId, id).first<{ r2_key: string; cover_key: string | null }>()
  if (!row) return c.json({ ok: true as const, removed: false })
  await Promise.all([
    c.env.FILES?.delete(row.r2_key),
    row.cover_key ? c.env.FILES?.delete(row.cover_key) : Promise.resolve(),
  ])
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM reader_books WHERE user_id = ?1 AND id = ?2').bind(userId, id),
    c.env.DB.prepare('DELETE FROM reader_progress WHERE user_id = ?1 AND book_id = ?2').bind(userId, id),
    c.env.DB.prepare('DELETE FROM reader_highlights WHERE user_id = ?1 AND book_id = ?2').bind(userId, id),
    c.env.DB.prepare('DELETE FROM reader_marks WHERE user_id = ?1 AND book_id = ?2').bind(userId, id),
    c.env.DB.prepare('DELETE FROM reader_stats WHERE user_id = ?1 AND book_id = ?2').bind(userId, id),
    c.env.DB.prepare('DELETE FROM reader_notes WHERE user_id = ?1 AND book_id = ?2').bind(userId, id),
    // A group keeps its name when it loses a member: the reader made the group, and an empty one
    // is a place they will put the next book.
    c.env.DB.prepare(
      `UPDATE reader_groups SET book_ids = (SELECT COALESCE(json_group_array(value), '[]')
                                               FROM json_each(reader_groups.book_ids) WHERE value != ?2)
                                         WHERE user_id = ?1`,
    ).bind(userId, id),
  ] as unknown as D1PreparedStatement[])
  return c.json({ ok: true as const, removed: true })
})
