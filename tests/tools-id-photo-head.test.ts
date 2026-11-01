// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { estimateHeadBox, toHeadBoxRatios } from '../src/client/features/tools/id-photo/engine/head-estimate'

const SKIN: [number, number, number] = [224, 176, 148]
const WHITE: [number, number, number] = [245, 245, 245]
const BLUE: [number, number, number] = [67, 139, 216]
const HAIR: [number, number, number] = [30, 24, 20]

type Paint = (x: number, y: number) => { rgb: [number, number, number]; alpha?: number }

function frame(size: number, paint: Paint): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const { rgb, alpha = 255 } = paint(x, y)
      const i = (y * size + x) * 4
      data[i] = rgb[0]
      data[i + 1] = rgb[1]
      data[i + 2] = rgb[2]
      data[i + 3] = alpha
    }
  }
  return data
}

/** The face is an ellipse, so the rasterised bounds the estimator should recover are known to the pixel. */
function portrait(options: {
  cx?: number
  cy?: number
  rx?: number
  ry?: number
  neck?: boolean
  hand?: boolean
  background?: [number, number, number]
  crown?: boolean
} = {}): Paint {
  const cx = options.cx ?? 80
  const cy = options.cy ?? 60
  const rx = options.rx ?? 25
  const ry = options.ry ?? 30
  const background = options.background ?? WHITE
  const inHead = (x: number, y: number): boolean => {
    const dx = (x - cx) / rx
    const dy = (y - cy) / ry
    return dx * dx + dy * dy <= 1
  }
  return (x, y) => {
    if (options.crown && Math.abs(x - cx) <= rx * 0.8 && y >= cy - ry - 12 && y <= cy - ry - 2) {
      return { rgb: HAIR }
    }
    if (inHead(x, y)) return { rgb: SKIN }
    if (options.neck && x >= cx - 8 && x <= cx + 8 && y > cy + ry && y <= cy + ry + 60) return { rgb: SKIN }
    if (options.hand && x >= 112 && x <= 140 && y >= 120 && y <= 142) return { rgb: SKIN }
    return { rgb: background }
  }
}

describe('ID photo head box estimation', () => {
  it('frames the face and ignores the neck below the chin', () => {
    const size = 160
    const box = estimateHeadBox(frame(size, portrait({ neck: true })), size, size)
    expect(box).not.toBeNull()
    const found = box!

    expect(found.width).toBeGreaterThanOrEqual(45)
    expect(found.width).toBeLessThanOrEqual(55)
    expect(Math.abs(found.x + found.width / 2 - 80)).toBeLessThanOrEqual(3)
    // The ellipse runs to y=90 and the neck to y=150; the estimate must stop near the chin.
    expect(found.y + found.height).toBeLessThanOrEqual(95)
    expect(found.height).toBeGreaterThanOrEqual(40)
    expect(found.y).toBeGreaterThanOrEqual(28)
    expect(found.y).toBeLessThanOrEqual(45)
  })

  it('says nothing when the photo holds no skin', () => {
    const size = 160
    expect(estimateHeadBox(frame(size, () => ({ rgb: WHITE })), size, size)).toBeNull()
    expect(estimateHeadBox(frame(size, () => ({ rgb: BLUE })), size, size)).toBeNull()
  })

  it('refuses a frame that is mostly skin, which is a backdrop not a head', () => {
    const size = 160
    expect(estimateHeadBox(frame(size, () => ({ rgb: SKIN })), size, size)).toBeNull()
  })

  it('keeps the face and drops a smaller skin patch elsewhere', () => {
    const size = 160
    const box = estimateHeadBox(frame(size, portrait({ cx: 60, cy: 60, rx: 22, ry: 28, hand: true })), size, size)
    expect(box).not.toBeNull()
    expect(Math.abs(box!.x + box!.width / 2 - 60)).toBeLessThanOrEqual(4)
    expect(box!.x + box!.width).toBeLessThan(112)
  })

  it('starts the box at the brow when hair crowns it', () => {
    const size = 160
    const bare = estimateHeadBox(frame(size, portrait()), size, size)!
    const crowned = estimateHeadBox(frame(size, portrait({ crown: true })), size, size)!
    expect(crowned.y).toBeGreaterThanOrEqual(bare.y - 2)
    expect(crowned.y + crowned.height).toBeLessThanOrEqual(bare.y + bare.height + 2)
  })

  it('ignores pixels drawn transparent', () => {
    const size = 160
    const painted = portrait()
    const box = estimateHeadBox(frame(size, (x, y) => ({ ...painted(x, y), alpha: 0 })), size, size)
    expect(box).toBeNull()
  })

  it('returns null for a frame too small to hold a grid', () => {
    expect(estimateHeadBox(new Uint8ClampedArray(3 * 3 * 4), 3, 3)).toBeNull()
    expect(estimateHeadBox(new Uint8ClampedArray(10 * 10 * 4), 10, 10)).toBeNull()
  })

  it('survives a truncated buffer instead of reading past it', () => {
    expect(estimateHeadBox(new Uint8ClampedArray(160 * 160 * 2), 160, 160)).toBeNull()
  })

  it('scales a downsampled grid back to pixel coordinates', () => {
    const size = 640
    const box = estimateHeadBox(frame(size, portrait({ cx: 320, cy: 240, rx: 100, ry: 120 })), size, size)
    expect(box).not.toBeNull()
    expect(Math.abs(box!.x + box!.width / 2 - 320)).toBeLessThanOrEqual(12)
    expect(box!.width).toBeGreaterThanOrEqual(170)
    expect(box!.width).toBeLessThanOrEqual(215)
  })

  it('normalises each edge by the axis it belongs to', () => {
    const ratios = toHeadBoxRatios({ x: 30, y: 40, width: 60, height: 80 }, 300, 400)
    expect(ratios).toEqual({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 })
    expect(toHeadBoxRatios(null, 300, 400)).toBeNull()
    expect(toHeadBoxRatios({ x: 30, y: 40, width: 60, height: 80 }, 0, 400)).toBeNull()
    expect(toHeadBoxRatios({ x: 30, y: 40, width: 60, height: 80 }, 300, Number.NaN)).toBeNull()
  })
})
