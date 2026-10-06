import { useMemo, useRef, useState } from 'react'
import { Link2, Plus, X } from 'lucide-react'
import { useClickOutside, useEscape } from '../../../../components/overlay'
import { t } from '../../../i18n'
import { kanbanDependencyIds, kanbanDependencyWouldCycle } from '../dependencies'
import type { KanbanItem } from '../types'

/**
 * The detail panel's dependency editor (KU-23, ADR-0006): the list of cards this card waits on,
 * with a searchable way to add a blocker and one remove button per row. The picker offers only
 * what would stick — the board's other cards, minus those already named — so a cycle is never
 * offered, let alone written; the missing ids a hand-edited fence may carry are listed as missing
 * rather than dropped, because a read must not rewrite a document the reader only opened.
 */

interface DependencyChoice {
  id: string
  title: string
}

function matches(query: string, choices: DependencyChoice[]): DependencyChoice[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return choices
  return choices.filter((choice) => choice.title.toLowerCase().includes(needle))
}

/** The trigger the add picker opens from; the panel is a sibling, opened above it in z-order. */
function DependencyAddTrigger({
  open,
  panelId,
  onToggle,
}: {
  open: boolean
  panelId: string
  onToggle: () => void
}) {
  return (
    <button
      type='button'
      onClick={onToggle}
      aria-haspopup='listbox'
      aria-expanded={open}
      {...(open ? { 'aria-controls': panelId } : {})}
      className='flex items-center gap-1.5 rounded-[var(--r-xs)] border border-dashed border-[var(--border-default)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-tertiary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]'
    >
      <Plus size={12} aria-hidden />
      <span>{t('preview.kanban_dependency_add')}</span>
    </button>
  )
}

/** The listbox itself: the search field and the choices the board still allows. */
function DependencyChoiceList({
  panelId,
  query,
  choices,
  onQuery,
  onPick,
}: {
  panelId: string
  query: string
  choices: DependencyChoice[]
  onQuery: (query: string) => void
  onPick: (id: string) => void
}) {
  return (
    <div
      id={panelId}
      role='listbox'
      aria-label={t('preview.kanban_dependency_add')}
      className='absolute left-0 top-full z-[var(--z-popover)] mt-1 flex max-h-56 w-64 flex-col gap-0.5 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1.5 shadow-[var(--shadow-pop)]'
    >
      <input
        type='search'
        autoFocus
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && choices.length > 0) onPick(choices[0]!.id)
        }}
        aria-label={t('preview.kanban_dependency_add')}
        placeholder={t('preview.kanban_dependency_add')}
        className='h-7 w-full rounded-[var(--r-xs)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 text-[length:var(--text-12)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'
      />
      {choices.map((choice) => (
        <button
          key={choice.id}
          type='button'
          role='option'
          aria-selected={false}
          onClick={() => onPick(choice.id)}
          className='flex items-center gap-1.5 rounded-[var(--r-xs)] px-1.5 py-1 text-left text-[length:var(--text-12)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
        >
          <Link2 size={12} aria-hidden className='shrink-0 text-[var(--text-tertiary)]' />
          <span className='truncate'>{choice.title}</span>
        </button>
      ))}
      {choices.length === 0 && (
        <span className='px-1.5 py-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]'>
          {t('preview.kanban_dependency_none')}
        </span>
      )}
    </div>
  )
}

function DependencyAddRow({
  board,
  excluded,
  onAdd,
}: {
  board: KanbanItem[]
  /** The ids the picker must not offer: already named, or any that would close a loop. */
  excluded: Set<string>
  onAdd: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const panelId = useMemo(() => `kanban-dep-add-${Math.random().toString(36).slice(2, 8)}`, [])

  const choices = useMemo(() => {
    const available = board
      .filter((item) => !excluded.has(item.id))
      .map((item) => ({ id: item.id, title: item.title }))
    return matches(query, available)
  }, [board, excluded, query])

  const close = () => {
    setOpen(false)
    setQuery('')
  }

  useClickOutside([containerRef], open, close)
  useEscape(open, close)

  const pick = (id: string) => {
    onAdd(id)
    close()
  }

  return (
    <div ref={containerRef} className='relative'>
      <DependencyAddTrigger open={open} panelId={panelId} onToggle={() => setOpen((o) => !o)} />
      {open && (
        <DependencyChoiceList
          panelId={panelId}
          query={query}
          choices={choices}
          onQuery={setQuery}
          onPick={pick}
        />
      )}
    </div>
  )
}

function DependencyRow({ title, onRemove }: { title: string; onRemove: () => void }) {
  return (
    <div className='flex items-center gap-1.5 rounded-[var(--r-xs)] bg-[var(--bg-surface)] px-2 py-1 text-[length:var(--text-12)] shadow-2xs'>
      <Link2 size={12} aria-hidden className='shrink-0 text-[var(--text-tertiary)]' />
      <span className='flex-1 truncate text-[var(--text-primary)]'>{title}</span>
      <button
        type='button'
        onClick={onRemove}
        aria-label={t('preview.kanban_delete_named', { name: title })}
        className='text-[var(--text-tertiary)] hover:text-[var(--danger)]'
      >
        <X size={11} />
      </button>
    </div>
  )
}

/**
 * A blocker the board no longer holds: reported rather than dropped (ADR-0006 — a read must not
 * rewrite a document), with its own remove button since it can never be edited back into existence.
 */
function MissingDependencyRow({ id, onRemove }: { id: string; onRemove: () => void }) {
  return (
    <div className='flex items-center gap-1.5 rounded-[var(--r-xs)] border border-dashed border-[var(--border-default)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]'>
      <Link2 size={12} aria-hidden className='shrink-0' />
      <span className='flex-1 truncate'>{t('preview.kanban_dependency_missing', { id })}</span>
      <button
        type='button'
        onClick={onRemove}
        aria-label={t('preview.kanban_dependency_missing', { id })}
        className='text-[var(--text-tertiary)] hover:text-[var(--danger)]'
      >
        <X size={11} />
      </button>
    </div>
  )
}

export function DetailDependencies({
  item,
  board,
  onChange,
}: {
  item: KanbanItem
  /** Every card the board holds today, as the picker's roster and the row titles' source. */
  board: KanbanItem[]
  /** The whole list, written through the board's guarded writer. */
  onChange: (deps: string[]) => void
}) {
  const deps = kanbanDependencyIds(item)
  const missing = deps.filter((id) => !board.some((other) => other.id === id))
  const titleOf = (id: string) => board.find((other) => other.id === id)?.title ?? id
  // The picker never offers what would not stick: cards already named, and any card that would
  // close a loop through the ones already on the board. The writer re-checks regardless (ADR-0006).
  const excluded = useMemo(() => {
    const ids = new Set(deps)
    for (const other of board) {
      if (!ids.has(other.id) && kanbanDependencyWouldCycle(board, item.id, other.id)) ids.add(other.id)
    }
    return ids
  }, [board, deps, item.id])

  return (
    <div className='flex flex-col gap-2'>
      <div>
        <div className='text-[length:var(--text-13)] font-semibold'>
          <h4 className='text-[var(--text-secondary)]'>{t('preview.kanban_dependencies')}</h4>
        </div>
        <p className='text-[length:var(--text-11)] text-[var(--text-tertiary)]'>
          {t('preview.kanban_dependencies_hint')}
        </p>
      </div>
      <div className='flex flex-col gap-1'>
        {deps.map((id) => (
          <DependencyRow
            key={id}
            title={titleOf(id)}
            onRemove={() => onChange(deps.filter((dep) => dep !== id))}
          />
        ))}
        {missing.map((id) => (
          <MissingDependencyRow
            key={id}
            id={id}
            onRemove={() => onChange(deps.filter((dep) => dep !== id))}
          />
        ))}
        <DependencyAddRow
          board={board}
          excluded={excluded}
          onAdd={(id) => onChange([...deps, id])}
        />
      </div>
    </div>
  )
}
