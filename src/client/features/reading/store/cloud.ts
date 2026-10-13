/**
 * The shelf's conversation with the server.
 *
 * The local IndexedDB copy stays the source the UI reads — a page must paint before any request returns —
 * and this module is what keeps the two ends in step: a debounced push of the reading state, a book's
 * bytes uploaded once, and a pull for a device that has never seen the shelf.
 *
 * Every failure here is reported rather than swallowed. A reader who thinks their notes are backed up
 * when the push failed on the third try is worse off than one who was told.
 */
import { api } from '../../../lib/api'
import type { ReaderUsage } from '@shared/types'
import { downloadAsBlob, uploadWithProgress } from '../../../lib/transfer'
import type { BookRecord, BookStats, Highlight, LocationMark, ReadingNoteLinks, ReadingProgress } from '../types'
import type { BookGroup } from '../book-groups'

export interface SyncState {
  phase: 'idle' | 'uploading' | 'downloading' | 'pushing' | 'pulling'
  bookId: string | null
  sent: number
  total: number
  message: string | null
  /** Wall time of the last successful exchange, so the shelf can say when it last spoke to the server. */
  at: number
}

export const IDLE_SYNC: SyncState = { phase: 'idle', bookId: null, sent: 0, total: 0, message: null, at: 0 }

/** The shelf as text: everything the local store holds except the book files themselves. */
export interface LibraryPayload {
  books: BookRecord[]
  progress: Record<string, ReadingProgress>
  highlights: Record<string, Highlight[]>
  marks: Record<string, LocationMark[]>
  stats: Record<string, BookStats>
  notes: ReadingNoteLinks
  groups: BookGroup[]
}

/** Upload a book's bytes. The row must already exist server-side, which the push of the state does. */
export async function uploadBookBytes(
  book: BookRecord,
  bytes: Blob,
  onProgress: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  await uploadWithProgress(api.readerLibrary.blobUrl(book.id), bytes, book.size || bytes.size, onProgress, signal)
}

export async function downloadBookBytes(
  bookId: string,
  onProgress: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  return downloadAsBlob(api.readerLibrary.blobUrl(bookId), onProgress, signal)
}

export interface PushResult {
  at: number
  missingBlobs: string[]
  missingCovers: string[]
  usage: ReaderUsage | null
}

export async function pushLibrary(library: LibraryPayload): Promise<PushResult> {
  const answer = await api.readerLibrary.put(library)
  return {
    at: answer.updatedAt,
    missingBlobs: Array.isArray(answer.missingBlobs) ? answer.missingBlobs : [],
    missingCovers: Array.isArray(answer.missingCovers) ? answer.missingCovers : [],
    usage: answer.usage ?? null,
  }
}

export async function pullLibrary(): Promise<{ library: LibraryPayload | null; usage: ReaderUsage | null }> {
  const answer = await api.readerLibrary.get()
  return { library: answer?.library ?? null, usage: answer?.usage ?? null }
}

/** The cover on its own, so a second device paints a shelf of covers without downloading any book. */
export async function uploadCoverBytes(bookId: string, blob: Blob): Promise<void> {
  await uploadWithProgress(api.readerLibrary.coverUrl(bookId), blob, blob.size)
}

export async function deleteBookOnServer(bookId: string): Promise<void> {
  await api.readerLibrary.remove(bookId)
}
