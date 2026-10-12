/**
 * Where the reader is, and a way to name somewhere else.
 *
 * The number is a page and a percentage at once because the two answer different questions: the page is
 * what the reader can see, the percentage is what they can compare against the whole book. The jump box
 * takes either, or a chapter number, which is what a reader holding a paper copy of the same book types.
 */
import { useState } from 'react'
import { t } from '../../../lib/i18n'
import { parsePositionInput, type BookPosition } from '../position'
import type { BookRecord } from '../types'

export interface PageStatusProps {
  book: BookRecord
  page: { page: number; pages: number }
  fraction: number
  chapterTitle: string
  onJump: (position: BookPosition, fragment?: string) => void
}

export function PageStatus({ book, page, fraction, onJump }: PageStatusProps) {
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
      <input
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
        className="h-8 w-28 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--reader-bg)] px-2 text-center text-[12px] tabular text-[var(--reader-fg)] outline-none"
      />
    )
  }

  return (
    <button
      type="button"
      className="reader-page-status reader-pill inline-flex items-center gap-1.5 px-2.5"
      onClick={() => setEditing(true)}
      title={t('reading.jump_to_hint')}
    >
      <span>{page.page} / {page.pages}</span>
      <span aria-hidden="true">·</span>
      <span>{percent}%</span>
    </button>
  )
}
