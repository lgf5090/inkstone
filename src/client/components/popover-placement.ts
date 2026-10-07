import { useEffect } from 'react'
import { getVisibleViewport } from '../lib/viewport'

/**
 * Where an anchored panel goes: under the control it hangs from, right- or left-aligned to it,
 * flipped above that control when the bottom of the viewport is closer than the panel is tall, and
 * kept inside the viewport's edges either way.
 *
 * The math is a plain function because that is the part worth pinning down: a panel wider than the
 * room left beside its control used to be drawn with its left edge off screen — on a 360px-wide
 * phone a 320px panel anchored to a control near the right edge lost its first field. Clamping is
 * what makes the panel reachable at every width, and it is asserted against numbers rather than
 * against a rendering engine.
 */

/** The gap a panel leaves between itself and the control it hangs from. */
const DEFAULT_GAP = 5
/** What a panel keeps clear of the viewport's edges. */
const DEFAULT_MARGIN = 8

export interface PanelAnchor {
  top: number
  right: number
  bottom: number
  left: number
}

export interface PanelSize {
  width: number
  height: number
}

export interface PanelViewport {
  top: number
  right: number
  bottom: number
  left: number
}

export interface PanelPlacement {
  top: number
  left: number
  flipped: boolean
  /** The corner the panel grows from, so the pop-in animation reads as coming from its control. */
  origin: string
}

export function placePanel({ anchor, size, viewport, align = 'end', gap = DEFAULT_GAP, margin = DEFAULT_MARGIN }: {
  anchor: PanelAnchor
  size: PanelSize
  viewport: PanelViewport
  align?: 'start' | 'end'
  gap?: number
  margin?: number
}): PanelPlacement {
  const flipped = anchor.bottom + gap + size.height > viewport.bottom - margin
  const roomBelow = viewport.bottom - margin - size.height - gap
  const roomAbove = anchor.top - size.height - gap
  const top = flipped
    ? Math.max(viewport.top + margin, roomAbove)
    : Math.min(anchor.bottom + gap, Math.max(viewport.top + margin, roomBelow))
  const preferredLeft = align === 'end' ? anchor.right - size.width : anchor.left
  const furthestLeft = viewport.left + margin
  // A panel with less room than it needs on either side keeps its left edge at the margin: the
  // anchor decides where it prefers to sit, the viewport decides how far that can go.
  const left = Math.min(Math.max(furthestLeft, preferredLeft), Math.max(furthestLeft, viewport.right - size.width - margin))
  return { top, left, flipped, origin: `${flipped ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}` }
}

/**
 * Measures when the panel opens — and whenever its own size changes, which is what a panel that
 * grows with its content reports — and hands the placement to the caller. `apply` has to be stable
 * (`useState`'s setter always is): an inline closure would re-measure on every render.
 */
export function usePanelPlacement(open: boolean, options: {
  anchor: { current: HTMLElement | null }
  size: PanelSize
  align?: 'start' | 'end'
  gap?: number
  margin?: number
  apply: (placement: PanelPlacement) => void
}): void {
  const { anchor, size, align, gap, margin, apply } = options
  useEffect(() => {
    if (!open)
      return
    const rect = anchor.current?.getBoundingClientRect()
    if (!rect)
      return
    apply(placePanel({ anchor: rect, size, viewport: getVisibleViewport(), align, gap, margin }))
  }, [open, anchor, size.width, size.height, align, gap, margin, apply])
}
