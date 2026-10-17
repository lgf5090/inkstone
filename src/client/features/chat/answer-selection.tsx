/**
 * The bar over a piece of an answer the reader highlighted.
 *
 * A reply is the one text in this app a reader reads *at* rather than writes, so the sentence they stop on
 * is the sentence they want to ask about — and until now the only way to do that was to retype it. The bar
 * answers to the selection and not to the pointer: a reader who extends one with Shift+arrows gets the same
 * four rows, and Escape takes the bar away with the focus it borrowed.
 *
 * Two decisions worth naming:
 *  - **One answer only.** A selection whose two ends are not both inside this bubble is ignored rather than
 *    acted on. Across two messages "translate it" is a guess about which half was meant, and a bar that
 *    guesses is worse than no bar.
 *  - **Nothing that cannot act is offered.** The note row appears only while a note is open, the same rule
 *    the message menu holds itself to.
 *
 * The bar is drawn in a portal on `document.body` because the thread scrolls: a child of the scrolling
 * column is clipped by it. Its position therefore comes from a pure function, which is also the only part
 * of this surface a test can check — jsdom has no layout engine, so a `DOMRect` answers with zeros and the
 * arithmetic has to be proved outside the render (see `answer-selection.test.ts`).
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Copy, CornerUpLeft, Languages, NotebookPen, type LucideIcon } from 'lucide-react'
import { t } from '../../lib/i18n'
import { copyText } from '../../lib/clipboard'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { EDITOR_AI_LABELS, quotePassage } from './editor-ai'
import { insertReplyIntoNote } from './save-to-note'

/** The box the selection drew on screen, in the shape this file can do arithmetic on. */
export interface SelectionBox {
  top: number
  left: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

/** Where the bar is put: the top-left corner, in viewport coordinates. */
export interface Placed {
  top: number
  left: number
}

/**
 * The bar's own size, as a box rather than a measurement.
 *
 * jsdom reports nothing and a re-measure after every selection change would chase the reader's scroll, so
 * the width is the one the widest row of labels fits and the height is the button track's. Four short rows
 * on one line is a deliberate cap: a bar that wraps is a bar whose position means something else.
 */
export const TOOLBAR_SIZE = { width: 300, height: 30 }

/** The smallest gap kept between the bar and an edge of the window, and between it and the text. */
export const VIEWPORT_EDGE = 8
export const SELECTION_GAP = 6

/**
 * Put the bar above the selection, below when there is no room above, and never across a window edge.
 *
 * Clamping the left rather than shrinking the bar is what keeps a 360px window usable: the row stays one
 * line and slides under the selection's start, which is where the reader is looking.
 */
export function placeToolbar(
  rect: SelectionBox,
  viewport: Viewport,
  size: { width: number, height: number } = TOOLBAR_SIZE,
  edge: number = VIEWPORT_EDGE,
  gap: number = SELECTION_GAP,
): Placed {
  const above = rect.top - size.height - gap
  const top = above >= edge
    ? above
    : Math.min(rect.top + rect.height + gap, Math.max(edge, viewport.height - size.height - edge))
  const left = Math.min(Math.max(rect.left, edge), Math.max(edge, viewport.width - size.width - edge))
  return { top, left }
}

/** The part of `window.getSelection()` this surface reads, narrowed so a test can hand over a literal. */
export interface AnswerSelectionRange {
  startContainer: Node
  endContainer: Node
  getBoundingClientRect: () => SelectionBox
}

export interface AnswerSelection {
  rangeCount: number
  getRangeAt: (index: number) => AnswerSelectionRange
  toString: () => string
}

export interface PickedAnswerSelection {
  text: string
  rect: SelectionBox
}

/**
 * The selection, if this answer owns all of it.
 *
 * `null` is the honest answer for a collapsed selection, a whitespace one, a box the platform will not
 * draw (a detached node has no geometry), and the two ends in different places: the last of those is the
 * spanning case above, and it is refused here rather than in the component so the rule has one home.
 */
export function readAnswerSelection(
  root: HTMLElement | null,
  selection: AnswerSelection | null,
): PickedAnswerSelection | null {
  if (!root || !selection || selection.rangeCount < 1) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const text = selection.toString()
  if (!text.trim()) return null
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { text, rect }
}

/** The four rows, with the label each one wears. */
function actionsFor(text: string): Array<{ id: string, Icon: LucideIcon, label: string, run: () => void }> {
  return [
    {
      id: 'ask',
      Icon: CornerUpLeft,
      // The question is the reader's, so nothing is sent: the passage goes into the composer as a quote,
      // which is exactly what the editor's own "Ask about this passage" row does.
      label: t(EDITOR_AI_LABELS.ask),
      run: () => useAssistant.getState().seedComposer(quotePassage(text)),
    },
    {
      id: 'translate',
      Icon: Languages,
      label: t(EDITOR_AI_LABELS.translate),
      run: () => useAssistant.getState().seedComposer(`${quotePassage(text)}${t('assistant.chat.select_translate_ask')}`),
    },
    {
      id: 'copy',
      Icon: Copy,
      label: t('assistant.chat.copy'),
      run: () => {
        void copyText(text).then((ok) => {
          // Said out loud: a copy that quietly did nothing is indistinguishable from one that worked.
          if (!ok) useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' })
        })
      },
    },
    {
      id: 'quote-to-note',
      Icon: NotebookPen,
      label: t('assistant.chat.select_quote_to_note'),
      run: () => {
        insertReplyIntoNote(quotePassage(text))
      },
    },
  ]
}

/**
 * The bar itself, mounted by every answer bubble and drawing nothing until the reader highlights a piece
 * of it. `root` is the prose container, which is the whole of what the bubble will call its own text.
 */
export function AnswerSelectionBar({ root }: { root: RefObject<HTMLElement | null> }): ReactNode {
  const [picked, setPicked] = useState<PickedAnswerSelection | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  // Whatever held focus when the bar appeared, which is where Escape gives it back. A pointer reader has
  // nothing focused, and the answer they were reading is the next-best place to stand.
  const returnTo = useRef<HTMLElement | null>(null)
  const noteIsOpen = useUi((state) => state.activeNoteId !== null)

  useEffect(() => {
    const sync = (): void => {
      const next = readAnswerSelection(root.current, window.getSelection())
      setPicked((current) => {
        if (!next) return null
        // The same text at the same place is the same selection: `selectionchange` fires on every step of
        // a drag, and a state write per pixel would redraw the thread all the way down it.
        if (current && current.text === next.text && current.rect.top === next.rect.top && current.rect.left === next.rect.left) {
          return current
        }
        return next
      })
      if (next && returnTo.current === null) returnTo.current = document.activeElement as HTMLElement | null
      if (!next) returnTo.current = null
    }
    document.addEventListener('selectionchange', sync)
    return () => {
      document.removeEventListener('selectionchange', sync)
      setPicked(null)
    }
  }, [root])

  useEffect(() => {
    if (!picked) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (barRef.current?.contains(target) || root.current?.contains(target)) return
      setPicked(null)
    }
    // The thread scrolling takes the bar off the text it was describing, and a bar that followed the
    // reader up the page would be pointing at nothing.
    const onScroll = (): void => setPicked(null)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setPicked(null)
      const back = returnTo.current && returnTo.current !== document.body && document.contains(returnTo.current)
        ? returnTo.current
        : root.current
      back?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [picked, root])

  if (!picked) return null

  const dismiss = (): void => setPicked(null)
  const placed = placeToolbar(picked.rect, { width: window.innerWidth, height: window.innerHeight })
  const rows = actionsFor(picked.text).filter((action) => action.id !== 'quote-to-note' || noteIsOpen)

  return createPortal(
    <div
      ref={barRef}
      role="toolbar"
      aria-label={t('assistant.chat.selection_actions')}
      className="fixed z-[var(--z-pop)] flex items-center gap-0.5 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-raised)] p-1 shadow-[var(--shadow-pop)]"
      style={{ top: placed.top, left: placed.left }}
    >
      {rows.map((action) => (
        <button
          key={action.id}
          type="button"
          data-answer-action={action.id}
          title={action.label}
          aria-label={action.label}
          onClick={() => {
            action.run()
            dismiss()
          }}
          className="inline-flex h-7 items-center gap-1.5 rounded-[var(--r-sm)] px-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          {<action.Icon size={13} />}
          {action.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
