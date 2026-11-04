import { describe, expect, it } from 'vitest'
import { diffPercent, diffPixels } from '../src/shared/tools/compare/image'

const pixel = (red: number, green: number, blue: number, alpha = 255): number[] => [red, green, blue, alpha]

describe('diffPixels', () => {
  it('counts nothing when the pixels match', () => {
    const left = new Uint8ClampedArray([...pixel(10, 20, 30), ...pixel(40, 50, 60)])
    const result = diffPixels(left, left, 0)
    expect(result.differing).toBe(0)
    expect(result.total).toBe(2)
    expect(diffPercent(result)).toBe(0)
  })

  it('counts the one pixel that changed', () => {
    const left = new Uint8ClampedArray([...pixel(10, 20, 30), ...pixel(40, 50, 60)])
    const right = new Uint8ClampedArray([...pixel(10, 20, 30), ...pixel(40, 250, 60)])
    const result = diffPixels(left, right, 0)
    expect(result.differing).toBe(1)
    expect(diffPercent(result)).toBe(50)
  })

  it('honours the tolerance that compression noise needs', () => {
    const left = new Uint8ClampedArray(pixel(10, 20, 30))
    const right = new Uint8ClampedArray(pixel(14, 22, 31))
    expect(diffPixels(left, right, 0).differing).toBe(1)
    expect(diffPixels(left, right, 12).differing).toBe(0)
  })

  it('paints differing pixels in the mask and leaves equal ones faint', () => {
    const left = new Uint8ClampedArray([...pixel(10, 20, 30), ...pixel(40, 50, 60)])
    const right = new Uint8ClampedArray([...pixel(10, 20, 30), ...pixel(250, 50, 60)])
    const result = diffPixels(left, right, 0)
    expect([...result.mask.slice(0, 4)]).toEqual([10, 20, 30, 56])
    expect([...result.mask.slice(4, 8)]).toEqual([255, 32, 32, 255])
  })
})
