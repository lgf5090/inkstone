/**
 * The reading library, held on the device.
 *
 * A book file is 2 MB to 200 MB of somebody's private reading, and this app's attachment storage is
 * quota-limited, referenced-by-note, and pruned when nothing points at it — three ways for a shelf to
 * lose a book. So the bytes go to IndexedDB under the same account namespace the note cache uses, and
 * only what a reader *writes* (highlights, the reading note) becomes a note that syncs.
 *
 * That split is deliberate and worth stating to the reader: the shelf is per device, the notes are
 * per account. The export/import pair in the settings is what carries the rest across.
 */
import { create } from 'zustand'
// The store's own `set`/`get` are the zustand pair, so the IndexedDB one is named for what it does.
import { createStore, del as idbRemove, get as idbGet, set as idbSet } from 'idb-keyval'
import { CLIENT_DATABASE_NAME } from '../../../lib/runtime'
import { randomLocalId } from '../../../lib/random-id'
import { importBook, ImportRejected } from '../engine/book-import'
import type {
  BookRecord,
  BookStats,
  Highlight,
  ImportFailure,
  LocationMark,
  ReadingNoteLinks,
  ReadingProgress,
} from '../types'

const store = createStore(CLIENT_DATABASE_NAME, 'kv')

interface PersistedLibrary {
  books: BookRecord[]
  progress: Record<string, ReadingProgress>
  highlights: Record<string, Highlight[]>
  marks: Record<string, LocationMark[]>
  stats: Record<string, BookStats>
  notes: ReadingNoteLinks
}

const EMPTY: PersistedLibrary = {
  books: [],
  progress: {},
  highlights: {},
  marks: {},
  stats: {},
  notes: { byBook: {}, vocabulary: null },
}

function keyFor(user: string | null, suffix: string): string {
  return user ? `user:${user}:reading:${suffix}` : `reading:${suffix}`
}

export interface LibraryState extends PersistedLibrary {
  status: 'idle' | 'loading' | 'ready'
  /** Blob URLs for covers, minted when the shelf loads and revoked when a book is deleted. */
  covers: Record<string, string>
  /** The account whose shelf is open. A change reloads everything. */
  userId: string | null
  bindUser: (userId: string | null) => Promise<void>
  addFiles: (files: File[]) => Promise<{ added: BookRecord[]; failed: ImportFailure[] }>
  removeBook: (id: string) => Promise<void>
  renameBook: (id: string, title: string) => void
  setProgress: (progress: ReadingProgress) => void
  markFinished: (bookId: string, finished: boolean) => void
  addHighlight: (highlight: Omit<Highlight, 'id' | 'createdAt' | 'updatedAt'>) => Highlight
  updateHighlight: (bookId: string, id: string, patch: Partial<Pick<Highlight, 'color' | 'comment'>>) => void
  removeHighlight: (bookId: string, id: string) => void
  addMark: (mark: Omit<LocationMark, 'id' | 'createdAt'>) => void
  removeMark: (bookId: string, id: string) => void
  recordSeconds: (bookId: string, seconds: number) => void
  linkNote: (bookId: string, noteId: string | null) => void
  linkVocabulary: (noteId: string | null) => void
  bookById: (id: string) => BookRecord | undefined
  highlightsOf: (bookId: string) => Highlight[]
  /** Everything but the files, as text a reader can carry to another device. */
  exportLibrary: () => Promise<string>
  importLibrary: (raw: string) => Promise<{ books: number; highlights: number }>
}

let writeTimer = 0
let pendingUser: string | null | undefined

function schedulePersist(getState: () => LibraryState): void {
  if (pendingUser === undefined) return
  window.clearTimeout(writeTimer)
  writeTimer = window.setTimeout(() => {
    const user = pendingUser
    if (user === undefined) return
    const state = getState()
    void persist(user, {
      books: state.books,
      progress: state.progress,
      highlights: state.highlights,
      marks: state.marks,
      stats: state.stats,
      notes: state.notes,
    })
  }, 400)
}

async function persist(user: string | null, data: PersistedLibrary): Promise<void> {
  try {
    await idbSet(keyFor(user, 'library'), data, store)
  } catch (err) {
    // A full device is the realistic failure, and it is the reader's to act on, not something to
    // swallow: the next write would silently start a fresh shelf otherwise.
    console.warn('[reading] could not save the library', err)
  }
}

async function loadLibrary(user: string | null): Promise<PersistedLibrary> {
  const stored = await idbGet<PersistedLibrary>(keyFor(user, 'library'), store)
  if (!stored || typeof stored !== 'object') return { ...EMPTY }
  return {
    books: Array.isArray(stored.books) ? stored.books : [],
    progress: stored.progress ?? {},
    highlights: stored.highlights ?? {},
    marks: stored.marks ?? {},
    stats: stored.stats ?? {},
    notes: { byBook: stored.notes?.byBook ?? {}, vocabulary: stored.notes?.vocabulary ?? null },
  }
}

/** A stable id for a book that survives re-importing the same file, so highlights are not orphaned. */
function identityOf(record: { filename: string; size: number }, identifier?: string): string {
  return identifier || `file:${record.filename}:${record.size}`
}

export const useLibrary = create<LibraryState>((set, get) => {
  return {
    ...EMPTY,
    status: 'idle',
    covers: {},
    userId: null,

    async bindUser(userId) {
      if (get().userId === userId && get().status === 'ready') return
      pendingUser = userId
      set({ status: 'loading', userId })
      const data = await loadLibrary(userId)
      const covers: Record<string, string> = {}
      await Promise.all(data.books.map(async (book) => {
        const blob = await idbGet<Blob>(keyFor(userId, `cover:${book.id}`), store).catch(() => null)
        if (blob) covers[book.id] = URL.createObjectURL(blob)
      }))
      set({ ...data, covers, status: 'ready' })
    },

    async addFiles(files) {
      const added: BookRecord[] = []
      const failed: ImportFailure[] = []
      const userId = get().userId
      const known = new Set(get().books.map((book) => book.id))
      for (const file of files) {
        try {
          const imported = await importBook(file)
          const id = identityOf({ filename: imported.record.filename, size: imported.record.size })
          if (known.has(id)) {
            failed.push({ filename: file.name, reason: 'duplicate' })
            continue
          }
          const record = { ...imported.record, id }
          known.add(id)
          await idbSet(keyFor(userId, `book:${id}`), new Blob([imported.bytes as unknown as BlobPart]), store)
          if (imported.cover) {
            const blob = new Blob([imported.cover as unknown as BlobPart], { type: 'image/png' })
            await idbSet(keyFor(userId, `cover:${id}`), blob, store)
            set((state) => ({ covers: { ...state.covers, [id]: URL.createObjectURL(blob) } }))
          }
          set((state) => ({ books: [record, ...state.books] }))
          added.push(record)
        } catch (err) {
          const reason = err instanceof ImportRejected ? err.reason : 'corrupt'
          failed.push({ filename: file.name, reason })
        }
      }
      schedulePersist(get)
      return { added, failed }
    },

    async removeBook(id) {
      const userId = get().userId
      const url = get().covers[id]
      if (url) URL.revokeObjectURL(url)
      await idbRemove(keyFor(userId, `book:${id}`), store).catch(() => {})
      await idbRemove(keyFor(userId, `cover:${id}`), store).catch(() => {})
      set((state) => {
        const covers = { ...state.covers }
        delete covers[id]
        const progress = { ...state.progress }
        const highlights = { ...state.highlights }
        const marks = { ...state.marks }
        const stats = { ...state.stats }
        const byBook = { ...state.notes.byBook }
        delete progress[id]
        delete highlights[id]
        delete marks[id]
        delete stats[id]
        delete byBook[id]
        return {
          books: state.books.filter((book) => book.id !== id),
          covers,
          progress,
          highlights,
          marks,
          stats,
          notes: { ...state.notes, byBook },
        }
      })
      schedulePersist(get)
    },

    renameBook(id, title) {
      set((state) => ({ books: state.books.map((book) => (book.id === id ? { ...book, title } : book)) }))
      schedulePersist(get)
    },

    setProgress(progress) {
      set((state) => ({ progress: { ...state.progress, [progress.bookId]: progress } }))
      schedulePersist(get)
    },

    markFinished(bookId, finished) {
      set((state) => {
        const current = state.progress[bookId]
        if (!current) return {}
        return {
          progress: {
            ...state.progress,
            [bookId]: { ...current, finishedAt: finished ? Date.now() : null },
          },
        }
      })
      schedulePersist(get)
    },

    addHighlight(highlight) {
      const now = Date.now()
      const created: Highlight = { ...highlight, id: randomLocalId('hl'), createdAt: now, updatedAt: now }
      set((state) => {
        const existing = state.highlights[created.bookId] ?? []
        return { highlights: { ...state.highlights, [created.bookId]: [...existing, created] } }
      })
      schedulePersist(get)
      return created
    },

    updateHighlight(bookId, id, patch) {
      set((state) => ({
        highlights: {
          ...state.highlights,
          [bookId]: (state.highlights[bookId] ?? []).map((one) => (
            one.id === id ? { ...one, ...patch, updatedAt: Date.now() } : one
          )),
        },
      }))
      schedulePersist(get)
    },

    removeHighlight(bookId, id) {
      set((state) => ({
        highlights: { ...state.highlights, [bookId]: (state.highlights[bookId] ?? []).filter((one) => one.id !== id) },
      }))
      schedulePersist(get)
    },

    addMark(mark) {
      const now = Date.now()
      const created: LocationMark = { ...mark, id: randomLocalId('mark'), createdAt: now }
      set((state) => ({ marks: { ...state.marks, [mark.bookId]: [...(state.marks[mark.bookId] ?? []), created] } }))
      schedulePersist(get)
    },

    removeMark(bookId, id) {
      set((state) => ({ marks: { ...state.marks, [bookId]: (state.marks[bookId] ?? []).filter((one) => one.id !== id) } }))
      schedulePersist(get)
    },

    recordSeconds(bookId, seconds) {
      if (seconds <= 0) return
      const day = new Date().toISOString().slice(0, 10)
      set((state) => {
        const current = state.stats[bookId] ?? { bookId, seconds: 0, days: {} }
        return {
          stats: {
            ...state.stats,
            [bookId]: {
              bookId,
              seconds: current.seconds + seconds,
              days: { ...current.days, [day]: (current.days[day] ?? 0) + seconds },
            },
          },
        }
      })
      schedulePersist(get)
    },

    linkNote(bookId, noteId) {
      set((state) => {
        const byBook = { ...state.notes.byBook }
        if (noteId) byBook[bookId] = noteId
        else delete byBook[bookId]
        return { notes: { ...state.notes, byBook } }
      })
      schedulePersist(get)
    },

    linkVocabulary(noteId) {
      set((state) => ({ notes: { ...state.notes, vocabulary: noteId } }))
      schedulePersist(get)
    },

    bookById: (id) => get().books.find((book) => book.id === id),
    highlightsOf: (bookId) => get().highlights[bookId] ?? [],

    async exportLibrary() {
      const state = get()
      return JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        books: state.books,
        progress: state.progress,
        highlights: state.highlights,
        marks: state.marks,
        stats: state.stats,
        notes: state.notes,
      }, null, 2)
    },

    async importLibrary(raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedLibrary>
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.books)) {
        throw new Error('This file is not a reading-library export')
      }
      const state = get()
      const byId = new Map(state.books.map((book) => [book.id, book]))
      for (const book of parsed.books) {
        if (!byId.has(book.id)) byId.set(book.id, book)
      }
      const merged: PersistedLibrary = {
        books: [...byId.values()].sort((a, b) => b.addedAt - a.addedAt),
        progress: { ...parsed.progress, ...state.progress },
        highlights: { ...state.highlights },
        marks: { ...state.marks },
        stats: { ...state.stats },
        notes: { byBook: { ...parsed.notes?.byBook, ...state.notes.byBook }, vocabulary: state.notes.vocabulary ?? parsed.notes?.vocabulary ?? null },
      }
      for (const [bookId, list] of Object.entries(parsed.highlights ?? {})) {
        const seen = new Map((merged.highlights[bookId] ?? []).map((one) => [one.id, one]))
        for (const highlight of list) if (!seen.has(highlight.id)) seen.set(highlight.id, highlight)
        merged.highlights[bookId] = [...seen.values()]
      }
      for (const [bookId, list] of Object.entries(parsed.marks ?? {})) {
        const seen = new Map((merged.marks[bookId] ?? []).map((one) => [one.id, one]))
        for (const mark of list) if (!seen.has(mark.id)) seen.set(mark.id, mark)
        merged.marks[bookId] = [...seen.values()]
      }
      for (const [bookId, value] of Object.entries(parsed.stats ?? {})) {
        const current = merged.stats[bookId]
        merged.stats[bookId] = !current || current.seconds < value.seconds ? value : current
      }
      set(merged)
      schedulePersist(get)
      return {
        books: parsed.books.length,
        highlights: Object.values(merged.highlights).reduce((total, list) => total + list.length, 0),
      }
    },
  }
})

/** The bytes of a book's file, or null when this device no longer holds it. */
export async function readBookBlob(userId: string | null, bookId: string): Promise<Blob | null> {
  return (await idbGet<Blob>(keyFor(userId, `book:${bookId}`), store)) ?? null
}
