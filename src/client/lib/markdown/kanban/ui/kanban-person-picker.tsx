import { useId, useRef, useState } from 'react'
import { UserRound, X } from 'lucide-react'
import { useClickOutside, useEscape } from '../../../../components/overlay'
import { t } from '../../../i18n'
import { kanbanPersonInitials, kanbanPersonName } from '../person'
import type { RefObject } from 'react'

/**
 * The one way a person is drawn. The cards, the list rows and the gallery footer all showed the
 * same two letters, so the letters and the name they stand for live here.
 */
export function KanbanPersonAvatar({ name }: { name: string }) {
  return (
    <span
      role='img'
      aria-label={name}
      title={name}
      className='flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[length:var(--text-10)] font-bold text-[var(--accent)]'
    >
      <span aria-hidden>{kanbanPersonInitials(name)}</span>
    </span>
  )
}

interface KanbanPersonPickerProps {
  /** What the column is called, so the control says whose member it picks. */
  propertyName: string
  value: unknown
  candidates?: string[]
  onChange: (name: string) => void
}

function matches(query: string, candidates: string[]): string[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return candidates
  return candidates.filter((name) => name.toLowerCase().includes(needle))
}

function canAdd(query: string, candidates: string[]): boolean {
  const needle = query.trim().toLowerCase()
  return needle.length > 0 && !candidates.some((name) => name.toLowerCase() === needle)
}

function PersonTrigger({
  propertyName,
  person,
  open,
  panelId,
  triggerRef,
  onToggle,
}: {
  propertyName: string
  person: string
  open: boolean
  panelId: string
  triggerRef: RefObject<HTMLButtonElement | null>
  onToggle: () => void
}) {
  return (
    <button
      ref={triggerRef}
      type='button'
      onClick={onToggle}
      aria-label={t('preview.kanban_person_change', { property: propertyName })}
      aria-haspopup='dialog'
      aria-expanded={open}
      {...(open ? { 'aria-controls': panelId } : {})}
      className='flex w-full min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] border border-transparent px-1.5 py-1 text-left text-[length:var(--text-12)] text-[var(--text-primary)] outline-none hover:border-[var(--border-subtle)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]'
    >
      {person ? (
        <>
          <KanbanPersonAvatar name={person} />
          <span className='truncate'>{person}</span>
        </>
      ) : (
        <span className='truncate text-[var(--text-tertiary)]'>{t('preview.kanban_person_unassigned')}</span>
      )}
    </button>
  )
}

function PersonChoiceRow({ name, current, onPick }: { name: string; current: boolean; onPick: (name: string) => void }) {
  return (
    <button
      type='button'
      data-kanban-person-choice
      aria-current={current ? 'true' : undefined}
      onClick={() => onPick(name)}
      className='flex items-center gap-1.5 rounded-[var(--r-xs)] px-1.5 py-1 text-left text-[length:var(--text-12)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
    >
      <KanbanPersonAvatar name={name} />
      <span data-kanban-person-name className='truncate'>{name}</span>
    </button>
  )
}

function PersonAddRow({ name, onPick }: { name: string; onPick: (name: string) => void }) {
  return (
    <button
      type='button'
      data-kanban-person-add
      onClick={() => onPick(name)}
      className='flex items-center gap-1.5 rounded-[var(--r-xs)] border border-dashed border-[var(--border-default)] px-1.5 py-1 text-left text-[length:var(--text-12)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
    >
      <UserRound size={14} aria-hidden />
      <span className='truncate'>{t('preview.kanban_person_add', { name })}</span>
    </button>
  )
}

function PersonClearRow({ onPick }: { onPick: () => void }) {
  return (
    <button
      type='button'
      aria-label={t('preview.kanban_person_clear')}
      onClick={onPick}
      className='flex items-center gap-1.5 rounded-[var(--r-xs)] px-1.5 py-1 text-left text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
    >
      <X size={12} aria-hidden />
      <span>{t('preview.kanban_person_clear')}</span>
    </button>
  )
}

interface PersonPanelProps {
  panelId: string
  panelRef: RefObject<HTMLDivElement | null>
  propertyName: string
  person: string
  query: string
  visible: string[]
  addable: string
  onQuery: (query: string) => void
  onPick: (name: string) => void
}

function PersonPanel({
  panelId,
  panelRef,
  propertyName,
  person,
  query,
  visible,
  addable,
  onQuery,
  onPick,
}: PersonPanelProps) {
  const handleQueryKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    // A search that still leaves a teammate on screen means that teammate; creating a near-duplicate
    // spelling of them is what the separate add button is for.
    if (visible.length > 0) onPick(visible[0]!)
    else if (addable) onPick(addable)
  }

  return (
    <div
      id={panelId}
      ref={panelRef}
      role='dialog'
      aria-label={t('preview.kanban_person_pick', { property: propertyName })}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className='absolute left-0 top-full z-[var(--z-popover)] mt-1 flex w-56 flex-col gap-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)]'
    >
      <input
        type='search'
        autoFocus
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={handleQueryKey}
        aria-label={t('preview.kanban_person_search')}
        placeholder={t('preview.kanban_person_search')}
        className='h-7 w-full rounded-[var(--r-xs)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 text-[length:var(--text-12)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'
      />
      {visible.map((name) => (
        <PersonChoiceRow key={name} name={name} current={name === person} onPick={onPick} />
      ))}
      {addable && <PersonAddRow name={addable} onPick={onPick} />}
      {visible.length === 0 && !addable && (
        <span className='px-1.5 py-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]'>
          {t('preview.kanban_person_none')}
        </span>
      )}
      {person && <PersonClearRow onPick={() => onPick('')} />}
    </div>
  )
}

/** Everything about the panel that is not how it looks: what is open, what the search leaves. */
function usePersonPanel(value: unknown, candidates: string[], onPick: (name: string) => void) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  const person = kanbanPersonName(value)
  const visible = matches(query, candidates)
  const addable = canAdd(query, candidates) ? query.trim() : ''

  const forget = () => {
    setOpen(false)
    setQuery('')
  }
  // Closing from inside the panel hands focus back to the trigger; a click elsewhere already put
  // focus where the reader aimed it.
  const close = () => {
    const hadFocus = panelRef.current?.contains(document.activeElement) ?? false
    forget()
    if (hadFocus) triggerRef.current?.focus()
  }

  useClickOutside([panelRef, triggerRef], open, forget)
  useEscape(open, close)

  return {
    open,
    query,
    person,
    visible,
    addable,
    panelId,
    panelRef,
    triggerRef,
    onQuery: setQuery,
    toggle: () => setOpen((o) => !o),
    pick: (name: string) => {
      onPick(name)
      close()
    },
  }
}

export function KanbanPersonPicker({ propertyName, value, candidates = [], onChange }: KanbanPersonPickerProps) {
  const panel = usePersonPanel(value, candidates, onChange)
  return (
    <div className='relative flex items-center'>
      <PersonTrigger
        propertyName={propertyName}
        person={panel.person}
        open={panel.open}
        panelId={panel.panelId}
        triggerRef={panel.triggerRef}
        onToggle={panel.toggle}
      />
      {panel.open && (
        <PersonPanel
          panelId={panel.panelId}
          panelRef={panel.panelRef}
          propertyName={propertyName}
          person={panel.person}
          query={panel.query}
          visible={panel.visible}
          addable={panel.addable}
          onQuery={panel.onQuery}
          onPick={panel.pick}
        />
      )}
    </div>
  )
}

