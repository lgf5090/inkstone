/**
 * The note a footnote reference points at, without leaving the page.
 *
 * A reader hovers a superscript to ask "what is this?" and the answer has to appear where their eyes
 * already are, so the card is placed against the reference's own box and kept inside the window by
 * clipping to its scrollable ancestor — the same rule the rest of the reader's floating parts follow.
 * The card is not a tooltip: it holds a paragraph, a reader may need to select from it, and it stays
 * until they say otherwise.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDownToLine, X } from 'lucide-react'
import { IconButton } from '../../../components/primitives'
import { t } from '../../../lib/i18n'

export interface FootnoteNote {
  /** The note's own words. */
  text: string
  /** The reference's number or mark, which is how the reader knows which note this is. */
  label: string
  /** Where the note lives, so the card can say it before the reader goes there. */
  chapterLabel?: string
}

const GAP = 8
const EDGE = 12

export function FootnotePopover({ note, anchor, onJump, onClose }: {
  note: FootnoteNote
  anchor: DOMRect
  onJump: () => void
  onClose: () => void
}) {
  const card = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState<{ top: number; left: number } | null>(null)

  // Measured after the first paint: the card's own height decides whether it goes above or below the
  // reference, and a guessed height is how a card ends up covering the word it explains.
  useLayoutEffect(() => {
    const element = card.current
    if (!element) return
    const place = () => {
      const { width, height } = element.getBoundingClientRect()
      const roomBelow = window.innerHeight - anchor.bottom - GAP - EDGE
      const top = height + GAP > roomBelow && anchor.top - GAP - EDGE > height
        ? Math.max(EDGE, anchor.top - height - GAP)
        : Math.min(window.innerHeight - height - EDGE, anchor.bottom + GAP)
      const left = Math.min(Math.max(EDGE, anchor.left), Math.max(EDGE, window.innerWidth - width - EDGE))
      setBox({ top, left })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    return () => observer.disconnect()
  }, [anchor, note.text])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      ref={card}
      role="dialog"
      aria-label={t('reading.footnote_title_value0', { value0: note.label })}
      className="reader-note-card"
      style={{ top: box?.top ?? -9999, left: box?.left ?? -9999 }}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]">
          {note.chapterLabel ?? t('reading.footnote_label')}
        </span>
        <IconButton label={t('common.close')} size="xs" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </div>
      <p className="mt-1 max-h-[40vh] overflow-y-auto whitespace-pre-wrap text-[length:var(--text-13)] leading-[1.6] text-[var(--text-primary)]">
        {note.text}
      </p>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={onJump}
          className="inline-flex items-center gap-1.5 rounded-[var(--r-sm)] px-1.5 py-1 text-[length:var(--text-11-5)] font-medium text-[var(--accent)] hover:bg-[var(--bg-hover)]"
        >
          <ArrowDownToLine size={12} aria-hidden="true" />
          {t('reading.go_to_footnote')}
        </button>
      </div>
    </div>
  )
}
