const SKIN_CB_MIN = 77
const SKIN_CB_MAX = 127
const SKIN_CR_MIN = 133
const SKIN_CR_MAX = 173
const SHARPEN_GAIN = 0.8
const RANGE_SIGMA_SQUARED = 288

function chromaBlue(r: number, g: number, b: number): number {
  return -0.168736 * r - 0.331264 * g + 0.5 * b + 128
}

function chromaRed(r: number, g: number, b: number): number {
  return 0.5 * r - 0.418688 * g - 0.081312 * b + 128
}

/**
 * The YCbCr skin gamut the retouch step works in: smoothing has to flatten speckle on a face
 * without dragging the backdrop colour across the shoulder line, and a plain wall or a white
 * shirt falls out of this range while lit skin stays inside it.
 */
function isSkinTone(r: number, g: number, b: number): boolean {
  const cb = chromaBlue(r, g, b)
  const cr = chromaRed(r, g, b)
  return cb >= SKIN_CB_MIN && cb <= SKIN_CB_MAX && cr >= SKIN_CR_MIN && cr <= SKIN_CR_MAX
}

export function applySkinSmoothing(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  strength: number,
): void {
  if (!(strength > 0) || width < 3 || height < 3) return

  const weight = Math.min(1, strength / 100)
  const source = new Uint8ClampedArray(data)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4
      if (!isSkinTone(source[i], source[i + 1], source[i + 2])) continue

      let sumR = 0
      let sumG = 0
      let sumB = 0
      let sumWeight = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = ((y + dy) * width + (x + dx)) * 4
          if (!isSkinTone(source[j], source[j + 1], source[j + 2])) continue
          const dr = source[j] - source[i]
          const dg = source[j + 1] - source[i + 1]
          const db = source[j + 2] - source[i + 2]
          const rangeWeight = Math.exp(-(dr * dr + dg * dg + db * db) / RANGE_SIGMA_SQUARED)
          sumR += source[j] * rangeWeight
          sumG += source[j + 1] * rangeWeight
          sumB += source[j + 2] * rangeWeight
          sumWeight += rangeWeight
        }
      }
      if (sumWeight <= 0) continue

      data[i] = source[i] + (sumR / sumWeight - source[i]) * weight
      data[i + 1] = source[i + 1] + (sumG / sumWeight - source[i + 1]) * weight
      data[i + 2] = source[i + 2] + (sumB / sumWeight - source[i + 2]) * weight
    }
  }
}

export function applySharpening(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
): void {
  if (!(amount > 0) || width < 3 || height < 3) return

  const gain = Math.min(1, amount / 100) * SHARPEN_GAIN
  const source = new Uint8ClampedArray(data)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += source[((y + dy) * width + (x + dx)) * 4 + channel]
          }
        }
        const center = source[i + channel]
        data[i + channel] = center + gain * (center - sum / 9)
      }
    }
  }
}
