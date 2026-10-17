/**
 * A draft that is also a note.
 *
 * A draft in the side panel and a note in the notebook were the same document the moment "save as note"
 * was pressed, and from then on they were two copies drifting apart. The link closes that: once a draft
 * knows its note, the panel edits *that note*, and the notebook's editor edits the same one — there is no
 * merge, because there is only ever one document.
 *
 * The note is the source of truth. Opening a linked draft reads the note (the notebook may have moved on
 * since), and writing goes through the notes store, which is where the notebook's own editor writes. When
 * the note is open in the notebook the two surfaces share the store and nothing can be lost; when it is
 * closed, the write is guarded by the body the panel last saw, so a note changed elsewhere is reported
 * rather than overwritten.
 */
import { api } from '../../lib/api'
import { useNotes } from '../../store/notes'

/** What the panel last read or wrote per draft, which is what a closed note's write is checked against. */
const seen = new Map<string, { noteId: string, content: string }>()

function remember(artifactId: string, noteId: string, content: string): void {
  seen.set(artifactId, { noteId, content })
}

/** The baseline for this draft, or null when it has none yet — a draft opened for the first time. */
function baselineFor(artifactId: string, noteId: string): string | null {
  const entry = seen.get(artifactId)
  return entry && entry.noteId === noteId ? entry.content : null
}

/** The note's current body: the open editor's copy when there is one, the server's otherwise. */
async function noteContent(noteId: string): Promise<string | null> {
  const cached = useNotes.getState().contents[noteId]
  if (cached !== undefined) return cached
  try {
    return (await api.notes.get(noteId)).content ?? ''
  } catch {
    return null
  }
}

/**
 * Read the linked note, which is also what makes it the baseline.
 *
 * A draft that has never been opened is not a conflict waiting to happen: whatever the note says now is
 * what the panel is showing, so the next write compares against that.
 */
export async function loadLinkedNote(artifactId: string, noteId: string): Promise<string | null> {
  const content = await noteContent(noteId)
  if (content !== null) remember(artifactId, noteId, content)
  return content
}

export type NoteWrite = 'ok' | 'conflict' | 'missing'

/**
 * Write the panel's body into the note.
 *
 * An open note takes the write through the store, the same door the notebook's editor uses — the two
 * surfaces are looking at one document, and a store write is what re-renders both. A closed note is
 * written against the body the panel last saw: a note that changed in the meantime is a conflict, and the
 * reader keeps their text instead of losing the note's.
 */
export async function pushToNote(artifactId: string, noteId: string, content: string): Promise<NoteWrite> {
  const store = useNotes.getState()
  if (store.contents[noteId] !== undefined) {
    store.editContent(noteId, content)
    remember(artifactId, noteId, content)
    return 'ok'
  }
  const baseline = baselineFor(artifactId, noteId)
  // No baseline means nothing has been read yet, and a write with nothing to compare against would be a
  // blind overwrite — so it is refused, and the caller reads the note first.
  if (baseline === null) return 'conflict'
  const result = await store.editRemoteContent(noteId, (server) => (server === baseline ? content : null))
  if (result === 'written') {
    remember(artifactId, noteId, content)
    return 'ok'
  }
  return result
}

/** Read the note back into the panel, which is the other direction of the same link. */
export async function pullFromNote(artifactId: string, noteId: string): Promise<string | null> {
  return await loadLinkedNote(artifactId, noteId)
}
