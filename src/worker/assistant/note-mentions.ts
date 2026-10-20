/**
 * `[[note]]` mentions resolved into the note's own words.
 *
 * The composer's `@` inserts a wikilink and nothing else, and the link carries the note's id as its
 * target with the title as the alias the reader sees (`[[<id>|Title]]`). On its own the model could only
 * call `read_note` and hope the title it guessed is unique, so a mention is resolved here against the
 * notes the reader actually allowed, and the words ride with the turn the way an attachment's do. The
 * scope is enforced by the same helper every note tool passes through, so a mention can never reach past
 * it.
 *
 * Mentions written before the id was carried — and any the reader typed by hand — are the bare
 * `[[Title]]`, and those keep resolving by title exactly as they always did. Nothing rewrites a stored
 * conversation: an old title-only mention still works, and still inherits the old ambiguity between two
 * notes that share a title.
 */

import { readableNoteIds, type NoteScope } from './note-scope'

/** How much of a mentioned note joins the turn, and how many mentions are read at all. */
export const MENTION_CHAR_CAP = 12_000
export const MAX_MENTIONS = 8

/** The shape of a note id, which is the only thing this resolves ahead of a title. */
const NOTE_ID = /^[0-9a-hjkmnp-tv-z]{26}$/

/** One `[[…]]` the turn carries: what it points at, and the words it shows. */
export interface NoteMention {
  /** The note the reader picked, when the link was written with its id. */
  id: string | null
  /** The title to look up, or the alias a link by id shows. Null when an id carries no words. */
  title: string | null
}

/**
 * The mentions in `[[…]]`, in order and deduplicated.
 *
 * A link with an id in front of the pipe is keyed on that id, so the same note named twice is read once
 * and two notes of the same title are not the same mention. Anything without an id is keyed on its
 * title, case-first, exactly as before.
 */
export function noteMentions(text: string): NoteMention[] {
  const out: NoteMention[] = []
  const seen = new Set<string>()
  const pattern = /\[\[([^\]\n]+)\]\]/g
  for (const match of text.matchAll(pattern)) {
    const inner = (match[1] ?? '').trim()
    if (!inner) continue
    const pipe = inner.indexOf('|')
    const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim()
    const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : ''
    if (!target) continue
    // A `sub:` target is a subscription's, resolved by `subscription-mentions`. Claiming it here would
    // report a perfectly live subscription as a note that has been deleted.
    if (target.startsWith('sub:')) continue
    const id = NOTE_ID.test(target) ? target : null
    const key = id ?? `title:${target.toLocaleLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id, title: id ? (alias || null) : target })
    if (out.length >= MAX_MENTIONS) break
  }
  return out
}

/** The words an unresolved mention is named by in the block: the words the reader wrote, then the id. */
function mentionLabel(mention: NoteMention): string {
  return mention.title ?? mention.id ?? ''
}

/**
 * The block a turn carries for the notes it mentioned, or an empty string when it mentioned none.
 *
 * A mention that matches nothing readable is named as unresolved rather than dropped, so the model says
 * so instead of inventing the note's contents.
 */
export async function resolveNoteMentions(
  db: D1Database,
  userId: string,
  text: string,
  scope: NoteScope,
): Promise<string> {
  const mentions = noteMentions(text)
  if (!mentions.length) return ''
  const sections: string[] = []
  let used = 0
  for (const mention of mentions) {
    // The id first, because it is the one thing that cannot be pointed at the wrong document; the title
    // is what a mention written before the id was carried — or typed by hand — still resolves on.
    const query = mention.id
      ? db.prepare(
        `SELECT id, title, content FROM notes
          WHERE user_id = ?1 AND deleted_at IS NULL AND id = ?2`,
      ).bind(userId, mention.id)
      : db.prepare(
        `SELECT id, title, content FROM notes
          WHERE user_id = ?1 AND deleted_at IS NULL AND lower(title) = lower(?2)
          ORDER BY updated_at DESC LIMIT 5`,
      ).bind(userId, mention.title)
    const { results } = await query.all<{ id: string, title: string, content: string }>()
    const candidates = results ?? []
    const label = mentionLabel(mention)
    if (!candidates.length) {
      sections.push(mention.id
        ? `[[${label}]] — the note this mention points at no longer exists`
        : `[[${label}]] — no note with that title`)
      continue
    }
    // The same gate the note tools use: a note the reader may not read is named, not quoted.
    const allowed = await readableNoteIds(db, userId, candidates.map((row) => row.id), scope)
    const note = candidates.find((row) => allowed.has(row.id))
    if (!note) {
      sections.push(`[[${label}]] — that note is outside what the assistant may read`)
      continue
    }
    const room = Math.max(0, MENTION_CHAR_CAP - used)
    if (!room) break
    const body = (note.content ?? '').slice(0, room)
    used += body.length
    sections.push(`[[${note.title}]]\n\`\`\`markdown\n${body}\n\`\`\``)
  }
  if (!sections.length) return ''
  return `[mentioned notes]\n\n${sections.join('\n\n')}`
}
