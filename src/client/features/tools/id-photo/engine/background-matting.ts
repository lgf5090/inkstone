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
