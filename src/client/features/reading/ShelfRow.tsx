/**
 * One book on the shelf, as a row.
 *
 * The list view exists for two readers: one on a phone where a cover is too small to identify, and one
 * with four hundred books who is searching by author rather than by picture. So the row leads with the
 * title, gives the cover only enough room to be a fingerprint, and puts the numbers a reader actually
 * compares — progress, marks, when they last read it — on their own line.
 */
import { BookOpen, MessageSquareQuote, PenLine } from 'lucide-react'
import { IconButton } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { formatLastRead } from './format-time'
import { ProgressRing } from './ProgressRing'
import type { BookRecord } from './types'

export interface ShelfRowProps {
  book: BookRecord
  coverUrl?: string
  fraction: number
  finished: boolean
  highlightCount: number
  noteCount: number
  lastReadAt?: number
  /** The chapter or page the reader stopped on, in the book's own words. */
  stoppedAt?: string
  /** Which of the reader's own groupings this book belongs to. */
  groupNames?: string[]
  onOpen: () => void
  onOpenNote: () => void
  onMenu: (event: React.MouseEvent) => void
}

export function ShelfRow({
  book,
  coverUrl,
  fraction,
  finished,
  highlightCount,
  noteCount,
  lastReadAt,
  stoppedAt = '',
  groupNames = [],
  onOpen,
  onOpenNote,
  onMenu,
}: ShelfRowProps) {
  const lastRead = formatLastRead(lastReadAt)
  return (
    <div className="reader-shelf-row group relative flex items-center gap-3 rounded-[var(--r-md)] ps-2 py-2 hover:bg-[var(--bg-hover)] focus-within:bg-[var(--bg-hover)]">
      <button
        type="button"
        onClick={onOpen}
        onContextMenu={onMenu}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2"
        aria-label={t('reading.open_book_value0', { value0: book.title })}
      >
        {coverUrl ? (
          <img src={coverUrl} alt="" loading="lazy" className="h-[52px] w-[38px] shrink-0 rounded-[var(--r-sm)] border border-[var(--border-subtle)] object-cover" />
        ) : (
          <span className="flex h-[52px] w-[38px] shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
            <BookOpen size={15} className="text-[var(--text-quaternary)]" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">{book.title}</span>
          <span className="block truncate text-[11.5px] text-[var(--text-tertiary)]">
            {book.author || t('reading.unknown_author')}
            {book.publisher ? <span className="text-[var(--text-quaternary)]"> · {book.publisher}</span> : null}
          </span>
          <span className="mt-0.5 flex items-center gap-2 truncate text-[11px] text-[var(--text-quaternary)]">
            {highlightCount > 0 ? (
              <span className="inline-flex items-center gap-0.5">
                <PenLine size={10} />
                <span className="tabular">{highlightCount}</span>
              </span>
            ) : null}
            {noteCount > 0 ? (
              <span className="inline-flex items-center gap-0.5">
                <MessageSquareQuote size={10} />
                <span className="tabular">{noteCount}</span>
              </span>
            ) : null}
            {groupNames.map((name) => (
              <span key={name} className="max-w-[8rem] truncate rounded-full border border-[var(--border-subtle)] px-1.5 text-[10px]">
                {name}
              </span>
            ))}
            <span className="truncate">{lastRead || `${book.format.toUpperCase()} · ${Math.round(book.size / 1024)} kB`}</span>
          </span>
        </span>
        {stoppedAt ? (
          <span className="hidden max-w-[15rem] shrink-0 truncate text-right text-[11px] text-[var(--text-quaternary)] lg:block">
            {stoppedAt}
          </span>
        ) : null}
        <ProgressRing fraction={fraction} finished={finished} />
      </button>

      <div className="reader-shelf-actions flex items-center gap-1">
        {noteCount > 0 ? (
          <Tooltip label={t('reading.open_note')} side="left">
            <IconButton label={t('reading.open_note')} size="xs" onClick={onOpenNote}>
              <MessageSquareQuote size={12} />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip label={t('reading.book_actions')} side="left">
          <IconButton label={t('reading.book_actions')} size="xs" onClick={onMenu}>
            <MoreDots />
          </IconButton>
        </Tooltip>
      </div>
    </div>
  )
}

/** The three-dot affordance, drawn rather than imported so it matches the grid card's. */
function MoreDots() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
      <circle cx="2.5" cy="6" r="1.1" />
      <circle cx="6" cy="6" r="1.1" />
      <circle cx="9.5" cy="6" r="1.1" />
    </svg>
  )
}
