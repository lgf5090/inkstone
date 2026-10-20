/**
 * The notes a turn named, pulled out of the things that carry them.
 *
 * Two shapes come out of this module. A search or a listing arrives as JSON, and the one row that looks
 * like `{"id": "...", "title": "..."}` is a note the reader can open. Printing that as text makes them
 * copy an id into a search box; the ids are already in hand, so the row offers the door instead of the
 * address.
 *
 * A mention the reader picked with `@` goes the other way: words that have to name one particular note
 * both on screen and in the worker, which cannot tell two notes of the same title apart by reading.
 *
 * Only the note tools are read as JSON. A task and a project carry an id and a title too, and a chip
 * that opened one of those in the notebook would be a link to nothing.
 */

import type { MarkdownLinks } from '../preview/MarkdownBody'

/** The tools whose payload describes notes, by name. */
const NOTE_TOOLS = new Set(['search_notes', 'list_notes', 'count_notes', 'read_note', 'create_note', 'update_note', 'delete_note'])

/** The shape every note id in this app has: a 26-character Crockford-ish ULID. */
const NOTE_ID = /^[0-9a-hjkmnp-tv-z]{26}$/

const MAX_REFS = 8

/**
 * Whether a value is a note id rather than a title, a folder id or a word.
 *
 * The worker only trusts an id shaped like this, so the composer must not write one that the resolver
 * would then read back as a note title.
 */
export function isNoteId(value: string): boolean {
  return NOTE_ID.test(value)
}

/**
 * The longest words a mention may show for its note.
 *
 * The renderer's own wiki-link pattern caps everything between the brackets at 200 characters, so the
 * alias gets what the id and its separator leave, with room to spare for what a title loses when its
 * whitespace is folded.
 */
const MENTION_ALIAS_MAX = 160

/** A wiki link holds no bracket, no alias separator and no newline in either half, so those become spaces. */
function mentionAlias(title: string): string {
  return title.replace(/[[\]|\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MENTION_ALIAS_MAX)
}

/**
 * The text the composer writes when the reader picks a note: `[[<id>|<title>]]`.
 *
 * A title alone is not an address. After a rename — or between two notes that were given the same one —
 * it names a different document and nothing says so, which is why the id travels inside the link the
 * worker resolves on while the title stays as the alias, so the transcript the reader can read and edit
 * still reads as a link to a note. A row whose id is not a note id keeps the old title-only shape, which
 * the worker answers by title; a title that cannot be represented in the link is cut to what can be, and
 * never left to break the syntax.
 */
export function formatNoteMention(id: string, title: string): string {
  const alias = mentionAlias(title)
  if (!isNoteId(id)) return `[[${alias || mentionAlias(id)}]]`
  return alias ? `[[${id}|${alias}]]` : `[[${id}]]`
}

/**
 * The chat's link handlers, with the mention's id taken back out of a link the title lookup missed.
 *
 * The renderer resolves a `[[…]]` by its title, so a mention written as `[[<id>|Title]]` is a note the
 * vault appears not to have, and the follow handler offered for that makes a new note named by the id —
 * a junk document out of a click. The id is the target, so it goes back through `openNote`, whose own
 * answer for an id the vault has truly lost is "that note is gone".
 */
export function noteMentionLinks(links: MarkdownLinks): MarkdownLinks {
  if (!links.createNote) return links
  const create = links.createNote
  return { ...links, createNote: (title) => (isNoteId(title) ? links.openNote(title) : create(title)) }
}

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
