/**
 * Pixel comparison for two images of the same size.
 *
 * The canvas is the only place that can read pixels, so the drawing lives in the client; what lives
 * here is the decision — which pixels differ, by how much, and what the highlight mask looks like —
 * so it can be tested without a browser and the screen only has to paint the result.
 */

export interface PixelDiff {
  /** The highlight layer: differing pixels in red, equal ones left as the dimmed source. */
  mask: Uint8ClampedArray
  differing: number
  total: number
}

/**
 * Compares two RGBA buffers.
 *
 * `tolerance` is a per-channel difference allowance: compression and re-encoding move a pixel by a
 * value or two, and a comparison that calls those different buries the real change under noise.
 * Alpha is compared with the same allowance, because a transparent pixel's colour is not visible.
 */
export function diffPixels(
  left: Uint8ClampedArray,
  right: Uint8ClampedArray,
  tolerance = 0,
): PixelDiff {
  const total = Math.min(left.length, right.length) / 4
  const mask = new Uint8ClampedArray(left.length)
  let differing = 0
  for (let index = 0; index < mask.length; index += 4) {
    const red = Math.abs(left[index]! - right[index]!)
    const green = Math.abs(left[index + 1]! - right[index + 1]!)
    const blue = Math.abs(left[index + 2]! - right[index + 2]!)
    const alpha = Math.abs(left[index + 3]! - right[index + 3]!)
    const changed = red > tolerance || green > tolerance || blue > tolerance || alpha > tolerance
    if (changed) {
      differing++
      mask[index] = 255
      mask[index + 1] = 32
      mask[index + 2] = 32
      mask[index + 3] = 255
    } else {
      // The equal pixels stay as a faint grey copy of the left image, so the highlight is readable
      // against the picture rather than floating on an empty canvas.
      mask[index] = left[index]!
      mask[index + 1] = left[index + 1]!
      mask[index + 2] = left[index + 2]!
      mask[index + 3] = 56
    }
  }
  return { mask, differing, total }
}

/** How much of the picture changed, as a percentage with one decimal. */
export function diffPercent(diff: PixelDiff): number {
  if (diff.total <= 0) return 0
  return Math.round((diff.differing / diff.total) * 1000) / 10
}
