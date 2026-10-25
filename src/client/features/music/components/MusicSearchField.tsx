/** The quiet search box the favourites and history shelves share. */
import type { ReactElement } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '../../../components/form'
import { isImeComposing } from '../../../lib/ime'
import { musicText } from './labels'

export function MusicSearchField({
  value,
  onChange,
  label,
  placeholder,
  className = 'w-full sm:max-w-[280px]',
}: {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder: string
  className?: string
}): ReactElement {
  return (
    <Input
      value={value}
      aria-label={label}
      placeholder={placeholder}
      className={className}
      leading={<Search size={14} aria-hidden="true" />}
      trailing={value ? (
        <button
          type="button"
          aria-label={musicText('music.local.clear_filter')}
          className="grid h-5 w-5 place-items-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          onClick={() => onChange('')}
        >
          <X size={13} aria-hidden="true" />
        </button>
      ) : undefined}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !value || isImeComposing(event)) return
        event.preventDefault()
        event.stopPropagation()
        onChange('')
      }}
    />
  )
}
