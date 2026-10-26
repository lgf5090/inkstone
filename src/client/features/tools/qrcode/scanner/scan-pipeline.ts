import jsQR from 'jsqr'

export interface PreprocessOptions {
  resize?: number
  grayscale?: boolean
  contrast?: number
  brightness?: number
  blur?: number
}

export interface ScanPoint {
  x: number
  y: number
}

export interface ScanResult {
  text: string
  durationMs: number
  location?: {
    topLeft: ScanPoint
    topRight: ScanPoint
    bottomRight: ScanPoint
    bottomLeft: ScanPoint
  }
}

export function preprocessImageToCanvas(
  img: HTMLImageElement | HTMLVideoElement,
  options: PreprocessOptions = {}
): HTMLCanvasElement {
  const naturalWidth = (img as HTMLImageElement).naturalWidth || (img as HTMLVideoElement).videoWidth || img.width
  const naturalHeight = (img as HTMLImageElement).naturalHeight || (img as HTMLVideoElement).videoHeight || img.height

  let targetWidth = naturalWidth
  let targetHeight = naturalHeight

  const maxDimension = options.resize ?? 1024
  if (Math.max(naturalWidth, naturalHeight) > maxDimension) {
    if (naturalWidth > naturalHeight) {
      targetWidth = maxDimension
      targetHeight = Math.round((naturalHeight * maxDimension) / naturalWidth)
    } else {
      targetHeight = maxDimension
      targetWidth = Math.round((naturalWidth * maxDimension) / naturalHeight)
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  const filters: string[] = []
  if (options.grayscale) filters.push('grayscale(100%)')
  if (typeof options.contrast === 'number' && options.contrast !== 100) {
    filters.push(`contrast(${options.contrast}%)`)
  }
  if (typeof options.brightness === 'number' && options.brightness !== 100) {
    filters.push(`brightness(${options.brightness}%)`)
  }
  if (typeof options.blur === 'number' && options.blur > 0) {
    filters.push(`blur(${options.blur}px)`)
  }

  ctx.filter = filters.length > 0 ? filters.join(' ') : 'none'
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight)
  ctx.filter = 'none'

  return canvas
}

export async function scanCanvas(canvas: HTMLCanvasElement): Promise<ScanResult | null> {
  const startTime = performance.now()

  // 1. Try native BarcodeDetector if available
  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    try {
      const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] })
      const barcodes = await detector.detect(canvas)
      if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
        const raw = barcodes[0]
        const cornerPoints = raw.cornerPoints || []
        const durationMs = Math.round(performance.now() - startTime)
        return {
          text: raw.rawValue,
          durationMs,
          location:
            cornerPoints.length >= 4
              ? {
                  topLeft: cornerPoints[0],
                  topRight: cornerPoints[1],
                  bottomRight: cornerPoints[2],
                  bottomLeft: cornerPoints[3],
                }
              : undefined,
        }
      }
    } catch {
      // Fall through to jsQR
    }
  }

  // 2. jsQR fallback
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const code = jsQR(imageData.data, canvas.width, canvas.height, {
    inversionAttempts: 'attemptBoth',
  })

  const durationMs = Math.round(performance.now() - startTime)

  if (code && code.data) {
    return {
      text: code.data,
      durationMs,
      location: code.location
        ? {
            topLeft: code.location.topLeftCorner,
            topRight: code.location.topRightCorner,
            bottomRight: code.location.bottomRightCorner,
            bottomLeft: code.location.bottomLeftCorner,
          }
        : undefined,
    }
  }

  return null
}
