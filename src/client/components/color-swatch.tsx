import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../lib/cn'

/**
 * The two swatch shapes the app draws: `organizer` is the tag, folder and QuickAdd ramp — a filled
 * circle beside a "no colour" slot; `format` is the editor and property ramp — a rounded square that
 * keeps its own outline and holds focus while a hex field is being typed.
 */
export type SwatchVariant = 'organizer' | 'format'

/**
 * One colour swatch: a real button carrying the colour's name, its pressed state and an active ring,
 * drawn the same way everywhere a palette is offered. The genuine differences between the ramps are
 * props — the `icon` for the "no colour" slot, the resolved `background`, the check's colour, and
 * whether the no-colour slot keeps its fill while it is the active pick.
 */
export function Swatch({
  color,
  label,
  active,
  onPick,
  icon,
  background,
  variant = 'organizer',
  checkClassName = 'text-white',
  noColorBackground = true,
  className,
}: {
  /** The colour to paint; `null` is the "no colour" slot, which shows `icon` instead. */
  color: string | null
  label: string
  active: boolean
  onPick: () => void
  /** Glyph drawn in the "no colour" slot. */
  icon?: ReactNode
  /** Resolved CSS colour painted behind a colour swatch. */
  background?: string
  variant?: SwatchVariant
  /** The active check, coloured to stay legible on the swatch under it. */
  checkClassName?: string
  /** Whether the "no colour" slot is filled with the base background even when it is active. */
  noColorBackground?: boolean
  className?: string
}) {
  const noColor = color === null
  const format = variant === 'format'
  return (<button type="button" aria-label={label} title={label} aria-pressed={active} onMouseDown={format ? event => event.preventDefault() : undefined} onClick={onPick} className={cn('flex size-7 items-center justify-center transition-transform hover:scale-110', format ? 'rounded-[var(--r-sm)] border border-[var(--border-subtle)]' : 'rounded-full', noColor && 'border', noColor && noColorBackground && 'bg-[var(--bg-base)]', noColor && (active
      ? 'border-[var(--accent)] text-[var(--accent)] ring-2 ring-[var(--accent-ring)]'
      : 'border-[var(--border-default)] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]'), !noColor && active && (format
      ? 'ring-2 ring-[var(--accent-ring)] ring-offset-1 ring-offset-[var(--bg-overlay)]'
      : 'ring-2 ring-[var(--accent-ring)] ring-offset-2 ring-offset-[var(--bg-overlay)]'), className)} style={background === undefined ? undefined : { backgroundColor: background }}>
      {noColor ? icon : active && <Check size={13} className={checkClassName} aria-hidden="true"/>}
    </button>)
}
