import { useRef, type ReactNode } from 'react'
import { cn } from '../lib/cn'

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  title?: string
  disabled?: boolean
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
  className,
  panelId,
}: {
  value: T
  onChange: (value: T) => void
  items: ReadonlyArray<TabItem<T>>
  label: string
  className?: string
  panelId?: string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const enabled = items.filter((item) => !item.disabled)
  const focus = (item: TabItem<T>) => {
    const target = items.findIndex((entry) => entry.id === item.id)
    refs.current[target]?.focus()
    onChange(item.id)
  }
  const move = (delta: number, current: number) => {
    if (enabled.length === 0) return
    const index = enabled.findIndex((item) => item.id === items[current]?.id)
    const base = index >= 0 ? index : 0
    focus(enabled[(base + delta + enabled.length) % enabled.length]!)
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('flex min-w-0 items-center gap-0.5 overflow-x-auto', className)}
      onKeyDown={(event) => {
        const index = items.findIndex((item) => item.id === value)
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          move(1, index)
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault()
          move(-1, index)
        } else if (event.key === 'Home') {
          event.preventDefault()
          if (enabled[0]) focus(enabled[0])
        } else if (event.key === 'End') {
          event.preventDefault()
          const last = enabled[enabled.length - 1]
          if (last) focus(last)
        }
      }}
    >
      {items.map((item, index) => {
        const active = item.id === value
        return (
          <button
            key={item.id}
            ref={(element) => {
              refs.current[index] = element
            }}
            type="button"
            role="tab"
            id={panelId ? `${panelId}-tab-${item.id}` : undefined}
            aria-selected={active}
            aria-controls={panelId}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            title={item.title}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.id)}
            className={cn(
              'relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--r-sm)] px-2.5 text-[length:var(--text-12)]',
              'transition-[color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              'disabled:pointer-events-none disabled:opacity-45',
              active
                ? 'bg-[var(--bg-surface)] font-medium text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,.08)]'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
            )}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
