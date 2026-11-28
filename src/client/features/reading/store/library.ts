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
import { coverMediaType, importBook, ImportRejected } from '../engine/book-import'
import { LIMITS, READER_COVER_TYPES } from '@shared/constants'
import { deleteBookOnServer, downloadBookBytes, IDLE_SYNC, pullLibrary, pushLibrary, uploadBookBytes, uploadCoverBytes, type SyncState } from './cloud'
import { createGroup, deleteGroup, normaliseGroups, pruneGroups, renameGroup, toggleBook, type BookGroup, type GroupResult } from '../book-groups'
import { dayKey } from '../format-time'
import { parseLibraryExport } from '../library-import'
import type { ReaderUsage } from '@shared/types'
import {
  clearTombstone,
  emptyDeletions,
  mergeRemoteLibrary,
  tombstonePayload,
  type LibraryData,
  type LibraryDeletionEntity,
  type LibraryDeletions,
  type LibraryTombstone,
} from '../sync-merge'
import type {
  BookRecord,
  Highlight,
  ImportFailure,
  LocationMark,
  ReadingProgress,
} from '../types'

const store = createStore(CLIENT_DATABASE_NAME, 'kv')

type PersistedLibrary = LibraryData

const EMPTY: PersistedLibrary = {
  books: [],
  groups: [],
  progress: {},
  highlights: {},
  marks: {},
  stats: {},
  notes: { byBook: {}, updatedAt: {}, vocabulary: null, vocabularyUpdatedAt: null },
  settings: {},
  settingsUpdatedAt: 0,
  deleted: emptyDeletions(),
}

function keyFor(user: string | null, suffix: string): string {
  return user ? `user:${user}:reading:${suffix}` : `reading:${suffix}`
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** A local write always wins the next merge, even when two writes land in the same millisecond. */
function nextTimestamp(previous = 0): number {
  return Math.max(Date.now(), previous + 1)
}

function isCurrentAccount(epoch: number, userId: string | null): boolean {
  return accountEpoch === epoch && useLibrary.getState().userId === userId
}

function normaliseStoredGroups(value: unknown): BookGroup[] {
  if (!Array.isArray(value)) return []
  return normaliseGroups(value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row
    const group = row as Partial<BookGroup>
    const createdAt = numberOr(group.createdAt)
    return { ...group, createdAt, updatedAt: numberOr(group.updatedAt, createdAt) }
  }))
}

function normaliseStoredDeletions(value: unknown): LibraryDeletions {
  const deleted = emptyDeletions()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return deleted
  const source = value as Partial<LibraryDeletions>
  for (const entity of ['books', 'progress', 'highlights', 'marks', 'stats', 'notes', 'groups'] as const) {
    const rows = source[entity]
    if (!Array.isArray(rows)) continue
    deleted[entity] = rows.flatMap((row) => {
      if (!row || typeof row.id !== 'string' || !row.id) return []
      return [{
        id: row.id,
        bookId: typeof row.bookId === 'string' ? row.bookId : '',
        updatedAt: numberOr(row.updatedAt),
      }]
    })
  }
  if (source.vocabulary?.deleted) {
    deleted.vocabulary = { deleted: true, updatedAt: numberOr(source.vocabulary.updatedAt) }
  }
  return deleted
}

function withTombstone(
  deletions: LibraryDeletions,
  entity: LibraryDeletionEntity,
  id: string,
  bookId: string,
  updatedAt: number,
): LibraryDeletions {
  const rows = deletions[entity]
  const current = rows.find((one) => one.id === id)
  const next: LibraryTombstone[] = !current
    ? [...rows, { id, bookId, updatedAt }]
    : current.updatedAt >= updatedAt
      ? rows
      : rows.map((one) => one.id === id ? { id, bookId, updatedAt } : one)
  return { ...deletions, [entity]: next }
}

function withoutTombstone(
  deletions: LibraryDeletions,
  entity: LibraryDeletionEntity | 'vocabulary',
  id?: string,
): LibraryDeletions {
  return clearTombstone(deletions, entity, id)
}

function revokeCovers(covers: Record<string, string>): void {
  if (typeof URL.revokeObjectURL !== 'function') return
  for (const url of Object.values(covers)) URL.revokeObjectURL(url)
}

function isLocalOnly(book: BookRecord): boolean {
  return book.localOnly === true || book.size > LIMITS.readerBookMaxBytes
}

function cloudBooks(books: BookRecord[]): BookRecord[] {
  return books.filter((book) => !isLocalOnly(book))
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
  updateBookMetadata: (id: string, metadata: BookRecord['metadata'], author?: string) => void
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
  /** A new group. Refuses an empty or already-taken name, and a shelf that is full of them. */
  addGroup: (name: string) => GroupResult
  renameGroup: (id: string, name: string) => GroupResult
  dropGroup: (id: string) => void
  /** Put a book in or out of one group; the group that changed is the one that moves up the list. */
  moveBook: (id: string, bookId: string) => GroupResult
  /** The account's storage figure, as the server last counted it. */
  usage: ReaderUsage | null
  /** Send the reading state up. Called on a debounce after a write, and by the shelf's sync button. */
  syncPush: () => Promise<void>
  /** Take the server's shelf. Only ever adopted when this device has nothing of its own. */
  syncPull: () => Promise<number>
  saveReaderSettings: (settings: Record<string, unknown>) => void
  /** Everything but the files, as text a reader can carry to another device. */
  exportLibrary: () => Promise<string>
  importLibrary: (raw: string) => Promise<{ books: number; highlights: number; rejected: number }>
}

let writeTimer = 0
let pendingUser: string | null | undefined
let writeNow: (() => void) | null = null
let accountEpoch = 0
let pushInFlight: { epoch: number; promise: Promise<void> } | null = null
let pullInFlight: { epoch: number; promise: Promise<number> } | null = null
let initialPull: { epoch: number; promise: Promise<void> } | null = null

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
    const epoch = accountEpoch
    void persist(user, {
      books: state.books,
      progress: state.progress,
      highlights: state.highlights,
      marks: state.marks,
      stats: state.stats,
      notes: state.notes,
      groups: state.groups,
      settings: state.settings,
      settingsUpdatedAt: state.settingsUpdatedAt,
      deleted: state.deleted,
    }, epoch)
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
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    const state = useLibrary.getState()
    if (!state.userId || state.status !== 'ready') return
    void state.syncPull().catch((err) => {
      // The store has already put the failure on the sync line; this only prevents an unhandled rejection.
      console.warn('[reading] background pull failed', err)
    })
  })
}

async function persist(user: string | null, data: PersistedLibrary, epoch = accountEpoch): Promise<void> {
  if (accountEpoch !== epoch || pendingUser !== user) return
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
  if (!stored || typeof stored !== 'object') return { ...EMPTY, deleted: emptyDeletions() }
  return {
    books: Array.isArray(stored.books) ? stored.books.map((book) => {
      const addedAt = numberOr(book.addedAt)
      return { ...book, addedAt, updatedAt: numberOr(book.updatedAt, addedAt), localOnly: isLocalOnly(book) }
    }) : [],
    progress: Object.fromEntries(Object.entries(stored.progress ?? {}).map(([bookId, progress]) => [
      bookId,
      { ...progress, updatedAt: numberOr(progress.updatedAt) },
    ])),
    highlights: Object.fromEntries(Object.entries(stored.highlights ?? {}).map(([bookId, list]) => [
      bookId,
      (Array.isArray(list) ? list : []).map((highlight) => {
        const createdAt = numberOr(highlight.createdAt)
        return { ...highlight, createdAt, updatedAt: numberOr(highlight.updatedAt, createdAt) }
      }),
    ])),
    marks: Object.fromEntries(Object.entries(stored.marks ?? {}).map(([bookId, list]) => [
      bookId,
      (Array.isArray(list) ? list : []).map((mark) => {
        const createdAt = numberOr(mark.createdAt)
        return { ...mark, createdAt, updatedAt: numberOr(mark.updatedAt, createdAt) }
      }),
    ])),
    stats: Object.fromEntries(Object.entries(stored.stats ?? {}).map(([bookId, stats]) => [
      bookId,
      { ...stats, days: stats.days ?? {}, updatedAt: numberOr(stats.updatedAt) },
    ])),
    notes: {
      byBook: stored.notes?.byBook ?? {},
      updatedAt: Object.fromEntries(Object.entries(stored.notes?.updatedAt ?? {}).map(([bookId, updatedAt]) => [bookId, numberOr(updatedAt)])),
      vocabulary: stored.notes?.vocabulary ?? null,
      vocabularyUpdatedAt: stored.notes?.vocabulary ? numberOr(stored.notes.vocabularyUpdatedAt) : null,
    },
    // A shelf written before groups existed has no key to read, which is the same as an empty one.
    groups: normaliseStoredGroups(stored.groups),
    settings: stored.settings && typeof stored.settings === 'object' && !Array.isArray(stored.settings) ? stored.settings : {},
    settingsUpdatedAt: numberOr(stored.settingsUpdatedAt),
    deleted: normaliseStoredDeletions(stored.deleted),
  }
}

/**
 * A stable id for a book that survives re-importing the same file, so highlights are not orphaned.
 *
 * The name in the middle is the reader's own, in their own language — which is exactly why the id is
 * minted from a cleaned copy of it. The shelf route refuses a name with a path separator or a dot-dot in
 * it, because its id becomes an R2 key, and a refusal at sync time reads to the reader as a broken app.
 * Only characters the route cannot accept are replaced, so a name that was already well formed keeps its
 * bytes: an id is a key, and changing one would file a book's highlights under something new.
 *
 * A name longer than the ceiling is hashed rather than sliced, for the same reason — the sliced form
 * would name a different book the next time the same file arrived.
 */
const ID_NAME_UNSAFE = /[\\/\u0000-\u001f\u007f-\u009f"]/g

function idSafeName(value: string): string {
  return value.replace(ID_NAME_UNSAFE, '_').replace(/\.\./g, '.')
}

/** Length in front of a djb2 of the name, so two long names of different lengths never collide. */
function digest(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index++) hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  return `n${value.length.toString(36)}-${(hash >>> 0).toString(36)}`
}

function identityOf(record: { filename: string; size: number }): string {
  const name = idSafeName(record.filename)
  const plain = `file:${name}:${record.size}`
  return plain.length <= LIMITS.readerIdMaxChars ? plain : `file:${digest(name)}:${record.size}`
}

export const useLibrary = create<LibraryState>((set, get) => {
  return {
    ...EMPTY,
    status: 'idle',
    covers: {},
    groups: [],
    userId: null,
    sync: { ...IDLE_SYNC },
    usage: null,

    async bindUser(userId) {
      const current = get()
      if (current.userId === userId && current.status === 'ready') return
      if (current.userId === userId && current.status === 'loading') return

      const epoch = ++accountEpoch
      pendingUser = userId
      initialPull = null
      revokeCovers(current.covers)
      set({ status: 'loading', userId, covers: {}, sync: { ...IDLE_SYNC } })
      const data = await loadLibrary(userId)
      if (!isCurrentAccount(epoch, userId)) return

      const covers: Record<string, string> = {}
      await Promise.all(data.books.map(async (book) => {
        const key = keyFor(userId, `cover:${book.id}`)
        const blob = await idbGet<Blob>(key, store).catch(() => null)
        if (!blob) return
        // A cover kept before its bytes were checked can be the page that *draws* the cover rather than
        // an image, and a tile of markup renders as a broken picture. The stored label is the thing that
        // lied, so look at the header; the bytes are re-derivable from the book, so the bad one goes.
        const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
        if (!coverMediaType(head, null)) {
          // Eviction of a cache entry that was just refused above: the `return` is what decides the shelf,
          // so a failed remove leaves a bad blob on disk that no code path reads again — the next bind
          // re-checks the header and drops it once more.
          await idbRemove(key, store).catch(() => {})
          return
        }
        covers[book.id] = URL.createObjectURL(blob)
      }))
      if (!isCurrentAccount(epoch, userId)) {
        revokeCovers(covers)
        return
      }
      set({ ...data, covers, status: 'ready' })

      // Every device pulls once after its local shelf is painted, not only an empty one. The first push
      // waits for this exchange so an offline empty shelf can never erase a populated cloud shelf.
      const pull = get().syncPull()
      const entry = {
        epoch,
        promise: pull.then(() => undefined, () => undefined).finally(() => {
          if (initialPull?.epoch === epoch) initialPull = null
        }),
      }
      initialPull = entry
    },

    async addFiles(files) {
      const added: BookRecord[] = []
      const failed: ImportFailure[] = []
      const userId = get().userId
      const epoch = accountEpoch
      const known = new Set(get().books.map((book) => book.id))
      for (const file of files) {
        try {
          const imported = await importBook(file)
          if (!isCurrentAccount(epoch, userId)) return { added, failed }
          const id = identityOf({ filename: imported.record.filename, size: imported.record.size })
          if (known.has(id)) {
            failed.push({ filename: file.name, reason: 'duplicate' })
            continue
          }
          const contentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(imported.bytes).buffer)))
            .map((byte) => byte.toString(16).padStart(2, '0')).join('')
          if (get().books.some((book) => book.contentHash === contentHash)) {
            failed.push({ filename: file.name, reason: 'duplicate' })
            continue
          }
          const tombstone = get().deleted.books.find((one) => one.id === id)
          const record = { ...imported.record, id, contentHash, updatedAt: nextTimestamp(tombstone?.updatedAt), localOnly: false }
          known.add(id)
          try {
            await idbSet(keyFor(userId, `book:${id}`), new Blob([imported.bytes as unknown as BlobPart]), store)
          } catch {
            throw new ImportRejected('storage')
          }
          if (!isCurrentAccount(epoch, userId)) return { added, failed }
          const coverBlob = imported.cover
            ? new Blob([imported.cover as unknown as BlobPart], { type: imported.coverType })
            : null
          if (coverBlob) {
            try {
              await idbSet(keyFor(userId, `cover:${id}`), coverBlob, store)
            } catch {
              throw new ImportRejected('storage')
            }
            if (!isCurrentAccount(epoch, userId)) return { added, failed }
            set((state) => ({ covers: { ...state.covers, [id]: URL.createObjectURL(coverBlob) } }))
          }
          set((state) => ({
            books: [record, ...state.books],
            deleted: withoutTombstone(state.deleted, 'books', id),
          }))
          added.push(record)
          if (userId) {
            // The row has to exist server-side before its bytes can be put, so the state goes up first
            // and the file follows. A failure leaves the book readable on this device and says so.
            set({ sync: { ...IDLE_SYNC, phase: 'uploading', bookId: id, total: record.size } })
            try {
              const now = get()
              await pushLibrary({
                books: cloudBooks(now.books), progress: now.progress, highlights: now.highlights,
                marks: now.marks, stats: now.stats, notes: now.notes, groups: now.groups,
                deleted: tombstonePayload(now.deleted),
              })
              if (!isCurrentAccount(epoch, userId)) return { added, failed }
              await uploadBookBytes(record, new Blob([imported.bytes as unknown as BlobPart]), (sent, total) => {
                if (isCurrentAccount(epoch, userId)) set((state) => ({ sync: { ...state.sync, sent, total } }))
              })
              // The cover goes up too, so the shelf on another device is a shelf of covers and not of
              // placeholders — reading it out of the archive there would cost the whole book.
              if (coverBlob && isUploadableCover(coverBlob.type)) await uploadCoverBytes(id, coverBlob)
              set({ sync: { ...IDLE_SYNC, at: Date.now() } })
            } catch (err) {
              if (isCurrentAccount(epoch, userId)) set({ sync: { ...IDLE_SYNC, message: err instanceof Error ? err.message : String(err) } })
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
      const before = get()
      const userId = before.userId
      const epoch = accountEpoch
      const url = before.covers[id]
      if (url) URL.revokeObjectURL(url)
      const versions = [
        before.books.find((book) => book.id === id)?.updatedAt ?? 0,
        before.progress[id]?.updatedAt ?? 0,
        ...(before.highlights[id] ?? []).map((one) => one.updatedAt ?? one.createdAt),
        ...(before.marks[id] ?? []).map((one) => one.updatedAt ?? one.createdAt),
        before.stats[id]?.updatedAt ?? 0,
        before.notes.updatedAt[id] ?? 0,
      ]
      const deletedAt = nextTimestamp(versions.reduce((latest, one) => Math.max(latest, numberOr(one)), 0))
      // Evicting this device's cached bytes. The shelf itself is dropped from state below and persisted
      // with it, so the book is gone from the reader's library whatever these two writes answer; a failed
      // eviction leaves bytes in the cache under a key nothing reads any more.
      await idbRemove(keyFor(userId, `book:${id}`), store).catch(() => {})
      if (!isCurrentAccount(epoch, userId)) return
      await idbRemove(keyFor(userId, `cover:${id}`), store).catch(() => {})
      if (!isCurrentAccount(epoch, userId)) return
      set((state) => {
        const covers = { ...state.covers }
        delete covers[id]
        const progress = { ...state.progress }
        const highlights = { ...state.highlights }
        const marks = { ...state.marks }
        const stats = { ...state.stats }
        const byBook = { ...state.notes.byBook }
        const noteTimes = { ...state.notes.updatedAt }
        delete progress[id]
        delete highlights[id]
        delete marks[id]
        delete stats[id]
        delete byBook[id]
        delete noteTimes[id]
        const surviving = new Set(state.books.filter((book) => book.id !== id).map((book) => book.id))
        let deleted = withTombstone(state.deleted, 'books', id, '', deletedAt)
        deleted = withTombstone(deleted, 'progress', id, id, deletedAt)
        deleted = withTombstone(deleted, 'stats', id, id, deletedAt)
        deleted = withTombstone(deleted, 'notes', id, id, deletedAt)
        for (const highlight of state.highlights[id] ?? []) {
          deleted = withTombstone(deleted, 'highlights', highlight.id, id, deletedAt)
        }
        for (const mark of state.marks[id] ?? []) {
          deleted = withTombstone(deleted, 'marks', mark.id, id, deletedAt)
        }
        return {
          books: state.books.filter((book) => book.id !== id),
          groups: pruneGroups(state.groups, surviving),
          covers,
          progress,
          highlights,
          marks,
          stats,
          notes: { ...state.notes, byBook, updatedAt: noteTimes },
          deleted,
        }
      })
      // The row and bytes still go away server-side when the request succeeds, but the tombstone above
      // is the durable deletion signal: a failed or offline DELETE cannot let an older pull revive it.
      void deleteBookOnServer(id).catch((err) => {
        console.warn('[reading] could not delete the server copy', err)
      })
      schedulePersist(get)
    },

    renameBook(id, title) {
      set((state) => ({
        books: state.books.map((book) => book.id === id
          ? { ...book, title, updatedAt: nextTimestamp(book.updatedAt) }
          : book),
        deleted: withoutTombstone(state.deleted, 'books', id),
      }))
      schedulePersist(get)
    },

    updateBookMetadata(id, metadata, author) {
      set((state) => ({
        books: state.books.map((book) => book.id === id ? { ...book, author: author ?? book.author, metadata, updatedAt: nextTimestamp(book.updatedAt) } : book),
      }))
      schedulePersist(get)
    },

    setProgress(progress) {
      set((state) => {
        const previous = state.progress[progress.bookId]
        const updatedAt = Math.max(numberOr(progress.updatedAt), nextTimestamp(previous?.updatedAt))
        return {
          progress: { ...state.progress, [progress.bookId]: {
            ...progress,
            updatedAt,
            finishedAt: progress.fraction >= 1 ? previous?.finishedAt ?? updatedAt : previous?.finishedAt ?? null,
          } },
          deleted: withoutTombstone(state.deleted, 'progress', progress.bookId),
        }
      })
      schedulePersist(get)
    },

    markFinished(bookId, finished) {
      set((state) => {
        const current = state.progress[bookId]
        const updatedAt = nextTimestamp(current?.updatedAt)
        const progress: ReadingProgress = current
          ? { ...current, finishedAt: finished ? updatedAt : null, updatedAt }
          : { bookId, position: null, fraction: finished ? 1 : 0, updatedAt, finishedAt: finished ? updatedAt : null }
        return {
          progress: { ...state.progress, [bookId]: progress },
          deleted: withoutTombstone(state.deleted, 'progress', bookId),
        }
      })
      schedulePersist(get)
    },

    addHighlight(highlight) {
      const now = Date.now()
      const created: Highlight = { ...highlight, id: randomLocalId('hl'), createdAt: now, updatedAt: now }
      set((state) => {
        const existing = state.highlights[created.bookId] ?? []
        return {
          highlights: { ...state.highlights, [created.bookId]: [...existing, created] },
          deleted: withoutTombstone(state.deleted, 'highlights', created.id),
        }
      })
      schedulePersist(get)
      return created
    },

    updateHighlight(bookId, id, patch) {
      set((state) => ({
        highlights: {
          ...state.highlights,
          [bookId]: (state.highlights[bookId] ?? []).map((one) => (
            one.id === id ? { ...one, ...patch, updatedAt: nextTimestamp(one.updatedAt) } : one
          )),
        },
        deleted: withoutTombstone(state.deleted, 'highlights', id),
      }))
      schedulePersist(get)
    },

    removeHighlight(bookId, id) {
      const previous = get().highlights[bookId]?.find((one) => one.id === id)
      const deletedAt = nextTimestamp(previous?.updatedAt ?? previous?.createdAt)
      set((state) => ({
        highlights: { ...state.highlights, [bookId]: (state.highlights[bookId] ?? []).filter((one) => one.id !== id) },
        deleted: withTombstone(state.deleted, 'highlights', id, bookId, deletedAt),
      }))
      schedulePersist(get)
    },

    addMark(mark) {
      const now = Date.now()
      const created: LocationMark = { ...mark, id: randomLocalId('mark'), createdAt: now, updatedAt: now }
      set((state) => ({
        marks: { ...state.marks, [mark.bookId]: [...(state.marks[mark.bookId] ?? []), created] },
        deleted: withoutTombstone(state.deleted, 'marks', created.id),
      }))
      schedulePersist(get)
    },

    removeMark(bookId, id) {
      const previous = get().marks[bookId]?.find((one) => one.id === id)
      const deletedAt = nextTimestamp(previous?.updatedAt ?? previous?.createdAt)
      set((state) => ({
        marks: { ...state.marks, [bookId]: (state.marks[bookId] ?? []).filter((one) => one.id !== id) },
        deleted: withTombstone(state.deleted, 'marks', id, bookId, deletedAt),
      }))
      schedulePersist(get)
    },

    recordSeconds(bookId, seconds) {
      if (seconds <= 0) return
      const day = dayKey()
      set((state) => {
        const current = state.stats[bookId] ?? { bookId, seconds: 0, days: {}, updatedAt: 0 }
        const updatedAt = nextTimestamp(current.updatedAt)
        return {
          stats: {
            ...state.stats,
            [bookId]: {
              bookId,
              seconds: current.seconds + seconds,
              days: { ...current.days, [day]: (current.days[day] ?? 0) + seconds },
              updatedAt,
            },
          },
          deleted: withoutTombstone(state.deleted, 'stats', bookId),
        }
      })
      schedulePersist(get)
    },

    linkNote(bookId, noteId) {
      set((state) => {
        const byBook = { ...state.notes.byBook }
        const updatedAt = { ...state.notes.updatedAt }
        const changedAt = nextTimestamp(updatedAt[bookId])
        let deleted = state.deleted
        if (noteId) {
          byBook[bookId] = noteId
          updatedAt[bookId] = changedAt
          deleted = withoutTombstone(deleted, 'notes', bookId)
        } else {
          delete byBook[bookId]
          delete updatedAt[bookId]
          deleted = withTombstone(deleted, 'notes', bookId, bookId, changedAt)
        }
        return { notes: { ...state.notes, byBook, updatedAt }, deleted }
      })
      schedulePersist(get)
    },

    linkVocabulary(noteId) {
      set((state) => {
        const updatedAt = nextTimestamp(state.notes.vocabularyUpdatedAt ?? 0)
        return {
          notes: {
            ...state.notes,
            vocabulary: noteId,
            vocabularyUpdatedAt: noteId ? updatedAt : null,
          },
          deleted: noteId
            ? withoutTombstone(state.deleted, 'vocabulary')
            : { ...state.deleted, vocabulary: { deleted: true, updatedAt } },
        }
      })
      schedulePersist(get)
    },

    bookById: (id) => get().books.find((book) => book.id === id),
    highlightsOf: (bookId) => get().highlights[bookId] ?? [],

    addGroup(name) {
      const answer = createGroup(get().groups, name)
      if (answer.ok) {
        const created = answer.groups[answer.groups.length - 1]!
        set((state) => ({
          groups: answer.groups,
          deleted: withoutTombstone(state.deleted, 'groups', created.id),
        }))
        schedulePersist(get)
      }
      return answer
    },

    renameGroup(id, name) {
      const answer = renameGroup(get().groups, id, name)
      if (answer.ok) {
        set((state) => ({
          groups: answer.groups.map((group) => group.id === id
            ? { ...group, updatedAt: nextTimestamp(group.updatedAt) }
            : group),
          deleted: withoutTombstone(state.deleted, 'groups', id),
        }))
        schedulePersist(get)
      }
      return answer
    },

    dropGroup(id) {
      const previous = get().groups.find((group) => group.id === id)
      const deletedAt = nextTimestamp(previous?.updatedAt)
      set((state) => ({
        groups: deleteGroup(state.groups, id),
        deleted: withTombstone(state.deleted, 'groups', id, '', deletedAt),
      }))
      schedulePersist(get)
    },

    moveBook(id, bookId) {
      const answer = toggleBook(get().groups, id, bookId)
      if (answer.ok) {
        set((state) => ({
          groups: answer.groups.map((group) => group.id === id
            ? { ...group, updatedAt: nextTimestamp(group.updatedAt) }
            : group),
          deleted: withoutTombstone(state.deleted, 'groups', id),
        }))
        schedulePersist(get)
      }
      return answer
    },

    syncPush() {
      const epoch = accountEpoch
      const userId = get().userId
      if (!userId) return Promise.resolve()
      const waitForInitialPull = initialPull
      return (async () => {
        if (waitForInitialPull?.epoch === epoch) await waitForInitialPull.promise
        if (!isCurrentAccount(epoch, userId)) return
        const existing = pushInFlight
        if (existing?.epoch === epoch) return existing.promise

        const task = (async () => {
          set({ sync: { ...get().sync, phase: 'pushing', message: null } })
          try {
            const state = get()
            const answer = await pushLibrary({
              books: cloudBooks(state.books),
              progress: state.progress,
              highlights: state.highlights,
              marks: state.marks,
              stats: state.stats,
              notes: state.notes,
              groups: state.groups,
              settings: state.settings,
              settingsUpdatedAt: state.settingsUpdatedAt,
              deleted: tombstonePayload(state.deleted),
            })
            if (!isCurrentAccount(epoch, userId)) return
            // The server says which files it never received: a shelf that predates the sync, or a book whose
            // upload failed while the reader was offline, catches up here rather than staying local forever.
            await uploadMissingFiles(get, answer.missingBlobs, answer.missingCovers, epoch, userId)
            if (!isCurrentAccount(epoch, userId)) return
            set({ sync: { ...IDLE_SYNC, at: answer.at }, usage: answer.usage ?? get().usage })
          } catch (err) {
            if (isCurrentAccount(epoch, userId)) {
              set({ sync: { ...IDLE_SYNC, message: err instanceof Error ? err.message : String(err) } })
            }
          }
        })()
        const entry = { epoch, promise: task }
        pushInFlight = entry
        void task.finally(() => {
          if (pushInFlight === entry) pushInFlight = null
        })
        return task
      })()
    },

    syncPull() {
      const epoch = accountEpoch
      const userId = get().userId
      if (!userId) return Promise.resolve(0)
      const existing = pullInFlight
      if (existing?.epoch === epoch) return existing.promise

      const task = (async () => {
        set({ sync: { ...get().sync, phase: 'pulling', message: null } })
        try {
          const pulled = await pullLibrary()
          if (!isCurrentAccount(epoch, userId)) return 0
          const library = pulled.library
          if (!library) throw new Error('The server sent no shelf')
          const current = get()
          const merged = mergeRemoteLibrary({
            books: current.books,
            progress: current.progress,
            highlights: current.highlights,
            marks: current.marks,
            stats: current.stats,
            notes: current.notes,
            groups: current.groups,
            deleted: current.deleted,
          }, library)
          const surviving = new Set(merged.books.map((book) => book.id))
          for (const book of current.books) {
            if (surviving.has(book.id)) continue
            const url = current.covers[book.id]
            if (url) URL.revokeObjectURL(url)
          }
          const covers = Object.fromEntries(Object.entries(current.covers).filter(([id]) => surviving.has(id)))
          set({ ...merged, covers, usage: pulled.usage, sync: { ...IDLE_SYNC, at: Date.now() } })
          await persist(userId, merged, epoch)
          return merged.books.length
        } catch (err) {
          if (!isCurrentAccount(epoch, userId)) return 0
          set({ sync: { ...IDLE_SYNC, message: err instanceof Error ? err.message : String(err) } })
          throw err
        }
      })()
      const entry = { epoch, promise: task }
      pullInFlight = entry
      void task.finally(() => {
        if (pullInFlight === entry) pullInFlight = null
      })
      return task
    },

    saveReaderSettings(settings) {
      set((state) => ({ settings, settingsUpdatedAt: nextTimestamp(state.settingsUpdatedAt) }))
      schedulePersist(get)
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
        groups: state.groups,
        deleted: state.deleted,
      }, null, 2)
    },

    async importLibrary(raw) {
      const { data: incoming, rejected } = parseLibraryExport(raw)
      const state = get()
      // Import is the same id-versioned merge as a pull, including explicit deletion tombstones.
      const merged = mergeRemoteLibrary({
        books: state.books,
        progress: state.progress,
        highlights: state.highlights,
        marks: state.marks,
        stats: state.stats,
        notes: state.notes,
        groups: state.groups,
        settings: state.settings,
        settingsUpdatedAt: state.settingsUpdatedAt,
        deleted: state.deleted,
      }, incoming)
      set(merged)
      schedulePersist(get)
      return {
        books: incoming.books.length,
        highlights: Object.values(merged.highlights).reduce((total, list) => total + list.length, 0),
        rejected,
      }
    },
  }
})

/**
 * The bytes of a book's file: this device's copy if it has one, the server's otherwise.
 *
 * The download reports itself through the store's `sync`, so the reader opening a book they own but have
 * not fetched here sees a bar move rather than a spinner that never explains itself.
 */
export async function readBookBlob(userId: string | null, bookId: string): Promise<Blob | null> {
  const epoch = accountEpoch
  const local = await idbGet<Blob>(keyFor(userId, `book:${bookId}`), store)
  if (local) return local
  if (!userId || !isCurrentAccount(epoch, userId)) return null
  const before = useLibrary.getState().sync
  setSync({ ...IDLE_SYNC, phase: 'downloading', bookId, at: before.at })
  try {
    const blob = await downloadBookBytes(bookId, (sent, total) => {
      if (isCurrentAccount(epoch, userId)) setSync({ ...IDLE_SYNC, phase: 'downloading', bookId, sent, total, at: before.at })
    })
    if (!isCurrentAccount(epoch, userId)) return blob
    // Caching what the caller already has in hand. The blob is returned from this function either way, so
    // the read the reader asked for is complete; what a failed write costs is the offline copy, and the
    // next open of this book asks the server again.
    await idbSet(keyFor(userId, `book:${bookId}`), blob, store).catch(() => {})
    if (!isCurrentAccount(epoch, userId)) return blob
    setSync({ ...IDLE_SYNC, at: Date.now() })
    return blob
  } catch (err) {
    if (isCurrentAccount(epoch, userId)) setSync({ ...IDLE_SYNC, message: err instanceof Error ? err.message : String(err) })
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
async function uploadMissingFiles(
  getState: () => LibraryState,
  bookIds: string[],
  coverIds: string[],
  epoch: number,
  userId: string,
): Promise<void> {
  for (const id of bookIds) {
    if (!isCurrentAccount(epoch, userId)) return
    const state = getState()
    const book = state.books.find((one) => one.id === id)
    if (!book || state.userId !== userId || isLocalOnly(book)) continue
    const blob = await idbGet<Blob>(keyFor(userId, `book:${id}`), store)
    if (!blob || !isCurrentAccount(epoch, userId)) continue
    setSync({ ...IDLE_SYNC, phase: 'uploading', bookId: id, total: book.size || blob.size })
    await uploadBookBytes(book, blob, (sent, total) => {
      if (isCurrentAccount(epoch, userId)) {
        setSync({ ...IDLE_SYNC, phase: 'uploading', bookId: id, sent, total })
      }
    })
  }
  for (const id of coverIds) {
    if (!isCurrentAccount(epoch, userId)) return
    const cover = await idbGet<Blob>(keyFor(userId, `cover:${id}`), store)
    if (!cover || !isUploadableCover(cover.type) || !isCurrentAccount(epoch, userId)) continue
    setSync({ ...IDLE_SYNC, phase: 'uploading', bookId: id, total: cover.size })
    await uploadCoverBytes(id, cover)
  }
}
