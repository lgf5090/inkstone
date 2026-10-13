import { LIMITS } from '@shared/constants'
import type { ReaderUsage } from '@shared/types'
import { ApiError } from '../lib/errors'

export async function countLiveNotes(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM notes WHERE user_id = ?1 AND deleted_at IS NULL`)
    .bind(userId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function assertNoteQuota(db: D1Database, userId: string, adding = 1): Promise<void> {
  assertQuotaRoom(await countLiveNotes(db, userId), adding)
}

export function assertQuotaRoom(liveNotes: number, adding = 1): void {
  if (liveNotes + adding > LIMITS.notesMaxPerUser) {
    throw new ApiError(
      403,
      'note_quota_exceeded',
      `This account already holds ${LIMITS.notesMaxPerUser} notes; the quota is exhausted`,
    )
  }
}

/**
 * Import runs hold a per-account import lease, so one count per request can budget every
 * note it inserts instead of paying a COUNT round trip per note.
 */
export interface NoteQuotaBudget {
  remaining: number
}

export async function openNoteQuotaBudget(db: D1Database, userId: string): Promise<NoteQuotaBudget> {
  return { remaining: LIMITS.notesMaxPerUser - await countLiveNotes(db, userId) }
}

export function consumeNoteQuota(budget: NoteQuotaBudget): void {
  if (--budget.remaining < 0) {
    throw new ApiError(
      403,
      'note_quota_exceeded',
      `This account already holds ${LIMITS.notesMaxPerUser} notes; the quota is exhausted`,
    )
  }
}

export async function assertOrganizerQuota(
  db: D1Database,
  userId: string,
  entity: 'folder' | 'tag',
): Promise<void> {
  const max = entity === 'folder' ? LIMITS.foldersMaxPerUser : LIMITS.tagsMaxPerUser
  const where = entity === 'folder'
    ? `SELECT COUNT(*) AS n FROM folders WHERE user_id = ?1 AND deleted_at IS NULL`
    : `SELECT COUNT(*) AS n FROM tags WHERE user_id = ?1`
  const row = await db.prepare(where).bind(userId).first<{ n: number }>()
  if ((row?.n ?? 0) + 1 > max) {
    throw new ApiError(
      403,
      'organizer_quota_exceeded',
      `This account already holds ${max} ${entity}s; the quota is exhausted`,
    )
  }
}

/**
 * The reader's shelf: how much of the account's book budget is gone, and whether more fits.
 *
 * Covers are counted with the books. They are small, but a shelf of five hundred is not, and a usage
 * figure that quietly left them out would be a number nobody could reconcile against the bucket.
 */
export async function readerUsage(db: D1Database, userId: string): Promise<ReaderUsage> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS books,
                     COALESCE(SUM(size), 0) AS bytes,
                     COALESCE(SUM(cover_size), 0) AS covers
                FROM reader_books WHERE user_id = ?1`)
    .bind(userId)
    .first<{ books: number; bytes: number; covers: number }>()
  return {
    books: row?.books ?? 0,
    bytes: row?.bytes ?? 0,
    covers: row?.covers ?? 0,
    quotaBytes: LIMITS.readerQuotaBytes,
    maxBooks: LIMITS.readerBooksMaxPerUser,
  }
}

/**
 * Refuse a file that would take the shelf over its budget.
 *
 * `replacingBytes` is the size the book being overwritten already counts for, so re-uploading a corrected
 * copy of a book costs the difference rather than the whole file.
 */
export async function assertReaderRoom(
  db: D1Database,
  userId: string,
  addingBytes: number,
  addingBooks = 0,
  replacingBytes = 0,
): Promise<void> {
  const usage = await readerUsage(db, userId)
  if (addingBooks > 0 && usage.books + addingBooks > LIMITS.readerBooksMaxPerUser) {
    throw new ApiError(
      403,
      'reader_book_quota_exceeded',
      `This account's shelf holds at most ${LIMITS.readerBooksMaxPerUser} books`,
    )
  }
  const next = usage.bytes + usage.covers + addingBytes - replacingBytes
  if (next > LIMITS.readerQuotaBytes) {
    throw new ApiError(
      403,
      'reader_space_exceeded',
      `This account's shelf has ${Math.max(0, LIMITS.readerQuotaBytes - usage.bytes - usage.covers)} bytes free and the file needs ${addingBytes}`,
    )
  }
}
