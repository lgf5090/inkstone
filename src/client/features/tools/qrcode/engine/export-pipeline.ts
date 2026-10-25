import type { QrExportFormat } from '../../../../../shared/tools/qrcode/types'
import type { QrEngine } from './qr-engine'

export interface ExportOptions {
  width?: number
  format?: QrExportFormat
  quality?: number
  filename?: string
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(',')
  if (commaIdx === -1) {
    throw new Error('Invalid Data URL: missing comma delimiter')
  }

  const header = dataUrl.slice(0, commaIdx)
  const data = dataUrl.slice(commaIdx + 1)

  const mimeMatch = header.match(/^data:([^;,]+)/)
  const mime = mimeMatch ? mimeMatch[1] : 'image/png'

  if (header.includes(';base64')) {
    const binary = atob(data)
    const array = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      array[i] = binary.charCodeAt(i)
    }
    return new Blob([array], { type: mime })
  }

  const decoded = decodeURIComponent(data)
  return new Blob([decoded], { type: mime })
}

export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: 'image/png' | 'image/jpeg' | 'image/webp',
  quality = 0.92
): Promise<Blob> {
  const q = Math.max(0, Math.min(1, quality))
  if (typeof canvas.toBlob === 'function') {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob)
          } else {
            try {
              const url = canvas.toDataURL(format, q)
              resolve(dataUrlToBlob(url))
            } catch (err) {
              reject(err)
            }
          }
        },
        format,
        q
      )
    })
  }

  const url = canvas.toDataURL(format, q)
  return dataUrlToBlob(url)
}

export function ensureSolidBackground(
  sourceCanvas: HTMLCanvasElement,
  bgColor = '#ffffff'
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = sourceCanvas.width
  canvas.height = sourceCanvas.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return sourceCanvas

  const effectiveBg =
    !bgColor || bgColor === 'transparent' || bgColor.toLowerCase() === 'rgba(0, 0, 0, 0)'
      ? '#ffffff'
      : bgColor

  ctx.fillStyle = effectiveBg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(sourceCanvas, 0, 0)
  return canvas
}

export async function exportQrToBlob(
  engine: QrEngine,
  options?: ExportOptions
): Promise<Blob> {
  const width = Math.max(50, Math.min(4000, options?.width || 1000))
  const format = options?.format || 'png'
  const quality = Math.max(0, Math.min(1, options?.quality ?? 0.92))
  const isJpeg = format === 'jpeg' || format === 'jpg'

  if (format === 'svg') {
    const svgString = await engine.renderSvg(width, width)
    return new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
  }

  let canvas = await engine.renderCanvas(width, width)

  if (isJpeg) {
    canvas = ensureSolidBackground(canvas, engine.getOptions().backgroundOptions?.color || '#ffffff')
    return canvasToBlob(canvas, 'image/jpeg', quality)
  }

  if (format === 'webp') {
    return canvasToBlob(canvas, 'image/webp', quality)
  }

  return canvasToBlob(canvas, 'image/png')
}

export async function exportQrToDataUrl(
  engine: QrEngine,
  options?: ExportOptions
): Promise<string> {
  const width = Math.max(50, Math.min(4000, options?.width || 1000))
  const format = options?.format || 'png'
  const quality = Math.max(0, Math.min(1, options?.quality ?? 0.92))
  const isJpeg = format === 'jpeg' || format === 'jpg'

  if (format === 'svg') {
    const svgString = await engine.renderSvg(width, width)
    return `data:image/svg+xml;utf8,${encodeURIComponent(svgString)}`
  }

  let canvas = await engine.renderCanvas(width, width)

  if (isJpeg) {
    canvas = ensureSolidBackground(canvas, engine.getOptions().backgroundOptions?.color || '#ffffff')
    return canvas.toDataURL('image/jpeg', quality)
  }

  if (format === 'webp') {
    return canvas.toDataURL('image/webp', quality)
  }

  return canvas.toDataURL('image/png')
}

export async function downloadQrCode(
  engine: QrEngine,
  options?: ExportOptions
): Promise<void> {
  const format = options?.format || 'png'
  const ext = (format === 'jpeg' || format === 'jpg') ? 'jpg' : format
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

export async function copyQrCodeToClipboard(
  engine: QrEngine,
  options?: { width?: number }
): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    throw new Error('Clipboard API is not supported in this environment')
  }

  const width = Math.max(50, Math.min(4000, options?.width || 1000))
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
      const dataUrl = await exportQrToDataUrl(engine, { width, format: 'png' })
      await navigator.clipboard.writeText(dataUrl)
      return true
    }
  }

  const dataUrl = await exportQrToDataUrl(engine, { width, format: 'png' })
  await navigator.clipboard.writeText(dataUrl)
  return true
}
