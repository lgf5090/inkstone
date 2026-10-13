/**
 * One book on the shelf.
 *
 * The cover carries the progress: a reader scanning a shelf is asking "where was I?", and a bar drawn
 * on the cover's own edge answers it in the same glance that finds the book. The caption holds only
 * what the cover cannot say, and the count of marked passages is what makes a book look worth opening
 * again rather than merely unread.
 */
import { BookOpen, MessageSquareQuote, PenLine } from 'lucide-react'
import { IconButton } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { formatLastRead } from './format-time'
import type { BookRecord } from './types'

export interface ShelfCardProps {
  book: BookRecord
  coverUrl?: string
  fraction: number
  finished: boolean
  highlightCount: number
  noteCount: number
  lastReadAt?: number
  /** Which of the reader's own groupings this book belongs to. */
  groupNames?: string[]
  /** Covers mode: the picture is the whole card, so the caption gives its room to a bigger cover. */
  captionless?: boolean
  onOpen: () => void
  onOpenNote: () => void
  onMenu: (event: React.MouseEvent) => void
}

export function ShelfCard({
  book,
  coverUrl,
  fraction,
  finished,
  highlightCount,
  noteCount,
  lastReadAt,
  groupNames = [],
  captionless = false,
  onOpen,
  onOpenNote,
  onMenu,
}: ShelfCardProps) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100)
  return (
    <div className="reader-shelf-card group relative flex flex-col">
      <button
        type="button"
        onClick={onOpen}
        onContextMenu={onMenu}
        className="relative block overflow-hidden rounded-[var(--r-md)] text-left focus-visible:outline-2 focus-visible:outline-offset-2"
        aria-label={t('reading.open_book_value0', { value0: book.title })}
      >
        {coverUrl ? (
          <img src={coverUrl} alt="" loading="lazy" className="reader-shelf-cover" />
        ) : (
          <span className="reader-shelf-cover flex flex-col items-center justify-center gap-1.5 border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 text-center">
            <BookOpen size={22} className="text-[var(--text-quaternary)]" />
            <span className="line-clamp-4 font-serif text-[12px] leading-snug text-[var(--text-secondary)]">{book.title}</span>
          </span>
        )}
        <span
          className="absolute inset-x-0 bottom-0 h-[3px] bg-[var(--accent)] transition-opacity"
          style={{ width: `${finished ? 100 : percent}%`, opacity: fraction > 0 || finished ? 1 : 0 }}
          aria-hidden="true"
        />
        {finished ? (
          <span className="absolute top-1.5 left-1.5 rounded-[var(--r-sm)] bg-[var(--bg-overlay)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--success)] shadow-[var(--shadow-xs)]">
            {t('reading.finished')}
          </span>
        ) : percent > 0 ? (
          <span className="absolute top-1.5 left-1.5 rounded-[var(--r-sm)] bg-[var(--bg-overlay)] px-1.5 py-0.5 text-[10px] font-medium tabular text-[var(--text-secondary)] shadow-[var(--shadow-xs)]">
            {percent}%
          </span>
        ) : null}
      </button>

      {captionless ? <span className="reader-shelf-hover-title">{book.title}</span> : null}
      <div className={captionless ? 'sr-only' : 'mt-1.5 min-w-0'}>
        <Tooltip label={book.title} side="top">
          <p className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">{book.title}</p>
        </Tooltip>
        <p className="truncate text-[11px] text-[var(--text-tertiary)]">
          {book.author || t('reading.unknown_author')}
        </p>
        {groupNames.length ? (
          <p className="mt-0.5 flex gap-1 overflow-hidden">
            {groupNames.slice(0, 2).map((name) => (
              <span key={name} className="max-w-full truncate rounded-full border border-[var(--border-subtle)] px-1.5 text-[10px] text-[var(--text-quaternary)]">
                {name}
              </span>
            ))}
            {groupNames.length > 2 ? (
              <span className="text-[10px] tabular text-[var(--text-quaternary)]">+{groupNames.length - 2}</span>
            ) : null}
          </p>
        ) : null}
        <p className="mt-0.5 flex items-center gap-1 truncate text-[10.5px] text-[var(--text-quaternary)]">
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
          <span className="truncate">{formatLastRead(lastReadAt) || book.format.toUpperCase()}</span>
        </p>
      </div>

      <div className="reader-shelf-actions absolute bottom-1.5 right-1.5 flex gap-1">
        {noteCount > 0 ? (
          <Tooltip label={t('reading.open_note')} side="left">
            <IconButton label={t('reading.open_note')} size="xs" onClick={onOpenNote} className="reader-shelf-note border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-xs)]">
              <MessageSquareQuote size={12} />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip label={t('reading.book_actions')} side="left">
          <IconButton label={t('reading.book_actions')} size="xs" onClick={onMenu} className="border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-xs)]">
            <MoreDots />
          </IconButton>
        </Tooltip>
      </div>
    </div>
  )
}

/** The three-dot affordance, drawn rather than imported so it sits on the same optical grid as the card. */
function MoreDots() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
      <circle cx="2.5" cy="6" r="1.1" />
      <circle cx="6" cy="6" r="1.1" />
      <circle cx="9.5" cy="6" r="1.1" />
    </svg>
  )
}
