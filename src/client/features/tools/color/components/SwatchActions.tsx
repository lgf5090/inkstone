import type { ReactNode } from 'react'
import { Tooltip } from '../../../../components/overlay'
import { cn } from '../../../../lib/cn'

export interface SwatchAction {
  key: string
  label: string
  icon: ReactNode
  onSelect: () => void
}

/**
 * The small controls that sit on top of a color swatch.
 *
 * Every swatch surface used to write this markup itself, and the copies disagreed in ways only a pointer
 * could find: the harmony strip's overlay covered the whole swatch and answered the click with nothing, so
 * the swatch's own "use this color" button never fired; the UI palette grid lost its top strip the same
 * way; and because `group-hover` compiles inside `@media (hover: hover)`, a touch reader never saw the
 * controls at all. The wrapper therefore stays transparent to pointers and only the buttons answer, and
 * visibility is driven by hover, focus and a no-hover media query instead of hover alone.
 */
export function SwatchActions({
  actions,
  className,
  align = 'end',
}: {
  actions: SwatchAction[]
  className?: string
  align?: 'end' | 'between'
}) {
  return (
    <div
      className={cn(
        'pointer-events-none flex items-center gap-1 opacity-0 transition-opacity',
        'group-hover:opacity-100 group-focus-within:opacity-100',
        'pointer-coarse:opacity-100',
        align === 'between' ? 'justify-between' : 'justify-end',
        className,
      )}
    >
      {actions.map((action) => (
        <Tooltip key={action.key} label={action.label}>
          <button
            type="button"
            aria-label={action.label}
            onClick={action.onSelect}
            className="pointer-events-auto flex items-center justify-center rounded-[var(--r-sm)] bg-black/75 p-1 text-white transition-colors hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {action.icon}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
