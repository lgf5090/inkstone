/**
 * A search box with the app's own chrome and keyboard contract.
 *
 * The box itself is the notebook's `FilterInput`: it already answers Escape, keeps an IME's keys, and
 * refuses an unsafe `/regex/` with a sentence beside itself. This wrapper only supplies the compiled
 * query the shared box expects and the Enter-to-submit a few screens want.
 */
import { compileQuery } from '../../../lib/query-match'
import { FilterInput } from '../../../components/FilterInput'
import { isImeComposing } from '../../../lib/ime'
import { cn } from '../../../lib/cn'

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
  const query = compileQuery(value)
  return (
    <FilterInput
      value={value}
      onChange={onChange}
      query={query}
      label={label}
      size="panel"
      placeholder={placeholder}
      autoFocus={autoFocus}
      className={cn('mt-0', className)}
      onKeyDown={(event) => {
        if (!onSubmit || isImeComposing(event)) return
        if (event.key === 'Enter') {
          event.preventDefault()
          onSubmit()
        }
      }}
    />
  )
}
