/**
 * The notes a reply was built from, as citations.
 *
 * A search the assistant ran is not visible in its answer: the model says "your notes mention X" and the
 * reader is left to find out which ones. The tool that answered already names them, so the reply carries
 * them — the same way a web search's pages ride along with the answer — and each card opens the note it
 * names.
 *
 * Only the two tools that read a note's words count. `list_notes` is a table of contents rather than a
 * source, and a citation from it would credit the answer to a note it never opened.
 *
 * The url is the app's own note path rather than the absolute one a tool result carries: a transcript is
 * exported and shared, and a citation that pointed at the origin it was written on would lead a reader of
 * the export back to somebody else's server. The id is what the client actually opens with.
 */
import type { AssistantSource } from '@shared/assistant'

/** How many hits of one search become cards. The rest stay in the tool's own result. */
export const NOTE_CITATION_LIMIT = 4

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function noteSource(id: string, title: string, cited?: string): AssistantSource {
  return {
    url: `/n/${id}`,
    title: title.slice(0, 120) || 'Untitled',
    kind: 'note',
    id,
    ...(cited ? { cited: cited.slice(0, 300) } : {}),
  }
}

/**
 * The citations one tool call earned, in the order the tool named them.
 *
 * `read_note` says which section it was asked for, so the card can say "that section" instead of naming
 * the whole note — which is the closest thing to a block-level pointer the vault has, since a note's body
 * carries no stable anchors of its own.
 */
export function noteCitationsFromTool(name: string, result: unknown): AssistantSource[] {
  if (!isRecord(result)) return []
  if (name === 'search_notes') {
    const hits = Array.isArray(result.results) ? result.results : []
    const out: AssistantSource[] = []
    for (const hit of hits.slice(0, NOTE_CITATION_LIMIT)) {
      if (!isRecord(hit)) continue
      const id = typeof hit.id === 'string' ? hit.id : ''
      const title = typeof hit.title === 'string' ? hit.title : ''
      if (!id) continue
      out.push(noteSource(id, title, typeof hit.excerpt === 'string' ? hit.excerpt : undefined))
    }
    return out
  }
  if (name === 'read_note') {
    const id = typeof result.note_id === 'string' ? result.note_id : ''
    if (!id) return []
    const section = isRecord(result.section) && typeof result.section.title === 'string' ? result.section.title : undefined
    return [noteSource(id, typeof result.title === 'string' ? result.title : '', section)]
  }
  return []
}
