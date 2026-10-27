/**
 * A multi-select the app can draw: a trigger and a panel of real checkboxes.
 *
 * The native `<select multiple>` cannot show a checked list without a modifier key, and its system
 * chrome ignores every token. This keeps the semantics (each row is a labelled checkbox) and closes on
 * Escape or a press outside, which is what the app's menus already do.
 */
import { useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { useClickOutside, useEscape } from '../../../components/overlay'

export interface MultiSelectOption {
  value: string
  label: string
  hint?: string
}

export function MultiSelect({
  label,
  value,
  options,
  onChange,
  placeholder,
  className,
  disabled,
}: {
  /** Accessible name; also the panel's own heading. */
  label: string
  value: readonly string[]
  options: readonly MultiSelectOption[]
  onChange: (next: string[]) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const panelId = useId()
  useEscape(open, () => setOpen(false))
  useClickOutside([wrapper], open, () => setOpen(false))

  const selected = new Set(value)
  const summary = value.length === 0
    ? (placeholder ?? label)
    : options.filter((option) => selected.has(option.value)).map((option) => option.label).join(', ')

  function toggle(option: string): void {
    const next = new Set(selected)
    if (next.has(option)) next.delete(option)
    else next.add(option)
    onChange([...next])
  }

  return (
    <div ref={wrapper} className={cn('relative', className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
        className={cn(
          'flex h-11 w-full items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--border-default)]',
          'bg-[var(--bg-raised)] px-2.5 text-left text-[length:var(--text-13)] md:h-[34px] md:text-[length:var(--text-12-5)]',
          'focus-visible:border-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-soft)]',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        <span className={cn('truncate', value.length === 0 && 'text-[var(--text-quaternary)]')}>{summary}</span>
        <ChevronDown size={13} className="shrink-0 text-[var(--text-tertiary)]" />
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={label}
          className="absolute z-[var(--z-pop)] mt-1 max-h-64 w-full min-w-52 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)]"
        >
          <div className="flex items-center justify-between px-1.5 py-1">
            <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{label}</span>
            <button
              type="button"
              onClick={() => onChange([])}
              className="rounded-[var(--r-xs)] px-1.5 py-0.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              {t('common.clear')}
            </button>
          </div>
          {options.length === 0 && (
            <p className="px-2 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{placeholder ?? label}</p>
          )}
          {options.map((option) => {
            const checked = selected.has(option.value)
            return (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 rounded-[var(--r-xs)] px-1.5 py-1.5 text-[length:var(--text-12-5)] hover:bg-[var(--bg-hover)]"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(option.value)}
                  className="size-3.5 accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint && <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{option.hint}</span>}
                {checked && <Check size={12} aria-hidden="true" className="text-[var(--accent)]" />}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
