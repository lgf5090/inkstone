/**
 * High-resolution export pipeline for QR codes.
 * Renders PNG, JPEG, SVG, and WEBP at configurable dimensions (500, 1000, 1500, custom).
 * Generates Blobs, Data URLs, direct file download, and system clipboard copying.
 */

import type { QrExportFormat } from '../../../../../shared/tools/qrcode/types'
import type { QrEngine } from './qr-engine'

export interface ExportOptions {
  /** Target export width (and height) in pixels (e.g. 500, 1000, 1500, 3000) */
  width?: number
  /** Target image format */
  format?: QrExportFormat
  /** Compression quality (0.0 - 1.0) for JPEG and WEBP */
  quality?: number
  /** Filename for downloading (defaults to qrcode-[timestamp].[ext]) */
  filename?: string
}

/**
 * Converts a base64 Data URL to a Blob instance.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(',')
  const header = parts[0]
  const data = parts[1] || ''

  const mimeMatch = header.match(/:(.*?);/)
  const mime = mimeMatch ? mimeMatch[1] : 'image/png'

  if (header.includes(';base64')) {
    const binary = atob(data)
    const array = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      array[i] = binary.charCodeAt(i)
    }
    return new Blob([array], { type: mime })
  }

  // Decoded URL-encoded text (e.g. SVG)
  const decoded = decodeURIComponent(data)
  return new Blob([decoded], { type: mime })
}

/**
 * Converts canvas to Blob safely across browser and test environments.
 */
export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: 'image/png' | 'image/jpeg' | 'image/webp',
  quality = 0.92
): Promise<Blob> {
  if (typeof canvas.toBlob === 'function') {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob)
          } else {
            // Fallback to dataURL conversion
            try {
              const url = canvas.toDataURL(format, quality)
              resolve(dataUrlToBlob(url))
            } catch (err) {
              reject(err)
            }
          }
        },
        format,
        quality
      )
    })
  }

  const url = canvas.toDataURL(format, quality)
  return dataUrlToBlob(url)
}

/**
 * Ensures canvas has a solid white background (required for JPEG export to prevent black backgrounds).
 */
export function ensureSolidBackground(
  sourceCanvas: HTMLCanvasElement,
  bgColor = '#ffffff'
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = sourceCanvas.width
  canvas.height = sourceCanvas.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return sourceCanvas

  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(sourceCanvas, 0, 0)
  return canvas
}

/**
 * Exports QR code to Blob according to specified format and resolution.
 */
export async function exportQrToBlob(
  engine: QrEngine,
  options?: ExportOptions
): Promise<Blob> {
  const width = options?.width || 1000
  const format = options?.format || 'png'
  const quality = options?.quality ?? 0.92

  if (format === 'svg') {
    const svgString = await engine.renderSvg(width, width)
    return new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
  }

  let canvas = await engine.renderCanvas(width, width)

  if (format === 'jpeg') {
    canvas = ensureSolidBackground(canvas, engine.getOptions().backgroundOptions?.color || '#ffffff')
    return canvasToBlob(canvas, 'image/jpeg', quality)
  }

  if (format === 'webp') {
    return canvasToBlob(canvas, 'image/webp', quality)
  }

  return canvasToBlob(canvas, 'image/png')
}

/**
 * Exports QR code to a Data URL string.
 */
export async function exportQrToDataUrl(
  engine: QrEngine,
  options?: ExportOptions
): Promise<string> {
  const width = options?.width || 1000
  const format = options?.format || 'png'
  const quality = options?.quality ?? 0.92

  if (format === 'svg') {
    const svgString = await engine.renderSvg(width, width)
    return `data:image/svg+xml;utf8,${encodeURIComponent(svgString)}`
  }

  let canvas = await engine.renderCanvas(width, width)

  if (format === 'jpeg') {
    canvas = ensureSolidBackground(canvas, engine.getOptions().backgroundOptions?.color || '#ffffff')
    return canvas.toDataURL('image/jpeg', quality)
  }

  if (format === 'webp') {
    return canvas.toDataURL('image/webp', quality)
  }

  return canvas.toDataURL('image/png')
}

/**
 * Triggers a browser file download for the rendered QR code.
 */
export async function downloadQrCode(
  engine: QrEngine,
  options?: ExportOptions
): Promise<void> {
  const format = options?.format || 'png'
  const ext = format === 'jpeg' ? 'jpg' : format
  const filename = options?.filename || `qrcode-${Date.now()}.${ext}`

  const blob = await exportQrToBlob(engine, options)
  const objectUrl = URL.createObjectURL(blob)

  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/**
 * Copies the rendered PNG QR code to the system clipboard.
 */
export async function copyQrCodeToClipboard(
  engine: QrEngine,
  options?: { width?: number }
): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    throw new Error('Clipboard API is not supported in this environment')
  }

  const width = options?.width || 1000
  const blob = await exportQrToBlob(engine, { width, format: 'png' })

  if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': blob,
        }),
      ])
      return true
    } catch {
      // If image/png item write fails, attempt fallback to dataUrl text
      const dataUrl = await exportQrToDataUrl(engine, { width, format: 'png' })
      await navigator.clipboard.writeText(dataUrl)
      return true
    }
  }

  // Fallback for environments lacking ClipboardItem
  const dataUrl = await exportQrToDataUrl(engine, { width, format: 'png' })
  await navigator.clipboard.writeText(dataUrl)
  return true
}
