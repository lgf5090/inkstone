import type { Command, EditorView } from '@codemirror/view'
import { t, type MessageKey } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { copyBlock, cutBlock, deleteBlock, duplicateBlock, moveBlockOver } from './commands'
import { draggerMoveCommand, type DraggerHost } from './extension'

export { draggerExtensions, draggerOptionsChanged, draggerPaintKey, type DraggerHost } from './extension'
export { HANDLE_CLASS as DRAGGER_HANDLE_CLASS } from 'md-dragger/adapter/codemirror'
export { buildDraggerBlockMenuItems, DraggerBlockMenuAt, type DraggerBlockMenuRequest } from './block-menu'
export { draggerPresentation, applyDraggerPresentation, clearDraggerPresentation } from './presentation'
export { useDraggerPresentation } from './use-dragger-presentation'

/**
 * Whether the reader's own pointer is a finger, which is what decides if a drag has to be armed by
 * holding. Media queries are used rather than a width: a stylus laptop drags from the handle like a
 * desktop, and a wide tablet with a finger does not.
 */
export function isTouchPointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches
}

/** The editor's own host: the dragger reads the session and reports back through the UI store. */
export function createDraggerHost(openBlockMenu: DraggerHost['openBlockMenu']): DraggerHost {
  return {
    settings: () => useSession.getState().settings.editor,
    isTouch: isTouchPointer,
    dragMode: () => useUi.getState().draggerDragMode,
    openBlockMenu,
    notifyDrop() {
      const editor = useSession.getState().settings.editor
      if (isTouchPointer() && editor.draggerExitDragModeAfterDrop) useUi.getState().setDraggerDragMode(false)
    },
  }
}

const moveKeysAllowed = () => useSession.getState().settings.editor.draggerMoveKeys

/** The caret's block, carried over its neighbour: the keyboard's version of the drag. */
export const draggerMoveUp = draggerMoveCommand(-1, moveKeysAllowed)
export const draggerMoveDown = draggerMoveCommand(1, moveKeysAllowed)

/** The same trip offered from a menu, where choosing the row is already the intent. */
export const draggerCarryUp: Command = (view) => moveBlockOver(view, caretLine(view), -1)
export const draggerCarryDown: Command = (view) => moveBlockOver(view, caretLine(view), 1)
export const draggerDuplicateBlock: Command = (view) => duplicateBlock(view, caretLine(view))
export const draggerCopyBlock: Command = (view) => {
  void copyBlock(view, caretLine(view)).then((ok) => report(ok, 'dragger.block_copied', 'dragger.could_not_copy'))
  return true
}
export const draggerCutBlock: Command = (view) => {
  void cutBlock(view, caretLine(view)).then((ok) => report(ok, 'dragger.block_cut', 'dragger.could_not_cut'))
  return true
}
export const draggerDeleteBlock: Command = (view) => {
  const ok = deleteBlock(view, caretLine(view))
  report(ok, 'dragger.block_deleted', 'dragger.could_not_delete')
  return ok
}

function caretLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number
}

function report(ok: boolean, done: MessageKey, failure: MessageKey): void {
  useUi.getState().toast({ title: t(ok ? done : failure), tone: ok ? 'default' : 'danger' })
}
