// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  applySharpening,
  applySkinSmoothing,
} from '../src/client/features/tools/id-photo/engine/retouch-pipeline'

type Swatch = [number, number, number]

const SKIN: Swatch = [225, 190, 160]
const BLUE: Swatch = [20, 60, 180]
const WALL: Swatch = [205, 205, 205]

function patch(size: number, base: Swatch, noise: number) {
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const bump = (x + y) % 2 === 0 ? noise : -noise
      data[i] = base[0] + bump
      data[i + 1] = base[1] + bump
      data[i + 2] = base[2] + bump
      data[i + 3] = 255
    }
  }
  return { data, size }
}

function stepEdge(size: number, low: number, high: number) {
  const data = new Uint8ClampedArray(size * size * 4)
  const mid = size >> 1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const v = x < mid ? low : high
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { data, size, mid }
}

function neighbourDelta(data: Uint8ClampedArray, size: number) {
  let sum = 0
  let count = 0
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 2; x++) {
      const i = (y * size + x) * 4
      const j = (y * size + x + 1) * 4
      sum += Math.abs(data[i] - data[j])
      count++
    }
  }
  return sum / count
}

function bandMean(data: Uint8ClampedArray, size: number, from: number, to: number) {
  let sum = 0
  let count = 0
  for (let y = 1; y < size - 1; y++) {
    for (let x = from; x < to; x++) {
      sum += data[(y * size + x) * 4]
      count++
    }
  }
  return sum / count
}

describe('ID photo retouch pipeline', () => {
  it('leaves the frame untouched at zero strength', () => {
    const { data, size } = patch(12, SKIN, 8)
    const before = Array.from(data)
    applySkinSmoothing(data, size, size, 0)
    expect(Array.from(data)).toEqual(before)
  })

  it('flattens speckle inside skin tones', () => {
    const { data, size } = patch(12, SKIN, 8)
    const before = neighbourDelta(data, size)
    applySkinSmoothing(data, size, size, 100)
    expect(neighbourDelta(data, size)).toBeLessThan(before)
  })

  it('does not smooth a saturated blue region', () => {
    const { data, size } = patch(12, BLUE, 8)
    const before = neighbourDelta(data, size)
    applySkinSmoothing(data, size, size, 100)
    expect(neighbourDelta(data, size)).toBeCloseTo(before, 5)
  })

  it('does not smooth the plain backdrop grey', () => {
    const { data, size } = patch(12, WALL, 8)
    const before = neighbourDelta(data, size)
    applySkinSmoothing(data, size, size, 100)
    expect(neighbourDelta(data, size)).toBeCloseTo(before, 5)
  })

  it('widens the contrast across an edge when sharpening', () => {
    const { data, size, mid } = stepEdge(13, 100, 150)
    const before = bandMean(data, size, mid, mid + 3) - bandMean(data, size, mid - 3, mid)
    applySharpening(data, size, size, 100)
    const after = bandMean(data, size, mid, mid + 3) - bandMean(data, size, mid - 3, mid)
    expect(after).toBeGreaterThan(before + 5)
  })

  it('leaves a flat area flat', () => {
    const { data, size } = patch(12, WALL, 0)
    applySharpening(data, size, size, 100)
    expect(bandMean(data, size, 1, size - 1)).toBeCloseTo(205, 1)
  })

  it('does nothing at zero amount', () => {
    const { data, size } = stepEdge(13, 100, 150)
    const before = Array.from(data)
    applySharpening(data, size, size, 0)
    expect(Array.from(data)).toEqual(before)
  })
})
