// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  applyBackdropMatte,
  estimateBackdropColor,
} from '../src/client/features/tools/id-photo/engine/background-matting'

type Swatch = readonly [number, number, number]

const WHITE: Swatch = [255, 255, 255]
const BLUE: Swatch = [20, 60, 180]

function buildFrame(width: number, height: number, at: (x: number, y: number) => Swatch, alpha = 255) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const [r, g, b] = at(x, y)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = alpha
    }
  }
  return { data, width, height }
}

function portraitFixture(size = 41) {
  const mid = Math.floor(size / 2)
  return buildFrame(size, size, (x, y) => {
    const insidePerson = Math.abs(x - mid) <= 8 && y > mid - 10
    if (!insidePerson) return WHITE
    const insideShirt = Math.abs(x - mid) <= 3 && y > mid + 2
    return insideShirt ? WHITE : BLUE
  })
}

const alphaAt = (data: Uint8ClampedArray, size: number, x: number, y: number) => data[(y * size + x) * 4 + 3]

describe('ID photo backdrop matte', () => {
  it('estimates the backdrop from the frame border, not from the subject', () => {
    const { data, width, height } = portraitFixture()
    const backdrop = estimateBackdropColor(data, width, height)
    expect(Math.abs(backdrop.r - 255)).toBeLessThanOrEqual(4)
    expect(Math.abs(backdrop.b - 255)).toBeLessThanOrEqual(4)
  })

  it('keys out the backdrop that touches the frame edge', () => {
    const { data, width, height } = portraitFixture()
    const replaced = applyBackdropMatte({ data, width, height, feather: 0 })
    expect(replaced).toBe(true)
    expect(alphaAt(data, width, 1, 1)).toBe(0)
    expect(alphaAt(data, width, 20, 2)).toBe(0)
  })

  it('keeps the person opaque, including a white shirt the backdrop also matches', () => {
    const { data, width, height } = portraitFixture()
    applyBackdropMatte({ data, width, height, feather: 0 })
    expect(alphaAt(data, width, 20, 32)).toBe(255)
    expect(alphaAt(data, width, 20, 36)).toBe(255)
  })

  it('feathers the cut-out edge instead of leaving a hard stair', () => {
    const hard = portraitFixture()
    applyBackdropMatte({ ...hard, feather: 0 })
    const soft = portraitFixture()
    applyBackdropMatte({ ...soft, feather: 40 })
    const edge = alphaAt(soft.data, soft.width, 11, 30)
    expect(alphaAt(hard.data, hard.width, 11, 30)).not.toBe(edge)
    expect(edge).toBeGreaterThan(0)
    expect(edge).toBeLessThan(255)
  })

  it('never makes an already transparent pixel opaque again', () => {
    const { data, width, height } = portraitFixture()
    const shirt = (32 * width + 20) * 4
    data[shirt + 3] = 0
    applyBackdropMatte({ data, width, height, feather: 40 })
    expect(data[shirt + 3]).toBe(0)
    expect(alphaAt(data, width, 20, 31)).toBeLessThanOrEqual(255)
  })

  it('refuses to key a frame that is mostly one colour all the way through', () => {
    const { data, width, height } = buildFrame(21, 21, () => WHITE)
    const replaced = applyBackdropMatte({ data, width, height, feather: 0 })
    expect(replaced).toBe(false)
    expect(alphaAt(data, width, 10, 10)).toBe(255)
  })
})
