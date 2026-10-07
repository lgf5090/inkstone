import type { NoteSummary } from '@shared/types'

// One answer to "can the user still see this note", shared by the list, the heatmap projection and
// the gap banner. The store has always treated `deletedAt: 0` as not deleted (truthiness); the
// calendar layer compared against null, which made a 0 stamp a note the list shows and the
// heatmap hides. Both now read this file.
export function isDeleted(note: Pick<NoteSummary, 'deletedAt'>): boolean {
  return Boolean(note.deletedAt)
}

export function isActiveNote(note: Pick<NoteSummary, 'deletedAt' | 'isArchived'>): boolean {
  return !isDeleted(note) && !note.isArchived
}
