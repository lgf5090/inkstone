import { createStore, get as idbGet, set as idbSet } from 'idb-keyval'
import { CLIENT_DATABASE_NAME } from '../../../lib/runtime'
import { LIMITS } from '@shared/constants'
import { normaliseGroups, type BookGroup } from '../book-groups'
import { emptyDeletions, type LibraryData, type LibraryDeletions } from '../sync-merge'
import type { BookRecord } from '../types'

export const libraryStore = createStore(CLIENT_DATABASE_NAME, 'kv')
export type PersistedLibrary = LibraryData

export const EMPTY: PersistedLibrary = {
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

export function keyFor(user: string | null, suffix: string): string {
  return user ? `user:${user}:reading:${suffix}` : `reading:${suffix}`
}

export function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

export function isLocalOnly(book: BookRecord): boolean {
  return book.localOnly === true || book.size > LIMITS.readerBookMaxBytes
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
      return [{ id: row.id, bookId: typeof row.bookId === 'string' ? row.bookId : '', updatedAt: numberOr(row.updatedAt) }]
    })
  }
  if (source.vocabulary?.deleted) {
    deleted.vocabulary = { deleted: true, updatedAt: numberOr(source.vocabulary.updatedAt) }
  }
  return deleted
}

export async function persistLibrary(user: string | null, data: PersistedLibrary, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return
  try {
    await idbSet(keyFor(user, 'library'), data, libraryStore)
  } catch (err) {
    console.warn('[reading] could not save the library', err)
  }
}

export async function loadLibrary(user: string | null): Promise<PersistedLibrary> {
  const stored = await idbGet<PersistedLibrary>(keyFor(user, 'library'), libraryStore)
  if (!stored || typeof stored !== 'object') return { ...EMPTY, deleted: emptyDeletions() }
  return {
    books: Array.isArray(stored.books) ? stored.books.map((book) => {
      const addedAt = numberOr(book.addedAt)
      return { ...book, addedAt, updatedAt: numberOr(book.updatedAt, addedAt), localOnly: isLocalOnly(book) }
    }) : [],
    progress: Object.fromEntries(Object.entries(stored.progress ?? {}).map(([bookId, progress]) => [bookId, { ...progress, updatedAt: numberOr(progress.updatedAt) }])),
    highlights: Object.fromEntries(Object.entries(stored.highlights ?? {}).map(([bookId, list]) => [bookId,
      (Array.isArray(list) ? list : []).map((highlight) => {
        const createdAt = numberOr(highlight.createdAt)
        return { ...highlight, createdAt, updatedAt: numberOr(highlight.updatedAt, createdAt) }
      }),
    ])),
    marks: Object.fromEntries(Object.entries(stored.marks ?? {}).map(([bookId, list]) => [bookId,
      (Array.isArray(list) ? list : []).map((mark) => {
        const createdAt = numberOr(mark.createdAt)
        return { ...mark, createdAt, updatedAt: numberOr(mark.updatedAt, createdAt) }
      }),
    ])),
    stats: Object.fromEntries(Object.entries(stored.stats ?? {}).map(([bookId, stats]) => [bookId, { ...stats, days: stats.days ?? {}, updatedAt: numberOr(stats.updatedAt) }])),
    notes: {
      byBook: stored.notes?.byBook ?? {},
      updatedAt: Object.fromEntries(Object.entries(stored.notes?.updatedAt ?? {}).map(([bookId, updatedAt]) => [bookId, numberOr(updatedAt)])),
      vocabulary: stored.notes?.vocabulary ?? null,
      vocabularyUpdatedAt: stored.notes?.vocabulary ? numberOr(stored.notes.vocabularyUpdatedAt) : null,
    },
    groups: normaliseStoredGroups(stored.groups),
    settings: stored.settings && typeof stored.settings === 'object' && !Array.isArray(stored.settings) ? stored.settings : {},
    settingsUpdatedAt: numberOr(stored.settingsUpdatedAt),
    deleted: normaliseStoredDeletions(stored.deleted),
  }
}
