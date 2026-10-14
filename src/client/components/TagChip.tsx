/**
 * One tag chip: a colour, a name, an optional count, and whether it is the one in force.
 *
 * Five surfaces drew this shape themselves and arrived at five different results — the sidebar's
 * active-filter strip at `--r-sm` with a literal `#`, the chat's filter row as a bordered pill with a
 * colour dot and no `#`, the reading shelf as a pill with a folder glyph, the kanban strip at `--r-xs`
 * with a parenthesised count, the graph panel as a fixed-height pill. The shared `Badge` answers none
 * of them: it is a `<span>`, and a chip is a control. So what is the same lives here — the box, the
 * tabular count, the pressed state and its ARIA, the keyboard path a real button gives for free — and
 * what a surface genuinely owns stays a prop: the leading glyph or colour dot, the sigil, the count's
 * format, and the corner radius and palette through `className`/`style` (a kanban tag's colour is data
 * written in the note, so it arrives as a style, exactly how `getKanbanTagStyle` hands it over today).
 *
 * It writes its own `<button>` rather than composing on `Button` for the reason the shared-layer guard
 * records for every other control here: `Button` fixes a height per size, and its responsive `md:h-*`
 * still wins over a caller's `h-auto`, while a chip is sized by its own padding so a strip of chips
 * with different counts keeps one baseline.
 */
import type { CSSProperties, MouseEventHandler, ReactNode } from 'react'
import { cn } from '../lib/cn'

/** Where the count is written, so one prop covers the two spellings in use. */
export type TagChipCountFormat = 'plain' | 'paren'

export interface TagChipProps {
  /** The tag's visible name. */
  label: ReactNode
  /** What pressing the chip does. The element is a button, so Enter and Space both reach it. */
  onPress: () => void
  /** The chip is one of a set of toggles and this one is in force; read out as `aria-pressed`. */
  pressed?: boolean
  /** A leading icon the surface draws itself (`<Folder size={11} />`), hidden from the name. */
  glyph?: ReactNode
  /** A colour dot in this CSS colour, for a tag that owns one. `null` draws no dot. */
  color?: string | null
  /** Prefix the name with `#`. Kept out of the accessible name: a screen reader would read it as "hash". */
  sigil?: boolean
  /** How many things wear the tag. `null` or omitted draws no count at all. */
  count?: number | null
  /** After the name, or in brackets the way the kanban strip writes it. */
  countFormat?: TagChipCountFormat
  /** The name to announce when the visible label alone does not identify the chip. */
  ariaLabel?: string
  // Deliberately no `disabled`: the only cheap way to dim a button is an opacity on its text, and the
  // chip's label and count already sit at the thinnest colour that clears AA. A chip that should not
  // act leaves `onPress` off.
  /** The trailing affordance a removable chip carries (the sidebar's and the graph's `X`). */
  trailing?: ReactNode
  onContextMenu?: MouseEventHandler<HTMLButtonElement>
  className?: string
  /** A palette that is data rather than a class — the kanban tag colours. */
  style?: CSSProperties
}

export function TagChip({
  label,
  onPress,
  pressed,
  glyph,
  color,
  sigil,
  count,
  countFormat = 'plain',
  ariaLabel,
  trailing,
  onContextMenu,
  className,
  style,
}: TagChipProps) {
  return (
    <button
      type="button"
      onClick={onPress}
      onContextMenu={onContextMenu}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex max-w-full items-center gap-[var(--sp-1)] rounded-[var(--r-full)]',
        'border px-[var(--sp-1-5)] py-[var(--sp-0-5)] font-medium select-none',
        'text-[length:var(--text-11)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',

        pressed
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]'
          : cn(
              'border-[var(--border-subtle)] text-[color:var(--text-secondary)]',
              'hover:border-[var(--border-default)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]',
            ),
        className,
      )}
      style={style}
    >
      {color ? (
        <span
          aria-hidden="true"
          className="size-[var(--sp-1-5)] shrink-0 rounded-[var(--r-full)]"
          style={{ backgroundColor: color }}
        />
      ) : null}
      {glyph ? <span aria-hidden="true" className="flex shrink-0 items-center">{glyph}</span> : null}
      <span className="min-w-0 truncate">
        {sigil ? <span aria-hidden="true">#</span> : null}
        {label}
      </span>
      {count !== null && count !== undefined ? (
        <span className="tabular shrink-0 text-[length:var(--text-10)] text-[color:var(--text-quaternary)]">
          {countFormat === 'paren' ? `(${count})` : count}
        </span>
      ) : null}
      {trailing}
    </button>
  )
}
