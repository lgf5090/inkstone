/**
 * Modified Median Cut Quantization (MMCQ) in pure TypeScript.
 * Extracts dominant color and harmonious palette matrix from image pixel data.
 */

import { rgbToHex } from './spaces'
import type { RgbColor } from './types'

// 5-bit color quantization to reduce histogram size (32 x 32 x 32 = 32,768 bins)
const SIGBITS = 5
const RSHIFT = 8 - SIGBITS

function getColorIndex(r: number, g: number, b: number): number {
  return (r << (2 * SIGBITS)) + (g << SIGBITS) + b
}

interface VBox {
  r1: number
  r2: number
  g1: number
  g2: number
  b1: number
  b2: number
  histo: Int32Array
}

function createVBox(
  r1: number,
  r2: number,
  g1: number,
  g2: number,
  b1: number,
  b2: number,
  histo: Int32Array,
): VBox {
  return { r1, r2, g1, g2, b1, b2, histo }
}

function vboxVolume(vbox: VBox): number {
  return (vbox.r2 - vbox.r1 + 1) * (vbox.g2 - vbox.g1 + 1) * (vbox.b2 - vbox.b1 + 1)
}

function vboxCount(vbox: VBox): number {
  let count = 0
  const { r1, r2, g1, g2, b1, b2, histo } = vbox
  for (let r = r1; r <= r2; r++) {
    for (let g = g1; g <= g2; g++) {
      for (let b = b1; b <= b2; b++) {
        const index = getColorIndex(r, g, b)
        count += histo[index] || 0
      }
    }
  }
  return count
}

function vboxAvg(vbox: VBox): RgbColor {
  let total = 0
  let rSum = 0
  let gSum = 0
  let bSum = 0
  const mult = 1 << RSHIFT

  const { r1, r2, g1, g2, b1, b2, histo } = vbox
  for (let r = r1; r <= r2; r++) {
    for (let g = g1; g <= g2; g++) {
      for (let b = b1; b <= b2; b++) {
        const index = getColorIndex(r, g, b)
        const h = histo[index] || 0
        if (h > 0) {
          total += h
          rSum += h * (r + 0.5) * mult
          gSum += h * (g + 0.5) * mult
          bSum += h * (b + 0.5) * mult
        }
      }
    }
  }

  if (total > 0) {
    return {
      r: Math.round(rSum / total),
      g: Math.round(gSum / total),
      b: Math.round(bSum / total),
    }
  }

  return {
    r: Math.round(((r1 + r2 + 1) / 2) * mult),
    g: Math.round(((g1 + g2 + 1) / 2) * mult),
    b: Math.round(((b1 + b2 + 1) / 2) * mult),
  }
}

function medianCut(vbox: VBox): [VBox, VBox] | null {
  const rw = vbox.r2 - vbox.r1 + 1
  const gw = vbox.g2 - vbox.g1 + 1
  const bw = vbox.b2 - vbox.b1 + 1
  const maxW = Math.max(rw, gw, bw)

  if (maxW <= 1) return null

  let cutDim: 'r' | 'g' | 'b' = 'r'
  if (maxW === gw) cutDim = 'g'
  else if (maxW === bw) cutDim = 'b'

  const total = vboxCount(vbox)
  if (total === 0) return null

  // Find median
  let sum = 0
  let splitPoint = -1

  if (cutDim === 'r') {
    for (let r = vbox.r1; r <= vbox.r2; r++) {
      let sub = 0
      for (let g = vbox.g1; g <= vbox.g2; g++) {
        for (let b = vbox.b1; b <= vbox.b2; b++) {
          sub += vbox.histo[getColorIndex(r, g, b)] || 0
        }
      }
      sum += sub
      if (sum >= total / 2) {
        splitPoint = r
        break
      }
    }
    splitPoint = Math.max(vbox.r1, Math.min(vbox.r2 - 1, splitPoint))
    const b1 = createVBox(vbox.r1, splitPoint, vbox.g1, vbox.g2, vbox.b1, vbox.b2, vbox.histo)
    const b2 = createVBox(splitPoint + 1, vbox.r2, vbox.g1, vbox.g2, vbox.b1, vbox.b2, vbox.histo)
    return [b1, b2]
  } else if (cutDim === 'g') {
    for (let g = vbox.g1; g <= vbox.g2; g++) {
      let sub = 0
      for (let r = vbox.r1; r <= vbox.r2; r++) {
        for (let b = vbox.b1; b <= vbox.b2; b++) {
          sub += vbox.histo[getColorIndex(r, g, b)] || 0
        }
      }
      sum += sub
      if (sum >= total / 2) {
        splitPoint = g
        break
      }
    }
    splitPoint = Math.max(vbox.g1, Math.min(vbox.g2 - 1, splitPoint))
    const b1 = createVBox(vbox.r1, vbox.r2, vbox.g1, splitPoint, vbox.b1, vbox.b2, vbox.histo)
    const b2 = createVBox(vbox.r1, vbox.r2, splitPoint + 1, vbox.g2, vbox.b1, vbox.b2, vbox.histo)
    return [b1, b2]
  } else {
    for (let b = vbox.b1; b <= vbox.b2; b++) {
      let sub = 0
      for (let r = vbox.r1; r <= vbox.r2; r++) {
        for (let g = vbox.g1; g <= vbox.g2; g++) {
          sub += vbox.histo[getColorIndex(r, g, b)] || 0
        }
      }
      sum += sub
      if (sum >= total / 2) {
        splitPoint = b
        break
      }
    }
    splitPoint = Math.max(vbox.b1, Math.min(vbox.b2 - 1, splitPoint))
    const b1 = createVBox(vbox.r1, vbox.r2, vbox.g1, vbox.g2, vbox.b1, splitPoint, vbox.histo)
    const b2 = createVBox(vbox.r1, vbox.r2, vbox.g1, vbox.g2, splitPoint + 1, vbox.b2, vbox.histo)
    return [b1, b2]
  }
}

export interface ExtractedPaletteResult {
  dominant: string
  dominantRgb: RgbColor
  palette: string[] // Array of hex colors (e.g. 10 colors)
}

/**
 * Extracts dominant color and palette array from RGBA image pixel data
 * @param pixels Uint8ClampedArray from canvas getImageData or numeric array [r, g, b, a, ...]
 * @param maxColors Total colors to return (default 10)
 */
export function extractPaletteFromPixels(
  pixels: Uint8ClampedArray | number[],
  maxColors = 10,
): ExtractedPaletteResult {
  const histo = new Int32Array(1 << (3 * SIGBITS))

  let rMin = 31
  let rMax = 0
  let gMin = 31
  let gMax = 0
  let bMin = 31
  let bMax = 0

  const len = pixels.length
  // Sample every few pixels for speed if image is huge
  const step = Math.max(1, Math.floor(len / 4 / 20000)) * 4

  for (let i = 0; i < len; i += step) {
    const a = pixels[i + 3]
    // Ignore near-transparent pixels
    if (a < 128) continue

    const r = pixels[i] >> RSHIFT
    const g = pixels[i + 1] >> RSHIFT
    const b = pixels[i + 2] >> RSHIFT

    // Ignore extreme pure white or pure black noise
    if (r >= 31 && g >= 31 && b >= 31) continue

    rMin = Math.min(rMin, r)
    rMax = Math.max(rMax, r)
    gMin = Math.min(gMin, g)
    gMax = Math.max(gMax, g)
    bMin = Math.min(bMin, b)
    bMax = Math.max(bMax, b)

    const index = getColorIndex(r, g, b)
    histo[index]++
  }

  if (rMin > rMax) {
    // Default fallback if transparent/blank image
    return {
      dominant: '#627486',
      dominantRgb: { r: 98, g: 116, b: 134 },
      palette: ['#627486', '#8aa1b1', '#475569', '#334155'],
    }
  }

  const initialBox = createVBox(rMin, rMax, gMin, gMax, bMin, bMax, histo)
  const boxes: VBox[] = [initialBox]

  const targetCount = maxColors + 1

  while (boxes.length < targetCount) {
    // Pick box with largest volume * count
    boxes.sort((a, b) => vboxCount(b) * vboxVolume(b) - vboxCount(a) * vboxVolume(a))
    const largest = boxes.shift()!
    const split = medianCut(largest)
    if (!split) {
      boxes.push(largest)
      break
    }
    boxes.push(split[0], split[1])
  }

  // Sort boxes by pixel population count descending
  boxes.sort((a, b) => vboxCount(b) - vboxCount(a))

  const rgbColors = boxes.map((box) => vboxAvg(box))
  const hexColors = rgbColors.map((rgb) => rgbToHex(rgb, true))

  const dominantRgb = rgbColors[0] || { r: 98, g: 116, b: 134 }
  const dominant = hexColors[0] || '#627486'
  const palette = hexColors.slice(1, maxColors + 1)

  return {
    dominant,
    dominantRgb,
    palette: palette.length > 0 ? palette : [dominant],
  }
}
