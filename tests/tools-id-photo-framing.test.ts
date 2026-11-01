// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  clampCrop,
  cropForZoom,
  MAX_ZOOM,
  panCrop,
  panPercent,
  percentToCrop,
  rotatedBounds,
  zoomCrop,
  zoomPercentOf,
  type CropRect,
} from '../src/client/features/tools/id-photo/engine/framing'

const LAYER = { width: 3000, height: 4000 }
const ASPECT = 295 / 413

const inside = (rect: CropRect, layer = LAYER) =>
  rect.cropX >= 0 &&
  rect.cropY >= 0 &&
  rect.cropX + rect.cropWidth <= layer.width &&
  rect.cropY + rect.cropHeight <= layer.height

describe('ID photo framing maths', () => {
  it('swaps the frame for a quarter turn and keeps it for a half turn', () => {
    expect(rotatedBounds(4000, 3000, 0)).toEqual({ width: 4000, height: 3000 })
    expect(rotatedBounds(4000, 3000, 90)).toEqual({ width: 3000, height: 4000 })
    expect(rotatedBounds(4000, 3000, 180)).toEqual({ width: 4000, height: 3000 })
    expect(rotatedBounds(4000, 3000, 270)).toEqual({ width: 3000, height: 4000 })
  })

  it('zoom 1 fills the frame with the widest possible band', () => {
    const rect = cropForZoom(LAYER, ASPECT, 1)
    expect(rect.cropWidth).toBeCloseTo(Math.min(LAYER.width, LAYER.height * ASPECT), 0)
    expect(rect.cropWidth / rect.cropHeight).toBeCloseTo(ASPECT, 3)
    expect(rect.cropX).toBeGreaterThan(0)
    expect(rect.cropY).toBe(0)
  })

  it('deep zoom only narrows the crop and never leaves the layer', () => {
    const wide = cropForZoom(LAYER, ASPECT, 1)
    const tight = cropForZoom(LAYER, ASPECT, MAX_ZOOM)
    expect(tight.cropWidth).toBeLessThan(wide.cropWidth)
    expect(tight.cropWidth / tight.cropHeight).toBeCloseTo(ASPECT, 3)
    expect(inside(tight)).toBe(true)
  })

  it('keeps the point under the cursor fixed while zooming', () => {
    const start = cropForZoom(LAYER, ASPECT, 1.4)
    const anchorX = start.cropX + start.cropWidth * 0.3
    const anchorY = start.cropY + start.cropHeight * 0.25
    const end = zoomCrop(start, LAYER, ASPECT, 1.5, anchorX, anchorY)
    const beforeRatio = (anchorX - start.cropX) / start.cropWidth
    const afterRatio = (anchorX - end.cropX) / end.cropWidth
    expect(afterRatio).toBeCloseTo(beforeRatio, 2)
    expect(inside(end)).toBe(true)
  })

  it('refuses to zoom past the layer or below the minimum crop edge', () => {
    const rect = cropForZoom(LAYER, ASPECT, 1)
    expect(zoomCrop(rect, LAYER, ASPECT, 0.0001, 1500, 2000)).toEqual(rect)
    const tiny = { cropX: 0, cropY: 0, cropWidth: 26, cropHeight: 36 }
    expect(zoomCrop(tiny, LAYER, ASPECT, 3, 13, 18).cropWidth).toBe(26)
  })

  it('pans opposite to the drag and stops at the edge', () => {
    const rect = cropForZoom(LAYER, ASPECT, 2)
    const moved = panCrop(rect, LAYER, 120, -80)
    expect(moved.cropX).toBeCloseTo(rect.cropX - 120, 0)
    expect(moved.cropY).toBeCloseTo(rect.cropY + 80, 0)

    let pushed = rect
    for (let step = 0; step < 80; step++) pushed = panCrop(pushed, LAYER, 200, 200)
    expect(pushed.cropX).toBe(0)
    expect(pushed.cropY).toBe(0)
    expect(inside(pushed)).toBe(true)
  })

  it('round-trips the slider percentages back into the same rectangle', () => {
    const rect = percentToCrop(LAYER, ASPECT, 62, 30, 70)
    expect(inside(rect)).toBe(true)
    expect(panPercent(rect, LAYER)).toEqual({ x: 30, y: 70 })
    expect(zoomPercentOf(rect, LAYER, ASPECT)).toBe(62)

    const back = percentToCrop(LAYER, ASPECT, 62, 30, 70)
    expect(back.cropX).toBe(rect.cropX)
    expect(back.cropWidth).toBe(rect.cropWidth)
  })

  it('clamps garbage input instead of trusting it', () => {
    expect(inside(clampCrop({ cropX: -9000, cropY: -50, cropWidth: 999999, cropHeight: 12 }, LAYER))).toBe(true)
    expect(inside(percentToCrop(LAYER, ASPECT, Number.NaN, -20, 180))).toBe(true)
    expect(inside(cropForZoom({ width: 10, height: 8 }, 3, 9))).toBe(true)
  })

  it('keeps every crop inside the layer across a swept range of zoom and pan', () => {
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let step = 0; step < 400; step++) {
      const rect = percentToCrop(LAYER, ASPECT, next() * 100, next() * 100, next() * 100)
      expect(inside(rect)).toBe(true)
      expect(rect.cropWidth / rect.cropHeight).toBeCloseTo(ASPECT, 2)
    }
  })
})
