/**
 * The frame every project view sits in: a head that names the surface and counts what it shows, a
 * toolbar of controls that change what is drawn, and a body that owns the remaining height.
 *
 * Ten views used to each invent their own padding, border and empty state, so switching tabs moved
 * the whole page. One shell means the tab strip is the only thing that changes.
 */
import { useState, type ReactElement, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { isImeComposing } from '../../../lib/ime'
import { Input } from '../../../components/form'

export function ViewShell({ children, ...rest }: { children: ReactNode, 'data-view': string }): ReactElement {
  return <div className="pv pv-scroll relative" data-view={rest['data-view']}>{children}</div>
}

export function ViewHead({ icon, title, count, note, children }: {
  icon?: ReactNode
  title: string
  count?: number
  note?: string
  children?: ReactNode
}): ReactElement {
  return (
    <div className="pv-head">
      <span className="pv-head-title">
        {icon}
        {title}
      </span>
      {count !== undefined && <span className="pv-head-count">{count}</span>}
      {note && <span className="pv-head-note">{note}</span>}
      {children && <span className="pv-head-actions">{children}</span>}
    </div>
  )
}

export function ViewToolbar({ children }: { children: ReactNode }): ReactElement {
  return <div className="pv-toolbar">{children}</div>
}

/** A pill row of mutually exclusive choices; `aria-pressed` carries the state a screen reader needs. */
export function Seg<T extends string>({ value, options, onChange, label }: {
  value: T
  options: readonly { value: T, label: string }[]
  onChange: (value: T) => void
  label: string
}): ReactElement {
  return (
    <div className="pv-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="pv-seg-btn"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Legend({ items }: { items: readonly { key: string, label: string, color: string, title?: string }[] }): ReactElement | null {
  if (items.length === 0) return null
  return (
    <div className="pv-legend pv-scroll" aria-label={t('project.view.legend')}>
      {items.map((item) => (
        <span key={item.key} className="pv-legend-item" title={item.title ?? item.label}>
          <span className="pv-legend-swatch" style={{ backgroundColor: item.color }} aria-hidden="true" />
          <span className="pv-legend-text">{item.label}</span>
        </span>
      ))}
    </div>
  )
}

/**
 * The inline "add a card" control every collection surface offers.
 *
 * It stays a button until pressed so a column of twenty cards is not twenty open text fields, and it
 * keeps focus after a submit so typing three cards in a row is three Enters rather than six clicks.
 */
export function QuickAdd({ label, placeholder, onAdd, className }: {
  label: string
  placeholder?: string
  onAdd: (title: string) => Promise<void>
  className?: string
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (form: HTMLFormElement): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await onAdd(trimmed)
      setTitle('')
      form.querySelector('input')?.focus()
    } finally {
      setBusy(false)
    }
  }
  if (!open) {
    return (
      <button type="button" className={`pv-quickadd-btn ${className ?? ''}`} onClick={() => setOpen(true)}>
        <Plus size={13} aria-hidden="true" />
        <span>{label}</span>
      </button>
    )
  }
  return (
    <form className={className} onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget) }}>
      <Input
        className="w-full"
        value={title}
        autoFocus
        disabled={busy}
        aria-label={label}
        placeholder={placeholder ?? t('project.board.card_placeholder')}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape' && !isImeComposing(event)) { setOpen(false); setTitle('') } }}
        onBlur={() => { if (!title.trim()) setOpen(false) }}
      />
    </form>
  )
}

/** The empty body a view shows when its filter left nothing, with the action that fixes it. */
export function ViewEmpty({ title, hint }: { title: string, hint?: string }): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">{title}</p>
      {hint && <p className="max-w-sm text-[length:var(--text-12)] text-[var(--text-tertiary)]">{hint}</p>}
    </div>
  )
}