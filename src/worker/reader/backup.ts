import { LIMITS } from '@shared/constants'
import { ApiError } from '../lib/errors'
import { readerBookKey, readerCoverKey } from '../db/reader-schema'
import type { Env } from '../env'

const VERSION = 1
const MAX_ROWS = 5000

interface ReaderBackupObject {
  key: string
  bookId: string
  kind: 'book' | 'cover'
  size: number
}

interface ReaderBackupDocument {
  version: number
  exportedAt: string
  books: Record<string, unknown>[]
  progress: Record<string, unknown>[]
  highlights: Record<string, unknown>[]
  marks: Record<string, unknown>[]
  stats: Record<string, unknown>[]
  notes: Record<string, unknown>[]
  groups: Record<string, unknown>[]
  versions: Record<string, unknown>[]
  objects: ReaderBackupObject[]
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function rows(value: unknown): Record<string, unknown>[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_ROWS || !value.every(record)) throw new ApiError(400, 'bad_request', 'Invalid reader backup rows')
  return value
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > LIMITS.readerIdMaxChars || value.includes('..') || /[\\/"\u0000-\u001f]/.test(value)) {
    throw new ApiError(400, 'bad_request', 'Invalid reader backup id')
  }
  return value
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export async function readBackupReader(db: D1Database, userId: string): Promise<string | null> {
  const [books, progress, highlights, marks, stats, notes, groups, versions] = await Promise.all([
    db.prepare('SELECT * FROM reader_books WHERE user_id = ?1 ORDER BY added_at, id').bind(userId).all(),
    db.prepare('SELECT * FROM reader_progress WHERE user_id = ?1').bind(userId).all(),
    db.prepare('SELECT * FROM reader_highlights WHERE user_id = ?1').bind(userId).all(),
    db.prepare('SELECT * FROM reader_marks WHERE user_id = ?1').bind(userId).all(),
    db.prepare('SELECT * FROM reader_stats WHERE user_id = ?1').bind(userId).all(),
    db.prepare('SELECT * FROM reader_notes WHERE user_id = ?1').bind(userId).all(),
    db.prepare('SELECT * FROM reader_groups WHERE user_id = ?1').bind(userId).all(),
    db.prepare('SELECT * FROM reader_sync_versions WHERE user_id = ?1').bind(userId).all(),
  ])
  if (![...books.results, ...progress.results, ...highlights.results, ...versions.results].length) return null
  const objects: ReaderBackupObject[] = books.results.flatMap((row) => {
    const book = row as Record<string, unknown>
    const bookId = id(book.id)
    const entries: ReaderBackupObject[] = []
    if (book.has_blob === 1) entries.push({ key: readerBookKey(userId, bookId, str(book.format)), bookId, kind: 'book', size: num(book.size) })
    if (book.cover_key) entries.push({ key: readerCoverKey(userId, bookId, str(book.cover_key).split('.').at(-1) ?? 'png'), bookId, kind: 'cover', size: num(book.cover_size) })
    return entries
  })
  const document: ReaderBackupDocument = {
    version: VERSION,
    exportedAt: new Date().toISOString(),
    books: books.results as Record<string, unknown>[],
    progress: progress.results as Record<string, unknown>[],
    highlights: highlights.results as Record<string, unknown>[],
    marks: marks.results as Record<string, unknown>[],
    stats: stats.results as Record<string, unknown>[],
    notes: notes.results as Record<string, unknown>[],
    groups: groups.results as Record<string, unknown>[],
    versions: versions.results as Record<string, unknown>[],
    objects,
  }
  return JSON.stringify(document)
}

export async function applyBackupReader(env: Env, userId: string, text: string): Promise<{ books: number; missingObjects: number }> {
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { throw new ApiError(400, 'bad_request', 'The reader backup is not valid JSON') }
  if (!record(value) || value.version !== VERSION) throw new ApiError(400, 'bad_request', 'Unsupported reader backup version')
  const books = rows(value.books)
  const progress = rows(value.progress)
  const highlights = rows(value.highlights)
  const marks = rows(value.marks)
  const stats = rows(value.stats)
  const notes = rows(value.notes)
  const groups = rows(value.groups)
  const versions = rows(value.versions)
  const objects = rows(value.objects) as unknown as ReaderBackupObject[]
  const entities = new Set(['books', 'progress', 'highlights', 'marks', 'stats', 'notes', 'groups', 'vocabulary'])
  for (const object of objects) {
    if (!['book', 'cover'].includes(object.kind)) throw new ApiError(400, 'bad_request', 'Invalid reader backup object kind')
  }
  const statements: D1PreparedStatement[] = []
  for (const row of books) {
    const bookId = id(row.id)
    const format = str(row.format)
    if (!['epub', 'pdf', 'cbz'].includes(format)) throw new ApiError(400, 'bad_request', 'Invalid reader backup format')
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO reader_books (id, user_id, title, author, format, filename, language, publisher, size, unit_count, r2_key, has_cover, toc, added_at, updated_at, has_blob, cover_key, cover_size, content_hash, metadata)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, NULL, 0, ?16, ?17)`,
    ).bind(bookId, userId, str(row.title, 'Untitled').slice(0, 300), str(row.author).slice(0, 200), format,
      str(row.filename, `${bookId}.${format}`).slice(0, 240), str(row.language).slice(0, 12), str(row.publisher).slice(0, 200),
      num(row.size), num(row.unit_count), readerBookKey(userId, bookId, format), row.has_cover === 1 ? 1 : 0,
      str(row.toc, '[]'), num(row.added_at), num(row.updated_at), str(row.content_hash).slice(0, 64), str(row.metadata, '{}').slice(0, 4096)))
  }
  for (const row of progress) statements.push(env.DB.prepare('INSERT OR IGNORE INTO reader_progress (user_id, book_id, position, fraction, updated_at, finished_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(userId, id(row.book_id), str(row.position, 'null'), num(row.fraction), num(row.updated_at), row.finished_at ?? null))
  for (const row of highlights) statements.push(env.DB.prepare('INSERT OR IGNORE INTO reader_highlights (id, user_id, book_id, chapter, start_offset, end_offset, quote, prefix, suffix, color, comment, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)')
    .bind(id(row.id), userId, id(row.book_id), num(row.chapter), num(row.start_offset), num(row.end_offset), str(row.quote).slice(0, 20_000), str(row.prefix).slice(0, 200), str(row.suffix).slice(0, 200), str(row.color, 'yellow').slice(0, 12), str(row.comment).slice(0, 4_000), num(row.created_at), num(row.updated_at)))
  for (const row of marks) statements.push(env.DB.prepare('INSERT OR IGNORE INTO reader_marks (id, user_id, book_id, label, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(id(row.id), userId, id(row.book_id), str(row.label, 'Mark').slice(0, 200), str(row.position), num(row.created_at)))
  for (const row of stats) statements.push(env.DB.prepare('INSERT OR IGNORE INTO reader_stats (user_id, book_id, seconds, days) VALUES (?1, ?2, ?3, ?4)')
    .bind(userId, id(row.book_id), num(row.seconds), str(row.days, '{}')))
  for (const row of notes) statements.push(env.DB.prepare('INSERT OR IGNORE INTO reader_notes (user_id, book_id, note_id) VALUES (?1, ?2, ?3)')
    .bind(userId, id(row.book_id), str(row.note_id).slice(0, 64)))
  for (const row of groups) statements.push(env.DB.prepare('INSERT OR IGNORE INTO reader_groups (id, user_id, name, book_ids, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(id(row.id), userId, str(row.name).slice(0, 40), str(row.book_ids, '[]'), num(row.created_at), num(row.updated_at)))
  for (const row of versions) {
    if (!entities.has(str(row.entity)) || ![0, 1].includes(Number(row.deleted))) throw new ApiError(400, 'bad_request', 'Invalid reader sync version')
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO reader_sync_versions (user_id, entity, entity_id, book_id, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(userId, str(row.entity), id(row.entity_id), str(row.book_id), num(row.updated_at), row.deleted === 1 ? 1 : 0))
  }
  if (statements.length) await env.DB.batch(statements)

  let missingObjects = 0
  for (const object of objects) {
    const bookId = id(object.bookId)
    const expected = object.kind === 'book'
      ? readerBookKey(userId, bookId, object.kind === 'book' ? books.find((row) => row.id === bookId)?.format as string : '')
      : readerCoverKey(userId, bookId, object.key.split('.').at(-1) ?? 'png')
    if (object.key !== expected || object.size < 0 || object.size > LIMITS.readerBookMaxBytes * 2) throw new ApiError(400, 'bad_request', 'The reader backup names an object outside this account')
    const stored = await env.FILES?.get(object.key)
    if (!stored) {
      missingObjects++
      continue
    }
    if (object.kind === 'book') {
      await env.DB.prepare('UPDATE reader_books SET has_blob = 1, size = ? WHERE user_id = ? AND id = ?').bind(stored.size, userId, bookId).run()
    } else {
      await env.DB.prepare('UPDATE reader_books SET cover_key = ?, cover_size = ?, has_cover = 1 WHERE user_id = ? AND id = ?').bind(object.key, stored.size, userId, bookId).run()
    }
  }
  return { books: books.length, missingObjects }
}
