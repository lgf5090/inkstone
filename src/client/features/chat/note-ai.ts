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
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import { sendForAnswerDetailed, type AnswerResult } from './editor-ai'

/**
 * Ask about a note and wait for the answer, naming whichever state it ended in.
 *
 * The four states are not one thing to report: a turn already in flight is refused before it starts (the
 * store would silently drop the request, and a dropped request that returned the *previous* answer would
 * be worse than none), a run the worker did not take is a failure, and an answer with no words in it is
 * neither. Folding them into `null` left every caller guessing, so two of them said different things about
 * the same screen. The reason is said here once, and each caller decides what its reader should hear.
 *
 * Nothing is announced from here: a module that only carries the turn has no idea what was being asked
 * for, and a toast about "nothing coming back" from the transport is the guess this replaced.
 *
 * The answer is the one this question produced, never the newest row on the screen: the caller writes it
 * into the note's front matter, where an older answer would look like it was suggested for this page.
 */
export async function askAboutNote(noteId: string, prompt: string): Promise<AnswerResult> {
  const assistant = useAssistant.getState()
  if (assistant.turn && !assistant.turn.done) return { status: 'busy' }
  const ui = useUi.getState()
  if (ui.activeNoteId !== noteId) await useNotes.getState().openNote(noteId)
  assistant.setNoteContext(true)
  ui.setAssistantDock(true)
  return await sendForAnswerDetailed(prompt)
}
