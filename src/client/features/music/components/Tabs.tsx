/**
 * A tab strip with the two behaviours the ARIA tab pattern asks for: one tab stop for the group and
 * arrow keys that move the selection. It is a `tablist` rather than a segmented control because a
 * search result set, an artist page and a library view all switch panels rather than a setting, and
 * the page can name the panel with `aria-labelledby` from the tab it selected.
 */
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'

export interface MusicTabItem<T extends string> {
  value: T
  label: ReactNode
  /** A small trailing count, e.g. how many results the tab holds. */
  count?: number
}

export interface MusicTabsProps<T extends string> {
  value: T
  items: readonly MusicTabItem<T>[]
  onChange: (value: T) => void
  /** The strip's accessible name; every page provides one. */
  label: string
  className?: string
}

const MOVES: Record<string, 'next' | 'previous' | 'first' | 'last'> = {
  ArrowRight: 'next',
  ArrowDown: 'next',
  ArrowLeft: 'previous',
  ArrowUp: 'previous',
  Home: 'first',
  End: 'last',
}

export function MusicTabs<T extends string>({
  value,
  items,
  onChange,
  label,
  className,
}: MusicTabsProps<T>): ReactElement {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const selected = items.findIndex((item) => item.value === value)

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const motion = MOVES[event.key]
    if (!motion || items.length === 0) return
    event.preventDefault()
    const last = items.length - 1
    const next = motion === 'next'
      ? (index >= last ? 0 : index + 1)
      : motion === 'previous'
        ? (index <= 0 ? last : index - 1)
        : motion === 'first'
          ? 0
          : last
    const target = items[next]
    if (!target) return
    onChange(target.value)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={className ? `music-tabs ${className}` : 'music-tabs'}
    >
      {items.map((item, index) => (
        <button
          key={item.value}
          ref={(element) => {
            refs.current[index] = element
          }}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          tabIndex={item.value === value || (selected < 0 && index === 0) ? 0 : -1}
          className="music-tabs__tab"
          onClick={() => onChange(item.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {item.label}
          {typeof item.count === 'number' && <span className="music-tabs__count">{item.count}</span>}
        </button>
      ))}
    </div>
  )
}
