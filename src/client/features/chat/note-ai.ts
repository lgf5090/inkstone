/**
 * One question about one note, answered and handed back as text.
 *
 * Several actions are "ask the assistant about this note and then do something with the answer": a
 * template's AI slot, a suggestion of tags and properties. They share the transport — put the note in
 * front of the assistant, open the dock so the reader can watch, wait for the whole turn — and differ
 * only in what they do with the answer. So the transport lives here once.
 *
 * The note is opened rather than merely named because that is what the turn carries: the request's
 * context is the note on screen, not an id the caller happens to hold. Opening it is also what the
 * reader expects from an action they aimed at a row.
 */
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import { lastAnswerText } from './editor-ai'

/**
 * Ask about a note and wait for the answer, or `null` when there will not be one.
 *
 * `null` is not a failure of its own: a turn already in flight is refused before it starts (the store
 * would silently drop the request, and a dropped request that returns the *previous* answer would be
 * worse than none), and an answer that came back empty is nothing to act on either. Both say why.
 */
export async function askAboutNote(noteId: string, prompt: string): Promise<string | null> {
  const assistant = useAssistant.getState()
  const ui = useUi.getState()
  if (assistant.turn && !assistant.turn.done) {
    ui.toast({ title: t('assistant.edit.busy'), tone: 'warning' })
    return null
  }
  if (ui.activeNoteId !== noteId) await useNotes.getState().openNote(noteId)
  assistant.setNoteContext(true)
  ui.setAssistantDock(true)
  await useAssistant.getState().send(prompt)
  return lastAnswerText().trim() || null
}
