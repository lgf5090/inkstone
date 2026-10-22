/**
 * A select drawn with the app's own menu, not the browser's.
 *
 * A native `<select>` cannot carry a list's icon, a priority's colour dot or the accent state the rest
 * of the app uses, and its system chrome ignores every design token (radius, height, dark theme). This
 * keeps the semantics a select needs — a labelled trigger that opens a menu, arrow keys and Enter, and
 * `menuitemcheckbox` rows that read their checked state — while drawing the panel the rest of the app
 * draws.
 *
 * The trigger is 44px tall on a touch screen and 34px on a wide one, exactly like `Input`/`Select`, so
 * a form row mixing the two does not jump by a pixel between breakpoints.
 */
import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../lib/cn'
import { Menu, type MenuItem } from './overlay'

export interface SelectMenuOption<T extends string = string> {
  value: T
  label: string
  /** A leading glyph — a list icon, a priority dot, a colour. */
  icon?: ReactNode
  disabled?: boolean
}

export function SelectMenu<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  disabled,
  width = 220,
  align = 'start',
  size = 'md',
  placeholder,
}: {
  /** The control's accessible name; also the menu's, so the panel is announced with its owner. */
  label: string
  value: T
  options: readonly SelectMenuOption<T>[]
  onChange: (value: T) => void
  className?: string
  disabled?: boolean
  /** Panel width in pixels; the trigger takes its width from the layout. */
  width?: number
  align?: 'start' | 'end'
  /** `sm` is the toolbar row; `md` the form field. */
  size?: 'sm' | 'md'
  placeholder?: string
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)
  const items: MenuItem[] = options.map((option) => ({
    id: option.value,
    label: option.label,
    ...(option.icon ? { icon: option.icon } : {}),
    checked: option.value === value,
    ...(option.disabled ? { disabled: true } : {}),
    onSelect: () => {
      setOpen(false)
      if (option.value !== value) onChange(option.value)
    },
  }))

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((open) => !open)}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-default)]',
          'bg-[var(--bg-inset)] px-2.5 text-left text-[length:var(--text-13)] text-[var(--text-primary)]',
          'transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          'hover:border-[var(--border-strong)] focus-visible:border-[var(--accent)] focus-visible:shadow-[var(--shadow-ring-focus)] focus-visible:outline-none',
          'disabled:pointer-events-none disabled:opacity-50',
          size === 'sm' ? 'h-11 md:h-7' : 'h-11 md:h-[34px]',
          className,
        )}
      >
        {current?.icon && <span className="flex shrink-0 items-center">{current.icon}</span>}
        <span className="min-w-0 flex-1 truncate">{current?.label ?? placeholder ?? ''}</span>
        <ChevronDown size={13} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
      </button>
      <Menu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        align={align}
        width={width}
        label={label}
      />
    </>
  )
}
