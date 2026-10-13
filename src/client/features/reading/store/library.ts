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
import { READER_COVER_TYPES } from '@shared/constants'
import { deleteBookOnServer, downloadBookBytes, IDLE_SYNC, pullLibrary, pushLibrary, uploadBookBytes, uploadCoverBytes, type SyncState } from './cloud'
import type { ReaderUsage } from '@shared/types'
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
  /** What the shelf is doing on the wire right now, which the header bar shows. */
  sync: SyncState
  /** The account's storage figure, as the server last counted it. */
  usage: ReaderUsage | null
  /** Send the reading state up. Called on a debounce after a write, and by the shelf's sync button. */
  syncPush: () => Promise<void>
  /** Take the server's shelf. Only ever adopted when this device has nothing of its own. */
  syncPull: () => Promise<number>
  /** Everything but the files, as text a reader can carry to another device. */
  exportLibrary: () => Promise<string>
  importLibrary: (raw: string) => Promise<{ books: number; highlights: number; rejected: number }>
}

let writeTimer = 0
let pendingUser: string | null | undefined
let writeNow: (() => void) | null = null

/**
 * The write is debounced because a comment edit is one keystroke at a time, but the debounce is also a
 * window in which closing the tab loses the reader's work — so the pending write is flushed when the
 * document goes away rather than being left to the timer.
 */
function schedulePersist(getState: () => LibraryState): void {
  if (pendingUser === undefined) return
  writeNow = () => {
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
  }
  window.clearTimeout(writeTimer)
  writeTimer = window.setTimeout(() => {
    writeNow?.()
    scheduleCloudPush(getState)
  }, 400)
}

let pushTimer = 0

/**
 * The server copy trails the local one by a few seconds.
 *
 * A keystroke in a comment is not a request, and a reader who closes the laptop mid-sentence should not
 * lose more than the debounce is worth. `flushPendingWrites` pushes too, so leaving the page sends what
 * the debounce was still holding.
 */
function scheduleCloudPush(getState: () => LibraryState): void {
  if (!pendingUser) return
  window.clearTimeout(pushTimer)
  pushTimer = window.setTimeout(() => {
    const state = getState()
    if (state.userId) void state.syncPush()
  }, 4000)
}

/**
 * Write whatever is pending the moment the document is being thrown away.
 *
 * Named, and registered as `pagehide` rather than `beforeunload`: this app forbids the browser's own
 * leave-page dialog, and `pagehide` is the event that still fires when the browser discards a tab
 * without asking anything of the reader.
 */
function flushPendingWrites(): void {
  window.clearTimeout(writeTimer)
  window.clearTimeout(pushTimer)
  writeNow?.()
  const state = useLibrary.getState()
  if (state.userId) void state.syncPush()
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPendingWrites)
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
    sync: { ...IDLE_SYNC },
    usage: null,

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
      // A second device or a cleared browser has nothing to lose by adopting the shelf, and everything
      // to gain. A device that already has books keeps them: its next write pushes its own state up.
      if (!data.books.length) {
        try {
          await get().syncPull()
        } catch {
          // The shelf's sync line carries the reason; a blank shelf is still usable offline.
        }
      }
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
          const coverBlob = imported.cover
            ? new Blob([imported.cover as unknown as BlobPart], { type: imported.coverType || 'image/png' })
            : null
          if (coverBlob) {
            await idbSet(keyFor(userId, `cover:${id}`), coverBlob, store)
            set((state) => ({ covers: { ...state.covers, [id]: URL.createObjectURL(coverBlob) } }))
          }
          set((state) => ({ books: [record, ...state.books] }))
          added.push(record)
          if (userId) {
            // The row has to exist server-side before its bytes can be put, so the state goes up first
            // and the file follows. A failure leaves the book readable on this device and says so.
            set({ sync: { ...IDLE_SYNC, phase: 'uploading', bookId: id, total: record.size } })
            try {
              const now = get()
              await pushLibrary({
                books: now.books, progress: now.progress, highlights: now.highlights,
                marks: now.marks, stats: now.stats, notes: now.notes,
              })
              await uploadBookBytes(record, new Blob([imported.bytes as unknown as BlobPart]), (sent, total) => {
                set((state) => ({ sync: { ...state.sync, sent, total } }))
              })
              // The cover goes up too, so the shelf on another device is a shelf of covers and not of
              // placeholders — reading it out of the archive there would cost the whole book.
              if (coverBlob && isUploadableCover(coverBlob.type)) await uploadCoverBytes(id, coverBlob)
              set({ sync: { ...IDLE_SYNC, at: Date.now() } })
            } catch (err) {
              set({ sync: { ...IDLE_SYNC, message: err instanceof Error ? err.message : String(err) } })
            }
          }
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
      // The server copy goes with it. A failure is reported by the next push, which re-sends the shelf
      // without this book anyway.
      void deleteBookOnServer(id).catch(() => {})
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

    async syncPush() {
      const state = get()
      if (!state.userId) return
      set({ sync: { ...state.sync, phase: 'pushing', message: null } })
      try {
        const answer = await pushLibrary({
          books: state.books,
          progress: state.progress,
          highlights: state.highlights,
          marks: state.marks,
          stats: state.stats,
          notes: state.notes,
        })
        // The server says which files it never received: a shelf that predates the sync, or a book whose
        // upload failed while the reader was offline, catches up here rather than staying local forever.
        await uploadMissingFiles(get, answer.missingBlobs, answer.missingCovers)
        set({ sync: { ...IDLE_SYNC, at: answer.at }, usage: answer.usage ?? get().usage })
      } catch (err) {
        set({ sync: { ...IDLE_SYNC, message: err instanceof Error ? err.message : String(err) } })
      }
    },

    async syncPull() {
      const state = get()
      if (!state.userId) return 0
      set({ sync: { ...state.sync, phase: 'pulling', message: null } })
      try {
        const pulled = await pullLibrary()
        const library = pulled.library
        if (!library) throw new Error('The server sent no shelf')
        set({ usage: pulled.usage })
        const books = Array.isArray(library.books) ? library.books : []
        set({
          books,
          progress: library.progress ?? {},
          highlights: library.highlights ?? {},
          marks: library.marks ?? {},
          stats: library.stats ?? {},
          notes: { byBook: library.notes?.byBook ?? {}, vocabulary: library.notes?.vocabulary ?? null },
          sync: { ...IDLE_SYNC, at: Date.now() },
        })
        schedulePersist(get)
        return books.length
      } catch (err) {
        set({ sync: { ...IDLE_SYNC, message: err instanceof Error ? err.message : String(err) } })
        throw err
      }
    },

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
      // The file is a stranger's JSON that later decides which engine reads a book and what the shelf
      // paints, so every field the app trusts is checked rather than copied.
      const wanted = parsed.books.filter((book) => isRecord(book)
        && typeof book.id === 'string' && book.id.length > 0 && book.id.length <= 200
        && typeof book.title === 'string'
        && ['epub', 'pdf', 'cbz'].includes(book.format as string)
        && typeof book.unitCount === 'number' && Number.isFinite(book.unitCount))
        .map((book) => ({ ...book, toc: Array.isArray(book.toc) ? book.toc.filter(isRecord) : [] }))
      const rejected = parsed.books.length - wanted.length
      parsed.books = wanted
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
        rejected,
      }
    },
  }
})

/** A JSON value that can be indexed as an object rather than an array or a primitive. */
function isRecord(value: unknown): value is Record<string, never> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The bytes of a book's file: this device's copy if it has one, the server's otherwise.
 *
 * The download reports itself through the store's `sync`, so the reader opening a book they own but have
 * not fetched here sees a bar move rather than a spinner that never explains itself.
 */
export async function readBookBlob(userId: string | null, bookId: string): Promise<Blob | null> {
  const local = await idbGet<Blob>(keyFor(userId, `book:${bookId}`), store)
  if (local) return local
  if (!userId) return null
  const before = useLibrary.getState().sync
  setSync({ ...IDLE_SYNC, phase: 'downloading', bookId, at: before.at })
  try {
    const blob = await downloadBookBytes(bookId, (sent, total) => {
      setSync({ ...IDLE_SYNC, phase: 'downloading', bookId, sent, total, at: before.at })
    })
    await idbSet(keyFor(userId, `book:${bookId}`), blob, store).catch(() => {})
    setSync({ ...IDLE_SYNC, at: Date.now() })
    return blob
  } catch (err) {
    setSync({ ...IDLE_SYNC, message: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

/** A tiny seam so the free function above can report through the store without a circular import. */
function setSync(sync: SyncState): void {
  useLibrary.setState({ sync })
}

/** A GIF or AVIF comic frame stays on the device: the cloud keeps only the types the route accepts. */
function isUploadableCover(type: string): boolean {
  return type in READER_COVER_TYPES
}

/**
 * Send the files the server is still missing, one at a time.
 *
 * A shelf of ten books should not fill the reader's uplink and stall the page, and a device that does not
 * hold the file either is not a failure — another one will bring it, and the row already exists.
 */
async function uploadMissingFiles(getState: () => LibraryState, bookIds: string[], coverIds: string[]): Promise<void> {
  for (const id of bookIds) {
    const state = getState()
    const book = state.books.find((one) => one.id === id)
    if (!book || !state.userId) continue
    const blob = await idbGet<Blob>(keyFor(state.userId, `book:${id}`), store)
    if (!blob) continue
    setSync({ ...IDLE_SYNC, phase: 'uploading', bookId: id, total: book.size || blob.size })
    await uploadBookBytes(book, blob, (sent, total) => {
      setSync({ ...IDLE_SYNC, phase: 'uploading', bookId: id, sent, total })
    })
  }
  for (const id of coverIds) {
    const state = getState()
    if (!state.userId) continue
    const cover = await idbGet<Blob>(keyFor(state.userId, `cover:${id}`), store)
    if (!cover || !isUploadableCover(cover.type)) continue
    setSync({ ...IDLE_SYNC, phase: 'uploading', bookId: id, total: cover.size })
    await uploadCoverBytes(id, cover)
  }
}
