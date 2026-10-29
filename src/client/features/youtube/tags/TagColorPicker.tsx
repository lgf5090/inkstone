import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ORGANIZER_COLORS } from '@shared/organizer-colors'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'

/** One grid row in the palette; the 24 colours are laid out eight across, so the arrow keys move by it. */
const COLOR_COLUMNS = 8

/**
 * The palette a YouTube tag can wear, as a single-select board.
 *
 * A tag colours a dot and a chip rather than a page, so all 24 organiser colours are valid here; the
 * two halves of the ramp sit in the same grid because the rows themselves (16 classic, then 8 vivid)
 * already read as the two groups. The checked swatch carries the accent ring and is the group's only
 * tab stop, which is the roving-radio pattern a `radiogroup` promises to a screen reader.
 */
export function TagColorPicker({
  value,
  onChange,
  compact = false,
}: {
  value: string
  onChange: (color: string) => void
  compact?: boolean
}) {
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([])
  const colors: readonly string[] = ORGANIZER_COLORS
  const selectedIndex = colors.indexOf(value)
  const tabStop = selectedIndex >= 0 ? selectedIndex : 0

  const move = (next: number) => {
    const count = colors.length
    const index = ((next % count) + count) % count
    onChange(colors[index]!)
    itemsRef.current[index]?.focus({ preventScroll: true })
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null
    switch (event.key) {
      case 'ArrowRight':
        next = index + 1
        break
      case 'ArrowLeft':
        next = index - 1
        break
      case 'ArrowDown':
        next = index + COLOR_COLUMNS
        break
      case 'ArrowUp':
        next = index - COLOR_COLUMNS
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = colors.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    move(next)
  }

  return (
    <div
      role="radiogroup"
      aria-label={t('youtube.tags.color')}
      className={cn('grid grid-cols-8', compact ? 'gap-1' : 'gap-1.5')}
    >
      {colors.map((color, index) => {
        const checked = color === value
        return (
          <button
            key={color}
            ref={(node) => {
              itemsRef.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={t('youtube.tags.color_name', { color })}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => onChange(color)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'size-5 rounded-[var(--r-full)] border border-[var(--border-subtle)]',
              'transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:scale-110',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
              checked && 'ring-2 ring-[var(--accent)]',
            )}
            style={{ backgroundColor: color }}
          />
        )
      })}
    </div>
  )
}
