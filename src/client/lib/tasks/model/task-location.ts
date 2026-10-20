/**
 * Where a task lives, so a result can be written back to the exact line it came from.
 *
 * `lineNumber` alone is not enough: two notes can hold byte-identical task lines, and a reader who
 * ticks one must not have the other rewritten. `sectionStart` and `sectionIndex` are the fallback
 * the write path uses when the line has moved since the query last ran.
 */
export interface TaskLocation {
  noteId: string
  /** The reader-facing path, used by `path includes` and by the backlink. */
  path: string
  /** Zero-based line within the note body. */
  lineNumber: number
  sectionStart: number
  sectionIndex: number
  precedingHeader: string | null
}

export function locationFromNotePosition(
  noteId: string,
  path: string,
  lineNumber: number,
  sectionStart = 0,
  sectionIndex = 0,
  precedingHeader: string | null = null,
): TaskLocation {
  return { noteId, path, lineNumber, sectionStart, sectionIndex, precedingHeader }
}

/** A task a script built rather than one read out of a note, which cannot be written back. */
export function unknownPosition(noteId = '', path = ''): TaskLocation {
  return { noteId, path, lineNumber: 0, sectionStart: 0, sectionIndex: 0, precedingHeader: null }
}

export function locationWithNewPath(location: TaskLocation, noteId: string, path: string): TaskLocation {
  return { ...location, noteId, path }
}
