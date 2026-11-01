export function parseHexColor(hex: string): { r: number; g: number; b: number } {
  let clean = hex.replace('#', '').trim()
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const num = parseInt(clean, 16)
  if (isNaN(num)) return { r: 255, g: 255, b: 255 }
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  }
}

export interface BackdropMatteInput {
  data: Uint8ClampedArray
  width: number
  height: number
  feather: number
}

const KEY_TOLERANCE = 30
const KEY_TRANSPARENT_BELOW = 10
const FEATHER_MAX_RADIUS = 6
const BACKDROP_SAMPLE_STEP = 2

function lumaWeightedDistance(
  r: number,
  g: number,
  b: number,
  backdrop: { r: number; g: number; b: number },
): number {
  const dr = r - backdrop.r
  const dg = g - backdrop.g
  const db = b - backdrop.b
  const dl = 0.299 * dr + 0.587 * dg + 0.114 * db
  const dBlue = -0.168736 * dr - 0.331264 * dg + 0.5 * db
  const dRed = 0.5 * dr - 0.418688 * dg - 0.081312 * db
  return Math.sqrt(dl * dl * 0.25 + dBlue * dBlue + dRed * dRed)
}

function median(values: number[]): number {
  if (values.length === 0) return 255
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export function estimateBackdropColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { r: number; g: number; b: number } {
  const reds: number[] = []
  const greens: number[] = []
  const blues: number[] = []
  const push = (x: number, y: number) => {
    const i = (y * width + x) * 4
    if (data[i + 3] < KEY_TRANSPARENT_BELOW) return
    reds.push(data[i])
    greens.push(data[i + 1])
    blues.push(data[i + 2])
  }
  for (let x = 0; x < width; x += BACKDROP_SAMPLE_STEP) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y += BACKDROP_SAMPLE_STEP) {
    push(0, y)
    push(width - 1, y)
  }
  return { r: median(reds), g: median(greens), b: median(blues) }
}

function featherRadius(feather: number): number {
  if (!(feather > 0)) return 0
  return Math.min(FEATHER_MAX_RADIUS, Math.round(feather / 8))
}

function boxBlurMask(mask: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius <= 0) return mask
  const horizontal = new Float32Array(mask.length)
  const vertical = new Float32Array(mask.length)
  const span = radius * 2 + 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        sum += mask[y * width + Math.min(width - 1, Math.max(0, x + k))]
      }
      horizontal[y * width + x] = sum / span
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        sum += horizontal[Math.min(height - 1, Math.max(0, y + k)) * width + x]
      }
      vertical[y * width + x] = sum / span
    }
  }
  return vertical
}

export function applyBackdropMatte({ data, width, height, feather }: BackdropMatteInput): boolean {
  const total = width * height
  if (total <= 0) return false

  const backdrop = estimateBackdropColor(data, width, height)
  const isKeyable = (index: number) => {
    const i = index * 4
    if (data[i + 3] < KEY_TRANSPARENT_BELOW) return true
    return lumaWeightedDistance(data[i], data[i + 1], data[i + 2], backdrop) <= KEY_TOLERANCE
  }

  const background = new Uint8Array(total)
  const queue = new Int32Array(total)
  let head = 0
  let tail = 0
  const seed = (index: number) => {
    if (!background[index] && isKeyable(index)) {
      background[index] = 1
      queue[tail++] = index
    }
  }
  for (let x = 0; x < width; x++) seed(x)
  for (let y = 0; y < height; y++) {
    seed(y * width)
    seed(y * width + width - 1)
  }

  let coverage = 0
  while (head < tail) {
    const index = queue[head++]
    coverage++
    const x = index % width
    const y = (index - x) / width
    if (x > 0 && !background[index - 1] && isKeyable(index - 1)) {
      background[index - 1] = 1
      queue[tail++] = index - 1
    }
    if (x < width - 1 && !background[index + 1] && isKeyable(index + 1)) {
      background[index + 1] = 1
      queue[tail++] = index + 1
    }
    if (y > 0 && !background[index - width] && isKeyable(index - width)) {
      background[index - width] = 1
      queue[tail++] = index - width
    }
    if (y < height - 1 && !background[index + width] && isKeyable(index + width)) {
      background[index + width] = 1
      queue[tail++] = index + width
    }
  }

  const probeRow = Math.floor(height / 2)
  const probes = [
    Math.floor(width * 0.35),
    Math.floor(width / 2),
    Math.floor(width * 0.65),
  ].map((x) => probeRow * width + x)

  if (coverage === 0 || probes.every((index) => background[index] === 1)) return false

  const weights = new Float32Array(total)
  for (let index = 0; index < total; index++) weights[index] = background[index]
  const blurred = boxBlurMask(weights, width, height, featherRadius(feather))

  for (let index = 0; index < total; index++) {
    const i = index * 4
    const kept = Math.round(255 * (1 - blurred[index]))
    if (kept < data[i + 3]) data[i + 3] = kept
  }
  return true
}

/**
 * Renders ID photo background (solid or smooth vertical gradient) onto a 2D Canvas context.
 */
export function renderBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bgColor: string,
  isGradient = false,
  endColor?: string,
): void {
  if (isGradient && endColor) {
    const grad = ctx.createLinearGradient(0, 0, 0, height)
    grad.addColorStop(0, bgColor)
    grad.addColorStop(1, endColor)
    ctx.fillStyle = grad
  } else {
    ctx.fillStyle = bgColor
  }
  ctx.fillRect(0, 0, width, height)
}

/**
 * Applies color tint adjustments and smoothing to canvas pixel buffer.
 */
export function applyImageFilters(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: {
    brightness: number // -100 to 100
    contrast: number // -100 to 100
    whitening: number // 0 to 100
  },
): void {
  if (options.brightness === 0 && options.contrast === 0 && options.whitening === 0) {
    return
  }

  const imgData = ctx.getImageData(0, 0, width, height)
  const data = imgData.data

  const bOffset = (options.brightness / 100) * 128
  const factor = (259 * (options.contrast + 255)) / (255 * (259 - options.contrast))
  const whiteBoost = (options.whitening / 100) * 40

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]
    let g = data[i + 1]
    let b = data[i + 2]

    // Whitening / brightness boost
    if (bOffset !== 0 || whiteBoost !== 0) {
      r += bOffset + whiteBoost
      g += bOffset + whiteBoost
      b += bOffset + whiteBoost
    }

    // Contrast
    if (options.contrast !== 0) {
      r = factor * (r - 128) + 128
      g = factor * (g - 128) + 128
      b = factor * (b - 128) + 128
    }

    data[i] = Math.min(255, Math.max(0, Math.round(r)))
    data[i + 1] = Math.min(255, Math.max(0, Math.round(g)))
    data[i + 2] = Math.min(255, Math.max(0, Math.round(b)))
  }

  ctx.putImageData(imgData, 0, 0)
}
