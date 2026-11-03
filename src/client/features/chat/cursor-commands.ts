import type { AssistantCursorCommand } from '@shared/assistant'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { useQuickAsk } from './quick-ask-store'
import { composeQuoted } from './editor-ai'

/**
 * Runs one custom instruction against the passage the reader selected.
 *
 * All four executions end in one of two existing surfaces — the floating Ask panel or the assistant
 * composer — rather than a third input of their own. That is what makes the command reusable: the
 * reader has already learned both, and the command only fills them in.
 */
export function runCursorCommand(command: AssistantCursorCommand, passage: string, note: { id: string | null, title: string }): void {
  const instruction = command.instruction.trim()
  const text = passage.trim() ? composeQuoted(passage, instruction) : instruction
  if (command.execution === 'quick-ask-ask' || command.execution === 'quick-ask-rewrite') {
    useQuickAsk.getState().openPanel({
      noteId: note.id,
      noteTitle: note.title,
      selection: passage,
      whole: passage,
      from: 0,
      to: passage.length,
      seed: instruction,
    })
    return
  }
  useUi.getState().setAssistantDock(true)
  if (command.execution === 'add-and-send') {
    void useAssistant.getState().send(text)
    return
  }
  useAssistant.getState().seedComposer(text)
}
