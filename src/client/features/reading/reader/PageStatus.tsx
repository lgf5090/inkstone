/**
 * Where the reader is, and a way to name somewhere else.
 *
 * The number is a page and a percentage at once because the two answer different questions: the page is
 * what the reader can see, the percentage is what they can compare against the whole book. The jump box
 * takes either, or a chapter number, which is what a reader holding a paper copy of the same book types.
 */
import { useState } from 'react'
import { Input } from '../../../components/form'
import { Tooltip as OverlayTooltip } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { parsePositionInput, type BookPosition } from '../position'
import type { BookRecord } from '../types'

export interface PageStatusProps {
  book: BookRecord
  page: { page: number; pages: number }
  fraction: number
  chapterTitle: string
  /** The reader's own pace turned into a guess; null until there is enough of a history to guess from. */
  minutesLeft: number | null
  onJump: (position: BookPosition, fragment?: string) => void
}

export function PageStatus({ book, page, fraction, minutesLeft, onJump }: PageStatusProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100)

  function commit(): void {
    const position = parsePositionInput(draft, {
      kind: book.format === 'epub' ? 'epub' : 'fixed',
      total: Math.max(1, book.unitCount),
    })
    setEditing(false)
    setDraft('')
    if (position) onJump(position)
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') {
            setEditing(false)
            setDraft('')
          }
        }}
        aria-label={t('reading.jump_to_hint')}
        placeholder={`${percent}%`}
        className="h-8 w-28 bg-[var(--reader-bg)] px-2 text-center text-[12px] tabular text-[var(--reader-fg)]"
      />
    )
  }

  return (
    <OverlayTooltip
      label={minutesLeft ? `${t('reading.jump_to_hint')} · ${t('reading.time_left_hint')}` : t('reading.jump_to_hint')}
      side="top"
    >
      <button
        type="button"
        className="reader-page-status reader-pill inline-flex items-center gap-1.5 px-2.5"
        onClick={() => setEditing(true)}
      >
        <span>{page.page} / {page.pages}</span>
        <span aria-hidden="true">·</span>
        <span>{percent}%</span>
        {minutesLeft ? (
          <span aria-hidden="true">·</span>
        ) : null}
        {minutesLeft ? (
          <span>{t('reading.minutes_short', { value0: minutesLeft })}</span>
        ) : null}
      </button>
    </OverlayTooltip>
  )
}
