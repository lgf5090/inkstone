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
import { downloadAsBlob, uploadWithProgress } from '../../../lib/transfer'
import type { BookRecord, BookStats, Highlight, LocationMark, ReadingNoteLinks, ReadingProgress } from '../types'

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

export async function pushLibrary(library: LibraryPayload): Promise<{ at: number; missingBlobs: string[] }> {
  const answer = await api.readerLibrary.put(library)
  return { at: answer.updatedAt, missingBlobs: Array.isArray(answer.missingBlobs) ? answer.missingBlobs : [] }
}

export async function pullLibrary(): Promise<LibraryPayload | null> {
  const answer = await api.readerLibrary.get()
  return answer?.library ?? null
}

export async function deleteBookOnServer(bookId: string): Promise<void> {
  await api.readerLibrary.remove(bookId)
}
