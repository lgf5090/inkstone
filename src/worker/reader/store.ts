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
}
