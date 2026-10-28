import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Variable as VariableIcon } from 'lucide-react'
import { VARIABLE_CLOSERS, VARIABLE_TRIGGERS } from '@shared/development/api-tester/keywords'
import { Input, Textarea } from '../../../../components/form'
import { useClickOutside } from '../../../../components/overlay'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { isImeComposing } from '../../../../lib/ime'

export interface AutocompleteVariable {
  key: string
  value: string
}

const OPEN = VARIABLE_TRIGGERS[0]
const CLOSE = VARIABLE_CLOSERS[0]

interface MenuState {
  start: number
  cursor: number
  filter: string
}

function findTrigger(value: string, cursor: number): MenuState | null {
  const before = value.slice(0, cursor)
  let start = -1
  let length = 0
  for (const trigger of VARIABLE_TRIGGERS) {
    const index = before.lastIndexOf(trigger)
    if (index > start) {
      start = index
      length = trigger.length
    }
  }
  if (start < 0) return null
  const filter = before.slice(start + length)
  if (VARIABLE_CLOSERS.some((closer) => filter.includes(closer))) return null
  if (/[\r\n]/.test(filter)) return null
  return { start, cursor, filter }
}

function filterVariables(variables: readonly AutocompleteVariable[], filter: string): AutocompleteVariable[] {
  const query = filter.trim().toLowerCase()
  const matches = query
    ? variables.filter((variable) => variable.key.toLowerCase().includes(query))
    : [...variables]
  return matches.sort((left, right) => {
    const leftPrefix = left.key.toLowerCase().startsWith(query) ? 0 : 1
    const rightPrefix = right.key.toLowerCase().startsWith(query) ? 0 : 1
    return leftPrefix - rightPrefix || left.key.localeCompare(right.key)
  })
}

export function VariableAutocomplete({
  value,
  onValueChange,
  variables,
  multiline = false,
  className,
  wrapperClassName,
  placeholder,
  type = 'text',
  id,
  ariaLabel,
  onKeyDown,
  onPaste,
}: {
  value: string
  onValueChange?: (value: string) => void
  variables: readonly AutocompleteVariable[]
  multiline?: boolean
  className?: string
  wrapperClassName?: string
  placeholder?: string
  type?: string
  id?: string
  ariaLabel?: string
  onKeyDown?: (event: React.KeyboardEvent) => void
  onPaste?: (event: React.ClipboardEvent) => void
}) {
  const menuId = useId()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const pendingCursor = useRef<number | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const filtered = useMemo(() => (menu ? filterVariables(variables, menu.filter) : []), [menu, variables])

  useClickOutside([containerRef], menu !== null, () => setMenu(null))

  useLayoutEffect(() => {
    const position = pendingCursor.current
    if (position === null) return
    pendingCursor.current = null
    const element = inputRef.current
    if (!element) return
    element.focus()
    element.setSelectionRange(position, position)
  }, [value])

  const handleChange = (next: string) => {
    const element = inputRef.current
    const cursor = element?.selectionStart ?? next.length
    const found = findTrigger(next, cursor)
    setMenu(found)
    if (found) setActiveIndex(0)
    onValueChange?.(next)
  }

  const select = (key: string) => {
    if (!menu) return
    const next = value.slice(0, menu.start) + OPEN + key + CLOSE + value.slice(menu.cursor)
    pendingCursor.current = menu.start + OPEN.length + key.length + CLOSE.length
    onValueChange?.(next)
    setMenu(null)
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (isImeComposing(event)) {
      onKeyDown?.(event)
      return
    }
    if (menu) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (filtered.length > 0) setActiveIndex((activeIndex + 1) % filtered.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (filtered.length > 0) setActiveIndex((activeIndex - 1 + filtered.length) % filtered.length)
        return
      }
      if (event.key === 'Enter' && filtered.length > 0) {
        event.preventDefault()
        select(filtered[Math.min(activeIndex, filtered.length - 1)]!.key)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenu(null)
        return
      }
    }
    onKeyDown?.(event)
  }

  const activeOption = menu && filtered.length > 0 ? `${menuId}-option-${Math.min(activeIndex, filtered.length - 1)}` : undefined
  const shared = {
    id,
    value,
    placeholder,
    'aria-label': ariaLabel,
    'aria-expanded': menu !== null,
    'aria-controls': menu ? menuId : undefined,
    'aria-autocomplete': 'list' as const,
    'aria-activedescendant': activeOption,
    spellCheck: false,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => handleChange(event.target.value),
    onKeyDown: handleKeyDown,
    onPaste,
  }

  return (
    <div ref={containerRef} className={cn('relative', wrapperClassName)}>
      {multiline ? (
        <Textarea
          {...shared}
          ref={(element) => {
            inputRef.current = element
          }}
          className={cn('w-full', className)}
        />
      ) : (
        <Input
          {...shared}
          ref={(element) => {
            inputRef.current = element
          }}
          type={type}
          className={cn('w-full', className)}
        />
      )}
      {menu && (
        <div
          id={menuId}
          role="listbox"
          aria-label={t('development.apitester.variables')}
          className={cn(
            'absolute z-[var(--z-popover)] overflow-hidden rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] text-[var(--text-primary)] shadow-[var(--shadow-pop)]',
            multiline ? 'top-1.5 left-1.5 w-72 max-w-[calc(100%-0.75rem)]' : 'inset-x-0 top-full mt-1',
          )}
        >
          {filtered.length === 0 ? (
            <div className="flex items-center gap-1.5 px-2.5 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              <VariableIcon size={12} className="shrink-0" aria-hidden="true" />
              {menu.filter
                ? t('development.apitester.no_matching_var', { name: menu.filter })
                : t('development.apitester.no_vars_hint')}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1 border-b border-[var(--border-subtle)] px-2.5 py-1 text-[length:var(--text-10)] font-medium text-[var(--text-quaternary)]">
                <VariableIcon size={11} aria-hidden="true" />
                {t('development.apitester.variable_autocomplete_hint')}
              </div>
              <div className="max-h-48 overflow-y-auto p-0.5">
                {filtered.map((variable, index) => (
                  <button
                    key={variable.key}
                    id={`${menuId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => select(variable.key)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-12)]',
                      index === activeIndex
                        ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    <span className="shrink-0 font-mono font-medium">
                      {OPEN}
                      {variable.key}
                      {CLOSE}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]">{variable.value}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
