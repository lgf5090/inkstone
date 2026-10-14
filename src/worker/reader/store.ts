/**
 * Every read and write the reader shelf routes make against D1.
 *
 * The shape follows `notes/store.ts` and `assistant/store.ts`: a store built per request from the
 * account it serves, methods that take already-validated input and hand back rows or the answer the
 * route needs, and nothing in between that knows about HTTP. Two rules hold throughout:
 *  - every statement binds `user_id`, so one account's shelf can never surface in another's listing.
 *    The book-id lookups here are always `user_id` AND `id`, never `id` alone: the R2 key a row names
 *    is derived from the account, and an unscoped lookup would hand one reader another's bytes.
 *  - a mutation's statements stay in the one D1 batch they are written in today. The shelf replace is
 *    atomic on purpose, and splitting a batch into sequential runs would leave a half-replaced shelf.
 *
 * The shelf listing reads eight tables. They stay eight parallel queries rather than one batch, which
 * is how they run today: a batch would serialize seven reads that have nothing to do with each other.
 */

/**
 * The shelf rows, one per table, listing exactly the columns `shelf()` reads.
 *
 * The queries spell the same columns out rather than reaching for `*`: a column added to a `reader_`
 * table then has to be asked for, so a schema change cannot quietly widen the payload every reader
 * downloads on start-up, and `r2_key`, which is the server's own, cannot leak into it by accident.
 */
export interface ReaderBookRow {
  id: string
  format: string
  title: string
  author: string
  language: string
  publisher: string
  filename: string
  size: number
  added_at: number
  unit_count: number
  has_cover: number
  has_blob: number
  cover_key: string | null
  toc: string
}

export interface ReaderProgressRow {
  book_id: string
  position: string
  fraction: number
  updated_at: number
  finished_at: number | null
}

export interface ReaderHighlightRow {
  id: string
  book_id: string
  chapter: number
  start_offset: number
  end_offset: number
  quote: string
  prefix: string
  suffix: string
  color: string
  comment: string
  created_at: number
  updated_at: number
}

export interface ReaderMarkRow {
  id: string
  book_id: string
  label: string
  position: string
  created_at: number
}

export interface ReaderStatRow {
  book_id: string
  seconds: number
  days: string
}

export interface ReaderBookNoteRow {
  book_id: string
  note_id: string
}

export interface ReaderMetaRow {
  key: string
  value: string | null
}

export interface ReaderGroupRow {
  id: string
  name: string
  book_ids: string
  created_at: number
  updated_at: number
}

/** One account's shelf, as rows, in the order the listing reads them. */
export interface ReaderShelfRows {
  books: ReaderBookRow[]
  progress: ReaderProgressRow[]
  highlights: ReaderHighlightRow[]
  marks: ReaderMarkRow[]
  stats: ReaderStatRow[]
  notes: ReaderBookNoteRow[]
  meta: ReaderMetaRow[]
  groups: ReaderGroupRow[]
}

/** The book rows a push has to know the server-side answer to: where the bytes and the cover live. */
export interface StoredBookRow {
  id: string
  r2_key: string
  has_blob: number
  cover_key: string | null
  cover_size: number
}

/**
 * A validated book row, with the JSON columns already stringified by the route.
 *
 * `fallbackKey` is the R2 path the book takes when the account has never held its bytes: the route owns
 * storage paths, this layer only stores the one it was handed.
 */
export interface ShelfBookInput {
  id: string
  title: string
  author: string
  format: string
  filename: string
  language: string
  publisher: string
  size: number
  unitCount: number
  /** The shelf claims a cover for this book, whichever field it came in on. */
  wantsCover: boolean
  tocJson: string
  addedAt: number
  updatedAt: number
  fallbackKey: string
}

export interface ShelfProgressInput {
  bookId: string
  positionJson: string
  fraction: number
  updatedAt: number
  finishedAt: number | null
}

export interface ShelfHighlightInput {
  id: string
  bookId: string
  chapter: number
  startOffset: number
  endOffset: number
  quote: string
  prefix: string
  suffix: string
  color: string
  comment: string
  createdAt: number
  updatedAt: number
}

export interface ShelfMarkInput {
  id: string
  bookId: string
  label: string
  positionJson: string
  createdAt: number
}

export interface ShelfStatInput {
  bookId: string
  seconds: number
  daysJson: string
}

export interface ShelfNoteInput {
  bookId: string
  noteId: string
}

export interface ShelfGroupInput {
  id: string
  name: string
  /** Members the route kept: strings that name a book on this same shelf. */
  bookIds: string[]
  createdAt: number
  updatedAt: number
}

/** A whole shelf, already validated and sliced by the route, ready to replace what the account had. */
export interface ShelfReplaceInput {
  books: ShelfBookInput[]
  progress: ShelfProgressInput[]
  highlights: ShelfHighlightInput[]
  marks: ShelfMarkInput[]
  stats: ShelfStatInput[]
  notes: ShelfNoteInput[]
  /** `null` when the push said nothing about the reading note's vocabulary. */
  vocabulary: string | null
  groups: ShelfGroupInput[]
}

export interface ShelfReplaceResult {
  /** Books the shelf claims to hold but this account has no bytes for. */
  missingBlobs: string[]
  /** Books the shelf claims a cover for while no cover object was ever stored. */
  missingCovers: string[]
}

/** The tables a shelf replace empties before writing the pushed state back. */
const SHELF_TABLES = [
  'reader_books',
  'reader_progress',
  'reader_highlights',
  'reader_marks',
  'reader_stats',
  'reader_notes',
  'reader_groups',
] as const

export class ReaderLibraryStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /** The whole shelf's reading state, rows only; the route decides the shape the device gets back. */
  async shelf(): Promise<ReaderShelfRows> {
    const [books, progress, highlights, marks, stats, notes, meta, groups] = await Promise.all([
      this.db.prepare(
        `SELECT id, format, title, author, language, publisher, filename, size, added_at, unit_count,
                has_cover, has_blob, cover_key, toc
           FROM reader_books WHERE user_id = ?1 ORDER BY added_at DESC`).bind(this.userId).all<ReaderBookRow>(),
      this.db.prepare(
        `SELECT book_id, position, fraction, updated_at, finished_at
           FROM reader_progress WHERE user_id = ?1`).bind(this.userId).all<ReaderProgressRow>(),
      this.db.prepare(
        `SELECT id, book_id, chapter, start_offset, end_offset, quote, prefix, suffix, color, comment,
                created_at, updated_at
           FROM reader_highlights WHERE user_id = ?1`).bind(this.userId).all<ReaderHighlightRow>(),
      this.db.prepare(
        `SELECT id, book_id, label, position, created_at
           FROM reader_marks WHERE user_id = ?1`).bind(this.userId).all<ReaderMarkRow>(),
      this.db.prepare(
        `SELECT book_id, seconds, days
           FROM reader_stats WHERE user_id = ?1`).bind(this.userId).all<ReaderStatRow>(),
      this.db.prepare(
        `SELECT book_id, note_id
           FROM reader_notes WHERE user_id = ?1`).bind(this.userId).all<ReaderBookNoteRow>(),
      this.db.prepare(
        `SELECT key, value
           FROM reader_meta WHERE user_id = ?1`).bind(this.userId).all<ReaderMetaRow>(),
      this.db.prepare(
        `SELECT id, name, book_ids, created_at, updated_at
           FROM reader_groups WHERE user_id = ?1 ORDER BY updated_at DESC`).bind(this.userId).all<ReaderGroupRow>(),
    ])
    return {
      books: books.results,
      progress: progress.results,
      highlights: highlights.results,
      marks: marks.results,
      stats: stats.results,
      notes: notes.results,
      meta: meta.results,
      groups: groups.results,
    }
  }

  /**
   * Replace the account's reading state with what the device holds.
   *
   * A full replace inside one `batch` is deliberate: the local store is the author of record, and merging
   * row by row would need a clock the two sides agree on. The book rows keep their server-side `r2_key`,
   * which a client never sends and never chooses.
   *
   * Whether the bytes and the cover are in R2 are the server's facts, so a push that does not mention
   * them keeps them, and the books it keeps nothing for are what the device still has to send.
   * Telling the device which files are still missing is what lets a shelf that predates the sync — or a
   * book that was on the device when the last push failed — catch up without a second round trip.
   */
  async replace(input: ShelfReplaceInput): Promise<ShelfReplaceResult> {
    const existing = await this.db
      .prepare('SELECT id, r2_key, has_blob, cover_key, cover_size FROM reader_books WHERE user_id = ?1')
      .bind(this.userId)
      .all<StoredBookRow>()
    const keys = new Map(existing.results.map((row) => [row.id, row.r2_key]))
    const covers = new Map(existing.results
      .filter((row): row is StoredBookRow & { cover_key: string } => Boolean(row.cover_key))
      .map((row) => [row.id, row]))
    const blobs = new Set(existing.results.filter((row) => row.has_blob === 1).map((row) => row.id))

    const statements: D1PreparedStatement[] = SHELF_TABLES.map((table) =>
      this.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(this.userId),
    )

    const missingBlobs: string[] = []
    const missingCovers: string[] = []
    for (const book of input.books) {
      if (!blobs.has(book.id)) missingBlobs.push(book.id)
      if (book.wantsCover && !covers.has(book.id)) missingCovers.push(book.id)
      statements.push(this.db.prepare(
        `INSERT OR REPLACE INTO reader_books (id, user_id, title, author, format, filename, language, publisher, size, unit_count, r2_key, has_cover, toc, added_at, updated_at, has_blob, cover_key, cover_size)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
      ).bind(
        book.id, this.userId, book.title, book.author, book.format, book.filename, book.language, book.publisher,
        book.size, book.unitCount,
        keys.get(book.id) ?? book.fallbackKey,
        book.wantsCover ? 1 : 0, book.tocJson, book.addedAt, book.updatedAt,
        blobs.has(book.id) ? 1 : 0,
        covers.get(book.id)?.cover_key ?? null, covers.get(book.id)?.cover_size ?? 0,
      ))
    }

    for (const row of input.progress) {
      statements.push(this.db.prepare(
        `INSERT OR REPLACE INTO reader_progress (user_id, book_id, position, fraction, updated_at, finished_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(this.userId, row.bookId, row.positionJson, row.fraction, row.updatedAt, row.finishedAt))
    }

    for (const row of input.highlights) {
      statements.push(this.db.prepare(
        `INSERT OR REPLACE INTO reader_highlights (id, user_id, book_id, chapter, start_offset, end_offset, quote, prefix, suffix, color, comment, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      ).bind(row.id, this.userId, row.bookId, row.chapter, row.startOffset, row.endOffset, row.quote,
        row.prefix, row.suffix, row.color, row.comment, row.createdAt, row.updatedAt))
    }

    for (const row of input.marks) {
      statements.push(this.db.prepare(
        `INSERT OR REPLACE INTO reader_marks (id, user_id, book_id, label, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(row.id, this.userId, row.bookId, row.label, row.positionJson, row.createdAt))
    }

    for (const row of input.stats) {
      statements.push(this.db.prepare(
        `INSERT OR REPLACE INTO reader_stats (user_id, book_id, seconds, days) VALUES (?1, ?2, ?3, ?4)`,
      ).bind(this.userId, row.bookId, row.seconds, row.daysJson))
    }

    for (const row of input.notes) {
      statements.push(this.db.prepare(
        `INSERT OR REPLACE INTO reader_notes (user_id, book_id, note_id) VALUES (?1, ?2, ?3)`,
      ).bind(this.userId, row.bookId, row.noteId))
    }
    if (input.vocabulary !== null) {
      statements.push(this.db.prepare(
        `INSERT OR REPLACE INTO reader_meta (user_id, key, value, updated_at) VALUES (?1, 'vocabulary', ?2, ?3)`,
      ).bind(this.userId, input.vocabulary, Date.now()))
    }

    // A group is only worth keeping if the shelf it points at still exists, and two groups with the
    // same name would be one group the reader cannot tell apart.
    const groupStatements = input.groups.map((group) => this.db.prepare(
      `INSERT OR REPLACE INTO reader_groups (id, user_id, name, book_ids, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(group.id, this.userId, group.name, JSON.stringify(group.bookIds), group.createdAt, group.updatedAt))

    await this.db.batch([...statements, ...groupStatements])
    return { missingBlobs, missingCovers }
  }
}
