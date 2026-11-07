import { useEffect, useId, useRef } from 'react'
import { CaseSensitive, ChevronDown, ChevronUp, Regex, Search, X } from 'lucide-react'
import { Input } from '../../components/form'
import { IconButton } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { isImeComposing } from '../../lib/ime'
import { t } from '../../lib/i18n'

export function TerminalSearchBar({
  open,
  term,
  caseSensitive,
  regex,
  resultIndex,
  resultCount,
  onTermChange,
  onCaseSensitiveChange,
  onRegexChange,
  onNext,
  onPrevious,
  onClose,
}: {
  open: boolean
  term: string
  caseSensitive: boolean
  regex: boolean
  resultIndex: number
  resultCount: number
  onTermChange: (value: string) => void
  onCaseSensitiveChange: (value: boolean) => void
  onRegexChange: (value: boolean) => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  if (!open) return null

  const summary = term
    ? resultCount === 0
      ? t('webssh.search.no_results')
      : t('webssh.search.results', { index: resultIndex + 1, count: resultCount })
    : ''

  return (
    <div role="search" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1">
      <Input
        ref={inputRef}
        value={term}
        onChange={(event) => onTermChange(event.target.value)}
        aria-label={t('webssh.search.placeholder')}
        placeholder={t('webssh.search.placeholder')}
        leading={<Search size={13} aria-hidden="true" />}
        className="h-8 min-w-32 flex-1 md:h-8"
        onKeyDown={(event) => {
          if (isImeComposing(event)) return
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) onPrevious()
            else onNext()
          }
        }}
      />
      <span id={`${id}-summary`} aria-live="polite" className="min-w-16 text-center text-[length:var(--text-11)] tabular text-[var(--text-tertiary)]">
        {summary}
      </span>
      <Tooltip label={t('webssh.search.case_sensitive')}>
        <IconButton
          label={t('webssh.search.case_sensitive')}
          size="sm"
          active={caseSensitive}
          onClick={() => onCaseSensitiveChange(!caseSensitive)}
        >
          <CaseSensitive size={13} aria-hidden="true" />
        </IconButton>
      </Tooltip>
      <Tooltip label={t('webssh.search.regex')}>
        <IconButton
          label={t('webssh.search.regex')}
          size="sm"
          active={regex}
          onClick={() => onRegexChange(!regex)}
        >
          <Regex size={13} aria-hidden="true" />
        </IconButton>
      </Tooltip>
      <Tooltip label={t('webssh.search.next')} combo="enter">
        <IconButton label={t('webssh.search.next')} size="sm" onClick={onNext}>
          <ChevronDown size={13} aria-hidden="true" />
        </IconButton>
      </Tooltip>
      <Tooltip label={t('webssh.search.previous')} combo="shift+enter">
        <IconButton label={t('webssh.search.previous')} size="sm" onClick={onPrevious}>
          <ChevronUp size={13} aria-hidden="true" />
        </IconButton>
      </Tooltip>
      <Tooltip label={t('webssh.search.close')} combo="escape">
        <IconButton label={t('webssh.search.close')} size="sm" onClick={onClose}>
          <X size={13} aria-hidden="true" />
        </IconButton>
      </Tooltip>
    </div>
  )
}
