import type { CSSProperties } from 'react'
import { HEAT_PERCENTS } from './strip'

/**
 * One day tile of a heat surface. `null` is not a day of this month at all, so it draws nothing.
 *
 * The whole ramp sits on paper rather than on the surface behind it: level 0 is the bare tile and
 * levels 1-4 mix the accent into that same white, so a quiet day and a busy day are the same object
 * at different saturation. Mixing over `transparent` made the quiet tiles read as shaded days,
 * because their fill was only a few points off the sunken sidebar behind them.
 */
export function heatCell(level: number | null): CSSProperties {
  if (level === null) return { backgroundColor: 'transparent' }
  if (level === 0) return { backgroundColor: 'var(--bg-surface)' }
  return { backgroundColor: `color-mix(in oklab, var(--accent) ${HEAT_PERCENTS[level]}%, var(--bg-surface))` }
}
