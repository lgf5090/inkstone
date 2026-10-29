/**
 * Paper ruling geometry, without a canvas.
 *
 * The reference draws ten paper styles from three numbers: a line pitch, a grid pitch, and a spacing
 * multiplier. Keeping them here lets the engine, the thumbnail renderer and the PDF renderer agree on
 * where the rules fall, and keeps the colour lookup in `@shared/inknote/color` (paperSurfaceFor).
 */
import { PAPER_GRID_SIZE, PAPER_LINE_HEIGHT } from '@shared/inknote/constants'
import type { InknotePaperStyle, InknoteSpacing } from '@shared/inknote/types'

/** The left margin the reference draws on ruled paper only. */
export const PAPER_MARGIN_X = 92

/** The pitch of a music staff group in the reference. */
export const PAPER_MUSIC_STAFF_STEP = 92

/** Multiplier applied to both pitches by the spacing setting. */
export function paperSpacingFactor(spacing: InknoteSpacing): number {
  if (spacing === 'tight') return 0.85
  if (spacing === 'wide') return 1.25
  return 1
}

/**
 * Vertical distance between ruling lines, in page units.
 *
 * With only a spacing this is the ordinary 48 px rule. With a style it accounts for the styles whose
 * pitch differs: grid and dot repeat on the 38 px cell, planner on two cells, music on its staff group,
 * and blank/story have no horizontal ruling at all.
 */
export function paperLineStep(spacing: InknoteSpacing): number
export function paperLineStep(style: InknotePaperStyle, spacing: InknoteSpacing): number
export function paperLineStep(
  styleOrSpacing: InknotePaperStyle | InknoteSpacing,
  spacing?: InknoteSpacing,
): number {
  if (spacing === undefined) return PAPER_LINE_HEIGHT * paperSpacingFactor(styleOrSpacing as InknoteSpacing)
  const factor = paperSpacingFactor(spacing)
  switch (styleOrSpacing) {
    case 'blank':
    case 'story':
      return 0
    case 'grid':
    case 'dot':
      return PAPER_GRID_SIZE * factor
    case 'planner':
      return PAPER_GRID_SIZE * 2 * factor
    case 'music':
      return PAPER_MUSIC_STAFF_STEP
    default:
      return PAPER_LINE_HEIGHT * factor
  }
}

/** The square cell used by grid, dot and the planner columns, in page units. */
export function paperGridStep(spacing: InknoteSpacing): number
export function paperGridStep(style: InknotePaperStyle, spacing: InknoteSpacing): number
export function paperGridStep(
  styleOrSpacing: InknotePaperStyle | InknoteSpacing,
  spacing?: InknoteSpacing,
): number {
  const resolved = spacing ?? (styleOrSpacing as InknoteSpacing)
  return PAPER_GRID_SIZE * paperSpacingFactor(resolved)
}

/** Whether a paper style carries the reference's vertical margin line. */
export function paperStyleHasMargin(style: InknotePaperStyle): boolean {
  return style === 'line'
}
