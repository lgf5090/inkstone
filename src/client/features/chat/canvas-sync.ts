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
import { api, ApiError } from '../../lib/api'
import { useNotes } from '../../store/notes'

/** What the panel last read or wrote per draft, which is what a closed note's write is checked against. */
interface Baseline { noteId: string, content: string, at: number }

/**
 * The same record, kept in `localStorage` as well as in memory.
 *
 * Held only in memory, the baseline died with a refresh: the note that had not been opened again had
 * nothing to compare its first write against, and a body that had not moved anywhere was reported as a
 * conflict. The draft row cannot carry it instead — `chat_artifacts` holds the draft's own title, body and
 * linked note, and none of those is what the *note* last said, since opening a linked draft reads the note
 * without committing its body to the draft. A field of its own would be a column, so the browser keeps its
 * own record of what it saw.
 */
const STORAGE_KEY = 'inkstone:canvas-note-baseline:v1'

/** How many drafts' baselines outlive the panel: the ones being worked on, not the whole vault. */
const MAX_BASELINES = 20

const seen = new Map<string, Baseline>()

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

/**
 * The stored baselines, or none at all when the record is not the shape it was written in.
 *
 * A browser's storage is shared and hand-editable, so a malformed entry is dropped rather than trusted:
 * the cost of dropping is one conflict message, the cost of trusting one is a write checked against bytes
 * that were never on screen.
 */
function readStored(): Record<string, Baseline> {
  const source = storage()
  if (!source) return {}
  try {
    const parsed: unknown = JSON.parse(source.getItem(STORAGE_KEY) ?? 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const entries: Record<string, Baseline> = {}
    for (const [artifactId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const row = value as Record<string, unknown>
      if (typeof row.noteId !== 'string' || typeof row.content !== 'string' || typeof row.at !== 'number') continue
      entries[artifactId] = { noteId: row.noteId, content: row.content, at: row.at }
    }
    return entries
  } catch (error) {
    console.warn('[inkstone] could not read the draft-to-note sync baseline', error)
    return {}
  }
}

function remember(artifactId: string, noteId: string, content: string): void {
  seen.set(artifactId, { noteId, content, at: Date.now() })
  const source = storage()
  if (!source) return
  const kept = Object.fromEntries([...seen.entries()].sort((left, right) => right[1].at - left[1].at).slice(0, MAX_BASELINES))
  try {
    // Best-effort: a record this browser could not keep costs the reader a conflict message on the next
    // write, which is the pre-existing behaviour — not a paragraph of theirs.
    source.setItem(STORAGE_KEY, JSON.stringify(kept))
  } catch (error) {
    console.warn('[inkstone] could not store the draft-to-note sync baseline', error)
  }
}

/** The baseline for this draft, or null when it has none yet — a draft opened for the first time. */
function baselineFor(artifactId: string, noteId: string): string | null {
  const entry = seen.get(artifactId) ?? readStored()[artifactId]
  return entry && entry.noteId === noteId ? entry.content : null
}

/**
 * What reading a linked note came back as.
 *
 * Two of these three leave the panel without a body, and they are not one fact: a note the notebook no
 * longer has is gone, while a request that never answered says nothing about the note at all. Collapsing
 * the second into the first tells a reader their document was deleted because the network blipped.
 */
export type NoteRead =
  | { status: 'ok', content: string }
  | { status: 'missing' }
  | { status: 'failed', reason: string }

/** The note's current body: the open editor's copy when there is one, the server's otherwise. */
async function noteContent(noteId: string): Promise<NoteRead> {
  const cached = useNotes.getState().contents[noteId]
  if (cached !== undefined) return { status: 'ok', content: cached }
  try {
    return { status: 'ok', content: (await api.notes.get(noteId)).content ?? '' }
  } catch (error) {
    // Only the route's own "there is no such note" ends the link. Anything else — a request that did not
    // reach the worker, a 5xx, an expired session — is this read's failure and not the note's, so it is
    // reported with what it said, which is also what a retry has to show.
    if (error instanceof ApiError && error.status === 404) return { status: 'missing' }
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read the linked note, which is also what makes it the baseline.
 *
 * A draft that has never been opened is not a conflict waiting to happen: whatever the note says now is
 * what the panel is showing, so the next write compares against that. A read that did not answer makes no
 * baseline — the panel has seen nothing, and its next write is rightly refused.
 */
export async function loadLinkedNote(artifactId: string, noteId: string): Promise<NoteRead> {
  const read = await noteContent(noteId)
  if (read.status === 'ok') remember(artifactId, noteId, read.content)
  return read
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
export async function pullFromNote(artifactId: string, noteId: string): Promise<NoteRead> {
  return await loadLinkedNote(artifactId, noteId)
}
