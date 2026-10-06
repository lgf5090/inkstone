/**
 * A board shows the cards that fit its canvas — a 480px window with a dozen rows in it — but it used
 * to build one for every card on the board to do so. Measured in jsdom on a 400 card board: the table
 * view put 33k DOM nodes on screen and took 3.5s to switch into, the gallery 17.5k and 1.8s.
 *
 * So each list that owns a scroll area renders a window and hands out the rest as the reader
 * approaches its end. The tail is a real button for that: the observer only pre-fetches, so a browser
 * without one (or a keyboard that never scrolls) still reaches every card. Adding a card does not
 * widen the window — a new card opens in the detail dialog, so it never had to be mounted to be seen.
 */
import { startTransition, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { t } from '../../../i18n'

export const KANBAN_RENDER_WINDOW = 30
const KANBAN_RENDER_STEP = 30
const KANBAN_RENDER_PRELOAD_PX = 400

interface KanbanRenderWindow<T> {
  visible: T[]
  hiddenCount: number
  /** Pass to the tail button's `ref`; the observer follows the element, so a tail that is not
   *  rendered (a collapsed group) simply has nothing to watch until it appears. */
  setTailElement: Dispatch<SetStateAction<HTMLButtonElement | null>>
  revealMore: () => void
}

export function useKanbanRenderWindow<T>(items: T[]): KanbanRenderWindow<T> {
  const [limit, setLimit] = useState(KANBAN_RENDER_WINDOW)
  const [tailElement, setTailElement] = useState<HTMLButtonElement | null>(null)
  const hiddenCount = Math.max(0, items.length - limit)

  const revealMore = () => {
    // Growing the window is what scrolling does, so it must not block the scroll it answers.
    startTransition(() => {
      setLimit((current) => current + KANBAN_RENDER_STEP)
    })
  }

  useEffect(() => {
    if (!tailElement || hiddenCount === 0 || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        revealMore()
      }
    }, { rootMargin: `${KANBAN_RENDER_PRELOAD_PX}px 0px` })
    observer.observe(tailElement)
    return () => {
      observer.disconnect()
    }
  }, [hiddenCount, tailElement])

  return {
    visible: limit >= items.length ? items : items.slice(0, limit),
    hiddenCount,
    setTailElement,
    revealMore,
  }
}

interface KanbanRenderTailProps {
  hiddenCount: number
  setTailElement: Dispatch<SetStateAction<HTMLButtonElement | null>>
  onReveal: () => void
  /** Given on a table surface, where anything between rows has to be a row of the grid itself. */
  columnCount?: number
}

export function KanbanRenderTail({ hiddenCount, setTailElement, onReveal, columnCount }: KanbanRenderTailProps) {
  if (hiddenCount === 0) {
    return null
  }
  const control = (
    <button
      type='button'
      ref={setTailElement}
      onClick={onReveal}
      data-kanban-render-more
      className='flex items-center gap-[var(--sp-1-5)] rounded-[var(--r-md)] px-[var(--sp-2)] py-[var(--sp-1-5)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
    >
      {t('preview.kanban_show_more', { count: hiddenCount })}
    </button>
  )
  if (columnCount === undefined) {
    return <div className='p-[var(--sp-1)]'>{control}</div>
  }
  return (
    <div role='row' className='border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] px-[var(--sp-4)] py-[var(--sp-1)]'>
      <div role='cell' aria-colspan={columnCount}>{control}</div>
    </div>
  )
}
