import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../lib/cn'

/**
 * The two swatch shapes the app draws: `organizer` is the tag, folder and QuickAdd ramp — a filled
 * circle beside a "no colour" slot; `format` is the editor and property ramp — a rounded square that
 * keeps its own outline and holds focus while a hex field is being typed.
 */
export type SwatchVariant = 'organizer' | 'format'

export type SwatchSize = 'md' | 'sm'

/**
 * The geometry each size carries. `md` is the 28px target every picker draws; `sm` is the graph's
 * colour rules — six dots on a tight row, where an offset ring would land on the neighbour beside it
 * and the default check would cover the colour it is naming.
 */
const SWATCH_SIZES: Record<SwatchSize, { box: string; ring: string; check: number }> = {
  md: {
    box: 'size-7',
    ring: 'ring-2 ring-[var(--accent-ring)] ring-offset-2 ring-offset-[var(--bg-overlay)]',
    check: 13,
  },
  sm: {
    box: 'size-3.5',
    ring: 'ring-2 ring-[var(--accent)]',
    check: 9,
  },
}

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
  size = 'md',
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
  /** The ramp's target size: `md` in every picker, `sm` in the graph's colour rules. */
  size?: SwatchSize
  /** The active check, coloured to stay legible on the swatch under it. */
  checkClassName?: string
  /** Whether the "no colour" slot is filled with the base background even when it is active. */
  noColorBackground?: boolean
  className?: string
}) {
  const noColor = color === null
  const format = variant === 'format'
  const box = SWATCH_SIZES[size]
  return (<button type="button" aria-label={label} title={label} aria-pressed={active} onMouseDown={format ? event => event.preventDefault() : undefined} onClick={onPick} className={cn('flex', box.box, 'items-center justify-center transition-transform hover:scale-110', format ? 'rounded-[var(--r-sm)] border border-[var(--border-subtle)]' : 'rounded-full', noColor && 'border', noColor && noColorBackground && 'bg-[var(--bg-base)]', noColor && (active
      ? 'border-[var(--accent)] text-[var(--accent)] ring-2 ring-[var(--accent-ring)]'
      : 'border-[var(--border-default)] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]'), !noColor && active && (format
      ? 'ring-2 ring-[var(--accent-ring)] ring-offset-1 ring-offset-[var(--bg-overlay)]'
      : box.ring), className)} style={background === undefined ? undefined : { backgroundColor: background }}>
      {noColor ? icon : active && <Check size={box.check} className={checkClassName} aria-hidden="true"/>}
    </button>)
}
