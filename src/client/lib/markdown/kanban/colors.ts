import type { CSSProperties } from 'react'
import type { KanbanColorName, KanbanOption } from './types'

export const KANBAN_COLOR_NAMES: readonly KanbanColorName[] = [
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
  'coral',
  'teal',
  'slate',
] as const

/**
 * The tag palette is painted the way `--accent` is: a foreground as text on its own soft tint. Its
 * values live in `styles/tokens.css` (which carries no comments by policy), so the rule they were
 * calibrated to is written here, next to the only code that reads them — and judged there by
 * `tests/kanban-tag-contrast.test.ts`, which reads the declarations rather than a painted board.
 *
 * Every `--kanban-tag-<name>-fg` clears AA (4.5:1) as text on its own 14% tint over each surface a
 * theme and background variant declares, and on those surfaces themselves — the light column
 * therefore sits near 48% lightness and the dark one near 73%, which are the values the ratio
 * allows rather than the ones the palette started with (a mid-lightness blue has 3.64:1 on its own
 * tint, which is what the browser reader reported for it). Each tint is a `color-mix` of its own
 * foreground rather than a second stored hex: the old pairs were two hexes with two alphas and had
 * drifted apart — a tag's dark tint was its light hex — and a mix cannot disagree with its colour.
 *
 * `scripts/check-contrast.mjs` measures both rules for every colour those blocks declare, in both
 * themes and both background variants; the board's own axe read in `scripts/e2e-visual.mjs` keeps
 * the painted chips judged on real pixels, with no allowance left for them.
 */
export function getKanbanTagStyle(color?: KanbanColorName | string | null): CSSProperties {
  if (!color || !KANBAN_COLOR_NAMES.includes(color as KanbanColorName)) {
    return {
      backgroundColor: 'var(--bg-hover)',
      color: 'var(--text-secondary)',
      borderColor: 'var(--border-subtle)',
    }
  }
  const name = color as KanbanColorName
  return {
    backgroundColor: `var(--kanban-tag-${name}-bg)`,
    color: `var(--kanban-tag-${name}-fg)`,
  }
}

/**
 * The colour a whole header band is painted in: the group's own soft tint behind the group's own
 * foreground, which is the one pairing the tag palette was calibrated to (see above). A column with
 * no colour gets nothing back rather than a neutral tint, so the header keeps the surface it already
 * had instead of growing a wash that says "some colour" — the board's own "No Status" column has no
 * colour to say.
 *
 * It returns a style rather than a class because the colour is data: which of the twelve a column
 * wears is written in the note, so nothing can be compiled ahead of the render.
 */
export function getKanbanTintStyle(color?: KanbanColorName | string | null): CSSProperties | undefined {
  if (!color || !KANBAN_COLOR_NAMES.includes(color as KanbanColorName)) return undefined
  return {
    backgroundColor: `var(--kanban-tag-${color}-bg)`,
    color: `var(--kanban-tag-${color}-fg)`,
  }
}

export function getKanbanDotColor(color?: KanbanColorName | string | null): string {
  if (!color || !KANBAN_COLOR_NAMES.includes(color as KanbanColorName)) {
    return 'var(--text-tertiary)'
  }
  return `var(--kanban-tag-${color}-fg)`
}

export function getDeterministicTagColor(name: string): KanbanColorName {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i)
    hash |= 0
  }
  const colors: readonly KanbanColorName[] = ['blue', 'green', 'yellow', 'purple', 'pink', 'orange', 'red', 'teal']
  return colors[Math.abs(hash) % colors.length]!
}

export function resolveKanbanTagColor(tag: string, options?: KanbanOption[]): KanbanColorName {
  const opt = options?.find((o) => o.id === tag || o.label === tag)
  return opt?.color ?? getDeterministicTagColor(tag)
}
