/**
 * The vocabulary note.
 *
 * One note per account holds every word a reader looked up, newest section last, each with the sentence
 * it came from and a link back into the book. A list of words with no context is a list nobody reviews,
 * which is why the entry carries the sentence and the position rather than just the translation.
 */
import { createContextualNote, useNotes } from '../../store/notes'
import { t } from '../../lib/i18n'
import { useLibrary } from './store/library'

export const VOCABULARY_BEGIN = '<!-- inkstone:vocabulary:begin -->'

/** Append one entry, creating the note the first time a word is collected. */
export async function ensureVocabularyNote(entry: string): Promise<string | null> {
  const notes = useNotes.getState()
  const library = useLibrary.getState()
  const title = t('reading.vocabulary_note_title')
  const linked = library.notes.vocabulary ? notes.notes[library.notes.vocabulary] : null
  const target = linked ?? Object.values(notes.notes).find((summary) => summary.title === title && !summary.deletedAt)
  if (target) {
    const result = await notes.editRemoteContent(target.id, (content) => appendEntry(content, entry))
    if (result !== 'written') return null
    if (!library.notes.vocabulary) library.linkVocabulary(target.id)
    return target.id
  }
  const body = `# ${title}\n\n${VOCABULARY_BEGIN}\n\n${entry}`
  const id = await createContextualNote({ title, content: body, open: false })
  if (id) library.linkVocabulary(id)
  return id
}

/**
 * Add a word, or a new example under the word the reader already collected.
 *
 * Duplicates are the common case — a word recurs — and a second heading for it would make the list
 * longer without making it any more useful.
 */
export function appendEntry(content: string, entry: string): string {
  const head = content.trimEnd()
  const body = head ? `${head}\n\n${entry}` : entry
  const word = /^### (.+)$/m.exec(entry)?.[1]?.trim()
  if (!word) return body
  const heading = `### ${word}`
  const at = body.indexOf(heading)
  if (at < 0) return body
  const next = body.indexOf('\n### ', at + heading.length)
  const sectionEnd = next < 0 ? body.length : next
  const section = body.slice(at, sectionEnd)
  const example = entry.split('\n').filter((line) => line.startsWith('> ')).join('\n')
  if (!example || section.includes(example)) return body
  const merged = `${section.trimEnd()}\n\n${example}\n`
  return `${body.slice(0, at)}${merged}${body.slice(sectionEnd)}`
}
