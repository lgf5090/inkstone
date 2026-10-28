import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '../../../../components/form'
import { IconButton } from '../../../../components/primitives'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'

export function SearchField({
  value,
  onChange,
  label,
  placeholder,
  debounceMs = 300,
  clearable = true,
  className,
  autoFocus,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder?: string
  debounceMs?: number
  clearable?: boolean
  className?: string
  autoFocus?: boolean
}) {
  const [local, setLocal] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setLocal(value)
  }, [value])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const commit = (next: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (debounceMs > 0) {
      timerRef.current = setTimeout(() => onChange(next), debounceMs)
      return
    }
    onChange(next)
  }

  const handleInput = (next: string) => {
    setLocal(next)
    commit(next)
  }

  const clear = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setLocal('')
    onChange('')
  }

  return (
    <div className={cn('relative', className)}>
      <Search
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-quaternary)]"
      />
      <Input
        type="search"
        value={local}
        aria-label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={cn('h-8 pl-8 text-[length:var(--text-12)]', clearable && local && 'pr-8')}
        onChange={(event) => handleInput(event.target.value)}
      />
      {clearable && local && (
        <IconButton
          label={t('development.apitester.clear')}
          size="xs"
          className="absolute top-1/2 right-1 -translate-y-1/2 text-[var(--text-tertiary)]"
          onClick={clear}
        >
          <X size={12} />
        </IconButton>
      )}
    </div>
  )
}
