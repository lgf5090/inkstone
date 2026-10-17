/**
 * The notes a tool call named, pulled out of its answer.
 *
 * A search or a listing comes back as JSON, and the one row that looks like `{"id": "...", "title":
 * "..."}` is a note the reader can open. Printing that as text makes them copy an id into a search box;
 * the ids are already in hand, so the row offers the door instead of the address.
 *
 * Only the note tools are read this way. A task and a project carry an id and a title too, and a chip
 * that opened one of those in the notebook would be a link to nothing.
 */

/** The tools whose payload describes notes, by name. */
const NOTE_TOOLS = new Set(['search_notes', 'list_notes', 'count_notes', 'read_note', 'create_note', 'update_note', 'delete_note'])

/** The shape every note id in this app has: a 26-character Crockford-ish ULID. */
const NOTE_ID = /^[0-9a-hjkmnp-tv-z]{26}$/

const MAX_REFS = 8

export interface NoteRef {
  id: string
  title: string
}

function collect(value: unknown, out: NoteRef[], seen: Set<string>): void {
  if (out.length >= MAX_REFS) return
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out, seen)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  // Two spellings of the same fact, because the worker has two: a listing names its rows `id`, while a
  // note read on its own answers with `note_id`. Reading only the first is how the chip that says "it
  // read this note" never appears for the one tool that read it.
  const id = record.id ?? record.note_id
  const title = record.title
  if (typeof id === 'string' && NOTE_ID.test(id) && typeof title === 'string' && !seen.has(id)) {
    seen.add(id)
    out.push({ id, title: title.trim() || 'Untitled' })
  }
  for (const nested of Object.values(record)) collect(nested, out, seen)
}

/**
 * The notes a call mentioned, in the order the payload named them.
 *
 * A result that is not the JSON this app wrote — a third-party server's own text, or an error string —
 * yields nothing rather than a guess: a chip is a promise that pressing it opens something.
 */
export function noteRefsFromToolResult(toolName: string, result: string | undefined): NoteRef[] {
  if (!result || !NOTE_TOOLS.has(toolName)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch {
    return []
  }
  const out: NoteRef[] = []
  collect(parsed, out, new Set())
  return out
}
