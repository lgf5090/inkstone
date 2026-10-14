import { useState } from 'react'
import { Search, X } from 'lucide-react'
import { DEBOUNCE } from '@shared/constants'
import { useFilterInput } from '../../../../components/FilterInput'
import { IconButton } from '../../../../components/primitives'
import { t } from '../../../i18n'
import { useDebouncedDraft } from '../../../hooks'

/**
 * What a collapsed box shows while it is still filtering. The query is view state, so a board can open
 * with a filter already in force while the box itself starts closed — a bare icon then gives the reader
 * no hint that what they see is not the whole board, since only the counts move. Opening it again and
 * clearing it are both one press from here.
 */
function ActiveSearchChip({ query, onOpen, onClear }: { query: string; onOpen: () => void; onClear: () => void }) {
  return (
    // The chip stands in the row where the search control was, so it takes that control's height on
    // both sides of the breakpoint — and the two things inside it are buttons a finger has to hit.
    <div className='inline-flex h-9 items-center gap-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-1.5 md:h-7'>
      <Search size={12} aria-hidden className='shrink-0 text-[var(--text-tertiary)]' />
      <button
        type='button'
        data-kanban-search
        onClick={onOpen}
        className='h-full max-w-24 truncate px-0.5 text-left text-[length:var(--text-11)] text-[var(--text-primary)] hover:underline'
        title={t('preview.kanban_search_placeholder')}
      >
        {query}
      </button>
      {/* The same clear control every other filter box draws. It keeps the primitives' phone-sized
          target — the header gate measures every icon-only control in this row — and the pill's height
          is its own, so only the button inside it comes from the component system. */}
      <IconButton
        label={t('preview.kanban_clear_search')}
        onClick={onClear}
        className='shrink-0'
      >
        <X size={11} aria-hidden />
      </IconButton>
    </div>
  )
}

export function KanbanSearchBox({
  searchQuery,
  onSearchChange,
}: {
  searchQuery: string
  onSearchChange: (q: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  // Each keystroke used to commit the whole dataset, so filtering re-ran and the
  // undo history grew per character; the draft holds the box, the parent the query.
  const { draft, setDraft } = useDebouncedDraft(searchQuery, onSearchChange, DEBOUNCE.search)

  // The box's own keys are the app-wide filter contract: Escape takes the text back out of the draft —
  // and so out of the board, one debounce later — while a key that arrives mid-composition belongs to
  // the input method, not to the box. The field marks itself `data-owns-escape` because Escape does
  // carry a meaning here: with nothing left to take out, the box goes back to the icon it opened from,
  // and the key stops there rather than dismissing whatever surface stands behind the board.
  const { field } = useFilterInput({
    value: draft,
    onClear: () => setDraft(''),
    escapeWhenEmpty: 'release',
    onKeyDown: (event) => {
      if (event.key !== 'Escape' || draft) return
      event.preventDefault()
      event.stopPropagation()
      setIsOpen(false)
    },
  })

  // The query is view state, so a board can open with a filter already in force while the box itself
  // starts closed. A bare icon then gives the reader no hint that what they see is not the whole board
  // — the count is the only thing that moves — so the query is shown as a chip they can clear.
  if (!isOpen) {
    if (searchQuery !== '') {
      return <ActiveSearchChip query={searchQuery} onOpen={() => setIsOpen(true)} onClear={() => onSearchChange('')} />
    }
    return (
      <button
        type='button'
        data-kanban-search
        onClick={() => setIsOpen(true)}
        className='inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] md:size-7'
        aria-label={t('preview.kanban_search')}
      >
        <Search size={14} aria-hidden />
      </button>
    )
  }

  return (
    <div className='flex h-9 items-center rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 md:h-7'>
      <Search size={13} aria-hidden className='text-[var(--text-tertiary)]' />
      <input
        type='search'
        autoFocus
        data-kanban-search-input
        data-owns-escape='true'
        aria-label={t('preview.kanban_search')}
        {...field}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('preview.kanban_search_placeholder')}
        className='h-full w-28 border-0 bg-transparent px-1.5 text-[length:var(--text-12)] text-[var(--text-primary)] outline-none transition-[width] duration-200 ease-out focus:w-48 [&::-webkit-search-cancel-button]:hidden'
      />
    </div>
  )
}
