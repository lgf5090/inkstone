// @vitest-environment jsdom
/**
 * Geometry of the color wheel's field and blit.
 *
 * jsdom answers `getContext('2d')` with null here, so the blit itself is verified in a real browser (see
 * the ledger's round-2 record for the device-pixel readback); what these cases pin is the two decisions
 * that failure turned on: the disk is built centred in its own square, and the backing store is sized by
 * the device pixel ratio while the drawing stays in CSS units.
 */
import { describe, expect, it } from 'vitest'
import { buildWheelPixels, wheelBlitPlan } from '../src/client/features/tools/color/lib/color-wheel'

const SIZE = 40
const CENTER = SIZE / 2
const RADIUS = SIZE / 2 - 2

function pixel(data: Uint8ClampedArray, x: number, y: number) {
  const i = (y * SIZE + x) * 4
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] }
}

describe('Color wheel field', () => {
  const data = buildWheelPixels(SIZE, 50)

  it('covers one RGBA slot per pixel', () => {
    expect(data.length).toBe(SIZE * SIZE * 4)
  })

  it('is opaque at the centre and transparent in the corners', () => {
    expect(pixel(data, CENTER, CENTER).a).toBe(255)
    expect(pixel(data, 0, 0).a).toBe(0)
    expect(pixel(data, SIZE - 1, SIZE - 1).a).toBe(0)
  })

  it('clips at the radius rather than at the box', () => {
    expect(pixel(data, CENTER + RADIUS - 1, CENTER).a).toBe(255)
    expect(pixel(data, CENTER + RADIUS + 1, CENTER).a).toBe(0)
  })

  it('maps angle to hue around the centre', () => {
    const east = pixel(data, CENTER + RADIUS - 1, CENTER)
    const west = pixel(data, CENTER - RADIUS + 1, CENTER)
    // Hue 0 due east, hue 180 due west, both near full saturation at the rim.
    expect(east.r).toBeGreaterThan(east.g)
    expect(east.r).toBeGreaterThan(east.b)
    expect(west.b).toBeGreaterThan(west.r)
    expect(west.g).toBeGreaterThan(west.r)
  })

  it('keeps saturation low at the centre and high at the rim', () => {
    const mid = pixel(data, CENTER, CENTER)
    const rim = pixel(data, CENTER + RADIUS - 1, CENTER)
    const spread = (c: { r: number, g: number, b: number }) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)
    expect(spread(mid)).toBeLessThan(spread(rim))
  })
})

describe('Color wheel blit plan', () => {
  it('scales the backing store by the device ratio and draws in CSS units', () => {
    expect(wheelBlitPlan(220, 1)).toEqual({ backing: 220, drawSize: 220 })
    expect(wheelBlitPlan(220, 2)).toEqual({ backing: 440, drawSize: 220 })
    expect(wheelBlitPlan(220, 1.5)).toEqual({ backing: 330, drawSize: 220 })
  })

  it('never sizes the backing store below one pixel', () => {
    expect(wheelBlitPlan(0, 2).backing).toBe(1)
  })
})
