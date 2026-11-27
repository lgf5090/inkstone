/**
 * The reader's shelf, on the server.
 *
 * A book is two things: the bytes, which go to R2 under `reader/<user>/<id>.<ext>`, and the account's
 * reading of it — the shelf row, the position, the highlights — which go to the `reader_*` tables. The
 * browser keeps its own copy of both (IndexedDB, so a plane reads offline), and this route is what makes
 * a second device and a cleared browser find the same shelf.
 *
 * Two rules hold it together. A client names a book by id only: the R2 key is derived here from the
 * authenticated user and the row, so no request can read or overwrite another account's file. And each
 * synced record carries its own `updatedAt`, so a stale snapshot cannot erase a newer change from another
 * device. Deletion is explicit and versioned; omission never means deletion.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { readJson } from '../lib/request'
import { readerBookKey, readerCoverKey } from '../db/reader-schema'
import {
  ReaderLibraryStore,
  type ReaderSyncEntity,
  type ShelfBookInput,
  type ShelfDeletedIds,
  type ShelfDeletedInput,
  type ShelfGroupInput,
  type ShelfHighlightInput,
  type ShelfMarkInput,
  type ShelfNoteInput,
  type ShelfProgressInput,
  type ShelfStatInput,
} from '../reader/store'
import { readerUsage, releaseReaderUpload, reserveReaderUpload } from '../db/quota'
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
const HIGHLIGHT_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'red', 'purple'])
const DELETED_ENTITIES = ['books', 'progress', 'highlights', 'marks', 'stats', 'notes', 'groups'] as const
type DeletedEntity = (typeof DELETED_ENTITIES)[number]

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

/** Missing timestamps are accepted only as the legacy snapshot fallback; supplied ones must be exact. */
function updatedAtOf(row: Record<string, unknown>, fallback: number): number {
  const value = row.updatedAt
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw ApiError.badRequest('updatedAt must be a non-negative integer')
  }
  return value
}

function requiredUpdatedAt(row: Record<string, unknown>): number {
  if (row.updatedAt === undefined) throw ApiError.badRequest('updatedAt is required for deletions')
  return updatedAtOf(row, 0)
}

function isPosition(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (row.kind === 'epub') {
    return Number.isSafeInteger(row.chapter) && (row.chapter as number) >= 0
      && Number.isSafeInteger(row.offset) && (row.offset as number) >= 0
  }
  if (row.kind === 'fixed') return Number.isSafeInteger(row.page) && (row.page as number) >= 1
  return false
}

function positionJsonOf(value: unknown, what: string, allowNull: boolean): string {
  if (value === null && allowNull) return 'null'
  if (!isPosition(value)) throw ApiError.badRequest(`${what} is not a valid position`)
  return JSON.stringify(value)
}

function requireBookReference(id: string, known: ReadonlySet<string>, what: string): void {
  if (!known.has(id)) throw ApiError.badRequest(`${what} references an unknown book`)
}

function parseDeleted(
  value: unknown,
  knownBooks: ReadonlySet<string>,
  liveIds: Readonly<Record<DeletedEntity, ReadonlySet<string>>>,
): ShelfDeletedInput {
  const row = asRecord(value, 'library.deleted')
  for (const key of Object.keys(row)) {
    if (key !== 'vocabulary' && !DELETED_ENTITIES.includes(key as DeletedEntity)) {
      throw ApiError.badRequest(`Unknown deleted entity: ${key}`)
    }
  }

  const deleted = {} as Pick<ShelfDeletedInput, DeletedEntity>
  for (const entity of DELETED_ENTITIES) {
    const raw = row[entity]
    if (raw === undefined) {
      deleted[entity] = { ids: [], updatedAt: 0 }
      continue
    }
    const item = asRecord(raw, `library.deleted.${entity}`)
    if (!Array.isArray(item.ids)) throw ApiError.badRequest(`library.deleted.${entity}.ids must be an array`)
    const ids = item.ids.slice(0, MAX_ROWS)
    const seen = new Set<string>()
    for (const value of ids) {
      const id = requireId(typeof value === 'string' ? value : undefined, `Deleted ${entity} id`)
      if (seen.has(id)) throw ApiError.badRequest(`Duplicate deleted ${entity} id: ${id}`)
      if (liveIds[entity].has(id)) throw ApiError.badRequest(`Duplicate live and deleted ${entity} id: ${id}`)
      if ((entity === 'progress' || entity === 'stats' || entity === 'notes') && !knownBooks.has(id)) {
        throw ApiError.badRequest(`Deleted ${entity} references an unknown book`)
      }
      seen.add(id)
    }
    deleted[entity] = { ids, updatedAt: requiredUpdatedAt(item) } satisfies ShelfDeletedIds
  }

  let vocabulary: ShelfDeletedInput['vocabulary'] = null
  if (row.vocabulary !== undefined) {
    const item = asRecord(row.vocabulary, 'library.deleted.vocabulary')
    if (typeof item.deleted !== 'boolean') throw ApiError.badRequest('library.deleted.vocabulary.deleted must be boolean')
    vocabulary = { deleted: item.deleted, updatedAt: requiredUpdatedAt(item) }
  }
  return { ...deleted, vocabulary }
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
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(full)}`
}

function store(c: Context<AppBindings>, userId: string): ReaderLibraryStore {
  return new ReaderLibraryStore(c.env.DB, userId)
}

async function drainStorageDeletions(c: Context<AppBindings>, userId: string): Promise<void> {
  const library = store(c, userId)
  for (const row of await library.storageDeletions()) {
    try {
      await c.env.FILES?.delete(row.object_key)
      await library.finishStorageDeletion(row.object_key)
    } catch (error) {
      console.warn('[reading] could not delete a stored book object', row.object_key, error)
      break
    }
  }
}

function hasBookMagic(format: BookFormat, bytes: Uint8Array): boolean {
  if (format === 'pdf') return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

interface LibraryTombstone {
  id: string
  bookId: string
  updatedAt: number
}

type LibraryDeletions = Record<Exclude<ReaderSyncEntity, 'vocabulary'>, LibraryTombstone[]> & {
  vocabulary: { deleted: true; updatedAt: number } | null
}

/** One account's whole shelf, in the shape the local store holds it. */
async function loadLibrary(c: Context<AppBindings>, userId: string) {
  const rows = await store(c, userId).shelf()
  const vocabulary = rows.meta.find((row) => row.key === 'vocabulary')?.value ?? null
  const vocabularyUpdatedAt = rows.meta.find((row) => row.key === 'vocabulary')?.updated_at
    ?? rows.syncVersions.find((row) => row.entity === 'vocabulary')?.updated_at
    ?? null
  const deleted: LibraryDeletions = {
    books: [], progress: [], highlights: [], marks: [], stats: [], notes: [], groups: [], vocabulary: null,
  }
  for (const version of rows.syncVersions) {
    if (version.deleted !== 1) continue
    if (version.entity === 'vocabulary') {
      deleted.vocabulary = { deleted: true, updatedAt: version.updated_at }
    } else {
      deleted[version.entity].push({
        id: version.entity_id,
        bookId: version.book_id,
        updatedAt: version.updated_at,
      })
    }
  }
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
      updatedAt: row.updated_at,
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
      createdAt: row.created_at, updatedAt: row.updated_at,
    }))),
    stats: Object.fromEntries(rows.stats.map((row) => [row.book_id, {
      bookId: row.book_id, seconds: row.seconds, days: JSON.parse(row.days || '{}') as Record<string, number>,
      updatedAt: row.updated_at,
    }])),
    notes: {
      byBook: Object.fromEntries(rows.notes.map((row) => [row.book_id, row.note_id])),
      updatedAt: Object.fromEntries(rows.notes.map((row) => [row.book_id, row.updated_at])),
      vocabulary: typeof vocabulary === 'string' ? vocabulary : null,
      vocabularyUpdatedAt: typeof vocabulary === 'string' ? vocabularyUpdatedAt : null,
    },
    groups: rows.groups.map((row) => ({
      id: row.id,
      name: row.name,
      bookIds: JSON.parse(row.book_ids || '[]') as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    deleted,
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
  await drainStorageDeletions(c, userId)
  return c.json({
    ok: true as const,
    library: await loadLibrary(c, userId),
    usage: await readerUsage(c.env.DB, userId),
  })
})

/**
 * Merge the account's reading state with what the device holds.
 *
 * Everything here is the trust boundary: an id, a format, a position or a length the client got wrong is
 * refused before the store is asked for anything. The store keeps the server's own facts and lands the
 * whole merge in one batch; see `reader/store.ts`.
 */
readerLibraryRoutes.put('/library', async (c) => {
  const userId = requireId(c.get('userId'), 'User id')
  const body = asRecord(await readJson<Record<string, unknown>>(c, MAX_LIBRARY_BYTES), 'Body')
  const library = asRecord(body.library, 'library')
  const fallbackUpdatedAt = Date.now()
  const current = await store(c, userId).shelf()
  const existingLiveBooks = new Set(current.books.map((row) => row.id))
  const knownBooks = new Set([
    ...existingLiveBooks,
    ...current.syncVersions.filter((row) => row.entity === 'books').map((row) => row.entity_id),
  ])

  const books = Array.isArray(library.books) ? library.books.slice(0, MAX_ROWS) : []
  if (books.length > LIMITS.readerBooksMaxPerUser) {
    throw ApiError.badRequest(`A shelf holds at most ${LIMITS.readerBooksMaxPerUser} books`)
  }
  const bookIds = new Set<string>()
  const bookRows: ShelfBookInput[] = []
  for (const raw of books) {
    const row = asRecord(raw, 'book')
    const id = idOf(row, 'id', 'Book id')
    if (bookIds.has(id)) throw ApiError.badRequest(`Duplicate book id: ${id}`)
    bookIds.add(id)
    knownBooks.add(id)
    // The shelf says a book has a cover by naming the file inside it; `hasCover` is the same fact after
    // a round trip. Either shape counts, so a cover is never left behind because of a field name.
    const wantsCover = row.hasCover === true || (typeof row.coverPath === 'string' && row.coverPath.length > 0)
    const format = textOf(row, 'format', 8) as BookFormat
    if (!(format in EXTENSIONS)) throw ApiError.badRequest(`Unsupported book format: ${format}`)
    const toc = Array.isArray(row.toc) ? row.toc.slice(0, 800) : []
    for (const rawEntry of toc) {
      const entry = asRecord(rawEntry, 'toc entry')
      if (entry.position !== null && entry.position !== undefined && !isPosition(entry.position)) {
        throw ApiError.badRequest('toc entry position is invalid')
      }
    }
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
      tocJson: JSON.stringify(toc),
      addedAt: numberOf(row, 'addedAt', fallbackUpdatedAt),
      updatedAt: updatedAtOf(row, numberOf(row, 'addedAt')),
      fallbackKey: readerBookKey(userId, id, EXTENSIONS[format]),
    })
  }

  const liveIds: Record<DeletedEntity, Set<string>> = {
    books: bookIds,
    progress: new Set(),
    highlights: new Set(),
    marks: new Set(),
    stats: new Set(),
    notes: new Set(),
    groups: new Set(),
  }

  const progressSource = asRecord(library.progress, 'progress')
  const progress: ShelfProgressInput[] = []
  for (const [bookId, raw] of Object.entries(progressSource).slice(0, MAX_ROWS)) {
    const id = requireId(bookId, 'Book id')
    requireBookReference(id, knownBooks, 'Progress')
    liveIds.progress.add(id)
    const row = asRecord(raw, 'progress')
    progress.push({
      bookId: id,
      positionJson: positionJsonOf(row.position ?? null, 'Progress position', true),
      fraction: Math.min(1, Math.max(0, numberOf(row, 'fraction') || Number(row.fraction) || 0)),
      updatedAt: updatedAtOf(row, fallbackUpdatedAt),
      finishedAt: typeof row.finishedAt === 'number' ? row.finishedAt : null,
    })
  }

  const highlights: ShelfHighlightInput[] = []
  const highlightsSource = asRecord(library.highlights, 'reader_highlights')
  for (const [bookId, raw] of Object.entries(highlightsSource).slice(0, MAX_ROWS)) {
    const id = requireId(bookId, 'Book id')
    requireBookReference(id, knownBooks, 'Highlight')
    if (!Array.isArray(raw)) throw ApiError.badRequest('Highlights for a book must be an array')
    for (const item of raw.slice(0, MAX_ROWS)) {
      const row = asRecord(item, 'row')
      const rowId = idOf(row, 'id', 'Row id')
      if (liveIds.highlights.has(rowId)) throw ApiError.badRequest(`Duplicate highlight id: ${rowId}`)
      liveIds.highlights.add(rowId)
      const color = row.color === undefined ? 'yellow' : textOf(row, 'color', 12)
      if (!HIGHLIGHT_COLORS.has(color)) throw ApiError.badRequest(`Unsupported highlight color: ${color}`)
      const start = numberOf(row, 'start')
      const end = numberOf(row, 'end')
      if (start < 0 || end < start) throw ApiError.badRequest('Highlight offsets are invalid')
      highlights.push({
        id: rowId,
        bookId: id,
        chapter: Math.max(0, numberOf(row, 'chapter')),
        startOffset: start,
        endOffset: end,
        quote: textOf(row, 'quote', 20000),
        prefix: textOf(row, 'prefix', 200),
        suffix: textOf(row, 'suffix', 200),
        color,
        comment: textOf(row, 'comment', 4000),
        createdAt: numberOf(row, 'createdAt', fallbackUpdatedAt),
        updatedAt: updatedAtOf(row, fallbackUpdatedAt),
      })
    }
  }

  const marks: ShelfMarkInput[] = []
  const marksSource = asRecord(library.marks, 'reader_marks')
  for (const [bookId, raw] of Object.entries(marksSource).slice(0, MAX_ROWS)) {
    const id = requireId(bookId, 'Book id')
    requireBookReference(id, knownBooks, 'Mark')
    if (!Array.isArray(raw)) throw ApiError.badRequest('Marks for a book must be an array')
    for (const item of raw.slice(0, MAX_ROWS)) {
      const row = asRecord(item, 'row')
      const rowId = idOf(row, 'id', 'Row id')
      if (liveIds.marks.has(rowId)) throw ApiError.badRequest(`Duplicate mark id: ${rowId}`)
      liveIds.marks.add(rowId)
      marks.push({
        id: rowId,
        bookId: id,
        label: textOf(row, 'label', 200, 'Mark'),
        positionJson: positionJsonOf(row.position, 'Mark position', false),
        createdAt: numberOf(row, 'createdAt', fallbackUpdatedAt),
        updatedAt: updatedAtOf(row, fallbackUpdatedAt),
      })
    }
  }

  const statsSource = asRecord(library.stats, 'stats')
  const stats: ShelfStatInput[] = []
  for (const [bookId, raw] of Object.entries(statsSource).slice(0, MAX_ROWS)) {
    const id = requireId(bookId, 'Book id')
    requireBookReference(id, knownBooks, 'Stats')
    liveIds.stats.add(id)
    const row = asRecord(raw, 'stat')
    const days = asRecord(row.days, 'days')
    const clean: Record<string, number> = {}
    for (const [day, seconds] of Object.entries(days).slice(0, 4000)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof seconds === 'number' && seconds > 0) clean[day] = Math.trunc(seconds)
    }
    stats.push({
      bookId: id,
      seconds: Math.max(0, numberOf(row, 'seconds')),
      daysJson: JSON.stringify(clean),
      updatedAt: updatedAtOf(row, fallbackUpdatedAt),
    })
  }

  const notesSource = asRecord(library.notes ?? {}, 'notes')
  const byBook = asRecord(notesSource.byBook ?? {}, 'notes.byBook')
  const noteTimes = asRecord(notesSource.updatedAt ?? {}, 'notes.updatedAt')
  const notes: ShelfNoteInput[] = []
  for (const [bookId, noteId] of Object.entries(byBook).slice(0, MAX_ROWS)) {
    const id = requireId(bookId, 'Book id')
    requireBookReference(id, knownBooks, 'Note')
    if (typeof noteId !== 'string') throw ApiError.badRequest('A note id must be a string')
    liveIds.notes.add(id)
    notes.push({
      bookId: id,
      noteId: noteId.slice(0, 64),
      updatedAt: updatedAtOf({ updatedAt: noteTimes[id] }, fallbackUpdatedAt),
    })
  }
  const vocabulary = typeof notesSource.vocabulary === 'string' ? notesSource.vocabulary.slice(0, 64) : null
  const vocabularyUpdatedAt = vocabulary === null ? null : updatedAtOf({ updatedAt: notesSource.vocabularyUpdatedAt }, fallbackUpdatedAt)

  // A group is only worth keeping if the shelf it points at still exists. Members may name an incoming
  // book or a book already live on the server, but never a tombstone.
  const groupBooks = new Set([...existingLiveBooks, ...bookIds])
  const seenGroups = new Set<string>()
  const groups: ShelfGroupInput[] = []
  for (const raw of (Array.isArray(library.groups) ? library.groups : []).slice(0, GROUPS_MAX)) {
    const row = asRecord(raw, 'group')
    const id = idOf(row, 'id', 'Group id')
    if (liveIds.groups.has(id)) throw ApiError.badRequest(`Duplicate group id: ${id}`)
    liveIds.groups.add(id)
    const name = groupNameOf(row)
    if (!name || seenGroups.has(name.toLowerCase())) continue
    seenGroups.add(name.toLowerCase())
    const members = Array.isArray(row.bookIds)
      ? [...new Set(row.bookIds.filter((one: unknown): one is string => typeof one === 'string' && groupBooks.has(one)))].slice(0, GROUP_BOOKS_MAX)
      : []
    groups.push({
      id,
      name,
      bookIds: members,
      createdAt: numberOf(row, 'createdAt', fallbackUpdatedAt),
      updatedAt: updatedAtOf(row, fallbackUpdatedAt),
    })
  }

  const deleted: ShelfDeletedInput = library.deleted === undefined
    ? {
        books: { ids: [], updatedAt: 0 }, progress: { ids: [], updatedAt: 0 },
        highlights: { ids: [], updatedAt: 0 }, marks: { ids: [], updatedAt: 0 },
        stats: { ids: [], updatedAt: 0 }, notes: { ids: [], updatedAt: 0 },
        groups: { ids: [], updatedAt: 0 }, vocabulary: null,
      }
    : parseDeleted(library.deleted, knownBooks, liveIds)

  const { missingBlobs, missingCovers } = await store(c, userId).merge({
    books: bookRows, progress, highlights, marks, stats, notes, groups,
    vocabulary, vocabularyUpdatedAt, deleted,
  })
  await drainStorageDeletions(c, userId)
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
  const view = new Uint8Array(bytes)
  if (!hasBookMagic(format, view)) throw ApiError.badRequest('The upload does not match the book format')

  const r2 = c.env.FILES
  if (!r2) throw ApiError.notFound('R2 storage is not configured')
  const reservation = `blob:${id}`
  await reserveReaderUpload(c.env.DB, userId, reservation, bytes.byteLength, row.size ?? 0)
  const key = readerBookKey(userId, id, EXTENSIONS[format])
  let stored = false
  try {
    await r2.put(key, bytes, { httpMetadata: { contentType: CONTENT_TYPES[format] } })
    stored = true
    await library.markBlobStored(id, key, bytes.byteLength)
    await releaseReaderUpload(c.env.DB, userId, reservation)
    return c.json({ ok: true as const, size: bytes.byteLength, key })
  } catch (error) {
    if (!stored) await releaseReaderUpload(c.env.DB, userId, reservation)
    throw error
  }
})

function parseByteRange(value: string | null, size: number): { offset: number; length: number } | null {
  if (!value) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim())
  if (!match) return undefined as unknown as null
  const offset = Number(match[1])
  const end = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || offset >= size) return undefined as unknown as null
  return { offset, length: end - offset + 1 }
}

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
  const etag = object.etag
  if (etag && c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } })
  const range = parseByteRange(c.req.header('range') ?? null, object.size)
  if (range === undefined as unknown as null) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${object.size}` } })
  }
  const body = range ? await r2.get(row.r2_key, { range }) : object
  if (!body) throw ApiError.notFound('The file is not in storage')
  const format = row.format as BookFormat
  return new Response(body.body, {
    status: range ? 206 : 200,
    headers: {
      'Content-Type': CONTENT_TYPES[format] ?? 'application/octet-stream',
      'Content-Length': String(body.size),
      ...(range ? { 'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}` } : {}),
      'Accept-Ranges': 'bytes',
      ...(etag ? { ETag: etag } : {}),
      'Content-Disposition': contentDisposition(downloadFilename(row.filename ?? '', id, EXTENSIONS[format])),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
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
  const r2 = c.env.FILES
  if (!r2) throw ApiError.notFound('R2 storage is not configured')
  const reservation = `cover:${id}`
  await reserveReaderUpload(c.env.DB, userId, reservation, buffer.byteLength, row.cover_size ?? 0)
  const key = readerCoverKey(userId, id, extension)
  let stored = false
  try {
    await r2.put(key, buffer, { httpMetadata: { contentType: type } })
    stored = true
    await library.setCover(id, key, buffer.byteLength)
    if (row.cover_key && row.cover_key !== key) await library.queueStorageDeletion(row.cover_key, row.cover_size)
    await releaseReaderUpload(c.env.DB, userId, reservation)
    await drainStorageDeletions(c, userId)
    return c.json({ ok: true as const, size: buffer.byteLength, key })
  } catch (error) {
    if (!stored) await releaseReaderUpload(c.env.DB, userId, reservation)
    throw error
  }
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
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

readerLibraryRoutes.delete('/books/:id', async (c) => {
  const userId = requireId(c.get('userId'), 'User id')
  const id = requireId(c.req.param('id'), 'Book id')
  const library = store(c, userId)
  const row = await library.bookObjects(id)
  if (!row) return c.json({ ok: true as const, removed: false })
  await library.deleteBook(id)
  await drainStorageDeletions(c, userId)
  return c.json({ ok: true as const, removed: true })
})
