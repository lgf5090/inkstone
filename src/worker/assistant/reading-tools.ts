/**
 * The reading tools the assistant can call.
 *
 * The shelf is the account's, not the browser's: the reader app keeps the files and the working copy on
 * the device and pushes the reading state to `reader_*` under the same account, which is the only copy a
 * worker can read. So these tools go through `ReaderLibraryStore`, which binds every statement to the
 * authenticated user; nothing here builds SQL or trusts an id the model made up, and a book that is on
 * somebody else's shelf is simply not in this account's rows.
 *
 * What the shelf holds is metadata: the title, the author, the contents the import cached, where the
 * reader stopped, and the passages they marked. It does not hold the prose of a chapter. A tool that
 * promised to quote a chapter would be inventing it, so `reading_chapter_info` answers the table of
 * contents and the reader's place in it, and says in its own answer that the body text is not available.
 * Reading a chapter would need the EPUB extracted and paginated — a service this app does not have and
 * that this module deliberately does not pretend to offer.
 */

import { ReaderLibraryStore } from '../reader/store'
import { ToolError, type FieldSpec, type ToolContext, type ToolDefinition } from './tools'

/** What one book's rows say, gathered once per call so the listing and the detail agree. */
interface BookEntry {
  row: {
    id: string
    title: string
    author: string
    format: string
    language: string
    publisher: string
    filename: string
    size: number
    added_at: number
    unit_count: number
    has_blob: number
    toc: string
  }
  progress: { fraction: number; updatedAt: number; finishedAt: number | null; position: AnyPosition | null } | null
  highlights: HighlightEntry[]
  marks: MarkEntry[]
  seconds: number
  days: Record<string, number>
  noteId: string | null
  groups: string[]
  toc: TocEntry[]
}

interface Position {
  kind: 'epub'
  chapter: number
  offset: number
}

interface FixedPosition {
  kind: 'fixed'
  page: number
}

type AnyPosition = Position | FixedPosition

interface TocEntry {
  label: string
  level: number
  position: AnyPosition | null
}

interface HighlightEntry {
  id: string
  chapter: number
  start: number
  end: number
  quote: string
  comment: string
  color: string
  createdAt: number
}

interface MarkEntry {
  id: string
  label: string
  position: AnyPosition | null
  createdAt: number
}

const MAX_LISTED_BOOKS = 50
const MAX_LISTED_HIGHLIGHTS = 100
const MAX_LISTED_CHAPTERS = 200
const MAX_QUOTE_CHARS = 600
const MAX_COMMENT_CHARS = 400
const UNFINISHED_TOLERANCE = 0.005

const BOOK_ID_FIELD: FieldSpec = {
  type: 'string',
  description: 'Book id from reading_list_books.',
  maxLength: 240,
  optional: true,
}

const BOOK_QUERY_FIELD: FieldSpec = {
  type: 'string',
  description: 'Title, author or file name words when the id is unknown. Must match exactly one book.',
  maxLength: 200,
  optional: true,
}

/** A position is stored as JSON by the shelf route, and a hand-edited row is not worth trusting. */
function positionOf(raw: unknown): AnyPosition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (row.kind === 'epub') {
    const chapter = Number(row.chapter)
    // A contents entry names the chapter's start, so an omitted offset is that start rather than a bad row.
    const offset = row.offset === undefined ? 0 : Number(row.offset)
    if (!Number.isSafeInteger(chapter) || !Number.isSafeInteger(offset) || chapter < 0 || offset < 0) return null
    return { kind: 'epub', chapter, offset }
  }
  if (row.kind === 'fixed') {
    const page = Number(row.page)
    if (!Number.isSafeInteger(page) || page < 1) return null
    return { kind: 'fixed', page }
  }
  return null
}

function jsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function tocOf(raw: string): TocEntry[] {
  const parsed = jsonObject(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((entry): TocEntry[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const row = entry as Record<string, unknown>
    const label = typeof row.label === 'string' ? row.label.trim().slice(0, 200) : ''
    if (!label) return []
    const level = Number.isSafeInteger(Number(row.level)) ? Math.max(0, Number(row.level)) : 0
    return [{ label, level, position: positionOf(row.position) }]
  })
}

function daysOf(raw: string): Record<string, number> {
  const parsed = jsonObject(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const days: Record<string, number> = {}
  for (const [day, seconds] of Object.entries(parsed as Record<string, unknown>)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      days[day] = Math.round(seconds)
    }
  }
  return days
}

/** The chapter's own title, which is the label a reader recognises, or nothing for an unnamed spine item. */
function chapterTitle(toc: readonly TocEntry[], chapter: number): string | null {
  const entry = toc.find((one) => one.position?.kind === 'epub' && one.position.chapter === chapter)
  return entry?.label ?? null
}

function percentOf(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100)
}

/** Where the reader stopped, in the book's own words: a chapter label, or "page 7 of 120". */
function stoppedAt(entry: BookEntry): string | null {
  const position = entry.progress?.position
  if (!position) return null
  if (position.kind === 'fixed') return `page ${position.page} of ${Math.max(1, entry.row.unit_count)}`
  const title = chapterTitle(entry.toc, position.chapter)
  return title ? `chapter ${position.chapter + 1} · ${title}` : `chapter ${position.chapter + 1}`
}

function lastDay(days: Record<string, number>): string | null {
  const keys = Object.keys(days).sort()
  return keys.length ? keys[keys.length - 1]! : null
}

async function shelfOf(ctx: ToolContext): Promise<BookEntry[]> {
  const rows = await new ReaderLibraryStore(ctx.env.DB, ctx.store.userId).shelf()
  const byId = new Map(rows.books.map((row) => [row.id, row]))
  const highlights = new Map<string, HighlightEntry[]>()
  for (const row of rows.highlights) {
    const bucket = highlights.get(row.book_id) ?? []
    bucket.push({
      id: row.id,
      chapter: row.chapter,
      start: row.start_offset,
      end: row.end_offset,
      quote: row.quote,
      comment: row.comment,
      color: row.color,
      createdAt: row.created_at,
    })
    highlights.set(row.book_id, bucket)
  }
  const marks = new Map<string, MarkEntry[]>()
  for (const row of rows.marks) {
    const bucket = marks.get(row.book_id) ?? []
    bucket.push({ id: row.id, label: row.label, position: positionOf(jsonObject(row.position)), createdAt: row.created_at })
    marks.set(row.book_id, bucket)
  }
  const stats = new Map(rows.stats.map((row) => [row.book_id, row]))
  const notes = new Map(rows.notes.map((row) => [row.book_id, row.note_id]))
  const groups = new Map<string, string[]>()
  for (const group of rows.groups) {
    for (const bookId of JSON.parse(group.book_ids || '[]') as string[]) {
      const bucket = groups.get(bookId) ?? []
      bucket.push(group.name)
      groups.set(bookId, bucket)
    }
  }
  return [...byId.values()].map((row): BookEntry => {
    const progressRow = rows.progress.find((one) => one.book_id === row.id)
    const stat = stats.get(row.id)
    return {
      row,
      progress: progressRow
        ? {
          fraction: progressRow.fraction,
          updatedAt: progressRow.updated_at,
          finishedAt: progressRow.finished_at ?? null,
          position: positionOf(jsonObject(progressRow.position)),
        }
        : null,
      highlights: (highlights.get(row.id) ?? []).sort((a, b) => b.createdAt - a.createdAt),
      marks: marks.get(row.id) ?? [],
      seconds: stat?.seconds ?? 0,
      days: stat ? daysOf(stat.days) : {},
      noteId: notes.get(row.id) ?? null,
      groups: groups.get(row.id) ?? [],
      toc: tocOf(row.toc),
    }
  })
}

function resolveBook(entries: readonly BookEntry[], args: Record<string, unknown>): BookEntry {
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (id) {
    const found = entries.find((entry) => entry.row.id === id)
    if (!found) throw new ToolError('No book on this shelf has that id. Call reading_list_books for the ids.')
    return found
  }
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) throw new ToolError('Name the book by "id" (preferred) or "query".')
  const needle = query.toLowerCase()
  const matches = entries.filter((entry) => `${entry.row.title} ${entry.row.author} ${entry.row.filename}`.toLowerCase().includes(needle))
  if (matches.length === 0) throw new ToolError(`No book matches "${query.slice(0, 60)}". Call reading_list_books to see the shelf.`)
  if (matches.length > 1) {
    const candidates = matches.slice(0, 5).map((entry) => `${entry.row.title} (id=${entry.row.id})`).join('; ')
    throw new ToolError(`More than one book matches "${query.slice(0, 60)}". Call again with one id: ${candidates}`)
  }
  return matches[0]!
}

function bookSummary(entry: BookEntry): Record<string, unknown> {
  const progress = entry.progress
  return {
    id: entry.row.id,
    title: entry.row.title,
    author: entry.row.author,
    format: entry.row.format,
    unit_count: entry.row.unit_count,
    progress_percent: progress ? percentOf(progress.fraction) : 0,
    started: Boolean(progress && progress.fraction > UNFINISHED_TOLERANCE),
    finished: Boolean(progress?.finishedAt),
    last_read_at: progress?.updatedAt ?? null,
    stopped_at: stoppedAt(entry),
    highlight_count: entry.highlights.length,
    note_id: entry.noteId,
    groups: entry.groups,
  }
}

export const READING_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'reading_list_books',
    description: 'List the books on this account\'s reading shelf with their progress, so "what am I reading" and "where did I stop" are answered from the synced shelf rather than from a guess. The shelf is pushed from the reader app a few seconds after a change; an empty answer means nothing has synced yet.',
    permission: 'read',
    fields: {
      status: {
        type: 'string',
        enum: ['all', 'reading', 'finished', 'marked', 'unread'],
        description: 'Only books being read, finished, carrying marks, or not started. Default all.',
        optional: true,
      },
      query: { type: 'string', description: 'Title, author or file name words.', maxLength: 200, optional: true },
      group: { type: 'string', description: 'Shelf group name or id.', maxLength: 60, optional: true },
      limit: { type: 'integer', description: 'Maximum books, 1–50. Default 20.', minimum: 1, maximum: MAX_LISTED_BOOKS, optional: true },
    },
    async run(args, ctx) {
      const entries = await shelfOf(ctx)
      const status = typeof args.status === 'string' ? args.status : 'all'
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const group = typeof args.group === 'string' ? args.group.trim().toLowerCase() : ''
      const limit = typeof args.limit === 'number' ? Math.min(MAX_LISTED_BOOKS, Math.max(1, args.limit)) : 20
      const filtered = entries
        .filter((entry) => {
          const progress = entry.progress
          if (status === 'reading') return Boolean(progress && !progress.finishedAt && progress.fraction > UNFINISHED_TOLERANCE)
          if (status === 'finished') return Boolean(progress?.finishedAt)
          if (status === 'marked') return entry.highlights.length > 0
          if (status === 'unread') return !progress || progress.fraction <= UNFINISHED_TOLERANCE
          return true
        })
        .filter((entry) => (query ? `${entry.row.title} ${entry.row.author} ${entry.row.filename}`.toLowerCase().includes(query) : true))
        .filter((entry) => (group
          ? entry.groups.some((name) => name.toLowerCase().includes(group))
          : true))
        .sort((left, right) => (right.progress?.updatedAt ?? 0) - (left.progress?.updatedAt ?? 0)
          || right.row.added_at - left.row.added_at)
      return {
        total: filtered.length,
        books: filtered.slice(0, limit).map(bookSummary),
        ...(filtered.length > limit ? { truncated: true, note: `Only ${limit} books are shown; narrow with status, query or group.` } : {}),
        ...(entries.length === 0 ? { note: 'This account has no synced books yet. The reading app pushes its shelf a few seconds after a change.' } : {}),
      }
    },
  },
  {
    name: 'reading_book_info',
    description: 'Describe one book on the shelf: author, source file, format, chapter or page count, the reader\'s progress and last position, their marks and reading time. Pass the id from reading_list_books, or a distinct title query.',
    permission: 'read',
    fields: {
      id: BOOK_ID_FIELD,
      query: BOOK_QUERY_FIELD,
    },
    async run(args, ctx) {
      const entry = resolveBook(await shelfOf(ctx), args)
      const progress = entry.progress
      return {
        id: entry.row.id,
        title: entry.row.title,
        author: entry.row.author || null,
        format: entry.row.format,
        source: {
          filename: entry.row.filename,
          size_bytes: entry.row.size,
          publisher: entry.row.publisher || null,
          language: entry.row.language || null,
        },
        chapter_count: entry.row.format === 'epub' ? entry.row.unit_count : 0,
        page_count: entry.row.format === 'epub' ? 0 : entry.row.unit_count,
        toc_entries: entry.toc.length,
        progress: progress
          ? {
            percent: percentOf(progress.fraction),
            position: progress.position,
            stopped_at: stoppedAt(entry),
            updated_at: progress.updatedAt,
            finished_at: progress.finishedAt,
          }
          : null,
        reading: {
          seconds: entry.seconds,
          days: Object.keys(entry.days).length,
          last_day: lastDay(entry.days),
        },
        marks: { highlights: entry.highlights.length, locations: entry.marks.length },
        note_id: entry.noteId,
        groups: entry.groups,
      }
    },
  },
  {
    name: 'reading_list_highlights',
    description: 'List the passages the reader marked in a book, with their own notes on them. Quotes are the reader\'s real marks, not the book text. Use this before turning a mark into a note.',
    permission: 'read',
    fields: {
      id: BOOK_ID_FIELD,
      query: BOOK_QUERY_FIELD,
      chapter: { type: 'integer', description: 'Only marks in this chapter number, counting from 1. Omit for all.', minimum: 1, maximum: 100_000, optional: true },
      limit: { type: 'integer', description: 'Maximum marks, 1–100. Default 30.', minimum: 1, maximum: MAX_LISTED_HIGHLIGHTS, optional: true },
    },
    async run(args, ctx) {
      const entry = resolveBook(await shelfOf(ctx), args)
      const chapter = typeof args.chapter === 'number' ? args.chapter - 1 : null
      const limit = typeof args.limit === 'number' ? Math.min(MAX_LISTED_HIGHLIGHTS, Math.max(1, args.limit)) : 30
      const rows = entry.highlights.filter((one) => (chapter === null ? true : one.chapter === chapter))
      return {
        book: { id: entry.row.id, title: entry.row.title },
        total: rows.length,
        highlights: rows.slice(0, limit).map((one) => ({
          id: one.id,
          chapter: one.chapter + 1,
          chapter_title: chapterTitle(entry.toc, one.chapter),
          color: one.color,
          quote: one.quote.slice(0, MAX_QUOTE_CHARS),
          comment: one.comment.slice(0, MAX_COMMENT_CHARS),
          created_at: one.createdAt,
        })),
        ...(entry.highlights.length === 0 ? { note: 'This book has no marks yet.' } : {}),
        ...(rows.length > limit ? { truncated: true } : {}),
        note_id: entry.noteId,
      }
    },
  },
  {
    name: 'reading_chapter_info',
    description: 'Read the stored table of contents of a book and the reader\'s place in it. This is metadata only: the chapter\'s body text is not available to this app, so never quote a chapter\'s contents from this answer. For a fixed-layout book it answers page metadata instead of chapters.',
    permission: 'read',
    fields: {
      id: BOOK_ID_FIELD,
      query: BOOK_QUERY_FIELD,
      chapter: { type: 'integer', description: 'Chapter number counting from 1. Defaults to the chapter the reader is in.', minimum: 1, maximum: 100_000, optional: true },
      limit: { type: 'integer', description: 'Maximum contents rows, 1–200. Default 80.', minimum: 1, maximum: MAX_LISTED_CHAPTERS, optional: true },
    },
    async run(args, ctx) {
      const entry = resolveBook(await shelfOf(ctx), args)
      const limit = typeof args.limit === 'number' ? Math.min(MAX_LISTED_CHAPTERS, Math.max(1, args.limit)) : 80
      if (entry.row.format !== 'epub') {
        const position = entry.progress?.position
        return {
          book: { id: entry.row.id, title: entry.row.title },
          kind: 'fixed',
          page_count: entry.row.unit_count,
          current_page: position?.kind === 'fixed' ? position.page : null,
          progress_percent: entry.progress ? percentOf(entry.progress.fraction) : 0,
          note: 'A fixed-layout book has pages, not chapters. Only page metadata is stored; the page image and its text stay in the reader app.',
        }
      }
      const current = typeof args.chapter === 'number'
        ? args.chapter - 1
        : entry.progress?.position?.kind === 'epub' ? entry.progress.position.chapter : null
      const chapters = entry.toc.slice(0, limit).map((one, index) => ({
        number: index + 1,
        title: one.label,
        level: one.level,
        chapter_index: one.position?.kind === 'epub' ? one.position.chapter : null,
      }))
      return {
        book: { id: entry.row.id, title: entry.row.title },
        kind: 'epub',
        chapter_count: entry.row.unit_count,
        current: current === null
          ? null
          : {
            number: current + 1,
            title: chapterTitle(entry.toc, current),
            offset: entry.progress?.position?.kind === 'epub' && entry.progress.position.chapter === current
              ? entry.progress.position.offset
              : null,
          },
        chapters,
        ...(entry.toc.length === 0 ? { note: 'This book has no stored table of contents.' } : {}),
        ...(entry.toc.length > limit ? { truncated: true } : {}),
        note: 'Only the table of contents, the chapter count and the reader\'s position are stored. The chapter body is not available here, so do not describe its contents from this answer.',
      }
    },
  },
]
