/**
 * A search box with the app's own chrome.
 *
 * Typing is immediate; debouncing belongs to the caller, because a filter that runs on every
 * keystroke of a local list and one that asks the server are different costs. Escape clears the box,
 * which is the one shortcut every search field in this notebook shares.
 */
import { Search, X } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  className,
  autoFocus,
  onSubmit,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label: string
  className?: string
  autoFocus?: boolean
  onSubmit?: () => void
}) {
  return (
    <div className={cn('relative', className)}>
      <Search
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-tertiary)]"
      />
      <input
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.stopPropagation()
            onChange('')
          }
          if (event.key === 'Enter') onSubmit?.()
        }}
        className={cn(
          'h-11 w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-raised)] pr-8 pl-8',
          'text-[length:var(--text-13)] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)]',
          'focus-visible:border-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-soft)]',
          'md:h-[34px] md:text-[length:var(--text-12-5)]',
        )}
      />
      {value && (
        <button
          type="button"
          aria-label={t('common.clear')}
          onClick={() => onChange('')}
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-[var(--r-xs)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}
