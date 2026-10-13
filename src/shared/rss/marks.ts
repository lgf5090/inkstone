/**
 * The reading marks, as rows.
 *
 * Six arrays and two maps inside the library — what has been read, starred, saved for later,
 * dismissed, opened, and the note an article became — are one table with a `kind` column. This
 * module is the only place that knows how the two shapes map onto each other, so the Worker's row
 * store and the client's change set cannot drift apart into two different ideas of what a mark is.
 */
import type { RssLibrary } from './model'

/** The mark kinds: four lists, one clock, and the two note ids an article was saved as. */
export const RSS_MARK_KINDS = ['read', 'star', 'later', 'hidden', 'opened', 'note', 'copy'] as const
export type RssMarkKind = (typeof RSS_MARK_KINDS)[number]

/** The kinds stored as an ordered list, where the newest mark is the first entry. */
export const RSS_LIST_MARK_KINDS = ['read', 'star', 'later', 'hidden'] as const satisfies readonly RssMarkKind[]

export interface RssMarkKey {
  kind: RssMarkKind
  entryId: string
}

export interface RssMarkRow extends RssMarkKey {
  /** What the mark points at: the note id for `note` and `copy`, empty for every other kind. */
  value: string
  /** When it happened. For a list mark this is what orders the list newest first. */
  at: number
}

/** `<entryId>|<kind>`, the way the library spells a saved-note key. */
export function splitSavedNoteKey(key: string): { entryId: string; kind: 'note' | 'copy' } | null {
  const cut = key.lastIndexOf('|')
  const tail = key.slice(cut + 1)
  if (cut <= 0 || (tail !== 'note' && tail !== 'copy')) return null
  const entryId = key.slice(0, cut)
  return entryId ? { entryId, kind: tail } : null
}

/** The library's marks, as the rows that carry them. */
export function libraryMarkRows(library: RssLibrary): RssMarkRow[] {
  const rows: RssMarkRow[] = []
  const lists: [RssMarkKind, readonly string[]][] = [
    ['read', library.readIds],
    ['star', library.favorites],
    ['later', library.readLater],
    ['hidden', library.hiddenIds],
  ]
  for (const [kind, ids] of lists) {
    for (const entryId of ids) rows.push({ kind, entryId, value: '', at: 0 })
  }
  for (const [entryId, at] of Object.entries(library.opened)) {
    rows.push({ kind: 'opened', entryId: entryId.slice(0, 80), value: '', at })
  }
  for (const [key, noteId] of Object.entries(library.savedNotes)) {
    const mark = splitSavedNoteKey(key)
    if (mark) rows.push({ kind: mark.kind, entryId: mark.entryId, value: noteId, at: 0 })
  }
  return rows
}

/** The mark rows a library implies, put back into the library shape it came from. */
export function marksIntoLibrary(rows: readonly RssMarkRow[], library: RssLibrary): RssLibrary {
  const readIds: string[] = []
  const favorites: string[] = []
  const readLater: string[] = []
  const hiddenIds: string[] = []
  const opened: Record<string, number> = {}
  const savedNotes: Record<string, string> = {}
  for (const row of rows) {
    if (row.kind === 'read') readIds.push(row.entryId)
    else if (row.kind === 'star') favorites.push(row.entryId)
    else if (row.kind === 'later') readLater.push(row.entryId)
    else if (row.kind === 'hidden') hiddenIds.push(row.entryId)
    else if (row.kind === 'opened') opened[row.entryId] = row.at
    else savedNotes[`${row.entryId}|${row.kind}`] = row.value
  }
  return { ...library, readIds, favorites, readLater, hiddenIds, opened, savedNotes }
}
