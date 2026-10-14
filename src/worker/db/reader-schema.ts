/**
 * The reader's own tables, all prefixed `reader_` so they are recognisable in the D1 console and never
 * collide with the note tables.
 *
 * The book binaries are not here: they live in R2 under `reader/<user>/<id>.<ext>`, and `reader_books`
 * holds the key alongside the metadata. Every table is keyed on `user_id` first because the routes read
 * one account's shelf at a time, and a query that forgot the column would hand another reader's notes
 * over — the shape a `PRIMARY KEY (user_id, …)` makes impossible to write by accident.
 */
/**
 * The shelf itself, keyed on the account first.
 *
 * A book's id is minted by the reader from the file's own name and size, so it is content, not a
 * random token: two accounts that added the same public-domain file hold the same string. Made
 * globally unique, that let one account's push replace another's row away, so the key is the pair.
 */
export const READER_BOOK_TABLE = `CREATE TABLE IF NOT EXISTS reader_books (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL,
  filename TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  unit_count INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  has_cover INTEGER NOT NULL DEFAULT 0,
  toc TEXT NOT NULL DEFAULT '[]',
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  /** Whether this account's bytes are actually in R2. The server owns it: a push never clears it. */
  has_blob INTEGER NOT NULL DEFAULT 0,
  cover_key TEXT,
  cover_size INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
)`

/** A reader-named collection of books. Membership is the group's own list, so a book can be in several. */
export const READER_GROUP_TABLE = `CREATE TABLE IF NOT EXISTS reader_groups (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  book_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
)`

export const READER_GROUP_INDEX = `CREATE INDEX IF NOT EXISTS idx_reader_groups_user ON reader_groups(user_id, updated_at DESC, id)`

/** The shelf's own read path: one account, newest first. Rebuilt alongside the table it indexes. */
export const READER_BOOK_INDEX = `CREATE INDEX IF NOT EXISTS idx_reader_books_user ON reader_books(user_id, added_at DESC, id)`

export const READER_SCHEMA_STATEMENTS: readonly string[] = [
  READER_BOOK_TABLE,
  READER_GROUP_TABLE,
  READER_GROUP_INDEX,
  READER_BOOK_INDEX,
  `CREATE TABLE IF NOT EXISTS reader_progress (
    user_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    position TEXT NOT NULL,
    fraction REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER,
    PRIMARY KEY (user_id, book_id)
  )`,
  `CREATE TABLE IF NOT EXISTS reader_highlights (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    chapter INTEGER NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    quote TEXT NOT NULL,
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reader_highlights_book
     ON reader_highlights(user_id, book_id, chapter, start_offset)`,
  `CREATE TABLE IF NOT EXISTS reader_marks (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    label TEXT NOT NULL,
    position TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reader_marks_book ON reader_marks(user_id, book_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS reader_stats (
    user_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    days TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, book_id)
  )`,
  `CREATE TABLE IF NOT EXISTS reader_notes (
    user_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    PRIMARY KEY (user_id, book_id)
  )`,
  `CREATE TABLE IF NOT EXISTS reader_meta (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
]

/** Where a book's bytes live. Built from the row, never accepted from a client. */
export function readerBookKey(userId: string, bookId: string, extension: string): string {
  return `reader/${userId}/${bookId}.${extension}`
}

/**
 * Where a cover lives. The extension is chosen here from the image type the client sent, so a cover
 * cannot be talked into landing on a path some other object owns.
 */
export function readerCoverKey(userId: string, bookId: string, extension: string): string {
  return `reader/${userId}/${bookId}.cover.${extension}`
}
