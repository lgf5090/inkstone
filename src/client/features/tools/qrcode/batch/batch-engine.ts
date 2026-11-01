import { zip } from 'fflate'
import type {
  QrExportFormat,
  QrStylingOptions,
  QrToolkitMarkerInnerShape,
  QrToolkitMarkerShape,
  QrToolkitPixelStyle,
} from '../../../../../shared/tools/qrcode/types'
import { QrEngine } from '../engine/qr-engine'

export interface BatchItemConfig {
  text: string
  filename: string
}

/** A guard rail, not a quota: this many canvases is already minutes of main-thread work. */
export const MAX_BATCH_ITEMS = 500

export interface BatchGenerateOptions {
  items: BatchItemConfig[]
  size?: number
  format?: QrExportFormat
  randomizeStyle?: boolean
  baseOptions: QrStylingOptions
  onProgress?: (current: number, total: number) => void
  /** Checked before each item, so a runaway batch can be stopped mid-run. */
  isCancelled?: () => boolean
}

const RANDOM_PIXELS: QrToolkitPixelStyle[] = [
  'square',
  'rounded',
  'dot',
  'squircle',
  'row',
  'column',
]

const RANDOM_MARKERS: QrToolkitMarkerShape[] = [
  'square',
  'circle',
  'plus',
  'box',
  'octagon',
  'random',
]

const RANDOM_INNER_MARKERS: QrToolkitMarkerInnerShape[] = [
  'square',
  'circle',
  'plus',
  'diamond',
  'eye',
]

export function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

export async function runBatchGeneration(options: BatchGenerateOptions): Promise<Blob> {
  const {
    items,
    size = 600,
    format = 'png',
    randomizeStyle = false,
    baseOptions,
    onProgress,
    isCancelled,
  } = options
  if (items.length > MAX_BATCH_ITEMS) {
    throw new Error(`batch limit exceeded: ${MAX_BATCH_ITEMS}`)
  }
  const zipFiles: Record<string, Uint8Array> = {}

  for (let i = 0; i < items.length; i++) {
    if (isCancelled?.()) throw new Error('BATCH_CANCELLED')
    const item = items[i]
    let itemOptions = { ...baseOptions }

    if (randomizeStyle) {
      const randPixel = RANDOM_PIXELS[Math.floor(Math.random() * RANDOM_PIXELS.length)]
      const randMarker = RANDOM_MARKERS[Math.floor(Math.random() * RANDOM_MARKERS.length)]
      const randInner = RANDOM_INNER_MARKERS[Math.floor(Math.random() * RANDOM_INNER_MARKERS.length)]

      itemOptions = {
        ...itemOptions,
        toolkitOptions: {
          ...itemOptions.toolkitOptions,
          enabled: true,
          pixelStyle: randPixel,
          markerShape: randMarker,
          markerInnerShape: randInner,
          marginNoise: Math.random() > 0.5,
          marginNoiseRate: Math.random() * 0.4 + 0.1,
          effect: Math.random() > 0.6 ? 'crystalize' : 'none',
          effectCrystalizeRadius: Math.floor(Math.random() * 8) + 4,
          seed: Math.floor(Math.random() * 100000),
        },
      }
    }

    const engine = new QrEngine(itemOptions, item.text)

    if (format === 'svg') {
      const svgStr = await engine.renderSvg(size, size)
      const encoder = new TextEncoder()
      zipFiles[`${item.filename}.svg`] = encoder.encode(svgStr)
    } else {
      const canvas = await engine.renderCanvas(size, size)
      const mimeType = format === 'webp' ? 'image/webp' : format === 'jpg' ? 'image/jpeg' : 'image/png'
      const dataUrl = canvas.toDataURL(mimeType, 0.92)
      const base64 = dataUrl.split(',')[1]
      const binaryStr = atob(base64)
      const bytes = new Uint8Array(binaryStr.length)
      for (let j = 0; j < binaryStr.length; j++) {
        bytes[j] = binaryStr.charCodeAt(j)
      }
      const ext = format === 'jpg' ? 'jpg' : format === 'webp' ? 'webp' : 'png'
      zipFiles[`${item.filename}.${ext}`] = bytes
    }

    onProgress?.(i + 1, items.length)
    // Rendering, encoding and base64 decoding all run here; without a yield the page is frozen for
    // the whole batch and the progress line never repaints.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(zipFiles, (err, data) => (err ? reject(err) : resolve(data)))
  })
  const buffer: ArrayBuffer =
    zipped.buffer instanceof ArrayBuffer ? zipped.buffer : zipped.slice().buffer
  return new Blob([buffer], { type: 'application/zip' })
}
