import { describe, expect, it } from 'vitest'
import { CANVAS_MAX_DOCK_WIDTH, CANVAS_MIN_DOCK_WIDTH, clampCanvasWidth, stepCanvasWidth } from './canvas-width'

describe('the canvas dock width', () => {
  it('never goes below the prose floor or above sixty percent of the viewport', () => {
    expect(clampCanvasWidth(100, 1440)).toBe(CANVAS_MIN_DOCK_WIDTH)
    expect(clampCanvasWidth(2000, 1440)).toBe(CANVAS_MAX_DOCK_WIDTH)
    // 900 * .6 = 540 is the ceiling on a window that is not wide enough for 720.
    expect(clampCanvasWidth(700, 900)).toBe(540)
    expect(clampCanvasWidth(420, 1440)).toBe(420)
  })

  it('moves by a keyboard step and stops at the same edges', () => {
    expect(stepCanvasWidth(420, 16, 1440)).toBe(436)
    expect(stepCanvasWidth(420, -16, 1440)).toBe(404)
    expect(stepCanvasWidth(CANVAS_MIN_DOCK_WIDTH, -16, 1440)).toBe(CANVAS_MIN_DOCK_WIDTH)
    expect(stepCanvasWidth(CANVAS_MAX_DOCK_WIDTH, 16, 1440)).toBe(CANVAS_MAX_DOCK_WIDTH)
  })
})
