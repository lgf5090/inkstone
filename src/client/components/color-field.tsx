import { Palette } from 'lucide-react'
import { cn } from '../lib/cn'

/** The colour the native wheel opens on when there is nothing to show yet. */
export const DEFAULT_CUSTOM_COLOR = '#888888'

/**
 * The two frames a custom-colour control is drawn in: `round` sits in the organiser ramp beside the
 * circular swatches, `square` in the format ramp and the settings rows beside the square ones.
 */
export type ColorFieldShape = 'round' | 'square'

const FRAME_RADIUS: Record<ColorFieldShape, string> = {
  round: 'rounded-full',
  square: 'rounded-[var(--r-sm)]',
}

/**
 * The native colour wheel itself: invisible, stretched over the whole frame so the box the reader
 * sees is the box they click, and named by the field it belongs to rather than by its own glyph.
 */
function HiddenColorInput({ value, label, onChange, onCommit }: {
  value: string | null
  label: string
  onChange: (value: string) => void
  onCommit?: (value: string) => void
}) {
  return (<input type="color" value={value ?? DEFAULT_CUSTOM_COLOR} onChange={event => onChange(event.target.value.toLocaleLowerCase())} onBlur={onCommit && (event => onCommit(event.target.value))} aria-label={label} className="absolute inset-0 size-full cursor-pointer opacity-0"/>)
}

/**
 * The palette-icon door to the native wheel, sitting beside the hex field a custom colour is typed
 * into. The field keeps the draft, so this only moves it: `onChange` while the wheel is being dragged,
 * `onCommit` when the pointer leaves it.
 */
export function ColorWheelTrigger({ value, label, shape = 'square', onChange, onCommit }: {
  value: string | null
  label: string
  shape?: ColorFieldShape
  onChange: (value: string) => void
  onCommit: (value: string) => void
}) {
  return (<label className={cn('relative flex size-7 shrink-0 items-center justify-center', FRAME_RADIUS[shape], 'border border-[var(--border-subtle)] text-[var(--text-tertiary)] transition-colors hover:border-[var(--border-default)] hover:text-[var(--text-secondary)]')}>
      <Palette size={13} aria-hidden="true"/>
      <span className="sr-only">{label}</span>
      <HiddenColorInput value={value} label={label} onChange={onChange} onCommit={onCommit}/>
    </label>)
}

/**
 * The colour a setting holds, drawn as the dot it will paint and changed through the native wheel.
 * An unset value is not a colour: the dot stays empty and carries the outline instead of a fill.
 */
export function ColorWellField({ value, label, onChange }: {
  value: string | null
  label: string
  onChange: (value: string) => void
}) {
  return (<span className={cn('relative flex size-7 items-center justify-center', FRAME_RADIUS.square, 'border border-[var(--border-subtle)]')}>
      <span className="size-3.5 rounded-full" style={{ backgroundColor: value ?? 'transparent', boxShadow: value ? undefined : 'inset 0 0 0 1px var(--border-default)' }} aria-hidden="true"/>
      <HiddenColorInput value={value} label={label} onChange={onChange}/>
    </span>)
}
