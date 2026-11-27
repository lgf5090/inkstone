import type { BookGroup } from './book-groups'
import type {
  BookRecord,
  BookStats,
  Highlight,
  LocationMark,
  ReadingNoteLinks,
  ReadingProgress,
} from './types'

export const LIBRARY_DELETION_ENTITIES = [
  'books',
  'progress',
  'highlights',
  'marks',
  'stats',
  'notes',
  'groups',
] as const

export type LibraryDeletionEntity = (typeof LIBRARY_DELETION_ENTITIES)[number]

export interface LibraryTombstone {
  id: string
  bookId: string
  updatedAt: number
}

export interface LibraryDeletions {
  books: LibraryTombstone[]
  progress: LibraryTombstone[]
  highlights: LibraryTombstone[]
  marks: LibraryTombstone[]
  stats: LibraryTombstone[]
  notes: LibraryTombstone[]
  groups: LibraryTombstone[]
  vocabulary: { deleted: true; updatedAt: number } | null
}

/** Everything the shelf syncs except the book bytes themselves. */
export interface LibraryData {
  books: BookRecord[]
  progress: Record<string, ReadingProgress>
  highlights: Record<string, Highlight[]>
  marks: Record<string, LocationMark[]>
  stats: Record<string, BookStats>
  notes: ReadingNoteLinks
  groups: BookGroup[]
  deleted: LibraryDeletions
}

export function emptyDeletions(): LibraryDeletions {
  return {
    books: [],
    progress: [],
    highlights: [],
    marks: [],
    stats: [],
    notes: [],
    groups: [],
    vocabulary: null,
  }
}

/** Remove one live/deleted conflict without mutating the persisted snapshot. */
export function clearTombstone(
  deletions: LibraryDeletions,
  entity: LibraryDeletionEntity | 'vocabulary',
  id?: string,
): LibraryDeletions {
  if (entity === 'vocabulary') return { ...deletions, vocabulary: null }
  if (!id) return deletions
  return { ...deletions, [entity]: deletions[entity].filter((one) => one.id !== id) }
}

/** The PUT route takes one timestamp per entity rather than one timestamp per tombstone. */
export function tombstonePayload(deletions: LibraryDeletions): {
  books: { ids: string[]; updatedAt: number }
  progress: { ids: string[]; updatedAt: number }
  highlights: { ids: string[]; updatedAt: number }
  marks: { ids: string[]; updatedAt: number }
  stats: { ids: string[]; updatedAt: number }
  notes: { ids: string[]; updatedAt: number }
  groups: { ids: string[]; updatedAt: number }
  vocabulary: { deleted: boolean; updatedAt: number }
} {
  const payload = {} as ReturnType<typeof tombstonePayload>
  for (const entity of LIBRARY_DELETION_ENTITIES) {
    const rows = deletions[entity]
    payload[entity] = {
      ids: [...new Set(rows.map((one) => one.id))],
      updatedAt: rows.reduce((latest, one) => Math.max(latest, timestamp(one.updatedAt)), 0),
    }
  }
  payload.vocabulary = deletions.vocabulary
    ? { deleted: true, updatedAt: timestamp(deletions.vocabulary.updatedAt) }
    : { deleted: false, updatedAt: 0 }
  return payload
}

export type TombstonePayload = ReturnType<typeof tombstonePayload>

/**
 * Merge a server shelf into the device's shelf.
 *
 * The server is a merge of snapshots, not a authoritative replacement: omitted rows stay on the device,
 * a live row wins only with a newer version, and a tombstone loses to a newer local row. A deleted book
 * owns its children, so its tombstone also clears those rows and removes it from every group.
 */
export function mergeRemoteLibrary(local: LibraryData, remote: LibraryData): LibraryData {
  const localData = normaliseLibrary(local)
  const remoteData = normaliseLibrary(remote)
  const deleted = emptyDeletions()

  for (const entity of LIBRARY_DELETION_ENTITIES) {
    deleted[entity] = mergeTombstones(localData.deleted[entity], remoteData.deleted[entity])
  }
  const localVocabulary = localData.deleted.vocabulary
  const remoteVocabulary = remoteData.deleted.vocabulary
  deleted.vocabulary = localVocabulary || remoteVocabulary
    ? {
        deleted: true,
        updatedAt: Math.max(timestamp(localVocabulary?.updatedAt), timestamp(remoteVocabulary?.updatedAt)),
      }
    : null

  const bookVersions = tombstoneMap(deleted.books)
  const books = new Map(localData.books.map((book) => [book.id, book]))
  const deletedBookIds = new Set<string>()

  for (const book of localData.books) {
    const tombstone = bookVersions.get(book.id)
    if (!tombstone) continue
    if (tombstone.updatedAt >= timestamp(book.updatedAt)) {
      books.delete(book.id)
      deletedBookIds.add(book.id)
    } else {
      bookVersions.delete(book.id)
    }
  }
  for (const book of remoteData.books) {
    const tombstone = bookVersions.get(book.id)
    if (tombstone && tombstone.updatedAt >= timestamp(book.updatedAt)) continue
    const mine = books.get(book.id)
    if (!mine || timestamp(book.updatedAt) > timestamp(mine.updatedAt)) books.set(book.id, book)
    bookVersions.delete(book.id)
    deletedBookIds.delete(book.id)
  }
  for (const id of bookVersions.keys()) {
    if (!books.has(id)) deletedBookIds.add(id)
  }
  deleted.books = [...bookVersions.values()]

  const progressVersions = tombstoneMap(deleted.progress)
  const progress = mergeKeyedRecords(localData.progress, remoteData.progress, progressVersions, (one) => one.bookId)
  deleted.progress = [...progressVersions.values()]

  const statsVersions = tombstoneMap(deleted.stats)
  const stats = mergeKeyedRecords(localData.stats, remoteData.stats, statsVersions, (one) => one.bookId)
  deleted.stats = [...statsVersions.values()]

  const noteVersions = tombstoneMap(deleted.notes)
  const localNotes = noteRecords(localData.notes)
  const remoteNotes = noteRecords(remoteData.notes)
  const notes = mergeKeyedRecords(localNotes, remoteNotes, noteVersions, (one) => one.bookId)
  deleted.notes = [...noteVersions.values()]

  const highlightVersions = tombstoneMap(deleted.highlights)
  const highlights = mergeChildRecords(
    Object.values(localData.highlights).flat(),
    Object.values(remoteData.highlights).flat(),
    highlightVersions,
  )
  deleted.highlights = [...highlightVersions.values()]

  const markVersions = tombstoneMap(deleted.marks)
  const marks = mergeChildRecords(
    Object.values(localData.marks).flat(),
    Object.values(remoteData.marks).flat(),
    markVersions,
  )
  deleted.marks = [...markVersions.values()]

  const groupVersions = tombstoneMap(deleted.groups)
  const groups = new Map(localData.groups.map((group) => [group.id, group]))
  for (const group of localData.groups) {
    const tombstone = groupVersions.get(group.id)
    if (!tombstone) continue
    if (tombstone.updatedAt >= timestamp(group.updatedAt)) groups.delete(group.id)
    else groupVersions.delete(group.id)
  }
  for (const group of remoteData.groups) {
    const tombstone = groupVersions.get(group.id)
    if (tombstone && tombstone.updatedAt >= timestamp(group.updatedAt)) continue
    const mine = groups.get(group.id)
    if (!mine || timestamp(group.updatedAt) > timestamp(mine.updatedAt)) groups.set(group.id, group)
    groupVersions.delete(group.id)
  }
  deleted.groups = [...groupVersions.values()]

  const vocabulary = mergeVocabulary(localData.notes, remoteData.notes, deleted.vocabulary)
  if (vocabulary.cleared) deleted.vocabulary = null

  if (deletedBookIds.size) {
    const deletionTimes = new Map(deleted.books.map((one) => [one.id, one.updatedAt]))
    for (const bookId of deletedBookIds) {
      const deletedAt = deletionTimes.get(bookId) ?? 0
      delete progress[bookId]
      delete stats[bookId]
      delete notes[bookId]
      deleted.progress = upsertTombstone(deleted.progress, bookId, bookId, deletedAt)
      deleted.stats = upsertTombstone(deleted.stats, bookId, bookId, deletedAt)
      deleted.notes = upsertTombstone(deleted.notes, bookId, bookId, deletedAt)
    }

    for (const [entity, rows] of [
      ['highlights', highlights],
      ['marks', marks],
    ] as const) {
      for (const row of Object.values(rows).flat()) {
        if (!deletedBookIds.has(row.bookId)) continue
        deleted[entity] = upsertTombstone(deleted[entity], row.id, row.bookId, deletionTimes.get(row.bookId) ?? 0)
      }
    }

    const liveHighlights: Record<string, Highlight[]> = {}
    for (const [bookId, list] of Object.entries(highlights)) {
      const kept = list.filter((one) => !deletedBookIds.has(one.bookId))
      if (kept.length) liveHighlights[bookId] = kept
    }
    const liveMarks: Record<string, LocationMark[]> = {}
    for (const [bookId, list] of Object.entries(marks)) {
      const kept = list.filter((one) => !deletedBookIds.has(one.bookId))
      if (kept.length) liveMarks[bookId] = kept
    }

    return {
      books: [...books.values()],
      progress,
      highlights: liveHighlights,
      marks: liveMarks,
      stats,
      notes: {
        byBook: Object.fromEntries(Object.entries(notes).map(([bookId, one]) => [bookId, one.noteId])),
        updatedAt: Object.fromEntries(Object.entries(notes).map(([bookId, one]) => [bookId, one.updatedAt])),
        vocabulary: vocabulary.vocabulary,
        vocabularyUpdatedAt: vocabulary.vocabularyUpdatedAt,
      },
      groups: pruneDeletedBooks([...groups.values()], deletedBookIds, deletionTimes),
      deleted,
    }
  }

  return {
    books: [...books.values()],
    progress,
    highlights,
    marks,
    stats,
    notes: {
      byBook: Object.fromEntries(Object.entries(notes).map(([bookId, one]) => [bookId, one.noteId])),
      updatedAt: Object.fromEntries(Object.entries(notes).map(([bookId, one]) => [bookId, one.updatedAt])),
      vocabulary: vocabulary.vocabulary,
      vocabularyUpdatedAt: vocabulary.vocabularyUpdatedAt,
    },
    groups: [...groups.values()],
    deleted,
  }
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function timestampOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function normaliseBook(book: BookRecord): BookRecord {
  const addedAt = timestamp(book.addedAt)
  return { ...book, addedAt, updatedAt: timestampOr(book.updatedAt, addedAt) }
}

function normaliseProgress(progress: ReadingProgress): ReadingProgress {
  return { ...progress, updatedAt: timestamp(progress.updatedAt) }
}

function normaliseHighlight(highlight: Highlight): Highlight {
  const createdAt = timestamp(highlight.createdAt)
  return { ...highlight, createdAt, updatedAt: timestampOr(highlight.updatedAt, createdAt) }
}

function normaliseMark(mark: LocationMark): LocationMark {
  const createdAt = timestamp(mark.createdAt)
  return { ...mark, createdAt, updatedAt: timestampOr(mark.updatedAt, createdAt) }
}

function normaliseStats(stats: BookStats): BookStats {
  return { ...stats, days: stats.days ?? {}, updatedAt: timestamp(stats.updatedAt) }
}

function normaliseGroup(group: BookGroup): BookGroup {
  const createdAt = timestamp(group.createdAt)
  return {
    ...group,
    bookIds: Array.isArray(group.bookIds) ? group.bookIds : [],
    createdAt,
    updatedAt: timestampOr(group.updatedAt, createdAt),
  }
}

function normaliseLibrary(library: LibraryData): LibraryData {
  const source = library ?? ({ books: [], progress: {}, highlights: {}, marks: {}, stats: {}, notes: {}, groups: [] } as unknown as LibraryData)
  const deletions = source.deleted ?? emptyDeletions()
  const notes = source.notes ?? { byBook: {}, updatedAt: {}, vocabulary: null, vocabularyUpdatedAt: null }
  const vocabulary = typeof notes.vocabulary === 'string' ? notes.vocabulary : null
  return {
    books: Array.isArray(source.books) ? source.books.map(normaliseBook) : [],
    progress: Object.fromEntries(Object.entries(source.progress ?? {}).map(([id, one]) => [id, normaliseProgress(one)])),
    highlights: Object.fromEntries(Object.entries(source.highlights ?? {}).map(([id, list]) => [
      id,
      (Array.isArray(list) ? list : []).map(normaliseHighlight),
    ])),
    marks: Object.fromEntries(Object.entries(source.marks ?? {}).map(([id, list]) => [
      id,
      (Array.isArray(list) ? list : []).map(normaliseMark),
    ])),
    stats: Object.fromEntries(Object.entries(source.stats ?? {}).map(([id, one]) => [id, normaliseStats(one)])),
    notes: {
      byBook: { ...(notes.byBook ?? {}) },
      updatedAt: Object.fromEntries(Object.entries(notes.updatedAt ?? {}).map(([id, one]) => [id, timestamp(one)])),
      vocabulary,
      vocabularyUpdatedAt: vocabulary ? timestamp(notes.vocabularyUpdatedAt) : null,
    },
    groups: (Array.isArray(source.groups) ? source.groups : []).map(normaliseGroup),
    deleted: {
      books: mergeTombstones([], deletions.books ?? []),
      progress: mergeTombstones([], deletions.progress ?? []),
      highlights: mergeTombstones([], deletions.highlights ?? []),
      marks: mergeTombstones([], deletions.marks ?? []),
      stats: mergeTombstones([], deletions.stats ?? []),
      notes: mergeTombstones([], deletions.notes ?? []),
      groups: mergeTombstones([], deletions.groups ?? []),
      vocabulary: deletions.vocabulary
        ? { deleted: true, updatedAt: timestamp(deletions.vocabulary.updatedAt) }
        : null,
    },
  }
}

function mergeTombstones(local: LibraryTombstone[], remote: LibraryTombstone[]): LibraryTombstone[] {
  const rows = new Map<string, LibraryTombstone>()
  for (const one of [...local, ...remote]) {
    if (!one || typeof one.id !== 'string' || !one.id) continue
    const current = rows.get(one.id)
    const next: LibraryTombstone = {
      id: one.id,
      bookId: typeof one.bookId === 'string' ? one.bookId : '',
      updatedAt: timestamp(one.updatedAt),
    }
    if (!current || next.updatedAt > current.updatedAt) rows.set(one.id, next)
  }
  return [...rows.values()]
}

function tombstoneMap(rows: LibraryTombstone[]): Map<string, LibraryTombstone> {
  return new Map(rows.map((one) => [one.id, one]))
}

function upsertTombstone(
  rows: LibraryTombstone[],
  id: string,
  bookId: string,
  updatedAt: number,
): LibraryTombstone[] {
  const current = rows.find((one) => one.id === id)
  if (!current) return [...rows, { id, bookId, updatedAt }]
  if (current.updatedAt >= updatedAt) return rows
  return rows.map((one) => one.id === id ? { id, bookId, updatedAt } : one)
}

function mergeKeyedRecords<T extends { updatedAt?: number }>(
  local: Record<string, T>,
  remote: Record<string, T>,
  versions: Map<string, LibraryTombstone>,
  idOf: (one: T) => string,
): Record<string, T> {
  const merged = new Map(Object.entries(local))
  for (const [key, one] of Object.entries(local)) {
    const id = idOf(one)
    const tombstone = versions.get(id)
    if (!tombstone) continue
    if (tombstone.updatedAt >= timestamp(one.updatedAt)) merged.delete(key)
    else versions.delete(id)
  }
  for (const [key, one] of Object.entries(remote)) {
    const id = idOf(one)
    const tombstone = versions.get(id)
    if (tombstone && tombstone.updatedAt >= timestamp(one.updatedAt)) continue
    const mine = merged.get(key)
    if (!mine || timestamp(one.updatedAt) > timestamp(mine.updatedAt)) merged.set(key, one)
    versions.delete(id)
  }
  return Object.fromEntries(merged)
}

function mergeChildRecords<T extends { id: string; bookId: string; updatedAt?: number }>(
  local: T[],
  remote: T[],
  versions: Map<string, LibraryTombstone>,
): Record<string, T[]> {
  const merged = new Map(local.map((one) => [one.id, one]))
  for (const one of local) {
    const tombstone = versions.get(one.id)
    if (!tombstone) continue
    if (tombstone.updatedAt >= timestamp(one.updatedAt)) merged.delete(one.id)
    else versions.delete(one.id)
  }
  for (const one of remote) {
    const tombstone = versions.get(one.id)
    if (tombstone && tombstone.updatedAt >= timestamp(one.updatedAt)) continue
    const mine = merged.get(one.id)
    if (!mine || timestamp(one.updatedAt) > timestamp(mine.updatedAt)) merged.set(one.id, one)
    versions.delete(one.id)
  }
  const grouped: Record<string, T[]> = {}
  for (const one of merged.values()) (grouped[one.bookId] ??= []).push(one)
  return grouped
}

interface NoteRecord {
  bookId: string
  noteId: string
  updatedAt: number
}

function noteRecords(notes: ReadingNoteLinks): Record<string, NoteRecord> {
  return Object.fromEntries(Object.entries(notes.byBook).map(([bookId, noteId]) => [
    bookId,
    { bookId, noteId, updatedAt: timestamp(notes.updatedAt[bookId]) },
  ]))
}

function mergeVocabulary(
  local: ReadingNoteLinks,
  remote: ReadingNoteLinks,
  tombstone: LibraryDeletions['vocabulary'],
): { vocabulary: string | null; vocabularyUpdatedAt: number | null; cleared: boolean } {
  let vocabulary = local.vocabulary
  let vocabularyUpdatedAt = local.vocabularyUpdatedAt
  if (tombstone && tombstone.updatedAt >= timestamp(vocabularyUpdatedAt)) {
    vocabulary = null
    vocabularyUpdatedAt = null
  }
  if (remote.vocabulary && (!tombstone || timestamp(remote.vocabularyUpdatedAt) > tombstone.updatedAt)) {
    if (!vocabulary || timestamp(remote.vocabularyUpdatedAt) > timestamp(vocabularyUpdatedAt)) {
      vocabulary = remote.vocabulary
      vocabularyUpdatedAt = timestamp(remote.vocabularyUpdatedAt)
    }
  }
  const cleared = Boolean(vocabulary && tombstone && timestamp(vocabularyUpdatedAt) > tombstone.updatedAt)
  return { vocabulary, vocabularyUpdatedAt, cleared }
}

function pruneDeletedBooks(
  groups: BookGroup[],
  deletedBookIds: ReadonlySet<string>,
  deletionTimes: ReadonlyMap<string, number>,
): BookGroup[] {
  return groups.map((group) => {
    if (!group.bookIds.some((id) => deletedBookIds.has(id))) return group
    const removedAt = group.bookIds.reduce((latest, id) => (
      deletedBookIds.has(id) ? Math.max(latest, deletionTimes.get(id) ?? 0) : latest
    ), 0)
    return {
      ...group,
      bookIds: group.bookIds.filter((id) => !deletedBookIds.has(id)),
      updatedAt: Math.max(group.updatedAt, removedAt),
    }
  })
}
