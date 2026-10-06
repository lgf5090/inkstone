import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { t } from '../../../i18n'

// Each keystroke used to commit the whole dataset, so filtering re-ran and the
// undo history grew per character; the draft holds the box, the parent the query.
const SEARCH_DEBOUNCE_MS = 200

function useDebouncedSearch(value: string, commit: (next: string) => void) {
  const [draft, setDraft] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const committedRef = useRef(value)

  // A query set elsewhere (switching views, clearing filters) wins over the draft.
  useEffect(() => {
    if (value !== committedRef.current) setDraft(value)
  }, [value])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const handleChange = (next: string) => {
    setDraft(next)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      committedRef.current = next
      commit(next)
    }, SEARCH_DEBOUNCE_MS)
  }

  return { draft, handleChange }
}

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
      <button
        type='button'
        onClick={onClear}
        className='inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] md:size-5'
        aria-label={t('preview.kanban_clear_search')}
      >
        <X size={11} aria-hidden />
      </button>
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
  const { draft, handleChange } = useDebouncedSearch(searchQuery, onSearchChange)

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
        type='text'
        autoFocus
        data-kanban-search-input
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={t('preview.kanban_search_placeholder')}
        className='h-full w-28 border-0 bg-transparent px-1.5 text-[length:var(--text-12)] text-[var(--text-primary)] outline-none transition-[width] duration-200 ease-out focus:w-48'
      />
    </div>
  )
}
