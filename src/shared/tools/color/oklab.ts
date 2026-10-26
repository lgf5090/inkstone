/**
 * OKLab Perceptual Interpolation & Dead-Zone-Free Gradient Engine.
 * Eliminates dull gray midtones occurring in standard sRGB linear interpolation.
 */

import { clamp, hexToRgb, normalizeHex, oklabToRgb, rgbToHex, rgbToOklab } from './spaces'
import type { GradientConfig } from './types'

/**
 * Linearly interpolates two colors in OKLab perceptual color space
 * @param hex1 Start color hex
 * @param hex2 End color hex
 * @param t Interpolation progress (0.0 to 1.0)
 */
export function interpolateOklab(hex1: string, hex2: string, t: number): string {
  const norm1 = normalizeHex(hex1, true)
  const norm2 = normalizeHex(hex2, true)

  const ok1 = rgbToOklab(hexToRgb(norm1))
  const ok2 = rgbToOklab(hexToRgb(norm2))

  const progress = clamp(t, 0, 1)

  const interpolated = {
    l: ok1.l + (ok2.l - ok1.l) * progress,
    a: ok1.a + (ok2.a - ok1.a) * progress,
    b: ok1.b + (ok2.b - ok1.b) * progress,
  }

  const rgb = oklabToRgb(interpolated)
  return rgbToHex(rgb, true)
}

/**
 * Generates smooth intermediate color stops using OKLab interpolation to eliminate the gray dead zone.
 */
export function generateOklabGradientStops(
  hex1: string,
  hex2: string,
  subdivisions = 5,
): Array<{ color: string; offset: number }> {
  const result: Array<{ color: string; offset: number }> = []

  for (let i = 0; i <= subdivisions; i++) {
    const t = i / subdivisions
    const color = interpolateOklab(hex1, hex2, t)
    const offset = Math.round(t * 100)
    result.push({ color, offset })
  }

  return result
}

/**
 * Builds valid CSS background gradient string
 */
export function buildCssGradient(config: GradientConfig): string {
  const { type, angle, stops, useOklabInterpolation } = config

  if (!stops || stops.length === 0) {
    return 'linear-gradient(90deg, #627486 0%, #475569 100%)'
  }

  const sortedStops = [...stops].sort((a, b) => a.offset - b.offset)

  let renderedStops: Array<{ color: string; offset: number }> = []

  if (useOklabInterpolation && sortedStops.length >= 2) {
    for (let i = 0; i < sortedStops.length - 1; i++) {
      const start = sortedStops[i]
      const end = sortedStops[i + 1]
      const intermediate = generateOklabGradientStops(start.color, end.color, 4)

      // Remap offsets
      for (let j = (i === 0 ? 0 : 1); j < intermediate.length; j++) {
        const localT = intermediate[j].offset / 100
        const globalOffset = start.offset + (end.offset - start.offset) * localT
        renderedStops.push({
          color: intermediate[j].color,
          offset: Math.round(globalOffset * 10) / 10,
        })
      }
    }
  } else {
    renderedStops = sortedStops.map((s) => ({ color: s.color, offset: s.offset }))
  }

  const stopStrings = renderedStops.map((s) => `${s.color} ${s.offset}%`).join(', ')

  switch (type) {
    case 'linear':
      return `linear-gradient(${angle}deg, ${stopStrings})`
    case 'radial':
      return `radial-gradient(circle at center, ${stopStrings})`
    case 'conic':
      return `conic-gradient(from ${angle}deg at center, ${stopStrings})`
    default:
      return `linear-gradient(${angle}deg, ${stopStrings})`
  }
}
