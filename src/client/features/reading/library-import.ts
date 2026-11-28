import { HIGHLIGHT_COLORS, type BookFormat, type BookMetadata, type BookRecord, type BookStats, type Highlight, type LocationMark, type ReadingNoteLinks, type ReadingProgress } from './types'
import type { BookPosition } from './position'
import { normaliseGroups, type BookGroup } from './book-groups'
import { emptyDeletions, type LibraryData, type LibraryDeletions, type LibraryTombstone } from './sync-merge'
import { LIMITS } from '@shared/constants'

const ID_UNSAFE = /[\\/\u0000-\u001f\u007f-\u009f"]/

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max: number, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback
}

function nonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= LIMITS.readerIdMaxChars
    && value.trim() === value && !value.includes('..') && !value.startsWith('~') && !ID_UNSAFE.test(value)
}

function position(value: unknown): BookPosition | null | undefined {
  if (value === null || value === undefined) return null
  if (!record(value)) return undefined
  if (value.kind === 'epub' && Number.isSafeInteger(value.chapter) && Number(value.chapter) >= 0 && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0) {
    return { kind: 'epub', chapter: Number(value.chapter), offset: Number(value.offset) }
  }
  if (value.kind === 'fixed' && Number.isSafeInteger(value.page) && Number(value.page) >= 1) {
    return { kind: 'fixed', page: Number(value.page) }
  }
  return undefined
}

function hasPosition(value: unknown): boolean {
  return position(value) !== undefined
}

function parseToc(value: unknown): BookRecord['toc'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!record(entry) || typeof entry.label !== 'string' || !hasPosition(entry.position)) return []
    return [{ label: entry.label.slice(0, 300), position: position(entry.position) ?? null, level: nonNegative(entry.level) }]
  })
}

function parseMetadata(value: unknown): BookMetadata {
  if (!record(value)) return { series: '', rating: 0, tags: [] }
  const rating = typeof value.rating === 'number' && Number.isFinite(value.rating) ? Math.max(0, Math.min(5, value.rating)) : 0
  return {
    series: text(value.series, 200),
    rating,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20).map((tag) => tag.slice(0, 40)) : [],
  }
}

function parseDeletions(value: unknown): LibraryDeletions {
  const deleted = emptyDeletions()
  if (!record(value)) return deleted
  for (const entity of ['books', 'progress', 'highlights', 'marks', 'stats', 'notes', 'groups'] as const) {
    const rows = value[entity]
    if (!Array.isArray(rows)) continue
    deleted[entity] = rows.flatMap((row): LibraryTombstone[] => {
      if (!record(row) || !validId(row.id)) return []
      return [{ id: row.id, bookId: text(row.bookId, LIMITS.readerIdMaxChars), updatedAt: nonNegative(row.updatedAt) }]
    })
  }
  if (record(value.vocabulary) && value.vocabulary.deleted === true) {
    deleted.vocabulary = { deleted: true, updatedAt: nonNegative(value.vocabulary.updatedAt) }
  }
  return deleted
}

export function parseLibraryExport(raw: string): { data: LibraryData; rejected: number } {
  const parsed: unknown = JSON.parse(raw)
  if (!record(parsed) || !Array.isArray(parsed.books)) throw new Error('This file is not a reading-library export')
  let rejected = 0
  const books: BookRecord[] = []
  const bookIds = new Set<string>()
  for (const value of parsed.books) {
    if (!record(value) || !validId(value.id) || typeof value.title !== 'string'
      || !['epub', 'pdf', 'cbz'].includes(String(value.format))
      || !Number.isSafeInteger(value.unitCount) || Number(value.unitCount) < 0
      || typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0) {
      rejected++
      continue
    }
    const id = value.id
    if (bookIds.has(id)) {
      rejected++
      continue
    }
    bookIds.add(id)
    const addedAt = nonNegative(value.addedAt)
    books.push({
      id,
      format: value.format as BookFormat,
      title: value.title.slice(0, 300),
      author: text(value.author, 200),
      language: text(value.language, 12),
      publisher: text(value.publisher, 200),
      filename: text(value.filename, 240, `${id}.${value.format as string}`),
      size: nonNegative(value.size),
      addedAt,
      updatedAt: nonNegative(value.updatedAt, addedAt),
      unitCount: Number(value.unitCount),
      coverPath: typeof value.coverPath === 'string' ? value.coverPath.slice(0, 500) : null,
      toc: parseToc(value.toc),
      localOnly: nonNegative(value.size) > LIMITS.readerBookMaxBytes,
      contentHash: typeof value.contentHash === 'string' && /^[0-9a-f]{64}$/.test(value.contentHash) ? value.contentHash : '',
      metadata: parseMetadata(value.metadata),
    })
  }

  const progress: Record<string, ReadingProgress> = {}
  if (parsed.progress !== undefined && !record(parsed.progress)) rejected++
  else for (const [bookId, value] of Object.entries(parsed.progress ?? {})) {
    if (!bookIds.has(bookId) || !record(value) || !hasPosition(value.position)
      || typeof value.fraction !== 'number' || !Number.isFinite(value.fraction)) {
      rejected++
      continue
    }
    progress[bookId] = {
      bookId,
      position: position(value.position) ?? null,
      fraction: Math.min(1, Math.max(0, value.fraction)),
      updatedAt: nonNegative(value.updatedAt),
      finishedAt: typeof value.finishedAt === 'number' && Number.isFinite(value.finishedAt) ? value.finishedAt : null,
    }
  }

  const highlights: Record<string, Highlight[]> = {}
  if (parsed.highlights !== undefined && !record(parsed.highlights)) rejected++
  else for (const [bookId, list] of Object.entries(parsed.highlights ?? {})) {
    if (!bookIds.has(bookId) || !Array.isArray(list)) {
      rejected++
      continue
    }
    const kept: Highlight[] = []
    for (const value of list) {
      if (!record(value) || !validId(value.id) || value.bookId !== bookId
        || !Number.isSafeInteger(value.chapter) || Number(value.chapter) < 0
        || !Number.isSafeInteger(value.start) || Number(value.start) < 0
        || !Number.isSafeInteger(value.end) || Number(value.end) <= Number(value.start)
        || !HIGHLIGHT_COLORS.includes(value.color as Highlight['color']) || typeof value.quote !== 'string') {
        rejected++
        continue
      }
      const createdAt = nonNegative(value.createdAt)
      kept.push({
        id: value.id, bookId, chapter: Number(value.chapter), start: Number(value.start), end: Number(value.end),
        color: value.color as Highlight['color'], quote: value.quote.slice(0, 20_000),
        prefix: text(value.prefix, 200), suffix: text(value.suffix, 200), comment: text(value.comment, 4_000),
        createdAt, updatedAt: nonNegative(value.updatedAt, createdAt),
      })
    }
    if (kept.length) highlights[bookId] = kept
  }

  const marks: Record<string, LocationMark[]> = {}
  if (parsed.marks !== undefined && !record(parsed.marks)) rejected++
  else for (const [bookId, list] of Object.entries(parsed.marks ?? {})) {
    if (!bookIds.has(bookId) || !Array.isArray(list)) {
      rejected++
      continue
    }
    const kept: LocationMark[] = []
    for (const value of list) {
      const markPosition = position(value)
      if (!record(value) || !validId(value.id) || value.bookId !== bookId || typeof value.label !== 'string' || !markPosition) {
        rejected++
        continue
      }
      const createdAt = nonNegative(value.createdAt)
      kept.push({ id: value.id, bookId, label: value.label.slice(0, 200), position: markPosition, createdAt, updatedAt: nonNegative(value.updatedAt, createdAt) })
    }
    if (kept.length) marks[bookId] = kept
  }

  const stats: Record<string, BookStats> = {}
  if (parsed.stats !== undefined && !record(parsed.stats)) rejected++
  else for (const [bookId, value] of Object.entries(parsed.stats ?? {})) {
    if (!bookIds.has(bookId) || !record(value) || typeof value.seconds !== 'number' || !Number.isFinite(value.seconds) || !record(value.days)) {
      rejected++
      continue
    }
    const days = Object.fromEntries(Object.entries(value.days).flatMap(([day, seconds]) => (
      /^\d{4}-\d{2}-\d{2}$/.test(day) && typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
        ? [[day, Math.trunc(seconds)] as const] : []
    )))
    stats[bookId] = { bookId, seconds: Math.max(0, Math.trunc(value.seconds)), days, updatedAt: nonNegative(value.updatedAt) }
  }

  const rawNotes = parsed.notes
  const byBook: Record<string, string> = {}
  const noteTimes: Record<string, number> = {}
  if (rawNotes !== undefined && !record(rawNotes)) rejected++
  else if (record(rawNotes)) {
    if (rawNotes.byBook !== undefined && !record(rawNotes.byBook)) rejected++
    else for (const [bookId, noteId] of Object.entries(rawNotes.byBook ?? {})) {
      if (!bookIds.has(bookId) || typeof noteId !== 'string' || !noteId) rejected++
      else {
        byBook[bookId] = noteId.slice(0, 64)
        noteTimes[bookId] = nonNegative(record(rawNotes.updatedAt) ? rawNotes.updatedAt[bookId] : 0)
      }
    }
  }
  const notes: ReadingNoteLinks = {
    byBook,
    updatedAt: noteTimes,
    vocabulary: record(rawNotes) && typeof rawNotes.vocabulary === 'string' ? rawNotes.vocabulary.slice(0, 64) : null,
    vocabularyUpdatedAt: record(rawNotes) && typeof rawNotes.vocabulary === 'string' ? nonNegative(rawNotes.vocabularyUpdatedAt) : null,
  }

  const groups: BookGroup[] = normaliseGroups(Array.isArray(parsed.groups) ? parsed.groups.flatMap((value) => {
    if (!record(value) || !validId(value.id) || typeof value.name !== 'string' || !Array.isArray(value.bookIds)) {
      rejected++
      return []
    }
    const createdAt = nonNegative(value.createdAt)
    return [{
      id: value.id,
      name: value.name.slice(0, 40),
      bookIds: [...new Set(value.bookIds.filter((id): id is string => typeof id === 'string' && bookIds.has(id)))].slice(0, LIMITS.readerBooksMaxPerUser),
      createdAt,
      updatedAt: nonNegative(value.updatedAt, createdAt),
    }]
  }) : [])

  return {
    data: { books, progress, highlights, marks, stats, notes, groups, deleted: parseDeletions(parsed.deleted) },
    rejected,
  }
}
