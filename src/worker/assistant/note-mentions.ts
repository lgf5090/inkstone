/**
 * `[[note]]` mentions resolved into the note's own words.
 *
 * The composer's `@` inserts a wikilink and nothing else — the title is what the reader sees and what
 * the transcript keeps. On its own the model could only call `read_note` and hope the title it guessed
 * is unique, so a mention is resolved here against the notes the reader actually allowed, and the words
 * ride with the turn the way an attachment's do. The scope is enforced by the same helper every note
 * tool passes through, so a mention can never reach past it.
 */

import { readableNoteIds, type NoteScope } from './note-scope'

/** How much of a mentioned note joins the turn, and how many mentions are read at all. */
export const MENTION_CHAR_CAP = 12_000
export const MAX_MENTIONS = 8

/** The titles inside `[[…]]`, in order, deduplicated, with any `|alias` dropped. */
export function wikiLinkTitles(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const pattern = /\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g
  for (const match of text.matchAll(pattern)) {
    const title = (match[1] ?? '').trim()
    if (!title || seen.has(title.toLocaleLowerCase())) continue
    seen.add(title.toLocaleLowerCase())
    out.push(title)
    if (out.length >= MAX_MENTIONS) break
  }
  return out
}

/**
 * The block a turn carries for the notes it mentioned, or an empty string when it mentioned none.
 *
 * A title that matches nothing readable is named as unresolved rather than dropped, so the model says
 * so instead of inventing the note's contents.
 */
export async function resolveNoteMentions(
  db: D1Database,
  userId: string,
  text: string,
  scope: NoteScope,
): Promise<string> {
  const titles = wikiLinkTitles(text)
  if (!titles.length) return ''
  const sections: string[] = []
  let used = 0
  for (const title of titles) {
    const { results } = await db.prepare(
      `SELECT id, title, content FROM notes
        WHERE user_id = ?1 AND deleted_at IS NULL AND lower(title) = lower(?2)
        ORDER BY updated_at DESC LIMIT 5`,
    ).bind(userId, title).all<{ id: string, title: string, content: string }>()
    const candidates = results ?? []
    if (!candidates.length) {
      sections.push(`[[${title}]] — no note with that title`)
      continue
    }
    // The same gate the note tools use: a title the reader may not read is named, not quoted.
    const allowed = await readableNoteIds(db, userId, candidates.map((row) => row.id), scope)
    const note = candidates.find((row) => allowed.has(row.id))
    if (!note) {
      sections.push(`[[${title}]] — a note with that title exists but is outside what the assistant may read`)
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
