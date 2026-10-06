import { getVisibleViewport } from '../../../lib/viewport'

export function placeHoverCard(anchor: DOMRect, card: DOMRect): { top: number, left: number } {
  const gap = 8
  const padding = 10
  const viewport = getVisibleViewport()
  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), Math.max(min, max))
  const left = clamp(anchor.left, viewport.left + padding, viewport.right - card.width - padding)
  const fitsBelow = anchor.bottom + gap + card.height <= viewport.bottom - padding
  const fitsAbove = anchor.top - gap - card.height >= viewport.top + padding
  const top = fitsBelow || !fitsAbove ? anchor.bottom + gap : anchor.top - gap - card.height
  return { top, left }
}
