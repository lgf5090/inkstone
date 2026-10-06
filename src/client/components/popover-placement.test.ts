import { describe, expect, it } from 'vitest'
import { placePanel, type PanelAnchor } from './popover-placement'

const DESKTOP = { top: 0, right: 1280, bottom: 900, left: 0 }
/** The phone the review shrank to: a 320px panel had its left edge at -8 and lost its first field. */
const PHONE = { top: 0, right: 360, bottom: 780, left: 0 }
const SIZE = { width: 320, height: 268 }

function anchorAt(overrides: Partial<PanelAnchor> = {}): PanelAnchor {
  return { top: 100, right: 900, bottom: 128, left: 820, ...overrides }
}

describe('anchored panel placement (SH-50)', () => {
  it('hangs under its control, right-aligned to it', () => {
    const placed = placePanel({ anchor: anchorAt(), size: SIZE, viewport: DESKTOP })
    expect(placed.top).toBe(133)
    expect(placed.left).toBe(580)
    expect(placed.flipped).toBe(false)
    expect(placed.origin).toBe('top right')
  })

  it('hangs left-aligned when that is what the control asks for', () => {
    const placed = placePanel({ anchor: anchorAt(), size: SIZE, viewport: DESKTOP, align: 'start' })
    expect(placed.left).toBe(820)
    expect(placed.origin).toBe('top left')
  })

  it('flips above the control when the bottom edge is closer than the panel is tall', () => {
    const placed = placePanel({ anchor: anchorAt({ top: 700, bottom: 728 }), size: SIZE, viewport: DESKTOP })
    expect(placed.flipped).toBe(true)
    expect(placed.top).toBe(427)
    expect(placed.origin).toBe('bottom right')
  })

  it('clamps to the left margin when the control sits near the left edge', () => {
    const placed = placePanel({ anchor: anchorAt({ left: 0, right: 24 }), size: SIZE, viewport: PHONE })
    expect(placed.left).toBe(8)
  })

  it('keeps a wide panel fully inside a 360px viewport', () => {
    const placed = placePanel({ anchor: anchorAt({ left: 300, right: 352 }), size: SIZE, viewport: PHONE })
    expect(placed.left).toBeGreaterThanOrEqual(8)
    expect(placed.left + SIZE.width).toBeLessThanOrEqual(PHONE.right - 8)
  })

  it('keeps the panel inside the top edge when neither side has room', () => {
    const placed = placePanel({ anchor: anchorAt({ top: 300, bottom: 320 }), size: { width: 320, height: 600 }, viewport: PHONE })
    expect(placed.flipped).toBe(true)
    expect(placed.top).toBe(8)
  })

  it('honours a caller that wants more clearance', () => {
    const placed = placePanel({ anchor: anchorAt({ left: 1196, right: 1276 }), size: SIZE, viewport: DESKTOP, gap: 12, margin: 24 })
    expect(placed.top).toBe(140)
    // Right-aligned would be 1276 - 320 = 956; the caller's wider margin caps it at 1280 - 320 - 24.
    expect(placed.left).toBe(936)
  })
})
