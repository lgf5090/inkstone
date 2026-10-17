/**
 * Filling the places a template asked the assistant to write.
 *
 * `{{ai: …}}` is a template's own request, so it is answered when the note is made rather than offered
 * as a button: a template with a slot in it is a template that is not finished until the slot is
 * filled. Each slot is one turn, and the answers are written back from the end of the document
 * backwards — an answer grows the note, and the offsets behind it are the ones that would move.
 *
 * A slot that cannot be filled stops the run instead of skipping ahead: the turns are one thread about
 * one note, and the reason the first one produced nothing is the reason the next one will too.
 */
import type { NewNoteAiSlot } from '@shared/note-template-render'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { insertBlockAt } from './editor-ai'
import { askAboutNote } from './note-ai'

/**
 * Fill every slot, newest offset first. Returns how many were written, which is what the caller can
 * say out loud when the answer is "none of them".
 *
 * A slot that produced nothing stops the run, and the reason is named as itself: waiting for an answer
 * that is still being written is not the same sentence to the reader as an answer that failed, and both
 * of those are different from a turn that came back with no words. Anything else — the note gone, a slot
 * that could not be read — falls back on the one message this module has of its own.
 */
export async function fillTemplateSlots(noteId: string, slots: readonly NewNoteAiSlot[]): Promise<number> {
  const toast = useUi.getState().toast
  let filled = 0
  let said = false
  for (const slot of [...slots].sort((left, right) => right.at - left.at)) {
    const answer = await askAboutNote(noteId, slot.instruction)
    const content = useNotes.getState().contents[noteId]
    if (answer.status !== 'ok' || content === undefined) {
      if (answer.status === 'busy') {
        toast({ title: t('assistant.edit.busy'), tone: 'warning' })
        said = true
      } else if (answer.status === 'failed') {
        toast({ title: t('assistant.note.answer_failed'), description: answer.error ?? undefined, tone: 'danger' })
        said = true
      } else if (answer.status === 'empty') {
        toast({ title: t('assistant.note.answer_empty'), tone: 'warning' })
        said = true
      }
      break
    }
    // The note may have been edited while the answer was being written; the offset is clamped rather
    // than trusted, because a slot past the end would put the paragraph nowhere.
    useNotes.getState().editContent(noteId, insertBlockAt(content, Math.min(slot.at, content.length), answer.text))
    filled += 1
  }
  if (!said && filled < slots.length) toast({ title: t('assistant.template.failed'), tone: 'warning' })
  return filled
}
