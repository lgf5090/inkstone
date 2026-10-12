import type { BookPosition } from './position'

export type BookFormat = 'epub' | 'pdf' | 'cbz'

/** What the shelf knows about a book without opening it again. */
export interface BookRecord {
  id: string
  format: BookFormat
  title: string
  author: string
  language: string
  publisher: string
  /** The name the file arrived under, which is what a reader looks for when they re-import. */
  filename: string
  size: number
  addedAt: number
  /** Number of spine items or pages; the denominator of every progress figure the shelf shows. */
  unitCount: number
  /** Package path of the cover inside the archive, when the format carries one. */
  coverPath: string | null
  /** The book's own contents, cached so the shelf, the note and the reader agree without a reparse. */
  toc: TocEntry[]
}

export interface TocEntry {
  label: string
  /** A position rather than an href: the archive is gone by the time a note reads this back. */
  position: BookPosition | null
  level: number
}

export interface ReadingProgress {
  bookId: string
  position: BookPosition | null
  /** 0…1, weighted by prose length for a flowing book and by page for a fixed one. */
  fraction: number
  updatedAt: number
  finishedAt: number | null
}

export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink', 'red', 'purple'] as const
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]

/**
 * A passage the reader marked.
 *
 * `start`/`end` are character offsets into the chapter's own text, and the quote plus its two
 * neighbours are what lets the reader tell whether those offsets still mean the same thing after a
 * re-import of a different edition of the same file.
 */
export interface Highlight {
  id: string
  bookId: string
  chapter: number
  start: number
  end: number
  color: HighlightColor
  quote: string
  prefix: string
  suffix: string
  comment: string
  createdAt: number
  updatedAt: number
}

/** A named place: "come back here", not "this sentence matters". */
export interface LocationMark {
  id: string
  bookId: string
  label: string
  position: BookPosition
  createdAt: number
}

export interface BookStats {
  bookId: string
  seconds: number
  /** Day keys (`YYYY-MM-DD`) to seconds, which is what the daily goal is measured against. */
  days: Record<string, number>
}

/** Which note a book's highlights are being written into, and where the vocabulary note lives. */
export interface ReadingNoteLinks {
  byBook: Record<string, string>
  vocabulary: string | null
}

export interface ImportFailure {
  filename: string
  reason: 'format' | 'size' | 'corrupt' | 'duplicate' | 'storage'
}

export const MAX_BOOK_BYTES = 200 * 1024 * 1024
