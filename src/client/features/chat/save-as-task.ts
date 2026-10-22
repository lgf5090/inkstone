/**
 * Turning something the reader said or was told into a task.
 *
 * The first line is the task's title and the rest is its note, because that is how the reader wrote it:
 * a message that opens with "order water" and goes on about which brand is a task called "order water"
 * with a note. Markdown is stripped rather than kept — a title is drawn in one line of a card, and `**`
 * in it reads as a typo.
 *
 * What comes out is a *draft*, not a task. Which list it belongs in, and whether it is due on Friday,
 * are questions only the reader can answer, so the editor opens on it and they press save.
 */
import { toPlainText } from '@shared/markdown-utils'
import { navigateToPath } from '../../lib/app-history'
import { useTodos, type TaskDraft } from '../todos/store'

/** The longest title a task may take, matching what the server keeps. */
const MAX_TITLE = 80

/** The longest note a draft carries; the editor's own field is what the reader sees and may extend. */
const MAX_NOTE = 2000

/**
 * The draft one message becomes.
 *
 * The text is flattened before it is split, so a message whose first line is a heading or a list item
 * yields a title without its markers. A message with no words in it — an image with no caption — yields
 * no draft at all rather than a task called "Untitled".
 */
export function taskDraftFromMessage(text: string, conversationId: string | null): TaskDraft | null {
  const plain = toPlainText(text).trim()
  if (!plain) return null
  const [first = ''] = plain.split('\n')
  const title = first.trim().slice(0, MAX_TITLE)
  const description = plain.slice(0, MAX_NOTE)
  return {
    title,
    description,
    ...(conversationId ? { conversationId } : {}),
  }
}

/**
 * Open the to-do app with that draft in the editor.
 *
 * The reader lands on the app rather than a dialog floating over the chat: the task is about to exist in
 * a place they will look for it later, and seeing the board behind the panel is how they know where.
 */
export function saveMessageAsTask(text: string, conversationId: string | null): void {
  const draft = taskDraftFromMessage(text, conversationId)
  if (!draft) return
  navigateToPath('/todo')
  useTodos.getState().openEditor(draft)
}
