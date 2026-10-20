/**
 * The action bar over a passage selected in the canvas.
 *
 * It floats in a portal because the editor scrolls; the parent handles the action and dismisses the bar.
 * The bar is icon-only so seven actions fit above a paragraph rather than wrapping into a menu the
 * reader has to open first. Every button keeps its name for a screen reader.
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AlignLeft, ArrowRight, Languages, ListTodo, ListTree, MessageCircleQuestion, PencilLine } from 'lucide-react'
import type { EditorSelectionInfo } from '../../editor/CodeEditor'
import { t } from '../../lib/i18n'
import { Tooltip } from '../../components/overlay'
import { EDITOR_AI_LABELS, type EditorAiAction } from './editor-ai'
import { placeToolbar } from './answer-selection'

const ACTIONS: ReadonlyArray<{ action: EditorAiAction, Icon: typeof PencilLine }> = [
  { action: 'ask', Icon: MessageCircleQuestion },
  { action: 'rewrite', Icon: PencilLine },
  { action: 'summarize', Icon: AlignLeft },
  { action: 'continue', Icon: ArrowRight },
  { action: 'translate', Icon: Languages },
  { action: 'outline', Icon: ListTree },
  { action: 'todo', Icon: ListTodo },
]

/** The bar's own box, used for placement before the browser has laid it out. */
const BAR_SIZE = { width: 252, height: 32 }

export function CanvasSelectionBar({ selection, onAction, onDismiss }: {
  selection: EditorSelectionInfo
  onAction: (action: EditorAiAction) => void
  onDismiss: () => void
}) {
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }
    // A bar pinned to a range the reader scrolled away from is pointing at nothing.
    const onScroll = (): void => onDismiss()
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [onDismiss])

  const placed = placeToolbar(selection.rect, { width: window.innerWidth, height: window.innerHeight }, BAR_SIZE)
  return createPortal(
    <div
      ref={barRef}
      role="toolbar"
      aria-label={t('assistant.canvas.selection_actions')}
      data-canvas-selection-bar="1"
      // Keeping the mouse press on the bar keeps the editor's selection: a button that focused itself
      // would collapse the range before its own click handler ran.
      onMouseDown={(event) => event.preventDefault()}
      className="fixed z-[var(--z-pop)] flex items-center gap-0.5 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-raised)] p-1 shadow-[var(--shadow-pop)]"
      style={{ top: placed.top, left: placed.left }}
    >
      {ACTIONS.map(({ action, Icon }) => (
        <Tooltip key={action} label={t(EDITOR_AI_LABELS[action])}>
          <button
            type="button"
            aria-label={t(EDITOR_AI_LABELS[action])}
            data-canvas-action={action}
            onClick={() => onAction(action)}
            className="inline-flex size-7 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            <Icon size={14} />
          </button>
        </Tooltip>
      ))}
    </div>,
    document.body,
  )
}
